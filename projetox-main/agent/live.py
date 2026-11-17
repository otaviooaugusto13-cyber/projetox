"""
Command Center · tempo real (WebSocket em /ws/live).

Por que assim:
  * EMPURRA o estado só quando algo muda (ou a cada KEEPALIVE_S como batimento). Cliente ocioso = zero
    CPU no agente: a thread dorme numa Condition.
  * Token NÃO vai na URL (apareceria em logs/histórico): o navegador manda {"type":"auth","token":...}
    como 1ª mensagem, em até AUTH_TIMEOUT_S. Comparação em tempo constante.
  * Origem verificada: mesma origem do agente ou uma de CC_ORIGINS (se configurada).
  * Limite de conexões simultâneas e coalescência (no máx. 1 envio por MIN_GAP_S).
  * Ping/pong de protocolo a cada 25 s derruba conexões meio-abertas (tablet que dormiu).

Protocolo (JSON):
  cliente -> {"type":"auth","token":"..."}
  servidor-> {"type":"hello","v":1}                      após autenticar
  servidor-> {"type":"state","seq":N,"data":{...}}       mesmo formato de GET /api/home/resumo
  servidor fecha com código 4001 se o token for recusado (o painel NÃO fica tentando de novo).

Dependência: pip install flask-sock   (sem ela o agente sobe normalmente e o painel usa polling HTTP).
"""
from __future__ import annotations

import hmac
import json
import threading
import time
from urllib.parse import urlsplit

AUTH_TIMEOUT_S = 5.0
KEEPALIVE_S = 5.0          # envia estado mesmo sem mudança: serve de batimento para o watchdog do painel
MIN_GAP_S = 1.0
MAX_CLIENTS = 8


class LiveBus:
    """Contador de versão + Condition. bump() é barato e pode ser chamado de qualquer thread."""

    def __init__(self):
        self._cv = threading.Condition()
        self.version = 0

    def bump(self) -> None:
        with self._cv:
            self.version += 1
            self._cv.notify_all()

    def wait_change(self, last: int, timeout: float) -> int:
        with self._cv:
            if self.version == last:
                self._cv.wait(timeout)
            return self.version


def origin_allowed(origin: str, host: str, allowed) -> bool:
    if not origin or "*" in allowed:
        return True
    try:
        netloc = urlsplit(origin).netloc
    except ValueError:
        return False
    return netloc == host or origin.rstrip("/") in allowed


def register(app, *, bus: LiveBus, build_state, token: str, auth: bool, origins, max_clients: int = MAX_CLIENTS):
    """Registra /ws/live. Devolve o objeto Sock, ou None se flask-sock não estiver instalado."""
    try:
        from flask import request
        from flask_sock import Sock
    except ImportError:
        print("[aviso] flask-sock não instalado: tempo real por WebSocket desativado (painel usa polling). "
              "Instale com: pip install flask-sock")
        return None

    app.config.setdefault("SOCK_SERVER_OPTIONS", {"ping_interval": 25})
    sock = Sock(app)
    clients = [0]
    mu = threading.Lock()

    @sock.route("/ws/live")
    def ws_live(ws):
        with mu:
            if clients[0] >= max_clients:
                ws.close(reason=1013, message="too many clients")
                return
            clients[0] += 1
        try:
            if not origin_allowed(request.headers.get("Origin", ""), request.host, origins):
                ws.close(reason=4003, message="origin")
                return
            try:
                first = json.loads(ws.receive(timeout=AUTH_TIMEOUT_S) or "{}")
            except (ValueError, TypeError):
                first = {}
            if auth:
                tok = str(first.get("token", "")) if isinstance(first, dict) and first.get("type") == "auth" else ""
                if not hmac.compare_digest(tok.encode(), token.encode()):
                    ws.close(reason=4001, message="auth")
                    return
            ws.send(json.dumps({"type": "hello", "v": 1}))

            seq, last_ver, last_sent = 0, -1, 0.0
            while True:
                last_ver = bus.wait_change(last_ver, KEEPALIVE_S)
                gap = MIN_GAP_S - (time.monotonic() - last_sent)
                if gap > 0:
                    time.sleep(gap)                     # coalesce rajadas de mudanças em 1 envio
                    last_ver = bus.version
                seq += 1
                ws.send(json.dumps({"type": "state", "seq": seq, "data": build_state()},
                                   separators=(",", ":"), ensure_ascii=False))
                last_sent = time.monotonic()
        except Exception:
            pass                                        # ConnectionClosed ou erro de envio: encerra só esta conexão
        finally:
            with mu:
                clients[0] -= 1

    return sock
