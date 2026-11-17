"""Módulo de telemetria Zero-Trust do agente Command Center.

Uso 1 (standalone, só telemetria):   python -m telemetry
Uso 2 (embutido no agent.py):        definindo CC_HUB_URL, o agent.py chama start_in_thread()
"""
from __future__ import annotations

import asyncio
import atexit
import logging
import threading
from typing import Optional

from .buffer import SampleBuffer
from .collectors import Collector
from .config import AGENT_VERSION, ConfigError, load_config, load_dotenv
from .heartbeat import Heartbeat
from .jsonlog import ev, setup_logging
from .transport import HubClient

__all__ = ["run_forever", "start_in_thread", "ConfigError", "AGENT_VERSION"]


async def run_forever(stop: Optional[asyncio.Event] = None, cfg=None) -> None:
    cfg = cfg or load_config()
    log = setup_logging(cfg.log_level)
    stop = stop or asyncio.Event()
    buf = SampleBuffer(cfg.buffer_max, cfg.buffer_file)
    restored = buf.load()
    hb = Heartbeat(cfg, Collector(cfg), buf, HubClient(cfg))
    ev(log, logging.INFO, "start", "telemetria iniciada", agent=cfg.agent_id, hub=cfg.hub_url, version=AGENT_VERSION,
       interval_s=cfg.interval_s, restored_samples=restored, services=len(cfg.services))
    await hb.run(stop)


def start_in_thread() -> Optional[threading.Thread]:
    """Sobe a telemetria num thread daemon com seu próprio event loop (usado pelo agent.py).
    Configuração inválida NÃO derruba o agente principal: só registra o erro e segue sem telemetria."""
    try:
        cfg = load_config()
    except ConfigError as e:
        ev(setup_logging(), logging.ERROR, "config_error", f"telemetria desativada: {e}")
        return None
    loop = asyncio.new_event_loop()
    stop = asyncio.Event()

    def _main() -> None:
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(run_forever(stop, cfg))
        except Exception as e:                        # última barreira: loga e encerra só este thread
            ev(logging.getLogger("cc-agent"), logging.CRITICAL, "fatal", "telemetria encerrada", err=e.__class__.__name__)

    t = threading.Thread(target=_main, name="cc-telemetry", daemon=True)
    t.start()
    atexit.register(lambda: loop.call_soon_threadsafe(stop.set))
    return t
