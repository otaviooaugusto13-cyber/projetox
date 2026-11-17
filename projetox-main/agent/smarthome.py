"""
Command Center · Casa inteligente (Jarvis)

Módulo plugado no agent.py. Faz três coisas, sempre com dados reais:
  1. CRUD de aparelhos (arquivo aparelhos.json ao lado do agent.py)
  2. Monitoramento: ping (ICMP) -> sonda TCP -> tabela ARP, e nuvem Tuya/Smart Life quando houver ID
  3. Acionamento: Tuya/Smart Life (OpenAPI na nuvem), webhooks (Voice Monkey, IFTTT, qualquer URL) e cenas Tuya

Nada é simulado: sem resposta do aparelho, o status é "offline" e o motivo aparece no painel.
Sem dependências extras (só biblioteca padrão + Flask, que o agente já usa).
"""
import hashlib, hmac, json, os, re, socket, threading, time, uuid
from concurrent.futures import ThreadPoolExecutor
from urllib import error as urlerror, parse, request as urlrequest

from flask import Blueprint, jsonify, request

CATEGORIAS = ("luz", "tomada", "pc", "tv", "alexa", "ar", "camera", "celular", "roteador", "rotina", "outro")
TIPOS = ("nenhum", "tuya", "tuya_cena", "webhook")
TUYA_HOSTS = {
    "us": "https://openapi.tuyaus.com",     # América (Brasil costuma cair aqui: "Western America")
    "ueaz": "https://openapi-ueaz.tuyaus.com",
    "eu": "https://openapi.tuyaeu.com",
    "cn": "https://openapi.tuyacn.com",
    "in": "https://openapi.tuyain.com",
}
SWITCH_CODES = ("switch_led", "switch_1", "switch", "led_switch", "switch_2")
PROBE_PORTS = (80, 443, 8009, 8008, 6668, 7000, 62078, 8080, 554, 445, 22)
MAX_DEVICES = 200


# ----------------------------------------------------------------------------------------------
# Utilidades
# ----------------------------------------------------------------------------------------------
def _env(name, default=""):
    return os.environ.get(name, default).strip()


def _clean(s, n):
    return re.sub(r"[\x00-\x1f\x7f]", "", str(s or "")).strip()[:n]


def _valid_ip(ip):
    m = re.fullmatch(r"(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})", ip or "")
    return bool(m) and all(0 <= int(g) <= 255 for g in m.groups())


def _redact(text):
    """Esconde tokens/chaves de URLs em mensagens de erro."""
    return re.sub(r"(token|key|secret|access_token)=[^&\s]+", r"\1=***", str(text), flags=re.I)


def resolve_trigger(spec):
    """Converte o atalho do webhook em (método, url).
    - 'voicemonkey:ID'  -> Voice Monkey (token vem de CC_VOICEMONKEY_TOKEN)
    - 'ifttt:evento'    -> IFTTT Webhooks (chave vem de CC_IFTTT_KEY)
    - 'http(s)://...'   -> chamada direta (GET); prefixo 'POST ' muda o método
    """
    spec = (spec or "").strip()
    method = "GET"
    if spec.upper().startswith("POST "):
        method, spec = "POST", spec[5:].strip()
    if spec.lower().startswith("voicemonkey:"):
        token = _env("CC_VOICEMONKEY_TOKEN")
        if not token:
            raise ValueError("defina CC_VOICEMONKEY_TOKEN no .env do agente")
        q = parse.urlencode({"token": token, "device": spec.split(":", 1)[1].strip()})
        return method, f"https://api-v2.voicemonkey.io/trigger?{q}"
    if spec.lower().startswith("ifttt:"):
        key = _env("CC_IFTTT_KEY")
        if not key:
            raise ValueError("defina CC_IFTTT_KEY no .env do agente")
        ev = parse.quote(spec.split(":", 1)[1].strip(), safe="")
        return method, f"https://maker.ifttt.com/trigger/{ev}/with/key/{key}"
    if re.match(r"https?://", spec, re.I):
        return method, spec
    raise ValueError("webhook inválido (use URL http(s), voicemonkey:ID ou ifttt:evento)")


