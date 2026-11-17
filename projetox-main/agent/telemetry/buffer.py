"""
Buffer "store-and-forward": TODA amostra entra aqui primeiro e só sai depois que o hub confirma (ack assinado).
  * Limitado (deque com maxlen): offline por horas nunca estoura a memória — descarta as MAIS ANTIGAS e conta.
  * Idempotente: reenviar um lote cujo ack se perdeu é seguro, o hub deduplica por (boot_id, seq).
  * Persistência opcional em disco (escrita atômica, só quando offline) para sobreviver a reinício do agente.
"""
from __future__ import annotations

import collections
import json
import os
import tempfile
import threading
import time
from typing import List


class SampleBuffer:
    def __init__(self, maxlen: int, path: str = ""):
        self._d: "collections.deque[dict]" = collections.deque(maxlen=maxlen)
        self._path = path
        self._k = 0                           # contador local: identifica cada item (não vai para o hub)
        self.dropped = 0
        self._last_persist = 0.0
        self._lock = threading.Lock()

    def __len__(self) -> int:
        return len(self._d)

    def append(self, sample: dict) -> None:
        with self._lock:
            if len(self._d) == self._d.maxlen:
                self.dropped += 1             # o deque vai descartar o mais antigo
            self._k += 1
            self._d.append({**sample, "_k": self._k})

    def peek(self, n: int) -> List[dict]:
        with self._lock:
            return list(self._d)[:n]

    def commit_upto(self, k: int) -> None:
        """Remove tudo até o item k (inclusive). Por id, não por contagem: seguro mesmo que o deque tenha
        descartado itens antigos enquanto o envio estava em andamento."""
        with self._lock:
            while self._d and self._d[0]["_k"] <= k:
                self._d.popleft()

    # ---------------- persistência ----------------
    def persist(self, force: bool = False) -> None:
        if not self._path or (not force and time.monotonic() - self._last_persist < 30):
            return
        with self._lock:
            data = list(self._d)
        try:
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self._path) or ".", prefix=".tb_", suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, separators=(",", ":"))
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
            os.replace(tmp, self._path)       # atômico: nunca deixa arquivo pela metade
            self._last_persist = time.monotonic()
        except OSError:
            pass                              # disco cheio/sem permissão: o buffer em memória continua valendo

    def clear_file(self) -> None:
        if self._path:
            try:
                os.remove(self._path)
            except OSError:
                pass

    def load(self) -> int:
        """Recarrega amostras do disco (JSON não confiável: valida o formato mínimo)."""
        if not self._path:
            return 0
        try:
            with open(self._path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return 0
        n = 0
        if isinstance(data, list):
            for s in data[-self._d.maxlen:]:
                if isinstance(s, dict) and {"boot_id", "seq", "ts", "metrics"} <= s.keys():
                    s.pop("_k", None)
                    self.append(s)
                    n += 1
        return n
