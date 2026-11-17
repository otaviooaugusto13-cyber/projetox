"""
Transporte seguro agente -> hub.

  * TLS obrigatório (HTTP puro só para loopback): verificação de certificado e de hostname LIGADAS,
    TLS >= 1.2. Opcional: CA privada (CC_HUB_CA_FILE) e/ou pinning do certificado (CC_HUB_PIN_SHA256).
  * Cada requisição é assinada (HMAC, protocolo CC1) com timestamp + nonce.
  * A RESPOSTA também é verificada (X-CC-Ack): só consideramos "entregue" se o hub provar que conhece a chave.
    Isso impede que um MITM responda 200 falso e faça o agente apagar o buffer.
  * Timeouts curtos e um ÚNICO thread dedicado: um hub travado nunca acumula threads nem bloqueia o agente.
"""
from __future__ import annotations

import asyncio
import hashlib
import http.client
import json
import secrets
import socket
import ssl
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Optional

from .config import AgentConfig
from .crypto import sign_request, verify_ack

MAX_RESPONSE = 64 * 1024


@dataclass
class SendResult:
    ok: bool
    kind: str = "ok"           # ok | network | timeout | tls | pin | auth | rate | invalid | server | badack
    status: int = 0
    rtt_ms: Optional[float] = None
    retry_after: float = 0.0
    clock_offset_s: Optional[float] = None    # (relógio do hub - nosso relógio), medido pelo cabeçalho Date
    detail: str = ""


class HubClient:
    def __init__(self, cfg: AgentConfig):
        self.cfg = cfg
        scheme, host, port, path = cfg.endpoint()
        self._scheme, self._host, self._port, self._path = scheme, host, port, path
        self._ctx = self._build_ctx() if scheme == "https" else None
        self._ex = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cc-hb")

    def _build_ctx(self) -> ssl.SSLContext:
        ctx = ssl.create_default_context(cafile=self.cfg.ca_file or None)    # verify_mode=CERT_REQUIRED, check_hostname=True
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        return ctx

    # ------------------------------------------------------------------ API assíncrona
    async def send(self, payload: dict) -> SendResult:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        loop = asyncio.get_running_loop()
        try:
            return await asyncio.wait_for(loop.run_in_executor(self._ex, self._post, body), timeout=self.cfg.timeout_s * 2 + 2)
        except asyncio.TimeoutError:
            return SendResult(False, "timeout", detail="tempo total excedido")

    def close(self) -> None:
        self._ex.shutdown(wait=False, cancel_futures=True)

    # ------------------------------------------------------------------ bloqueante (roda no thread dedicado)
    def _post(self, body: bytes) -> SendResult:
        ts, nonce = int(time.time()), secrets.token_hex(16)
        sig = sign_request(self.cfg.key, "POST", self._path, self.cfg.agent_id, ts, nonce, body)
        headers = {"Content-Type": "application/json", "Content-Length": str(len(body)), "Connection": "close",
                   "User-Agent": "cc-agent/4", "X-CC-Agent": self.cfg.agent_id, "X-CC-Timestamp": str(ts),
                   "X-CC-Nonce": nonce, "X-CC-Signature": sig}
        conn = None
        try:
            if self._scheme == "https":
                conn = http.client.HTTPSConnection(self._host, self._port, timeout=self.cfg.timeout_s, context=self._ctx)
            else:
                conn = http.client.HTTPConnection(self._host, self._port, timeout=self.cfg.timeout_s)
            conn.connect()
            if self.cfg.pin_sha256 and self._scheme == "https":
                der = conn.sock.getpeercert(binary_form=True)
                if not der or hashlib.sha256(der).hexdigest() != self.cfg.pin_sha256:
                    return SendResult(False, "pin", detail="certificado do hub não confere com o fingerprint fixado")
            t0 = time.perf_counter()
            conn.request("POST", self._path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read(MAX_RESPONSE)
            rtt = (time.perf_counter() - t0) * 1000
            return self._interpret(resp, data, nonce, rtt, ts)
        except ssl.SSLError as e:                                   # inclui falha de verificação do certificado
            return SendResult(False, "tls", detail=e.__class__.__name__)
        except (socket.timeout, TimeoutError):
            return SendResult(False, "timeout", detail="timeout de socket")
        except (OSError, http.client.HTTPException) as e:
            return SendResult(False, "network", detail=e.__class__.__name__)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    def _interpret(self, resp, data: bytes, nonce: str, rtt: float, ts_sent: int) -> SendResult:
        offset = None
        date = resp.getheader("Date")
        if date:
            try:
                offset = parsedate_to_datetime(date).timestamp() - time.time()
            except (TypeError, ValueError):
                pass
        st = resp.status
        if st == 200:
            if not verify_ack(self.cfg.key, nonce, data, resp.getheader("X-CC-Ack") or ""):
                return SendResult(False, "badack", st, rtt, detail="ack do hub com assinatura inválida (MITM/hub falso?)")
            try:
                ok = bool(json.loads(data.decode("utf-8")).get("ok"))
            except ValueError:
                ok = False
            return SendResult(ok, "ok" if ok else "server", st, rtt, clock_offset_s=offset)
        retry = 0.0
        try:
            retry = float(resp.getheader("Retry-After") or 0)
        except ValueError:
            pass
        if st in (401, 403):
            return SendResult(False, "auth", st, rtt, clock_offset_s=offset, detail="credenciais rejeitadas")
        if st == 429:
            return SendResult(False, "rate", st, rtt, retry_after=retry or 60.0, clock_offset_s=offset)
        if st in (400, 413, 422):
            return SendResult(False, "invalid", st, rtt, detail="payload rejeitado pelo hub")
        return SendResult(False, "server", st, rtt, retry_after=retry, detail=f"HTTP {st}")
