"""Logging estruturado (uma linha JSON por evento) — fácil de filtrar com jq, Loki, Datadog etc.
Regra: NUNCA registrar chaves, assinaturas completas ou o corpo das requisições."""
from __future__ import annotations

import json
import logging
import sys
import time


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "component": "cc-agent",
            "event": getattr(record, "event", "log"),
            "msg": record.getMessage(),
        }
        out.update(getattr(record, "ctx", {}))
        if record.exc_info:
            out["exc"] = record.exc_info[0].__name__ if record.exc_info[0] else None   # só o tipo: sem stack com dados
        return json.dumps(out, ensure_ascii=False, separators=(",", ":"))


def setup_logging(level: str = "INFO") -> logging.Logger:
    lg = logging.getLogger("cc-agent")
    if not lg.handlers:
        h = logging.StreamHandler(sys.stdout)
        h.setFormatter(JsonFormatter())
        lg.addHandler(h)
        lg.propagate = False
    lg.setLevel(getattr(logging, level.upper(), logging.INFO))
    return lg


def ev(lg: logging.Logger, level: int, event: str, msg: str, **ctx) -> None:
    """Atalho: ev(log, logging.WARNING, 'send_failed', 'mensagem', kind='timeout')"""
    lg.log(level, msg, extra={"event": event, "ctx": ctx})
