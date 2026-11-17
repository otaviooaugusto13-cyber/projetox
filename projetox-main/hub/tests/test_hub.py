"""Testes do hub: rode em command-center/hub com  python -m unittest discover -s tests -v"""
import json
import os
import secrets
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, os.path.join(HERE, "..", "..", "agent"))       # para o teste de interoperabilidade

from cc_hub import crypto                                            # noqa: E402
from cc_hub.config import Settings, parse_agents                     # noqa: E402
from cc_hub.server import create_app                                 # noqa: E402
from telemetry import crypto as agent_crypto                         # noqa: E402

MASTER = b"m" * 48
PATH = "/api/v1/heartbeat"


class Clock:
    t = 1_900_000_000.0

    def __call__(self):
        return self.t


def sample(seq=1, ts=None, boot="a" * 32, cpu=10.0, svc_ok=True):
    return {"boot_id": boot, "seq": seq, "ts": ts or Clock.t, "flags": [],
            "metrics": {"cpu": cpu, "ram": 40.0, "disk": 50.0, "rtt_ms": 20.0, "uptime_s": 1000},
            "services": [{"name": "API", "ok": svc_ok, "critical": True}]}


def envelope(samples, agent="pc-principal", version="4.0.0"):
    return {"v": 1, "agent_id": agent, "agent_version": version, "interval_s": 15,
            "host": {"hostname": "pc", "os": "Linux", "python": "3.12"}, "samples": samples}


class HubTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.clock.t = 1_900_000_000.0
        cfg = Settings(master_key=MASTER, viewer_token="v" * 30,
                       agents=parse_agents("pc-principal:PC Principal,notebook:Notebook"),
                       revoked=frozenset({"velho-nodo"}), allowed_origins=("https://painel.example",))
        self.app = create_app(cfg, start_ticker=False, now_fn=self.clock)
        self.c = self.app.test_client()
        self.cc = self.app.extensions["cc"]
        self.key = crypto.derive_agent_key(MASTER, "pc-principal", 1)

    # ---- helpers
    def post(self, obj, agent="pc-principal", key=None, ts=None, nonce=None, raw=None, sig=None):
        body = raw if raw is not None else json.dumps(obj).encode()
        ts = int(self.clock.t) if ts is None else ts
        nonce = nonce or secrets.token_hex(16)
        key = key or crypto.derive_agent_key(MASTER, agent, 1)
        s = sig or agent_crypto.sign_request(key, "POST", PATH, agent, ts, nonce, body)
        h = {"X-CC-Agent": agent, "X-CC-Timestamp": str(ts), "X-CC-Nonce": nonce, "X-CC-Signature": s,
             "Content-Type": "application/json"}
        return self.c.post(PATH, data=body, headers=h), nonce

    def viewer(self, path="/api/v1/fleet", token="v" * 30):
        return self.c.get(path, headers={"Authorization": f"Bearer {token}"})

    def status(self, aid="pc-principal"):
        return {a["id"]: a for a in self.viewer().get_json()["agents"]}[aid]

    # ---- dispositivos da rede (payload do agente -> hub -> painel)
    def net_payload(self, **over):
        n = {"scanned_at": self.clock.t - 3, "subnet": "192.168.0.0/24", "devices": [
            {"ip": "192.168.0.1", "mac": "A4:2B:B0:1C:55:90", "name": "Roteador", "status": "online",
             "latency_ms": 1.8, "method": "icmp", "last_seen": self.clock.t - 3},
            {"ip": "192.168.0.23", "mac": "3C:5A:B4:91:0E:D2", "name": "Celular", "status": "offline",
             "latency_ms": None, "method": None, "last_seen": self.clock.t - 900}]}
        n.update(over)
        return n

    def test_network_valido_e_exposto_ao_painel(self):
        env = envelope([sample()]); env["network"] = self.net_payload()
        r, _ = self.post(env)
        self.assertEqual(r.status_code, 200)
        net = {a["id"]: a for a in self.viewer("/api/v1/network").get_json()["agents"]}["pc-principal"]["network"]
        self.assertEqual([d["ip"] for d in net["devices"]], ["192.168.0.1", "192.168.0.23"])
        self.assertEqual(net["devices"][0]["latency_ms"], 1.8)
        self.assertEqual(self.status()["net"], {"online": 1, "total": 2, "scanned_at": self.clock.t - 3})

    def test_network_malformado_descarta_so_o_network(self):
        env = envelope([sample()])
        env["network"] = self.net_payload(devices=[{"ip": "999.1.1.1", "mac": "xx", "status": "online"}])
        r, _ = self.post(env)
        self.assertEqual(r.status_code, 200)                         # métricas continuam aceitas
        self.assertIsNone(self.status()["net"])

    def test_network_chaves_extras_e_html_nao_passam(self):
        env = envelope([sample()]); n = self.net_payload()
        n["devices"][0]["name"] = "<img src=x>"
        env["network"] = n
        r, _ = self.post(env)
        self.assertEqual(r.status_code, 200); self.assertIsNone(self.status()["net"])
        env["network"] = self.net_payload(); env["network"]["devices"][0]["evil"] = "x"
        r, _ = self.post(env)
        d = self.viewer("/api/v1/network").get_json()["agents"][0]["network"]["devices"][0]
        self.assertNotIn("evil", d)

    def test_network_antigo_nao_sobrescreve_o_novo(self):
        e1 = envelope([sample(seq=1)]); e1["network"] = self.net_payload(scanned_at=self.clock.t - 1)
        e2 = envelope([sample(seq=2)]); e2["network"] = self.net_payload(scanned_at=self.clock.t - 50)
        self.post(e1); self.post(e2)
        self.assertEqual(self.status()["net"]["scanned_at"], self.clock.t - 1)

    def test_network_exige_token_de_painel(self):
        self.assertEqual(self.viewer("/api/v1/network", token="errado").status_code, 401)

    # ---- autenticação / protocolo
    def test_agente_e_hub_assinam_igual(self):
        body = b'{"x":1}'
        a = agent_crypto.sign_request(self.key, "POST", PATH, "pc-principal", 5, "n" * 16, body)
        b = crypto.sign(self.key, crypto.canonical("POST", PATH, "pc-principal", 5, "n" * 16, crypto.body_sha256(body)))
        self.assertEqual(a, b)

    def test_heartbeat_valido_e_ack_assinado(self):
        r, nonce = self.post(envelope([sample()]))
        self.assertEqual(r.status_code, 200)
        self.assertTrue(agent_crypto.verify_ack(self.key, nonce, r.data, r.headers["X-CC-Ack"]))
        self.assertFalse(agent_crypto.verify_ack(self.key, "outro-nonce-qualquer", r.data, r.headers["X-CC-Ack"]))
        self.assertEqual(self.status()["status"], "online")

    def test_assinatura_adulterada_corpo(self):
        body = json.dumps(envelope([sample()])).encode()
        ts, nonce = int(self.clock.t), secrets.token_hex(16)
        sig = agent_crypto.sign_request(self.key, "POST", PATH, "pc-principal", ts, nonce, body)
        r, _ = self.post(None, raw=body.replace(b'"cpu": 10.0', b'"cpu": 1.0'), ts=ts, nonce=nonce, sig=sig)
        self.assertEqual(r.status_code, 401)
        self.assertEqual(self.cc["security"].recent()[-1]["kind"], "bad_signature")

    def test_chave_errada_e_agente_desconhecido_tem_mesma_resposta(self):
        r1, _ = self.post(envelope([sample()]), key=b"k" * 32)
        r2, _ = self.post(envelope([sample()], agent="intruso-x"), agent="intruso-x")
        self.assertEqual((r1.status_code, r1.get_json()), (r2.status_code, r2.get_json()))
        self.assertEqual(r1.status_code, 401)

    def test_agente_revogado(self):
        r, _ = self.post(envelope([sample()], agent="velho-nodo"), agent="velho-nodo")
        self.assertEqual(r.status_code, 401)

    def test_replay(self):
        body = json.dumps(envelope([sample()])).encode()
        ts, nonce = int(self.clock.t), secrets.token_hex(16)
        r1, _ = self.post(None, raw=body, ts=ts, nonce=nonce)
        r2, _ = self.post(None, raw=body, ts=ts, nonce=nonce)
        self.assertEqual((r1.status_code, r2.status_code), (200, 401))
        self.assertEqual(self.cc["security"].recent()[-1]["kind"], "replay")

    def test_timestamp_fora_da_janela(self):
        r, _ = self.post(envelope([sample()]), ts=int(self.clock.t) - 500)
        self.assertEqual(r.status_code, 401)
        self.assertEqual(self.cc["security"].recent()[-1]["kind"], "clock_skew")

    def test_bloqueio_por_forca_bruta(self):
        for _ in range(20):
            self.post(envelope([sample()]), key=b"k" * 32)
        r, _ = self.post(envelope([sample()]))                       # até o agente legítimo leva 429 desse IP
        self.assertEqual(r.status_code, 429)

    # ---- validação do payload
    def test_payload_invalido_422(self):
        for bad in (envelope([sample(cpu=250)]), envelope([]), {**envelope([sample()]), "v": 2},
                    envelope([sample()], agent="notebook")):
            r, _ = self.post(bad)
            self.assertEqual(r.status_code, 422, bad)

    def test_nan_e_tipos_errados(self):
        raw = json.dumps(envelope([sample()])).replace("10.0", "NaN").encode()
        self.assertEqual(self.post(None, raw=raw)[0].status_code, 422)
        s = sample()
        s["metrics"]["cpu"] = True
        self.assertEqual(self.post(envelope([s]))[0].status_code, 422)

    def test_nome_de_servico_com_html_e_rejeitado(self):
        s = sample()
        s["services"][0]["name"] = "<img src=x onerror=alert(1)>"
        self.assertEqual(self.post(envelope([s]))[0].status_code, 422)

    def test_corpo_grande_413(self):
        r, _ = self.post(None, raw=b"x" * (70 * 1024))
        self.assertEqual(r.status_code, 413)

    # ---- idempotência / backlog
    def test_reenvio_nao_duplica(self):
        e = envelope([sample(1), sample(2)])
        r1, _ = self.post(e)
        r2, _ = self.post(e)
        self.assertEqual(r1.get_json()["accepted"], 2)
        self.assertEqual((r2.get_json()["accepted"], r2.get_json()["duplicates"]), (0, 2))
        self.assertEqual(self.status()["rx_samples"], 2)

    def test_backlog_fora_de_ordem_mantem_o_mais_novo(self):
        t = self.clock.t
        self.post(envelope([sample(3, t), sample(1, t - 30), sample(2, t - 15)]))
        hist = self.status()["history"]
        self.assertEqual([p[0] for p in hist], sorted(p[0] for p in hist))
        self.assertEqual(self.status()["backlog_flushes"], 1)

    # ---- estados de saúde
    def test_online_degradado_offline_fantasma(self):
        self.post(envelope([sample()]))
        self.assertEqual(self.status()["status"], "online")
        self.clock.t += 35                                           # > 2 x 15 s
        self.assertEqual(self.status()["status"], "degraded")
        self.clock.t += 20                                           # > 3 x 15 s
        self.assertEqual(self.status()["status"], "offline")
        self.clock.t += 700
        self.assertEqual(self.status()["status"], "ghost")

    def test_degradado_por_metrica_e_servico(self):
        self.post(envelope([sample(cpu=95.0)]))
        st = self.status()
        self.assertEqual(st["status"], "degraded")
        self.post(envelope([sample(2, cpu=5.0, svc_ok=False)]))
        self.assertTrue(any(r["code"] == "svc_down" for r in self.status()["reasons"]))

    def test_agente_nunca_visto(self):
        self.assertEqual(self.status("notebook")["status"], "pending")
        self.clock.t += 700
        self.assertEqual(self.status("notebook")["status"], "ghost")

    # ---- painel
    def test_painel_exige_token(self):
        self.assertEqual(self.c.get("/api/v1/fleet").status_code, 401)
        self.assertEqual(self.viewer(token="errado" * 6).status_code, 401)
        self.assertEqual(self.c.get("/api/v1/stream").status_code, 401)
        self.assertEqual(self.viewer().status_code, 200)

    def test_cors_somente_origem_permitida(self):
        ok = self.c.get("/api/v1/health", headers={"Origin": "https://painel.example"})
        bad = self.c.get("/api/v1/health", headers={"Origin": "https://evil.example"})
        self.assertEqual(ok.headers.get("Access-Control-Allow-Origin"), "https://painel.example")
        self.assertIsNone(bad.headers.get("Access-Control-Allow-Origin"))

    def test_health_nao_vaza_frota(self):
        self.assertEqual(self.c.get("/api/v1/health").get_json(), {"ok": True})

    def test_sse_snapshot_e_evento(self):
        r = self.viewer("/api/v1/stream")
        self.assertEqual(r.mimetype, "text/event-stream")
        it = (c.decode() if isinstance(c, bytes) else c for c in r.response)
        self.assertIn("retry:", next(it))
        self.assertIn("event: snapshot", next(it))
        self.post(envelope([sample()]))
        self.assertIn("event: agent", next(it))
        r.close()


if __name__ == "__main__":
    unittest.main()
