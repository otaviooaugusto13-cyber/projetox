#!/usr/bin/env python3
"""
Command Center · Agente coletor (v3)

Rode no PC e no notebook (porta 5000). O painel (tablet/Render) consulta os dois.
  pip install -r requirements.txt
  python agent.py                       (CC_NAME="Notebook" python agent.py  para nomear)

Segurança por padrão:
  - Todo endpoint (menos /api/health) exige o cabeçalho X-CC-Token. O token é gerado na 1ª execução,
    impresso no terminal e salvo em agent/.token. Cole-o em ⚙ Configurações do painel.
  - Ações/Lockdown só executam comandos definidos AQUI ou no .env, nunca texto vindo da rede.
  - HTTPS opcional: CC_SSL_CERT / CC_SSL_KEY (veja README → "HTTPS e mixed content").
Configuração por variáveis de ambiente (ou arquivo .env ao lado deste script): veja .env.example.
"""
import atexit, collections, hmac, itertools, json, os, platform, re, secrets, socket, subprocess, threading, time, uuid
import psutil
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------- .env simples (sem dependência extra) ----------
def _load_env():
    try:
        with open(os.path.join(HERE, ".env"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except OSError:
        pass
_load_env()

def _json_env(name, default):
    try:
        return json.loads(os.environ[name]) if os.environ.get(name) else default
    except ValueError:
        print(f"[aviso] {name} não é JSON válido; ignorado")
        return default

HOSTNAME = os.environ.get("CC_NAME", socket.gethostname())
PORT = int(os.environ.get("CC_PORT", "5000"))
GATEWAY = os.environ.get("CC_GATEWAY", "192.168.0.1")
SSL_CERT, SSL_KEY = os.environ.get("CC_SSL_CERT"), os.environ.get("CC_SSL_KEY")
ORIGINS = [o.strip() for o in os.environ.get("CC_ORIGINS", "*").split(",") if o.strip()]
GB = 1024 ** 3
PERIPHERALS_FILE = os.path.join(HERE, "peripherals.json")
ALIASES_FILE = os.path.join(HERE, "devices.json")      # opcional: {"AA:BB:CC:DD:EE:FF": "Meu Celular"}
STATE_FILE = os.path.join(HERE, ".state.json")
TOKEN_FILE = os.path.join(HERE, ".token")

app = Flask(__name__)
CORS(app, origins=ORIGINS if ORIGINS != ["*"] else "*", allow_headers=["Content-Type", "X-CC-Token"], max_age=600)

# ---------- Autenticação por token ----------
AUTH = os.environ.get("CC_AUTH", "on").lower() != "off"
TOKEN = os.environ.get("CC_TOKEN", "")
if AUTH and not TOKEN:
    try:
        TOKEN = open(TOKEN_FILE, encoding="utf-8").read().strip()
    except OSError:
        TOKEN = ""
    if not TOKEN:
        TOKEN = secrets.token_urlsafe(24)
        with open(TOKEN_FILE, "w", encoding="utf-8") as f:
            f.write(TOKEN)
        try:
            os.chmod(TOKEN_FILE, 0o600)
        except OSError:
            pass

@app.before_request
def _auth():
    if not AUTH or request.method == "OPTIONS" or request.path == "/api/health" or not request.path.startswith("/api/"):
        return None      # painel (arquivos estáticos) é público na LAN; TODA a API exige token
    if not hmac.compare_digest(request.headers.get("X-CC-Token", ""), TOKEN):
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    return None

@app.after_request
def _headers(r):
    r.headers["Access-Control-Allow-Private-Network"] = "true"   # Chrome: página pública -> IP privado (PNA)
    r.headers["Cache-Control"] = "no-store"
    r.headers["X-Content-Type-Options"] = "nosniff"
    return r

WEB_DIR = os.path.abspath(os.environ.get("CC_WEB_DIR") or os.path.join(HERE, "..", "web"))
SERVE_WEB = os.environ.get("CC_SERVE_WEB", "on").lower() != "off" and os.path.isfile(os.path.join(WEB_DIR, "index.html"))

@app.route("/")
def index():
    if SERVE_WEB:       # o agente entrega o próprio painel: mesma origem, sem CORS nem mixed content
        return send_from_directory(WEB_DIR, "index.html")
    return "Command Center agent · /api/health", 200, {"Content-Type": "text/plain; charset=utf-8"}

@app.route("/<path:filename>")
def static_web(filename):
    if not SERVE_WEB or filename.startswith("api/"):
        return jsonify({"ok": False, "error": "not found"}), 404
    return send_from_directory(WEB_DIR, filename)

@app.route("/api/health")
def health():
    return jsonify({"ok": True, "name": HOSTNAME, "auth": AUTH, "https": bool(SSL_CERT and SSL_KEY), "version": "4.0"})

# ---------- Estado persistente (baseline do gateway) ----------
_state = {}
try:
    if os.environ.get("CC_GW_RESET") != "1":
        _state = json.load(open(STATE_FILE, encoding="utf-8"))
except Exception:
    _state = {}
def _save_state():
    try:
        json.dump(_state, open(STATE_FILE, "w", encoding="utf-8"))
    except OSError:
        pass

# ======================================================================
# MÉTRICAS: CPU / RAM / disco / rede / GPU / temperaturas
# ======================================================================
_net = {"down": 0.0, "up": 0.0}
def _net_loop():
    last, t = psutil.net_io_counters(), time.time()
    while True:
        time.sleep(1)
        cur, now = psutil.net_io_counters(), time.time()
        dt = max(now - t, 0.001)
        _net["down"] = (cur.bytes_recv - last.bytes_recv) * 8 / 1e6 / dt
        _net["up"] = (cur.bytes_sent - last.bytes_sent) * 8 / 1e6 / dt
        last, t = cur, now

_nvml = None
def read_gpu():
    """GPU NVIDIA via NVML. Sem GPU/driver devolve None (o painel mostra 'sem GPU'), nunca valores inventados."""
    global _nvml
    try:
        import pynvml as n
        if _nvml is None:
            n.nvmlInit(); _nvml = n.nvmlDeviceGetHandleByIndex(0)
        name = n.nvmlDeviceGetName(_nvml)
        return {"name": name.decode() if isinstance(name, bytes) else name,
                "percent": n.nvmlDeviceGetUtilizationRates(_nvml).gpu,
                "temp": n.nvmlDeviceGetTemperature(_nvml, n.NVML_TEMPERATURE_GPU),
                "clock": round(n.nvmlDeviceGetClockInfo(_nvml, n.NVML_CLOCK_GRAPHICS) / 1000, 2)}
    except Exception:
        return None

# Temperatura de CPU no Windows: psutil não lê. Opcional: LibreHardwareMonitor com "Remote Web Server" ligado
# (Options → Remote Web Server → Run) e CC_LHM_URL=http://localhost:8085/data.json   [parser NÃO testado em hardware real]
LHM_URL = os.environ.get("CC_LHM_URL", "")
_lhm = {"t": 0, "cpu": None, "gpu": None}
def _lhm_walk(node, path, out):
    p = path + [(node.get("Text", ""), (node.get("ImageURL") or "").lower())]
    v = node.get("Value") or ""
    if "°C" in v:
        try:
            out.append((p, float(v.replace("°C", "").replace(",", ".").strip())))
        except ValueError:
            pass
    for ch in node.get("Children", []):
        _lhm_walk(ch, p, out)
def read_lhm():
    if not LHM_URL or time.time() - _lhm["t"] < 2:
        return _lhm
    _lhm["t"] = time.time()
    try:
        from urllib.request import urlopen
        data = json.loads(urlopen(LHM_URL, timeout=1.5).read().decode("utf-8"))
        out = []
        _lhm_walk(data, [], out)
        def pick(keys, prefer):
            c = [(p, v) for p, v in out if any(any(k in img for k in keys) for _, img in p)]
            pr = [v for p, v in c if any(w in p[-1][0].lower() for w in prefer)]
            vals = pr or [v for _, v in c]
            return round(max(vals)) if vals else None
        _lhm["cpu"] = pick(("cpu",), ("package", "tctl", "tdie"))
        _lhm["gpu"] = pick(("nvidia", "ati", "gpu"), ("core",))
    except Exception:
        pass
    return _lhm

def read_cpu_temp():
    try:
        for entries in psutil.sensors_temperatures().values():
            if entries:
                return round(entries[0].current)
    except Exception:
        pass
    return read_lhm()["cpu"]

@app.route("/api/stats")
def stats():
    vm = psutil.virtual_memory()
    du = psutil.disk_usage("C:\\" if platform.system() == "Windows" else "/")
    freq = psutil.cpu_freq()
    bat = psutil.sensors_battery()
    gpu = read_gpu()
    if gpu is not None and gpu.get("temp") is None:
        gpu["temp"] = read_lhm()["gpu"]
    return jsonify({
        "host": HOSTNAME, "ts": time.time(),
        "cpu": psutil.cpu_percent(interval=0.2), "cpu_temp": read_cpu_temp(),
        "cpu_clock": round(freq.current / 1000, 2) if freq else None,
        "ram": vm.percent, "ram_used": round(vm.used / GB, 1), "ram_total": round(vm.total / GB, 1),
        "disk": du.percent, "disk_used": round(du.used / GB, 1), "disk_total": round(du.total / GB, 1),
        "gpu": gpu, "net": {"down": round(_net["down"], 2), "up": round(_net["up"], 2)},
        "battery": None if bat is None else {"percent": round(bat.percent), "plugged": bat.power_plugged},
    })

@app.route("/api/peripherals")
def peripherals():
    """Lê peripherals.json (veja peripherals.example.json). Sem o arquivo: 404 e o painel mostra dados simulados rotulados.
    Bateria de celular/relógio/fones: alimente o arquivo com KDE Connect, Home Assistant, Tasker etc."""
    try:
        with open(PERIPHERALS_FILE, encoding="utf-8") as f:
            return jsonify(json.load(f))
    except Exception:
        return jsonify({"ok": False, "error": "peripherals.json ausente"}), 404

# ======================================================================
# PING, SERVIÇOS, AÇÕES RÁPIDAS, ILUMINAÇÃO
# ======================================================================
_ping = {"gateway": None, "cloudflare": None, "google": None, "internet": None}
def _ping_once(host):
    cmd = (["ping", "-n", "1", "-w", "1000", host] if platform.system() == "Windows" else ["ping", "-c", "1", "-W", "1", host])
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=3).stdout
        m = re.search(r"(?:time|tempo)\s*[=<]\s*([\d.,]+)", out, re.I)
        return round(float(m.group(1).replace(",", "."))) if m else None
    except Exception:
        return None
def _ping_loop():
    from concurrent.futures import ThreadPoolExecutor
    targets = {"gateway": GATEWAY, "cloudflare": "1.1.1.1", "google": "8.8.8.8"}
    with ThreadPoolExecutor(3) as ex:
        while True:
            res = dict(zip(targets, ex.map(_ping_once, targets.values())))
            res["internet"] = res["cloudflare"]
            _ping.update(res)
            time.sleep(1.5)

@app.route("/api/ping")
def ping():
    return jsonify(_ping)

SERVICES = [("API Python", "port", PORT), ("Servidor Web", "port", 8080),
            ("Docker", "proc", ("dockerd", "docker.exe", "com.docker.backend.exe", "docker desktop.exe"))]
def _port_open(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.4):
            return True
    except OSError:
        return False
def _proc_running(names):
    return any((p.info["name"] or "").lower() in names for p in psutil.process_iter(["name"]))

@app.route("/api/services")
def services():
    out = []
    for name, kind, target in SERVICES:
        ok = _port_open(target) if kind == "port" else _proc_running(target)
        out.append({"name": name, "ok": ok, "detail": f":{target}" if kind == "port" else "ativo" if ok else "parado"})
    return jsonify(out)

ACTIONS = {   # só executa o que está definido AQUI
    "dev":  {},   # ex.: {"Windows": ["code", "C:/projetos"], "Linux": ["bash", "/home/voce/start-dev.sh"]}
    "mute": {"Windows": ["nircmd.exe", "mutesysvolume", "2", "microphone"], "Linux": ["amixer", "set", "Capture", "toggle"]},
    "eco":  {"Windows": ["powercfg", "/setactive", "a1841308-3541-4fab-bc81-f71556f20b4a"], "Linux": ["powerprofilesctl", "set", "power-saver"]},
}
@app.route("/api/action/<name>", methods=["POST"])
def action(name):
    cmd = ACTIONS.get(name, {}).get(platform.system())
    if not cmd:
        return jsonify({"ok": False, "msg": "não configurado em agent.py"})
    try:
        subprocess.Popen(cmd)
        return jsonify({"ok": True, "msg": "executado"})
    except Exception as e:
        return jsonify({"ok": False, "msg": f"falhou ({e.__class__.__name__})"})

LIGHTS = {"strip": {"on": True, "brightness": 80}, "room": {"on": False, "brightness": 100}, "panel": {"on": True, "brightness": 60}}
def apply_light(lid, st):
    """GANCHO: envie o comando ao dispositivo real. WLED: POST http://IP/json/state {"on":..,"bri":..}; Home Assistant: /api/services/light/turn_on."""
    pass
@app.route("/api/lights")
def lights():
    return jsonify(LIGHTS)
@app.route("/api/lights/<lid>", methods=["POST"])
def set_light(lid):
    if lid not in LIGHTS:
        return jsonify({"ok": False}), 404
    d = request.get_json(silent=True) or {}
    LIGHTS[lid]["on"] = bool(d.get("on", LIGHTS[lid]["on"]))
    try:
        LIGHTS[lid]["brightness"] = max(0, min(100, int(d.get("brightness", LIGHTS[lid]["brightness"]))))
    except (TypeError, ValueError):
        pass
    apply_light(lid, LIGHTS[lid])
    return jsonify({"ok": True, **LIGHTS[lid]})

# ======================================================================
# MIXER DE VOLUME (Windows · pycaw opcional)
# ======================================================================
try:
    import comtypes
    from comtypes import CLSCTX_ALL
    from ctypes import cast, POINTER
    from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
    PYCAW = platform.system() == "Windows"
except Exception:
    PYCAW = False

MIXER = {   # canal -> processos (edite ou use CC_MIXER_MAP='{"game":["eldenring.exe"]}')
    "music": {"name": "Música", "procs": ["spotify.exe"]},
    "game":  {"name": "Jogos", "procs": []},
    "chat":  {"name": "Chat", "procs": ["discord.exe", "teams.exe", "ms-teams.exe", "whatsapp.exe"]},
    "web":   {"name": "Navegador", "procs": ["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe"]},
}
for _k, _v in _json_env("CC_MIXER_MAP", {}).items():
    if _k in MIXER and isinstance(_v, list):
        MIXER[_k]["procs"] = [str(x).lower() for x in _v]

class _Com:   # cada thread do Flask precisa inicializar o COM
    def __enter__(self): comtypes.CoInitialize()
    def __exit__(self, *a): comtypes.CoUninitialize()

def _master():
    dev = AudioUtilities.GetSpeakers()
    ev = getattr(dev, "EndpointVolume", None)                                   # pycaw recente
    if ev is not None:
        return ev
    return cast(dev.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None), POINTER(IAudioEndpointVolume))   # pycaw antigo

