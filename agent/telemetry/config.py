"""Configuração do módulo de telemetria (variáveis de ambiente / agent/.env). Falha fechada e com mensagens claras."""
from __future__ import annotations

import json
import os
import platform
import re
from dataclasses import dataclass, field
from typing import Mapping
from urllib.parse import urlsplit

from .crypto import unb64u

AGENT_VERSION = "4.0.0"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,39}$")
LOOPBACK = {"localhost", "127.0.0.1", "::1"}
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))        # pasta agent/


class ConfigError(RuntimeError):
    pass


def load_dotenv(path: str = os.path.join(HERE, ".env")) -> None:
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except OSError:
        pass


@dataclass(frozen=True)
class AgentConfig:
    hub_url: str
    agent_id: str
    key: bytes = field(repr=False)                 # repr=False: a chave nunca aparece em logs/tracebacks
    interval_s: float = 15.0
    buffer_max: int = 240                          # ~1 h de amostras a cada 15 s
    batch_max: int = 50
    buffer_file: str = os.path.join(HERE, ".telemetry_buffer.json")
    services: list = field(default_factory=list)     # serviços críticos vigiados (ver CC_SERVICES)
    disk_path: str = "C:\\" if platform.system() == "Windows" else "/"
    pin_sha256: str = ""                           # fingerprint SHA-256 (hex) do certificado do hub (opcional)
    ca_file: str = ""                              # CA privada (opcional)
    timeout_s: float = 6.0
    backoff_base_s: float = 2.0
    backoff_cap_s: float = 60.0
    log_level: str = "INFO"

    def endpoint(self):
        """(esquema, host, porta, caminho) do endpoint de heartbeat."""
        u = urlsplit(self.hub_url)
        port = u.port or (443 if u.scheme == "https" else 80)
        return u.scheme, u.hostname, port, (u.path.rstrip("/") + "/api/v1/heartbeat")


def _num(env: Mapping[str, str], name: str, default: float, lo: float, hi: float) -> float:
    raw = env.get(name)
    if raw in (None, ""):
        return default
    try:
        v = float(raw)
    except ValueError as e:
        raise ConfigError(f"{name} precisa ser numérico") from e
    if not lo <= v <= hi:
        raise ConfigError(f"{name} fora do intervalo {lo}..{hi}")
    return v


def default_services(env: Mapping[str, str]) -> list:
    """Serviços críticos vigiados. Ex.: CC_SERVICES='[{"name":"API","kind":"port","target":5000},
    {"name":"Docker","kind":"proc","target":["dockerd","docker.exe"]}]'  (critical:false => só 'degrada' em vez de crítico)."""
    raw = env.get("CC_SERVICES", "")
    if not raw:
        return []
    try:
        items = json.loads(raw)
    except ValueError as e:
        raise ConfigError("CC_SERVICES não é JSON válido") from e
    out = []
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict) or it.get("kind") not in ("port", "proc") or not str(it.get("name", "")).strip():
            raise ConfigError("CC_SERVICES: cada item precisa de name e kind ('port' ou 'proc')")
        tgt = it.get("target")
        if it["kind"] == "port":
            if isinstance(tgt, bool) or not isinstance(tgt, int) or not 1 <= tgt <= 65535:
                raise ConfigError(f"CC_SERVICES: porta inválida em '{it['name']}'")
        else:
            tgt = [str(x).lower() for x in (tgt if isinstance(tgt, list) else [tgt]) if x]
            if not tgt:
                raise ConfigError(f"CC_SERVICES: processo vazio em '{it['name']}'")
        out.append({"name": str(it["name"])[:40], "kind": it["kind"], "target": tgt,
                    "critical": bool(it.get("critical", True))})
    return out


def load_config(env: Mapping[str, str] = os.environ) -> AgentConfig:
    url = (env.get("CC_HUB_URL") or "").strip().rstrip("/")
    u = urlsplit(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ConfigError("CC_HUB_URL ausente ou inválida (ex.: https://hub.seudominio.com)")
    if u.scheme == "http" and u.hostname not in LOOPBACK and env.get("CC_HUB_ALLOW_INSECURE") != "1":
        raise ConfigError("CC_HUB_URL em HTTP puro é recusada (Zero-Trust exige TLS). Use https://")
    aid = (env.get("CC_AGENT_ID") or "").strip().lower()
    if not ID_RE.match(aid):
        raise ConfigError("CC_AGENT_ID ausente ou inválido (a-z, 0-9, _ e -; 3 a 40 caracteres)")
    try:
        key = unb64u((env.get("CC_AGENT_KEY") or "").strip())
    except Exception as e:
        raise ConfigError("CC_AGENT_KEY inválida (gere com: python -m cc_hub enroll <id>)") from e
    if len(key) != 32:
        raise ConfigError("CC_AGENT_KEY inválida (esperado 32 bytes em base64url)")
    pin = (env.get("CC_HUB_PIN_SHA256") or "").replace(":", "").strip().lower()
    if pin and not re.fullmatch(r"[0-9a-f]{64}", pin):
        raise ConfigError("CC_HUB_PIN_SHA256 deve ser o SHA-256 (64 hex) do certificado")
    return AgentConfig(
        hub_url=url, agent_id=aid, key=key,
        interval_s=_num(env, "CC_HB_INTERVAL", 15, 5, 300),
        buffer_max=int(_num(env, "CC_HB_BUFFER_MAX", 240, 10, 5000)),
        batch_max=int(_num(env, "CC_HB_BATCH_MAX", 50, 1, 50)),
        services=default_services(env),
        pin_sha256=pin, ca_file=(env.get("CC_HUB_CA_FILE") or "").strip(),
        log_level=(env.get("CC_LOG_LEVEL") or "INFO").upper(),
    )