def valid_trigger(spec):
    spec = (spec or "").strip()
    if not spec:
        return True
    s = spec[5:].strip() if spec.upper().startswith("POST ") else spec
    return bool(re.match(r"https?://\S+$", s, re.I) or re.match(r"(voicemonkey|ifttt):[^\s]+$", s, re.I))


def call_webhook(spec, timeout=8):
    """Dispara o webhook. Devolve (ok, mensagem). Mensagem nunca expõe token."""
    try:
        method, url = resolve_trigger(spec)
    except ValueError as e:
        return False, str(e)
    try:
        req = urlrequest.Request(url, method=method, data=b"" if method == "POST" else None,
                                 headers={"User-Agent": "CommandCenter/4"})
        with urlrequest.urlopen(req, timeout=timeout) as r:
            return (200 <= r.status < 300), f"HTTP {r.status}"
    except urlerror.HTTPError as e:
        return False, f"o serviço respondeu HTTP {e.code}"
    except Exception as e:
        return False, f"sem resposta do serviço ({e.__class__.__name__}): {_redact(e)}"[:200]


# ----------------------------------------------------------------------------------------------
# Tuya / Smart Life (OpenAPI na nuvem)
# ----------------------------------------------------------------------------------------------
class TuyaError(Exception):
    pass