def _sessions(procs):
    out = []
    for s in AudioUtilities.GetAllSessions():
        try:
            if s.Process and s.Process.name().lower() in procs:
                out.append(s.SimpleAudioVolume)
        except Exception:
            pass
    return out

@app.route("/api/mixer")
def mixer_get():
    if not PYCAW:
        return jsonify({"available": False, "reason": "pycaw/Windows indisponível"})
    try:
        with _Com():
            ev = _master()
            ch = [{"id": "master", "name": "Master", "volume": round(ev.GetMasterVolumeLevelScalar() * 100), "mute": bool(ev.GetMute()), "available": True}]
            for cid, cfg in MIXER.items():
                ss = _sessions(cfg["procs"])
                ch.append({"id": cid, "name": cfg["name"], "available": bool(ss),
                           "volume": round(ss[0].GetMasterVolume() * 100) if ss else 0, "mute": bool(ss[0].GetMute()) if ss else False})
            return jsonify({"available": True, "channels": ch})
    except Exception as e:
        return jsonify({"available": False, "reason": e.__class__.__name__})

@app.route("/api/mixer/<cid>", methods=["POST"])
def mixer_set(cid):
    if not PYCAW or (cid != "master" and cid not in MIXER):
        return jsonify({"ok": False}), 404
    d = request.get_json(silent=True) or {}
    try:
        vol = max(0, min(100, int(d.get("volume", 0)))) / 100
        mute = 1 if d.get("mute") else 0
        with _Com():
            if cid == "master":
                ev = _master(); ev.SetMasterVolumeLevelScalar(vol, None); ev.SetMute(mute, None)
            else:
                for sv in _sessions(MIXER[cid]["procs"]):
                    sv.SetMasterVolume(vol, None); sv.SetMute(mute, None)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "msg": e.__class__.__name__}), 500

