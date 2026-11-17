"""Protocolo CC1 (lado do agente): assina a requisição e verifica a assinatura da resposta do hub.
Deve permanecer idêntico a hub/cc_hub/crypto.py (há um teste de interoperabilidade em hub/tests)."""
from __future__ import annotations

import base64
import hashlib
import hmac

PROTOCOL = "CC1"


def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def unb64u(txt: str) -> bytes:
    return base64.urlsafe_b64decode(txt + "=" * (-len(txt) % 4))


def body_sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def sign_request(key: bytes, method: str, path: str, agent_id: str, ts: int, nonce: str, body: bytes) -> str:
    canonical = "\n".join([PROTOCOL, method.upper(), path, agent_id, str(ts), nonce, body_sha256(body)]).encode("utf-8")
    return b64u(hmac.new(key, canonical, hashlib.sha256).digest())


def verify_ack(key: bytes, nonce: str, response_body: bytes, given: str) -> bool:
    """Confere o X-CC-Ack do hub (amarrado ao nonce desta requisição). Falhou = resposta forjada/adulterada."""
    msg = f"{PROTOCOL}-ACK\n{nonce}\n{body_sha256(response_body)}".encode("utf-8")
    expected = b64u(hmac.new(key, msg, hashlib.sha256).digest())
    return hmac.compare_digest(expected.encode(), (given or "").encode("utf-8", "replace"))
