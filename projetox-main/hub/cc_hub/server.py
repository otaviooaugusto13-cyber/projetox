"""
Hub de telemetria · Flask.

  POST /api/v1/heartbeat   agente -> hub   (assinado com HMAC; corpo JSON validado)
  GET  /api/v1/fleet       painel -> hub   (Bearer do painel)   snapshot da frota
  GET  /api/v1/stream      painel -> hub   (Bearer do painel)   tempo real via SSE
  GET  /api/v1/health      público         {"ok": true}   (sem nenhuma informação da frota)

Produção:  gunicorn -k gthread -w 1 --threads 40 "cc_hub.server:create_app()"
(1 worker de propósito: o estado da frota vive em memória; as threads atendem os streams SSE.)
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from email.utils import formatdate
from typing import Optional

from flask import Flask, Response, jsonify, request
from werkzeug.middleware.proxy_fix import ProxyFix

from . import crypto
from .broker import Broker
from .config import Settings, load_settings
from .fleet import FleetStore, SecurityLog
from .schema import ID_RE, SchemaError, validate_envelope

log = logging.getLogger("cc_hub")


class _JsonFormatter(logging.Formatter):
    def format(self, r: logging.LogRecord) -> str:
        out = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(r.created)) + "Z", "level": r.levelname,
               "logger": r.name, "msg": r.getMessage()}
        out.update(getattr(r, "ctx", {}))
        return json.dumps(out, ensure_ascii=False)


def _setup_logging() -> None:
    if logging.getLogger("cc_hub").handlers:
        return
    h = logging.StreamHandler()
    h.setFormatter(_JsonFormatter())
    lg = logging.getLogger("cc_hub")
    lg.addHandler(h)
    lg.setLevel(os.environ.get("CC_LOG_LEVEL", "INFO").upper())
    lg.propagate = False


class FailureLimiter:
    """Contador de falhas de autenticação por IP: passou do limite, responde 429 por alguns segundos
    (antes de gastar CPU com HMAC). Mitiga força bruta e inundação de requisições inválidas."""

    def __init__(self, limit: int, window_s: int):
        self.limit, self.window = limit, window_s
        self._hits: dict = {}
        self._lock = threading.Lock()

    def blocked(self, ip: str, now: float) -> bool:
        with self._lock:
            hits = [t for t in self._hits.get(ip, []) if now - t < self.window]
            self._hits[ip] = hits
            if not hits:
                self._hits.pop(ip, None)
            return len(hits) >= self.limit

    def fail(self, ip: str, now: float) -> None:
        with self._lock:
            self._hits.setdefault(ip, []).append(now)
            if len(self._hits) > 10_000:                       # teto de memória
                self._hits.pop(next(iter(self._hits)))


def _unauthorized(status: int = 401) -> Response:
    """Resposta ÚNICA para qualquer falha de autenticação (não revela se o agente existe, se a assinatura
    ou o timestamp estava errado). O cabeçalho Date permite ao agente diagnosticar relógio fora de hora."""
    r = jsonify({"ok": False, "error": "unauthorized" if status == 401 else "rate_limited"})
    r.status_code = status
    r.headers["Date"] = formatdate(usegmt=True)
    if status == 429:
        r.headers["Retry-After"] = "60"
    return r


def create_app(settings: Optional[Settings] = None, start_ticker: bool = True,
               now_fn=time.time) -> Flask:
    _setup_logging()
    cfg = settings or load_settings()
    app = Flask(__name__, static_folder=None)          # sem rota /static: superfície mínima
    app.config["MAX_CONTENT_LENGTH"] = cfg.max_body
    if cfg.trust_proxy:                                         # atrás do proxy do Render/Cloudflare: lê o IP real
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)

    broker = Broker(cfg.max_subscribers)
    security = SecurityLog(broker.publish)
    fleet = FleetStore(cfg, security, now_fn)
    replay = crypto.ReplayCache(ttl_s=cfg.max_skew_s * 2 + 5)
    limiter = FailureLimiter(cfg.fail_limit, cfg.fail_window_s)
    dummy_key = crypto.derive_agent_key(cfg.master_key, "dummy-agent", 0)      # equaliza o tempo p/ agente desconhecido
    viewer_digest = crypto.sign(cfg.master_key, b"viewer|" + cfg.viewer_token.encode())
    app.extensions["cc"] = {"cfg": cfg, "fleet": fleet, "security": security, "broker": broker}

    # ------------------------------------------------------------------ cabeçalhos / CORS
    @app.after_request
    def _headers(r: Response) -> Response:
        r.headers["Cache-Control"] = "no-store"
        r.headers["X-Content-Type-Options"] = "nosniff"
        r.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
        r.headers["Referrer-Policy"] = "no-referrer"
        if request.is_secure:
            r.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        origin = (request.headers.get("Origin") or "").rstrip("/")
        if origin and origin in cfg.allowed_origins:
            r.headers["Access-Control-Allow-Origin"] = origin
            r.headers["Vary"] = "Origin"
            r.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
            r.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
            r.headers["Access-Control-Max-Age"] = "600"
        return r

    @app.errorhandler(413)
    def _too_big(_e):
        return jsonify({"ok": False, "error": "payload_too_large"}), 413

    @app.errorhandler(404)
    def _nf(_e):
        return jsonify({"ok": False, "error": "not_found"}), 404

    @app.errorhandler(405)
    def _na(_e):
        return jsonify({"ok": False, "error": "method_not_allowed"}), 405

    # ------------------------------------------------------------------ helpers
    def _ip() -> str:
        return request.remote_addr or "?"

    def _viewer_ok() -> bool:
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return False
        given = crypto.sign(cfg.master_key, b"viewer|" + auth[7:].strip().encode("utf-8", "replace"))
        return crypto.safe_equal(given, viewer_digest)

    def _viewer_gate() -> Optional[Response]:
        now, ip = now_fn(), _ip()
        if limiter.blocked(ip, now):
            return _unauthorized(429)
        if not _viewer_ok():
            limiter.fail(ip, now)
            security.add("warn", "viewer_auth_fail", f"Painel com token inválido em {request.path}", None, ip, now)
            return _unauthorized()
        return None

    def _safe_id(raw: str) -> str:
        return raw if ID_RE.match(raw or "") else "<inválido>"

    # ------------------------------------------------------------------ rotas públicas
    @app.get("/")
    def index():
        return Response("Command Center hub · /api/v1/health\n", mimetype="text/plain")

    @app.get("/api/v1/health")
    def health():
        return jsonify({"ok": True})

    # ------------------------------------------------------------------ AGENTE -> HUB
    @app.post("/api/v1/heartbeat")
    def heartbeat():
        now, ip = now_fn(), _ip()
        if limiter.blocked(ip, now):
            return _unauthorized(429)

        agent_id = (request.headers.get("X-CC-Agent") or "").strip().lower()
        ts_raw = request.headers.get("X-CC-Timestamp", "")
        nonce = request.headers.get("X-CC-Nonce", "")
        sig = request.headers.get("X-CC-Signature", "")
        body = request.get_data(cache=True)                      # já limitado por MAX_CONTENT_LENGTH

        def reject(kind: str, msg: str, level: str = "warn", who: Optional[str] = None):
            limiter.fail(ip, now)
            security.add(level, kind, msg, who, ip, now)
            log.warning(msg, extra={"ctx": {"event": kind, "agent": who, "ip": ip}})
            return _unauthorized()

        # 1) Forma dos cabeçalhos (barato, antes de qualquer criptografia)
        if not (ID_RE.match(agent_id) and ts_raw.isdigit() and len(ts_raw) <= 12
                and 16 <= len(nonce) <= 64 and nonce.isalnum() and 20 <= len(sig) <= 64):
            return reject("bad_request", "Heartbeat com cabeçalhos malformados")
        ts = int(ts_raw)

        # 2) Identidade: agente cadastrado e não revogado. Para desconhecidos calcula HMAC com chave falsa
        #    (mesmo custo) e devolve a MESMA resposta: nenhum oráculo de enumeração de agentes.
        entry = cfg.agents.get(agent_id)
        revoked = agent_id in cfg.revoked
        key = crypto.derive_agent_key(cfg.master_key, agent_id, entry["epoch"]) if entry and not revoked else dummy_key
        expected = crypto.sign(key, crypto.canonical("POST", request.path, agent_id, ts, nonce, crypto.body_sha256(body)))
        sig_ok = crypto.safe_equal(expected, sig)

        if not entry or revoked or not sig_ok:
            if revoked:
                return reject("revoked", f"Agente REVOGADO tentou conectar: {agent_id}", "crit", agent_id)
            if not entry:
                return reject("unknown_agent", f"Agente não cadastrado tentou conectar: {_safe_id(agent_id)}", "warn", None)
            return reject("bad_signature", f"Assinatura inválida para {entry['name']} (possível spoofing/adulteração)",
                          "crit", agent_id)

        # 3) Frescor: janela de tempo + nonce de uso único (anti-replay). Só depois da assinatura válida.
        skew = ts - now
        if abs(skew) > cfg.max_skew_s:
            return reject("clock_skew", f"{entry['name']}: timestamp fora da janela ({skew:+.0f} s). Relógio errado ou replay",
                          "warn", agent_id)
        if replay.check_and_add(agent_id, nonce, now):
            return reject("replay", f"{entry['name']}: REPLAY detectado (nonce reutilizado)", "crit", agent_id)

        # 4) Taxa por agente autenticado
        if not fleet.allow_request(agent_id, now):
            security.add("warn", "agent_rate", f"{entry['name']}: excesso de requisições", agent_id, ip, now)
            return _unauthorized(429)

        # 5) Corpo: JSON estrito + schema com lista branca
        try:
            obj = json.loads(body.decode("utf-8"), parse_constant=lambda c: (_ for _ in ()).throw(ValueError(c)))
            head, samples = validate_envelope(obj, now, cfg.max_samples, cfg.max_skew_s)
            if head["agent_id"] != agent_id:
                raise SchemaError("agent_id do corpo difere do cabeçalho assinado")
        except (ValueError, SchemaError, UnicodeDecodeError) as e:
            security.add("warn", "schema", f"{entry['name']}: payload rejeitado ({str(e)[:80]})", agent_id, ip, now)
            log.warning("payload rejeitado", extra={"ctx": {"event": "schema", "agent": agent_id, "err": str(e)[:120]}})
            r = jsonify({"ok": False, "error": "invalid_payload"})
            r.status_code = 422
            return r

        # 6) Ingestão idempotente + publicação em tempo real
        res = fleet.ingest(head, samples, ip, now, skew_s=skew)
        broker.publish("agent", fleet.summary(fleet.agents[agent_id], now) | {"server_ts": now})
        out = json.dumps({"ok": True, "server_ts": now, **res}, separators=(",", ":")).encode()
        r = Response(out, mimetype="application/json")
        r.headers["X-CC-Ack"] = crypto.ack_signature(key, nonce, out)       # autenticação mútua
        return r

    # ------------------------------------------------------------------ PAINEL -> HUB
    @app.get("/api/v1/fleet")
    def fleet_snapshot():
        gate = _viewer_gate()
        return gate if gate else jsonify(fleet.snapshot())

    @app.get("/api/v1/network")
    def network_snapshot():
        gate = _viewer_gate()
        return gate if gate else jsonify(fleet.network_snapshot())

    @app.get("/api/v1/stream")
    def stream():
        gate = _viewer_gate()
        if gate:
            return gate
        sub = broker.subscribe()
        if sub is None:
            r = jsonify({"ok": False, "error": "too_many_streams"})
            r.status_code = 503
            return r
        first = broker.frame("snapshot", fleet.snapshot())
        resp = Response(broker.stream(sub, first), mimetype="text/event-stream")
        resp.headers["X-Accel-Buffering"] = "no"                 # nginx/Render: não segurar o stream em buffer
        resp.headers["Cache-Control"] = "no-store"
        return resp

    # ------------------------------------------------------------------ relógio da frota
    if start_ticker:
        def _tick():
            """A cada 2 s reavalia os estados: Online→Offline→Fantasma acontecem por SILÊNCIO (sem requisição),
            então alguém precisa empurrar a mudança ao painel."""
            last = fleet.signature(now_fn())
            while True:
                time.sleep(2)
                try:
                    now = now_fn()
                    cur = fleet.signature(now)
                    for aid, sig in cur.items():
                        if last.get(aid) != sig:
                            broker.publish("agent", fleet.summary(fleet.agents[aid], now) | {"server_ts": now})
                    last = cur
                except Exception:                                # o relógio nunca pode morrer
                    log.exception("falha no ticker", extra={"ctx": {"event": "ticker_error"}})
        threading.Thread(target=_tick, name="fleet-ticker", daemon=True).start()

    log.info("hub iniciado", extra={"ctx": {"event": "start", "agents": list(cfg.agents), "revoked": sorted(cfg.revoked)}})
    return app