# ======================================================================
# REDE LOCAL: varredura ARP + detecção de MAC do gateway alterado (ARP spoofing)
# ======================================================================
import netscan
_local_ip = netscan.local_ip
_read_arp = netscan.read_arp_pairs     # [(ip, mac)] — também usado pelo smarthome.py

_gw = {"changed": False, "dup": False}
def _check_gateway(pairs):
    macs = {m for ip, m in pairs if ip == GATEWAY}
    if not macs:
        return
    mac = sorted(macs)[0]
    base = _state.get("gateway_mac")
    if base is None:
        _state["gateway_mac"] = mac; _save_state()
        sec_event("info", "gateway", f"Baseline do gateway salvo: {mac}")
    elif mac != base:
        if not _gw["changed"]:
            sec_event("crit", "arp", f"MAC do gateway mudou: {base} → {mac}. Possível ARP spoofing (ou troca do roteador; apague .state.json se foi você)")
        _gw["changed"] = True
    else:
        _gw["changed"] = False
    others = {ip for ip, m in pairs if m == mac and ip != GATEWAY}
    if others and not _gw["dup"]:
        sec_event("warn", "arp", f"O MAC do gateway também responde por {', '.join(sorted(others))}")
    _gw["dup"] = bool(others)

# Varredura real (ARP + ping/TCP + histerese) em netscan.py. A telemetria para o hub usa a MESMA instância.
_scanner = netscan.get_scanner(gateway=GATEWAY, aliases_file=ALIASES_FILE, on_arp=_check_gateway)

