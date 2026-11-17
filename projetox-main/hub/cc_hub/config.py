"""Configuração do hub via variáveis de ambiente. Falha FECHADA: sem segredos fortes o hub não sobe."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Mapping

AGENT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,39}$")


class ConfigError(RuntimeError):
    pass


def _int(env: Mapping[str, str], name: str, default: int, lo: int, hi: int) -> int:
    raw = env.get(name)
    if raw in (None, ""):
        return default
    try:
        v = int(raw)
    except ValueError as e:
        raise ConfigError(f"{name} precisa ser um número inteiro") from e
    if not lo <= v <= hi:
        raise ConfigError(f"{name} fora do intervalo {lo}..{hi}")
    return v


def parse_agents(raw: str) -> dict:
    """Formato: 'pc-principal:PC Principal, notebook@2:Notebook'  (id[@época][:Nome]); época padrão = 1."""
    out = {}
    for item in (raw or "").split(","):
        item = item.strip()
        if not item:
            continue
        ident, _, name = item.partition(":")
        ident, _, epoch = ident.strip().partition("@")
        ident = ident.lower()
        if not AGENT_ID_RE.match(ident):
            raise ConfigError(f"CC_AGENTS: id inválido '{ident}' (use a-z, 0-9, _ e -; 3 a 40 caracteres)")
        try:
            ep = int(epoch) if epoch else 1
        except ValueError as e:
            raise ConfigError(f"CC_AGENTS: época inválida em '{item}'") from e
        out[ident] = {"name": name.strip()[:40] or ident, "epoch": max(1, ep)}
    return out


@dataclass(frozen=True)
class Settings:
    master_key: bytes
    viewer_token: str
    agents: dict
    revoked: frozenset = frozenset()
    allowed_origins: tuple = ()
    trust_proxy: bool = False
    max_skew_s: int = 60              # tolerância de relógio entre agente e hub
    max_body: int = 64 * 1024         # corpo máximo aceito (64 KB)
    max_samples: int = 50             # amostras por requisição (backlog em lote)
    max_subscribers: int = 20         # conexões SSE simultâneas
    min_agent_version: tuple = (4, 0, 0)
    offline_factor: float = 3.0       # silêncio > 3 × intervalo = Offline
    degraded_factor: float = 2.0      # silêncio > 2 × intervalo = Degradado (heartbeat atrasado)
    ghost_after_s: int = 600          # offline há mais de 10 min = Fantasma
    cpu_warn: float = 90.0
    ram_warn: float = 90.0
    disk_warn: float = 90.0
    rtt_warn_ms: float = 500.0
    agent_rate_per_min: int = 30      # requisições/min por agente já autenticado
    fail_limit: int = 20              # falhas de autenticação por IP...
    fail_window_s: int = 60           # ...nesta janela => 429 temporário


def load_settings(env: Mapping[str, str] = os.environ) -> Settings:
    master = (env.get("CC_MASTER_KEY") or "").strip()
    if len(master) < 32:
        raise ConfigError("CC_MASTER_KEY ausente ou curta (mín. 32 caracteres). Gere com: python -m cc_hub gen-secrets")
    viewer = (env.get("CC_VIEWER_TOKEN") or "").strip()
    if len(viewer) < 24:
        raise ConfigError("CC_VIEWER_TOKEN ausente ou curto (mín. 24 caracteres). Gere com: python -m cc_hub gen-secrets")
    origins = tuple(o.strip().rstrip("/") for o in (env.get("CC_ALLOWED_ORIGINS") or "").split(",") if o.strip())
    if "*" in origins:
        raise ConfigError("CC_ALLOWED_ORIGINS não aceita '*'. Liste a(s) origem(ns) do painel.")
    ver = (env.get("CC_MIN_AGENT_VERSION") or "4.0.0").strip()
    try:
        min_ver = tuple(int(x) for x in ver.split("."))
    except ValueError as e:
        raise ConfigError("CC_MIN_AGENT_VERSION inválida (ex.: 4.0.0)") from e
    return Settings(
        master_key=master.encode("utf-8"),
        viewer_token=viewer,
        agents=parse_agents(env.get("CC_AGENTS", "")),
        revoked=frozenset(x.strip().lower() for x in (env.get("CC_REVOKED") or "").split(",") if x.strip()),
        allowed_origins=origins,
        trust_proxy=(env.get("CC_TRUST_PROXY", "0") == "1"),
        max_skew_s=_int(env, "CC_MAX_SKEW_S", 60, 5, 600),
        ghost_after_s=_int(env, "CC_GHOST_AFTER_S", 600, 60, 86400),
        min_agent_version=min_ver,
    )
