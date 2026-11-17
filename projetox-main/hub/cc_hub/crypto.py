"""
Protocolo CC1 · assinatura de requisições (HMAC-SHA256) e proteção contra replay.

Cada requisição do agente carrega 4 cabeçalhos:
  X-CC-Agent      identificador do agente (ex.: "pc-principal")
  X-CC-Timestamp  epoch em segundos (inteiro)
  X-CC-Nonce      16 bytes aleatórios em hex (uso único)
  X-CC-Signature  base64url(HMAC-SHA256(chave_do_agente, canonical))

canonical = "CC1\\nMETODO\\n/caminho\\nagent_id\\ntimestamp\\nnonce\\nsha256(corpo)"

A chave de cada agente é DERIVADA da chave-mestra do hub (HKDF simplificado), então o hub não
precisa guardar segredos por agente: revogar = remover da lista; rotacionar = aumentar a "época".
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import threading
from collections import OrderedDict

PROTOCOL = "CC1"


def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def unb64u(txt: str) -> bytes:
    return base64.urlsafe_b64decode(txt + "=" * (-len(txt) % 4))


def body_sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def canonical(method: str, path: str, agent_id: str, ts: int, nonce: str, body_hash: str) -> bytes:
    return "\n".join([PROTOCOL, method.upper(), path, agent_id, str(ts), nonce, body_hash]).encode("utf-8")


def sign(key: bytes, message: bytes) -> str:
    return b64u(hmac.new(key, message, hashlib.sha256).digest())


def safe_equal(a: str, b: str) -> bool:
    """Comparação em tempo constante (não vaza em qual byte a assinatura divergiu)."""
    return hmac.compare_digest(a.encode("utf-8", "replace"), b.encode("utf-8", "replace"))


def derive_agent_key(master: bytes, agent_id: str, epoch: int) -> bytes:
    """Chave do agente = HMAC(mestra, contexto|id|época). A época permite rotação sem trocar a mestra."""
    info = f"cc-agent-key|v1|{agent_id}|{epoch}".encode("utf-8")
    return hmac.new(master, info, hashlib.sha256).digest()


def ack_signature(key: bytes, nonce: str, response_body: bytes) -> str:
    """Assinatura da RESPOSTA: prova ao agente que quem respondeu conhece a chave (autenticação mútua)
    e que a resposta pertence a ESTA requisição (amarrada ao nonce). Impede ack falso por MITM."""
    msg = f"{PROTOCOL}-ACK\n{nonce}\n{body_sha256(response_body)}".encode("utf-8")
    return sign(key, msg)


class ReplayCache:
    """Memoriza nonces já vistos por (agente, nonce) durante a janela de validade do timestamp.
    Só é alimentado DEPOIS da assinatura válida, então um atacante sem a chave não consegue encher o cache."""

    def __init__(self, ttl_s: int, max_items: int = 50_000):
        self._ttl, self._max = ttl_s, max_items
        self._seen: "OrderedDict[tuple, float]" = OrderedDict()
        self._lock = threading.Lock()

    def check_and_add(self, agent_id: str, nonce: str, now: float) -> bool:
        """Devolve True se o nonce JÁ FOI USADO (replay). Caso contrário registra e devolve False."""
        key = (agent_id, nonce)
        with self._lock:
            while self._seen:                                   # expira do mais antigo para o mais novo
                k, exp = next(iter(self._seen.items()))
                if exp > now and len(self._seen) < self._max:
                    break
                self._seen.popitem(last=False)
            if key in self._seen:
                return True
            self._seen[key] = now + self._ttl
            return False