def network_list():
    """Lista real de dispositivos. Mantém as chaves antigas (name/ip/mac/online/role/ago) e acrescenta
    status, latency_ms (float|None) e method (icmp|tcp|arp|local|None)."""
    snap = _scanner.snapshot()
    now = time.time()
    return [{**d, "ago": None if d["online"] else int(now - d["last_seen"])} for d in (snap["devices"] if snap else [])]

def network_meta():
    snap = _scanner.snapshot()
    return {"scanned_at": snap["scanned_at"], "subnet": snap["subnet"]} if snap else None

@app.route("/api/network")
def network():
    return jsonify(network_list())

# ======================================================================
# SENTINEL: eventos, tripwires (iscas), portas expostas, firewall e Lockdown
# ======================================================================
EVENTS = collections.deque(maxlen=100)
_ev_id = itertools.count(1)
def sec_event(level, kind, msg, ip=None):   # level: info | warn | crit
    EVENTS.append({"id": next(_ev_id), "ts": time.time(), "level": level, "kind": kind, "msg": msg, "ip": ip})
    print(f"[{level.upper():4}] {msg}")

# --- Tripwires: portas-isca. Ninguém legítimo usa; qualquer conexão = alguém varrendo/explorando a LAN.
#     A isca aceita e fecha a conexão na hora (sem banner, sem ler dados): nunca conversa com quem bate.
_c = os.environ.get("CC_CANARY_PORTS", "2222,2323").strip().lower()
CANARY_REQ = [] if _c in ("", "off", "0") else [int(p) for p in _c.split(",") if p.strip().isdigit()]
CANARY_UP, CANARY_HITS = [], [0]
def _canary(port):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind(("0.0.0.0", port)); srv.listen(16)
    except OSError as e:
        print(f"[aviso] isca :{port} não iniciou ({e.__class__.__name__})")
        return
    CANARY_UP.append(port)
    last = {}
    while True:
        try:
            conn, (ip, _p) = srv.accept()
        except OSError:
            return
        conn.close()
        CANARY_HITS[0] += 1
        now = time.time()
        if now - last.get((ip, port), 0) < 20:     # agrupa rajadas
            continue
        last[(ip, port)] = now
        local = ip.startswith("127.") or ip == _local_ip()
        sec_event("warn" if local else "crit", "tripwire", f"Tripwire :{port} {'(teste local)' if local else 'acionado'} por {ip}", None if local else ip)

