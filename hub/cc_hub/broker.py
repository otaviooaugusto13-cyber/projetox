"""Distribuição em tempo real para o painel via Server-Sent Events (SSE).

Por que SSE e não WebSocket: o fluxo é só servidor → painel (o painel não envia nada), SSE é HTTP puro
(passa por proxies/Render sem configuração), reconecta sozinho e não exige dependência extra no hub.
"""
from __future__ import annotations

import itertools
import json
import queue
import threading
from typing import Iterator, Optional


class Subscriber:
    __slots__ = ("q", "alive")

    def __init__(self, size: int = 200):
        self.q: "queue.Queue[str]" = queue.Queue(maxsize=size)
        self.alive = True


class Broker:
    def __init__(self, max_subscribers: int = 20):
        self._subs: set = set()
        self._lock = threading.Lock()
        self._max = max_subscribers
        self._ids = itertools.count(1)

    @staticmethod
    def frame(event: str, data: dict, eid: Optional[int] = None) -> str:
        head = f"id: {eid}\n" if eid is not None else ""
        return f"{head}event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"

    def subscribe(self) -> Optional[Subscriber]:
        with self._lock:
            if len(self._subs) >= self._max:
                return None                      # protege o hub contra esgotamento de threads
            sub = Subscriber()
            self._subs.add(sub)
            return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        with self._lock:
            sub.alive = False
            self._subs.discard(sub)

    def publish(self, event: str, data: dict) -> None:
        frame = self.frame(event, data, next(self._ids))
        with self._lock:
            subs = list(self._subs)
        for s in subs:
            try:
                s.q.put_nowait(frame)
            except queue.Full:                   # consumidor lento: derruba (ele reconecta e recebe snapshot novo)
                self.unsubscribe(s)

    def count(self) -> int:
        with self._lock:
            return len(self._subs)

    def stream(self, sub: Subscriber, first_frame: str, ping_s: int = 15) -> Iterator[str]:
        """Gerador entregue ao Flask. O comentário ': ping' a cada 15 s mantém a conexão viva e permite
        ao painel detectar um hub travado (watchdog no cliente)."""
        try:
            yield "retry: 3000\n\n"
            yield first_frame
            while sub.alive:
                try:
                    yield sub.q.get(timeout=ping_s)
                except queue.Empty:
                    yield ": ping\n\n"
        finally:
            self.unsubscribe(sub)