class Tuya:
    def __init__(self):
        self.cid = _env("CC_TUYA_ID")
        self.secret = _env("CC_TUYA_SECRET")
        self.base = _env("CC_TUYA_URL") or TUYA_HOSTS.get(_env("CC_TUYA_REGION", "us").lower(), TUYA_HOSTS["us"])
        self.region = _env("CC_TUYA_REGION", "us").lower()
        self._tok, self._tok_exp = "", 0.0
        self._mu = threading.Lock()
        self.codes = {}      # device_id -> código do interruptor (switch_led etc.)

    @property
    def configured(self):
        return bool(self.cid and self.secret)

    def _sign(self, method, path_qs, body, token, t, nonce):
        sha = hashlib.sha256(body).hexdigest()
        string_to_sign = "\n".join([method, sha, "", path_qs])
        msg = self.cid + (token or "") + t + nonce + string_to_sign
        return hmac.new(self.secret.encode(), msg.encode(), hashlib.sha256).hexdigest().upper()

    def _raw(self, method, path, query=None, body=None, use_token=True):
        qs = "&".join(f"{k}={parse.quote(str(v), safe=',')}" for k, v in sorted((query or {}).items()))
        path_qs = path + (("?" + qs) if qs else "")
        data = json.dumps(body, separators=(",", ":")).encode() if body is not None else b""
        token = self._token() if use_token else ""
        t, nonce = str(int(time.time() * 1000)), uuid.uuid4().hex
        headers = {"client_id": self.cid, "sign": self._sign(method, path_qs, data, token, t, nonce), "t": t,
                   "sign_method": "HMAC-SHA256", "nonce": nonce, "Content-Type": "application/json"}
        if token:
            headers["access_token"] = token
        req = urlrequest.Request(self.base + path_qs, data=data or None, method=method, headers=headers)
        try:
            with urlrequest.urlopen(req, timeout=10) as r:
                return json.loads(r.read().decode("utf-8"))
        except urlerror.HTTPError as e:
            raise TuyaError(f"Tuya respondeu HTTP {e.code}")
        except Exception as e:
            raise TuyaError(f"sem acesso à nuvem Tuya ({e.__class__.__name__})")

    def _token(self):
        with self._mu:
            if self._tok and time.time() < self._tok_exp - 60:
                return self._tok
            res = self._raw("GET", "/v1.0/token", {"grant_type": 1}, use_token=False)
            if not res.get("success"):
                raise TuyaError(f"token recusado: {res.get('msg') or res.get('code')} (confira ID/Secret/região)")
            r = res["result"]
            self._tok, self._tok_exp = r["access_token"], time.time() + int(r.get("expire_time", 7200))
            return self._tok

    def call(self, method, path, query=None, body=None):
        if not self.configured:
            raise TuyaError("Tuya não configurada (CC_TUYA_ID / CC_TUYA_SECRET no .env)")
        res = self._raw(method, path, query, body)
        if not res.get("success") and res.get("code") in (1010, 1011):     # token inválido/expirado: renova 1x
            self._tok = ""
            res = self._raw(method, path, query, body)
        if not res.get("success"):
            raise TuyaError(f"{res.get('msg') or 'erro'} (código {res.get('code')})")
        return res.get("result")

    # ----- leitura
    @staticmethod
    def _pick_code(status):
        have = {s.get("code"): s.get("value") for s in status or []}
        for c in SWITCH_CODES:
            if c in have and isinstance(have[c], bool):
                return c, have[c]
        return None, None

    def snapshot(self, ids):
        """{id: {'online': bool, 'power': bool|None}} — 1 chamada em lote; cai para 1 por aparelho se o lote falhar."""
        out, ids = {}, [i for i in ids if i]
        if not ids:
            return out
        items = None
        try:
            res = self.call("GET", "/v1.0/devices", {"device_ids": ",".join(ids)})
            items = res.get("devices") if isinstance(res, dict) else res
        except TuyaError:
            items = None
        if not items:
            items = []
            for i in ids:
                try:
                    d = self.call("GET", f"/v1.0/devices/{i}")
                    d["id"] = d.get("id") or i
                    items.append(d)
                except TuyaError as e:
                    out[i] = {"online": None, "power": None, "erro": str(e)}
        for d in items:
            code, val = self._pick_code(d.get("status"))
            if code:
                self.codes[d["id"]] = code
            out[d["id"]] = {"online": bool(d.get("online")), "power": val}
        for i in ids:
            out.setdefault(i, {"online": None, "power": None, "erro": "aparelho não encontrado na conta Tuya"})
        return out

    # ----- escrita
    def set_power(self, dev_id, on):
        code = self.codes.get(dev_id)
        if not code:
            code, _ = self._pick_code(self.call("GET", f"/v1.0/devices/{dev_id}/status"))
            if not code:
                raise TuyaError("este aparelho não tem interruptor liga/desliga")
            self.codes[dev_id] = code
        self.call("POST", f"/v1.0/devices/{dev_id}/commands", body={"commands": [{"code": code, "value": bool(on)}]})
        return bool(on)

    def trigger_scene(self, scene_id, home_id=""):
        try:
            return self.call("POST", f"/v2.0/cloud/scene/rule/{scene_id}/actions/trigger")
        except TuyaError:
            if not home_id:
                raise
            return self.call("POST", f"/v1.0/homes/{home_id}/scenes/{scene_id}/trigger")


# ----------------------------------------------------------------------------------------------
# Armazenamento
# ----------------------------------------------------------------------------------------------
class Store:
    def __init__(self, path):
        self.path, self.mu = path, threading.RLock()
        self.items = self._load()

    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                d = json.load(f)
            return d if isinstance(d, list) else []
        except (OSError, ValueError):
            return []

    def _save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.items, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)

    def list(self):
        with self.mu:
            return [dict(x) for x in self.items]

    def get(self, did):
        with self.mu:
            return next((dict(x) for x in self.items if x["id"] == did), None)

    def add(self, d):
        with self.mu:
            if len(self.items) >= MAX_DEVICES:
                raise ValueError("limite de aparelhos atingido")
            d["id"] = uuid.uuid4().hex[:8]
            self.items.append(d)
            self._save()
            return dict(d)

    def update(self, did, d):
        with self.mu:
            for i, x in enumerate(self.items):
                if x["id"] == did:
                    d["id"] = did
                    self.items[i] = d
                    self._save()
                    return dict(d)
        return None

    def remove(self, did):
        with self.mu:
            n = len(self.items)
            self.items = [x for x in self.items if x["id"] != did]
            if len(self.items) != n:
                self._save()
                return True
        return False