# --- Portas em escuta
RISKY = {21: ("FTP", "high"), 22: ("SSH", "med"), 23: ("Telnet", "high"), 135: ("RPC", "med"), 139: ("NetBIOS", "med"), 445: ("SMB", "high"),
         1433: ("SQL Server", "med"), 2375: ("Docker API sem TLS", "high"), 3306: ("MySQL", "med"), 3389: ("RDP", "high"),
         5432: ("PostgreSQL", "med"), 5900: ("VNC", "high"), 5985: ("WinRM", "med"), 6379: ("Redis", "high"), 9200: ("Elasticsearch", "med"),
         27017: ("MongoDB", "high")}
LABELS = {80: "HTTP", 443: "HTTPS", 8080: "HTTP alt", PORT: "Agente CC"}
_sec = {"ports": [], "listening": 0, "firewall": None}
def scan_ports():
    try:
        conns = psutil.net_connections(kind="inet")
    except (psutil.AccessDenied, OSError):
        return None
    found = {}
    for c in conns:
        if c.status != psutil.CONN_LISTEN or not c.laddr:
            continue
        ip, port = c.laddr[0], c.laddr[1]
        exposed = not (ip.startswith("127.") or ip == "::1")
        label, risk = RISKY.get(port, (LABELS.get(port), None))
        proc = None
        try:
            proc = psutil.Process(c.pid).name() if c.pid else None
        except Exception:
            pass
        cur = found.get(port)
        if cur is None or (exposed and not cur["exposed"]):
            found[port] = {"port": port, "label": label, "proc": proc, "bind": ip, "exposed": exposed, "risk": risk}
    return sorted(found.values(), key=lambda p: ({"high": 0, "med": 1}.get(p["risk"], 2), p["port"]))

