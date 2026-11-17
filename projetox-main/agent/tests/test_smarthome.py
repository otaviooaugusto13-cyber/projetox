"""Testes do módulo smarthome (sem rede externa). Rodar:  cd agent && python -m unittest discover -s tests -v
O servidor Tuya aqui é um MOCK local: valida o formato da assinatura e o fluxo, não substitui um teste na conta real."""
import hashlib, hmac, json, os, sys, tempfile, threading, unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import smarthome as sh

CID, SECRET = "cid123", "secret456"
CALLS = []


def expected_sign(method, path_qs, body, token, t, nonce):
    sts = "\n".join([method, hashlib.sha256(body).hexdigest(), "", path_qs])
    return hmac.new(SECRET.encode(), (CID + token + t + nonce + sts).encode(), hashlib.sha256).hexdigest().upper()


class Mock(BaseHTTPRequestHandler):
    expire_next = False

    def log_message(self, *a): pass

    def _do(self, method):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        h = self.headers
        token = h.get("access_token", "")
        ok = h.get("sign") == expected_sign(method, self.path, body, token, h.get("t"), h.get("nonce")) and h.get("client_id") == CID
        CALLS.append((method, urlsplit(self.path).path, ok))
        path = urlsplit(self.path).path
        if not ok:
            res = {"success": False, "code": 1004, "msg": "sign invalid"}
        elif path == "/v1.0/token":
            res = {"success": True, "result": {"access_token": "TOK1", "expire_time": 7200}}
        elif token != "TOK1" or Mock.expire_next:
            Mock.expire_next = False
            res = {"success": False, "code": 1010, "msg": "token invalid"}
        elif path == "/v1.0/devices":
            res = {"success": True, "result": {"devices": [
                {"id": "dev1", "online": True, "status": [{"code": "switch_led", "value": True}, {"code": "bright_value_v2", "value": 500}]},
                {"id": "dev2", "online": False, "status": [{"code": "switch_1", "value": False}]}]}}
        elif path.endswith("/status"):
            res = {"success": True, "result": [{"code": "switch_1", "value": False}]}
        elif path.endswith("/commands"):
            CALLS.append(("CMD", json.loads(body), True))
            res = {"success": True, "result": True}
        elif "/scene/rule/" in path:
            res = {"success": True, "result": True}
        else:
            res = {"success": False, "code": 404, "msg": "no route"}
        out = json.dumps(res).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)

    do_GET = lambda s: s._do("GET")
    do_POST = lambda s: s._do("POST")


class TuyaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), Mock)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        os.environ.update(CC_TUYA_ID=CID, CC_TUYA_SECRET=SECRET, CC_TUYA_URL=f"http://127.0.0.1:{cls.srv.server_port}")

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        CALLS.clear()
        self.t = sh.Tuya()

    def test_snapshot_batch(self):
        s = self.t.snapshot(["dev1", "dev2", "dev3"])
        self.assertEqual(s["dev1"], {"online": True, "power": True})
        self.assertEqual(s["dev2"], {"online": False, "power": False})
        self.assertIn("erro", s["dev3"])
        self.assertTrue(all(c[2] for c in CALLS if c[0] != "CMD"), "assinatura recusada pelo mock")

    def test_set_power_detects_code(self):
        self.t.set_power("devX", True)
        cmd = [c for c in CALLS if c[0] == "CMD"][0][1]
        self.assertEqual(cmd, {"commands": [{"code": "switch_1", "value": True}]})

    def test_token_refresh_on_1010(self):
        self.t._token()
        Mock.expire_next = True
        self.t.set_power("devX", False)
        self.assertEqual(len([c for c in CALLS if c[1] == "/v1.0/token"]), 2)

    def test_scene(self):
        self.assertTrue(self.t.trigger_scene("abc"))

    def test_not_configured(self):
        t = sh.Tuya(); t.cid = ""
        with self.assertRaises(sh.TuyaError):
            t.call("GET", "/x")


class MiscTests(unittest.TestCase):
    def test_normalize_ok_and_errors(self):
        d = sh.normalize({"nome": " Luz ", "ip": "192.168.0.5", "categoria": "luz", "tipo": "webhook", "webhook_on": "voicemonkey:abc"})
        self.assertEqual(d["nome"], "Luz")
        for bad in ({"nome": ""}, {"nome": "x", "ip": "300.1.1.1"}, {"nome": "x", "categoria": "zzz"},
                    {"nome": "x", "tipo": "tuya"}, {"nome": "x", "tipo": "webhook", "webhook_on": "ftp://a"},
                    {"nome": "x", "tipo": "webhook"}, {"nome": "x", "tuya_id": "a b"}):
            with self.assertRaises(ValueError, msg=str(bad)):
                sh.normalize(bad)

    def test_triggers(self):
        os.environ["CC_VOICEMONKEY_TOKEN"] = "TK"; os.environ["CC_IFTTT_KEY"] = "KEY"
        self.assertEqual(sh.resolve_trigger("voicemonkey:sala")[1], "https://api-v2.voicemonkey.io/trigger?token=TK&device=sala")
        self.assertEqual(sh.resolve_trigger("ifttt:luz on")[1], "https://maker.ifttt.com/trigger/luz%20on/with/key/KEY")
        self.assertEqual(sh.resolve_trigger("POST http://x/y"), ("POST", "http://x/y"))
        with self.assertRaises(ValueError):
            sh.resolve_trigger("javascript:alert(1)")
        self.assertNotIn("TK", sh._redact("falhou token=TK&device=a"))

    def test_store_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            st = sh.Store(os.path.join(d, "a.json"))
            a = st.add({"nome": "A"}); st.add({"nome": "B"})
            self.assertEqual(len(sh.Store(os.path.join(d, "a.json")).list()), 2)   # persistiu
            self.assertTrue(st.remove(a["id"])); self.assertFalse(st.remove(a["id"]))

    def test_probe_order(self):
        r = sh.probe("1.2.3.4", lambda ip: 7, {})
        self.assertEqual((r["online"], r["metodo"], r["ms"]), (True, "ping", 7))
        orig = sh.tcp_alive
        try:
            sh.tcp_alive = lambda ip: None
            self.assertEqual(sh.probe("1.2.3.4", lambda ip: None, {"1.2.3.4": "AA"})["metodo"], "arp")
            self.assertFalse(sh.probe("1.2.3.4", lambda ip: None, {})["online"])
        finally:
            sh.tcp_alive = orig


if __name__ == "__main__":
    unittest.main()
