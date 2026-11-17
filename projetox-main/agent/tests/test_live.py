import json, os, sys, threading, time, types, unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from flask import Flask


class FakeWS:
    def __init__(self, incoming):
        self.incoming, self.sent, self.closed = list(incoming), [], None
        self.stop_after = None

    def receive(self, timeout=None):
        return self.incoming.pop(0) if self.incoming else None

    def send(self, data):
        self.sent.append(json.loads(data))
        if self.stop_after and len(self.sent) >= self.stop_after:
            raise ConnectionError("fechado")           # simula cliente que saiu

    def close(self, reason=None, message=None):
        self.closed = reason


def install_fake_flask_sock():
    mod = types.ModuleType("flask_sock")
    class Sock:
        handlers = {}
        def __init__(self, app): pass
        def route(self, path):
            def deco(fn):
                Sock.handlers[path] = fn
                return fn
            return deco
    mod.Sock = Sock
    sys.modules["flask_sock"] = mod
    return Sock


class LiveTests(unittest.TestCase):
    def setUp(self):
        import importlib, live
        importlib.reload(live)
        self.live = live
        self.Sock = install_fake_flask_sock()
        self.app = Flask(__name__)
        self.bus = live.LiveBus()
        live.MIN_GAP_S = 0.0
        live.KEEPALIVE_S = 0.2
        live.register(self.app, bus=self.bus, build_state=lambda: {"n": 1}, token="segredo", auth=True, origins=["*"])
        self.handler = self.Sock.handlers["/ws/live"]

    def run_handler(self, ws, origin="http://x", host="localhost"):
        with self.app.test_request_context("/ws/live", headers={"Origin": origin, "Host": host}):
            self.handler(ws)

    def test_token_errado_fecha_com_4001(self):
        ws = FakeWS([json.dumps({"type": "auth", "token": "errado"})])
        self.run_handler(ws)
        self.assertEqual(ws.closed, 4001); self.assertEqual(ws.sent, [])

    def test_sem_auth_fecha_com_4001(self):
        ws = FakeWS([None])
        self.run_handler(ws)
        self.assertEqual(ws.closed, 4001)

    def test_token_ok_recebe_hello_e_estado_e_keepalive(self):
        ws = FakeWS([json.dumps({"type": "auth", "token": "segredo"})]); ws.stop_after = 3
        self.run_handler(ws)
        self.assertEqual([m["type"] for m in ws.sent], ["hello", "state", "state"][:len(ws.sent)])
        self.assertEqual(ws.sent[1]["data"], {"n": 1}); self.assertEqual(ws.sent[1]["seq"], 1)

    def test_bump_acorda_antes_do_keepalive(self):
        self.live.KEEPALIVE_S = 30
        ws = FakeWS([json.dumps({"type": "auth", "token": "segredo"})]); ws.stop_after = 3
        threading.Timer(0.2, self.bus.bump).start()
        t0 = time.monotonic(); self.run_handler(ws)
        self.assertLess(time.monotonic() - t0, 5)

    def test_origem_bloqueada(self):
        self.app = Flask(__name__)
        self.live.register(self.app, bus=self.bus, build_state=dict, token="t", auth=False, origins=["https://ok.example"])
        self.handler = self.Sock.handlers["/ws/live"]
        ws = FakeWS([json.dumps({"type": "auth", "token": ""})])
        self.run_handler(ws, origin="https://evil.example")
        self.assertEqual(ws.closed, 4003)

    def test_origin_allowed_helper(self):
        f = self.live.origin_allowed
        self.assertTrue(f("http://192.168.0.5:5000", "192.168.0.5:5000", ["https://ok"]))
        self.assertTrue(f("https://ok/", "x", ["https://ok"]))
        self.assertFalse(f("https://evil", "x", ["https://ok"]))

    def test_sem_flask_sock_nao_quebra(self):
        sys.modules["flask_sock"] = None               # força ImportError
        self.assertIsNone(self.live.register(Flask("y"), bus=self.bus, build_state=dict, token="t", auth=True, origins=["*"]))


if __name__ == "__main__":
    unittest.main()