def read_firewall():
    if platform.system() != "Windows":
        return None
    try:
        out = subprocess.run(["netsh", "advfirewall", "show", "allprofiles", "state"], capture_output=True, text=True, timeout=5).stdout
        states = [m.group(2).upper() for m in re.finditer(r"^\s*(State|Estado)\s+(\S+)", out, re.M)]
        if not states:
            return None
        return not any(s.startswith(("OFF", "DESATIV")) for s in states)    # "OFF" em EN · "DESATIVADO/DESATIVAR" em PT-BR
    except Exception:
        return None

def _sec_loop():
    prev = None
    while True:
        ports = scan_ports()
        if ports is not None:
            _sec["ports"], _sec["listening"] = ports, len(ports)
            now_risky = {p["port"] for p in ports if p["exposed"] and p["risk"]}
            if prev is not None:
                for p in ports:
                    if p["port"] in now_risky - prev:
                        sec_event("warn", "port", f"Nova porta sensível exposta: :{p['port']} {p['label'] or ''} ({p['proc'] or 'processo?'})")
            prev = now_risky
        _sec["firewall"] = read_firewall()
        time.sleep(20)

# --- Lockdown: comandos de isolamento vêm SÓ do .env (CC_LOCKDOWN_ON / CC_LOCKDOWN_OFF, lista JSON de comandos).
#     Auto-liberação após CC_LOCKDOWN_TTL minutos (dead-man's switch) e ao encerrar o agente.
LOCK_ON, LOCK_OFF = _json_env("CC_LOCKDOWN_ON", []), _json_env("CC_LOCKDOWN_OFF", [])
LOCK_TTL = max(1, int(os.environ.get("CC_LOCKDOWN_TTL", "10")))
_lock = {"active": False, "until": 0, "timer": None}
_lock_mu = threading.RLock()
def _run_cmds(cmds):
    for c in cmds:
        try:
            subprocess.run(c, timeout=20, capture_output=True)
        except Exception as e:
            print(f"[aviso] comando de lockdown falhou: {e.__class__.__name__}")
def _lock_release(reason="liberado"):
    with _lock_mu:
        if not _lock["active"]:
            return
        _lock.update(active=False, until=0)
        if _lock["timer"]:
            _lock["timer"].cancel()
    if LOCK_OFF:
        threading.Thread(target=_run_cmds, args=(LOCK_OFF,), daemon=True).start()
    sec_event("info", "lockdown", f"Lockdown {reason}")