def normalize(raw):
    """Valida e normaliza o payload vindo do painel. Levanta ValueError com mensagem em português."""
    nome = _clean(raw.get("nome"), 60)
    if not nome:
        raise ValueError("Informe o nome do aparelho")
    ip = _clean(raw.get("ip"), 15)
    if ip and not _valid_ip(ip):
        raise ValueError("IP inválido (ex.: 192.168.0.25)")
    cat = _clean(raw.get("categoria"), 20) or "outro"
    if cat not in CATEGORIAS:
        raise ValueError("Categoria inválida")
    tipo = _clean(raw.get("tipo"), 20) or "nenhum"
    if tipo not in TIPOS:
        raise ValueError("Tipo de acionamento inválido")
    tuya_id = _clean(raw.get("tuya_id"), 64)
    if tuya_id and not re.fullmatch(r"[A-Za-z0-9_\-]+", tuya_id):
        raise ValueError("ID Tuya inválido (só letras, números, - e _)")
    won, woff = _clean(raw.get("webhook_on"), 500), _clean(raw.get("webhook_off"), 500)
    for w in (won, woff):
        if not valid_trigger(w):
            raise ValueError("Webhook inválido: use URL http(s), voicemonkey:ID ou ifttt:evento")
    if tipo in ("tuya", "tuya_cena") and not tuya_id:
        raise ValueError("Informe o ID do aparelho (ou da cena) no Smart Life/Tuya")
    if tipo == "webhook" and not won:
        raise ValueError("Informe o webhook de ligar/acionar")
    return {"nome": nome, "ip": ip, "categoria": cat, "tipo": tipo, "tuya_id": tuya_id,
            "tuya_home": _clean(raw.get("tuya_home"), 32), "webhook_on": won, "webhook_off": woff}


# ----------------------------------------------------------------------------------------------
# Sondagem de rede
# ----------------------------------------------------------------------------------------------
def tcp_alive(ip, ports=PROBE_PORTS, timeout=0.35):
    """Qualquer resposta TCP (conexão aceita OU recusada) prova que o host está vivo, mesmo sem ICMP."""
    for p in ports:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        try:
            s.connect((ip, p))
            return p
        except ConnectionRefusedError:
            return p
        except OSError as e:
            if getattr(e, "winerror", None) == 10061:      # WSAECONNREFUSED no Windows
                return p
        finally:
            s.close()
    return None


def probe(ip, ping_once, arp_ips):
    ms = ping_once(ip)
    if ms is not None:
        return {"online": True, "metodo": "ping", "ms": ms}
    p = tcp_alive(ip)
    if p is not None:
        return {"online": True, "metodo": f"tcp:{p}", "ms": None}
    if ip in arp_ips:
        return {"online": True, "metodo": "arp", "ms": None}
    return {"online": False, "metodo": None, "ms": None}


