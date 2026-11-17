"""
Heartbeat assíncrono com store-and-forward.

Duas tarefas independentes num único event loop:
  sampler  a cada `interval` coleta uma amostra e a coloca no buffer (nunca bloqueia por causa da rede)
  sender   drena o buffer em lotes; falhou => backoff exponencial com jitter total; voltou => descarrega o backlog

Tratamento de falhas por tipo:
  network/timeout/server  -> retry com backoff (2 s .. 60 s), amostras ficam no buffer
  tls/pin/badack          -> nunca "faz downgrade": backoff longo + log crítico (possível MITM)
  auth                    -> backoff longo (>=30 s) + dica de relógio fora de hora (cabeçalho Date)
  rate                    -> respeita Retry-After
  invalid (422)           -> lote "veneno": descarta para não travar a fila para sempre
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from typing import Optional

from .buffer import SampleBuffer
from .collectors import Collector
from .config import AGENT_VERSION, AgentConfig
from .jsonlog import ev
from .transport import HubClient, SendResult

log = logging.getLogger("cc-agent")


class Backoff:
    """Backoff exponencial com 'full jitter' (evita que vários agentes reconectem todos no mesmo instante)."""

    def __init__(self, base: float, cap: float, rng=random.random):
        self.base, self.cap, self.n, self._rng = base, cap, 0, rng

    def next(self, floor: float = 0.0) -> float:
        ceiling = min(self.cap, self.base * (2 ** self.n))
        self.n += 1
        return max(floor, self.base / 2 + self._rng() * (ceiling - self.base / 2))

    def reset(self) -> None:
        self.n = 0


class Heartbeat:
    def __init__(self, cfg: AgentConfig, collector: Collector, buffer: SampleBuffer, client: HubClient):
        self.cfg, self.col, self.buf, self.client = cfg, collector, buffer, client
        self.backoff = Backoff(cfg.backoff_base_s, cfg.backoff_cap_s)
        self.last_rtt: Optional[float] = None
        self.online: Optional[bool] = None
        self._next_attempt = 0.0
        self._offline_since: Optional[float] = None
        self._fails = 0
        self._wake: Optional[asyncio.Event] = None
        self._host = collector.host_info()

    # ---------------------------------------------------------------- tarefas
    async def run(self, stop: asyncio.Event) -> None:
        self._wake = asyncio.Event()
        tasks = [asyncio.create_task(self._sampler()), asyncio.create_task(self._sender())]
        try:
            await stop.wait()
        finally:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            self.buf.persist(force=True)                 # não perde o que ainda não foi entregue
            self.client.close()

    async def _sampler(self) -> None:
        while True:
            try:
                self.buf.append(await self.col.sample(self.last_rtt))
                self._wake.set()
            except asyncio.CancelledError:
                raise
            except Exception as e:                       # coleta falhou: registra e segue no próximo ciclo
                ev(log, logging.ERROR, "sample_error", "falha ao coletar amostra", err=e.__class__.__name__)
            await asyncio.sleep(self.cfg.interval_s * random.uniform(0.95, 1.05))

    async def _sender(self) -> None:
        while True:
            try:
                wait = self._next_attempt - time.monotonic()
                if not self.buf or wait > 0:
                    try:
                        await asyncio.wait_for(self._wake.wait(), timeout=wait if (self.buf and wait > 0) else None)
                    except asyncio.TimeoutError:
                        pass
                    self._wake.clear()
                    if not self.buf or time.monotonic() < self._next_attempt:
                        continue
                await self._flush_once()
                if self.buf and self.online:
                    await asyncio.sleep(0.2)             # ainda há backlog: continua drenando sem martelar o hub
                    self._wake.set()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                ev(log, logging.ERROR, "sender_error", "erro inesperado no envio", err=e.__class__.__name__)
                await asyncio.sleep(5)

    # ---------------------------------------------------------------- envio de um lote
    async def _flush_once(self) -> None:
        batch = self.buf.peek(self.cfg.batch_max)
        if not batch:
            return
        payload = {"v": 1, "agent_id": self.cfg.agent_id, "agent_version": AGENT_VERSION,
                   "interval_s": self.cfg.interval_s, "host": self._host,
                   "samples": [{k: v for k, v in s.items() if k != "_k"} for s in batch]}
        try:
            net = self.col.network()                 # snapshot atual da LAN; falha aqui nunca bloqueia as métricas
        except Exception:
            net = None
        if net:
            payload["network"] = net
        r = await self.client.send(payload)
        if r.ok:
            self.buf.commit_upto(batch[-1]["_k"])
            self.last_rtt = r.rtt_ms
            self._on_success(len(batch))
        elif r.kind == "invalid":
            self.buf.commit_upto(batch[-1]["_k"])        # lote veneno: descarta
            ev(log, logging.ERROR, "batch_dropped", "hub rejeitou o payload; lote descartado", samples=len(batch), status=r.status)
        else:
            self._on_failure(r)

    def _on_success(self, n: int) -> None:
        if not self.online:
            down = 0 if self._offline_since is None else int(time.monotonic() - self._offline_since)
            ev(log, logging.INFO, "hub_connected", "conectado ao hub", flushed=n, backlog=len(self.buf), offline_s=down,
               dropped_total=self.buf.dropped)
        self.online, self._offline_since, self._fails = True, None, 0
        self._next_attempt = 0.0
        self.backoff.reset()
        if not self.buf:
            self.buf.clear_file()

    def _on_failure(self, r: SendResult) -> None:
        self._fails += 1
        floor = {"auth": 30.0, "tls": 30.0, "pin": 60.0, "badack": 60.0}.get(r.kind, 0.0)
        floor = max(floor, r.retry_after)
        delay = self.backoff.next(floor)
        self._next_attempt = time.monotonic() + delay
        if self.online is not False:
            self._offline_since = time.monotonic()
        self.online = False
        sev = logging.CRITICAL if r.kind in ("tls", "pin", "badack") else logging.WARNING
        if self._fails <= 3 or self._fails % 10 == 0:   # não inunda o log durante quedas longas
            hint = {}
            if r.kind == "auth" and r.clock_offset_s is not None and abs(r.clock_offset_s) > 30:
                hint["clock_offset_s"] = round(r.clock_offset_s)     # causa mais comum de 401: relógio fora de hora
            ev(log, sev, "send_failed", "falha ao enviar heartbeat", kind=r.kind, status=r.status, detail=r.detail,
               retry_in_s=round(delay, 1), buffered=len(self.buf), dropped_total=self.buf.dropped, fails=self._fails, **hint)
        self.buf.persist()