atexit.register(lambda: _lock_release("encerrado com o agente"))

@app.route("/api/security/lockdown", methods=["POST"])
def lockdown():
    enable = bool((request.get_json(silent=True) or {}).get("enable"))
    with _lock_mu:
        if enable and not _lock["active"]:
            _lock.update(active=True, until=time.time() + LOCK_TTL * 60)
            t = threading.Timer(LOCK_TTL * 60, _lock_release, args=("liberado automaticamente (TTL)",))
            t.daemon = True; t.start(); _lock["timer"] = t
            if LOCK_ON:
                threading.Thread(target=_run_cmds, args=(LOCK_ON,), daemon=True).start()
            sec_event("crit", "lockdown", "LOCKDOWN ativado" + ("" if LOCK_ON else " (sem comando de isolamento configurado: apenas registrado)"))
    if not enable:
        _lock_release()
    return jsonify({"ok": True, "active": _lock["active"], "until": _lock["until"], "configured": bool(LOCK_ON)})

@app.route("/api/security")
def security():
    return jsonify({
        "ts": time.time(), "ports": _sec["ports"], "listening": _sec["listening"], "firewall": _sec["firewall"],
        "canary": {"ports": CANARY_UP, "hits": CANARY_HITS[0]},
        "gateway": {"ip": GATEWAY, **_gw}, "https": bool(SSL_CERT and SSL_KEY), "auth": AUTH,
        "lockdown": {"active": _lock["active"], "until": _lock["until"], "configured": bool(LOCK_ON)},
        "events": list(EVENTS),
    })

# ======================================================================
# CASA INTELIGENTE · Jarvis (aparelhos, Tuya/Smart Life, webhooks/Alexa) -> smarthome.py
# ======================================================================
import smarthome, live
_live = live.LiveBus()
_home = smarthome.register(app, here=HERE, ping_once=_ping_once, read_arp=_read_arp, pings=_ping,
                           network_list=network_list, network_meta=network_meta, on_change=_live.bump,
                           event=lambda lv, k, m: sec_event(lv, k, m))
_scanner.subscribe(_live.bump)
# Tempo real (WebSocket em /ws/live). Sem a lib flask-sock o painel continua funcionando por polling.
live.register(app, bus=_live, build_state=_home["resumo"], token=TOKEN, auth=AUTH, origins=ORIGINS)

# ======================================================================
if __name__ == "__main__":
    psutil.cpu_percent()
    _home["start"]()
    _scanner.start()
    for fn in (_net_loop, _ping_loop, _sec_loop):
        threading.Thread(target=fn, daemon=True).start()
    for p in CANARY_REQ:
        threading.Thread(target=_canary, args=(p,), daemon=True).start()
    # Telemetria Zero-Trust (push assinado para o hub). Só liga se CC_HUB_URL estiver definido; falha de config não derruba o agente.
    if os.environ.get("CC_HUB_URL"):
        import telemetry
        telemetry.start_in_thread()
    ssl_ctx = (SSL_CERT, SSL_KEY) if SSL_CERT and SSL_KEY else None
    proto, ip = ("https" if ssl_ctx else "http"), (_local_ip() or "IP-DA-MAQUINA")
    print(f"\n[Command Center] {HOSTNAME} · {proto}://{ip}:{PORT}/api/health")
    if SERVE_WEB:
        print(f"[Command Center] PAINEL (abra no tablet): {proto}://{ip}:{PORT}/")
    if AUTH:
        print(f"[Command Center] TOKEN (cole em ⚙ Configurações do painel): {TOKEN}")
    else:
        print("[AVISO] CC_AUTH=off: qualquer dispositivo da rede pode ler métricas e acionar ações!")
    if not ssl_ctx:
        print("[aviso] sem HTTPS: o painel hospedado em HTTPS (Render) NÃO consegue falar com este agente; veja o README.")
    print(f"[Command Center] iscas (tripwires): {CANARY_REQ or 'desativadas'} · pycaw: {'ok' if PYCAW else 'indisponível'}\n")
    app.run(host="0.0.0.0", port=PORT, threaded=True, ssl_context=ssl_ctx)