# ----------------------------------------------------------------------------------------------
# Registro no Flask
# ----------------------------------------------------------------------------------------------
def register(app, *, here, ping_once, read_arp, pings, network_list, network_meta=None, on_change=None, event=None):
    """Plugar no agent.py. `ping_once(ip)` -> ms|None · `read_arp()` -> [(ip, mac)] · `pings` -> dict de latências
    gateway/internet · `network_list()` -> lista da varredura ARP já existente."""
    bp = Blueprint("home", __name__)
    store = Store(os.path.join(here, "aparelhos.json"))
    tuya = Tuya()
    status, last_cmd = {}, {}
    mu = threading.Lock()
    poll = max(3, int(_env("CC_HOME_POLL", "8") or 8))
    tuya_poll = max(20, int(_env("CC_TUYA_POLL", "120") or 120))
    wake = threading.Event()
    tuya_last = [0.0]

    def _cycle():
        devs = store.list()
        arp = {}
        try:
            arp = dict(read_arp())
        except Exception:
            pass
        with ThreadPoolExecutor(16) as ex:
            futs = {d["id"]: ex.submit(probe, d["ip"], ping_once, arp) for d in devs if d.get("ip")}
            res = {k: f.result() for k, f in futs.items()}
        mac_by_ip = arp
        tu = {}
        ids = [d["tuya_id"] for d in devs if d["tipo"] == "tuya" and d.get("tuya_id")]
        if ids and tuya.configured and time.time() - tuya_last[0] >= tuya_poll:
            tuya_last[0] = time.time()
            try:
                tu = tuya.snapshot(ids)
            except TuyaError as e:
                tu = {i: {"online": None, "power": None, "erro": str(e)} for i in ids}
        with mu:
            for d in devs:
                st = status.setdefault(d["id"], {})
                if d.get("ip"):
                    st["lan"] = res.get(d["id"])
                    st["mac"] = mac_by_ip.get(d["ip"]) or st.get("mac")
                if d["tipo"] == "tuya":
                    if d.get("tuya_id") in tu:
                        st["nuvem"] = tu[d["tuya_id"]]
                    elif not tuya.configured:
                        st["nuvem"] = {"online": None, "power": None, "erro": "Tuya não configurada no agente"}
            for gone in set(status) - {d["id"] for d in devs}:
                status.pop(gone, None)

    def _loop():
        while True:
            try:
                _cycle()
            except Exception as e:           # nunca derruba o agente
                print(f"[aviso] ciclo casa inteligente: {e.__class__.__name__}: {e}")
            _notify()
            wake.wait(poll)
            wake.clear()

    def _notify():
        if on_change:
            try:
                on_change()
            except Exception:
                pass

    def view(d):
        with mu:
            st = dict(status.get(d["id"], {}))
        lan, nuvem = st.get("lan"), st.get("nuvem")
        monitorado = bool(d.get("ip")) or (d["tipo"] == "tuya" and bool(d.get("tuya_id")))
        online, motivo = None, None
        if d.get("ip") and lan is not None:
            online = lan["online"]
            if not online:
                motivo = "sem resposta a ping, TCP nem ARP"
        elif not d.get("ip") and nuvem is not None:
            online = nuvem.get("online")
            motivo = nuvem.get("erro")
        power, fonte = None, None
        if nuvem and nuvem.get("power") is not None:
            power, fonte = nuvem["power"], "confirmado"
        elif d["id"] in last_cmd and last_cmd[d["id"]]["ok"] and last_cmd[d["id"]]["acao"] in ("ligar", "desligar"):
            power, fonte = last_cmd[d["id"]]["acao"] == "ligar", "ultimo_comando"
        controlavel = d["tipo"] != "nenhum"
        return {**d, "monitorado": monitorado, "online": online, "motivo": motivo,
                "lan": lan, "nuvem": nuvem, "mac": st.get("mac"), "power": power, "power_fonte": fonte,
                "controlavel": controlavel, "ultimo_comando": last_cmd.get(d["id"])}

    def err(msg, code=400):
        return jsonify({"ok": False, "error": msg}), code

    @bp.route("/api/home/devices", methods=["GET"])
    def list_devices():
        return jsonify([view(d) for d in store.list()])

    @bp.route("/api/home/devices", methods=["POST"])
    def add_device():
        try:
            d = store.add(normalize(request.get_json(silent=True) or {}))
        except ValueError as e:
            return err(str(e))
        wake.set()
        return jsonify({"ok": True, "device": view(d)}), 201

    @bp.route("/api/home/devices/<did>", methods=["PUT"])
    def edit_device(did):
        try:
            d = store.update(did, normalize(request.get_json(silent=True) or {}))
        except ValueError as e:
            return err(str(e))
        if not d:
            return err("aparelho não encontrado", 404)
        with mu:
            status.pop(did, None)
        wake.set()
        return jsonify({"ok": True, "device": view(d)})

    @bp.route("/api/home/devices/<did>", methods=["DELETE"])
    def delete_device(did):
        if not store.remove(did):
            return err("aparelho não encontrado", 404)
        with mu:
            status.pop(did, None)
            last_cmd.pop(did, None)
        return jsonify({"ok": True})

    @bp.route("/api/home/devices/<did>/acao", methods=["POST"])
    def act(did):
        d = store.get(did)
        if not d:
            return err("aparelho não encontrado", 404)
        acao = _clean((request.get_json(silent=True) or {}).get("acao"), 12)
        if acao not in ("ligar", "desligar", "alternar", "acionar"):
            return err("ação inválida")
        v = view(d)
        if acao == "alternar":
            acao = "desligar" if v["power"] else "ligar"
        ok, msg = False, ""
        try:
            if d["tipo"] == "nenhum":
                msg = "este aparelho não tem acionamento configurado"
            elif d["tipo"] == "tuya":
                if acao == "acionar":
                    acao = "ligar"
                tuya.set_power(d["tuya_id"], acao == "ligar")
                ok, msg = True, "comando enviado à nuvem Tuya"
                with mu:
                    n = status.setdefault(did, {}).setdefault("nuvem", {"online": None})
                    n["power"] = acao == "ligar"
                tuya_last[0] = 0       # reconfirma o estado real no próximo ciclo
                wake.set()
            elif d["tipo"] == "tuya_cena":
                tuya.trigger_scene(d["tuya_id"], d.get("tuya_home", ""))
                ok, msg = True, "cena disparada"
                acao = "acionar"
            elif d["tipo"] == "webhook":
                spec = d["webhook_off"] if acao == "desligar" else d["webhook_on"]
                if acao == "desligar" and not spec:
                    ok, msg = False, "sem webhook de desligar configurado"
                else:
                    ok, msg = call_webhook(spec)
        except TuyaError as e:
            ok, msg = False, str(e)
        with mu:
            last_cmd[did] = {"acao": acao, "ok": ok, "msg": msg, "ts": time.time()}
        _notify()
        if event:
            event("info" if ok else "warn", "casa", f"{d['nome']}: {acao} {'ok' if ok else 'falhou'} ({msg})")
        return jsonify({"ok": ok, "acao": acao, "msg": msg, "device": view(d)}), (200 if ok else 502)

    def build_resumo():
        devs = [view(d) for d in store.list()]
        try:
            lan = network_list()
        except Exception:
            lan = []
        try:
            scan = network_meta() if network_meta else None
        except Exception:
            scan = None
        return {
            "ts": time.time(),
            "rede": {"ping": dict(pings), "lan_online": sum(1 for x in lan if x.get("online")),
                     "lan": lan, "scan": scan},
            "aparelhos": devs,
        }

    @bp.route("/api/home/resumo")
    def resumo():
        return jsonify(build_resumo())

    @bp.route("/api/home/integracoes")
    def integracoes():
        return jsonify({"tuya": {"configurado": tuya.configured, "regiao": tuya.region, "host": tuya.base},
                        "voicemonkey": bool(_env("CC_VOICEMONKEY_TOKEN")), "ifttt": bool(_env("CC_IFTTT_KEY")),
                        "categorias": list(CATEGORIAS), "tipos": list(TIPOS)})

    @bp.route("/api/home/atualizar", methods=["POST"])
    def refresh():
        tuya_last[0] = 0
        wake.set()
        return jsonify({"ok": True})

    app.register_blueprint(bp)
    return {"start": lambda: threading.Thread(target=_loop, daemon=True).start(), "tuya": tuya, "store": store,
            "resumo": build_resumo}
