"""python -m telemetry  ->  agente de telemetria standalone (sem Flask, só psutil + stdlib)."""
from __future__ import annotations

import asyncio
import signal
import sys

from . import ConfigError, run_forever
from .config import load_dotenv


async def _main() -> int:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)        # Linux/macOS
        except (NotImplementedError, RuntimeError):
            pass                                          # Windows: Ctrl+C vira KeyboardInterrupt (tratado abaixo)
    await run_forever(stop)
    return 0


if __name__ == "__main__":
    load_dotenv()
    try:
        sys.exit(asyncio.run(_main()))
    except ConfigError as e:
        print(f'{{"level":"ERROR","event":"config_error","msg":"{e}"}}', file=sys.stderr)
        sys.exit(2)
    except KeyboardInterrupt:
        sys.exit(0)
