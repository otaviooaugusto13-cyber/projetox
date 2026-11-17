"""
Validação ESTRITA do payload do agente. Regra de ouro Zero-Trust: o corpo é entrada não confiável
mesmo depois de a assinatura ser válida (um agente comprometido assina lixo com a chave verdadeira).

- Tipos e faixas verificados campo a campo; bool NÃO vale como número; NaN/Infinity rejeitados.
- Strings com tamanho e alfabeto limitados (o painel as exibe: nada de HTML/controle).
- Chaves desconhecidas são DESCARTADAS (lista branca), nunca repassadas ao painel.
"""
from __future__ import annotations

import math
import re
from typing import Any, Optional, Tuple

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,39}$")
VER_RE = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,3}$")
TXT_RE = re.compile(r"^[\w .:/()\[\]+\-@#]{0,60}$", re.UNICODE)      # sem <, >, aspas, crases, controle
BOOT_RE = re.compile(r"^[0-9a-f]{8,40}$")
FLAG_RE = re.compile(r"^[a-z0-9_]{1,32}$")
IPV4_RE = re.compile(r"^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$")
MAC_RE = re.compile(r"^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$")
CIDR_RE = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}/\d{1,2}$")
NET_METHODS = frozenset({"icmp", "tcp", "arp", "local"})
MAX_NET_DEVICES = 128


class SchemaError(ValueError):
    pass


def _num(v: Any, name: str, lo: float, hi: float, optional: bool = False) -> Optional[float]:
    if v is None and optional:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise SchemaError(f"{name}: esperado número")
    if not math.isfinite(v) or not lo <= v <= hi:
        raise SchemaError(f"{name}: fora da faixa {lo}..{hi}")
    return float(v)


def _txt(v: Any, name: str, rx: re.Pattern = TXT_RE, optional: bool = False) -> Optional[str]:
    if v is None and optional:
        return None
    if not isinstance(v, str) or not rx.match(v):
        raise SchemaError(f"{name}: texto inválido")
    return v


def _sample(s: Any, now: float, skew: int) -> dict:
    if not isinstance(s, dict):
        raise SchemaError("amostra inválida")
    seq = s.get("seq")
    if isinstance(seq, bool) or not isinstance(seq, int) or not 0 <= seq <= 2**40:
        raise SchemaError("seq inválido")
    ts = _num(s.get("ts"), "ts", 1.6e9, 4.0e9)
    if ts > now + skew:
        raise SchemaError("ts no futuro")
    m = s.get("metrics")
    if not isinstance(m, dict):
        raise SchemaError("metrics ausente")
    metrics = {
        "cpu": _num(m.get("cpu"), "cpu", 0, 100),
        "ram": _num(m.get("ram"), "ram", 0, 100),
        "disk": _num(m.get("disk"), "disk", 0, 100),
        "rtt_ms": _num(m.get("rtt_ms"), "rtt_ms", 0, 60_000, optional=True),
        "uptime_s": _num(m.get("uptime_s"), "uptime_s", 0, 1e9, optional=True),
        "load1": _num(m.get("load1"), "load1", 0, 10_000, optional=True),
        "ram_total_gb": _num(m.get("ram_total_gb"), "ram_total_gb", 0, 100_000, optional=True),
        "disk_total_gb": _num(m.get("disk_total_gb"), "disk_total_gb", 0, 10_000_000, optional=True),
        "disk_free_gb": _num(m.get("disk_free_gb"), "disk_free_gb", 0, 10_000_000, optional=True),
        "agent_rss_mb": _num(m.get("agent_rss_mb"), "agent_rss_mb", 0, 100_000, optional=True),
    }
    svcs = s.get("services", [])
    if not isinstance(svcs, list) or len(svcs) > 20:
        raise SchemaError("services inválido")
    services = []
    for it in svcs:
        if not isinstance(it, dict) or not isinstance(it.get("ok"), bool):
            raise SchemaError("serviço inválido")
        crit = it.get("critical", True)
        if not isinstance(crit, bool):
            raise SchemaError("service.critical inválido")
        services.append({"name": _txt(it.get("name"), "service.name"), "ok": it["ok"], "critical": crit})
    flags = s.get("flags", [])
    if not isinstance(flags, list) or len(flags) > 8:
        raise SchemaError("flags inválido")
    flags = [_txt(f, "flag", FLAG_RE) for f in flags]
    return {"boot_id": _txt(s.get("boot_id"), "boot_id", BOOT_RE), "seq": seq, "ts": ts,
            "metrics": metrics, "services": services, "flags": flags}


def _network(n: Any, now: float, skew: int) -> dict:
    """Lista real de dispositivos da LAN. Lista branca: só ip, mac, name, status, latency_ms, method, last_seen."""
    if not isinstance(n, dict):
        raise SchemaError("network inválido")
    scanned = _num(n.get("scanned_at"), "scanned_at", 1.6e9, 4.0e9)
    if scanned > now + skew:
        raise SchemaError("scanned_at no futuro")
    subnet = n.get("subnet")
    if subnet is not None and not (isinstance(subnet, str) and CIDR_RE.match(subnet)):
        raise SchemaError("subnet inválida")
    devs_in = n.get("devices")
    if not isinstance(devs_in, list) or len(devs_in) > MAX_NET_DEVICES:
        raise SchemaError(f"devices: até {MAX_NET_DEVICES} itens")
    devs, seen = [], set()
    for d in devs_in:
        if not isinstance(d, dict):
            raise SchemaError("device inválido")
        ip, mac = d.get("ip"), d.get("mac")
        if not (isinstance(ip, str) and IPV4_RE.match(ip)) or not (isinstance(mac, str) and MAC_RE.match(mac)):
            raise SchemaError("device ip/mac inválido")
        if mac in seen:
            raise SchemaError("device duplicado")
        seen.add(mac)
        status = d.get("status")
        if status not in ("online", "offline"):
            raise SchemaError("device status inválido")
        method = d.get("method")
        if method is not None and method not in NET_METHODS:
            raise SchemaError("device method inválido")
        devs.append({"ip": ip, "mac": mac, "name": _txt(d.get("name", "?"), "device.name"), "status": status,
                     "latency_ms": _num(d.get("latency_ms"), "latency_ms", 0, 60_000, optional=True),
                     "method": method,
                     "last_seen": _num(d.get("last_seen"), "last_seen", 0, 4.0e9, optional=True)})
    return {"scanned_at": scanned, "subnet": subnet, "devices": devs}


def validate_envelope(obj: Any, now: float, max_samples: int, skew: int) -> Tuple[dict, list]:
    """Devolve (cabeçalho_limpo, amostras_limpas) ou levanta SchemaError."""
    if not isinstance(obj, dict) or obj.get("v") != 1:
        raise SchemaError("versão de protocolo não suportada")
    agent_id = _txt(obj.get("agent_id"), "agent_id", ID_RE)
    ver = _txt(obj.get("agent_version"), "agent_version", VER_RE)
    interval = _num(obj.get("interval_s"), "interval_s", 5, 300)
    host_in = obj.get("host") if isinstance(obj.get("host"), dict) else {}
    host = {"hostname": _txt(host_in.get("hostname", "?"), "hostname"),
            "os": _txt(host_in.get("os", "?"), "os"),
            "python": _txt(host_in.get("python", "?"), "python")}
    samples_in = obj.get("samples")
    if not isinstance(samples_in, list) or not 1 <= len(samples_in) <= max_samples:
        raise SchemaError(f"samples: 1..{max_samples} itens")
    samples = [_sample(s, now, skew) for s in samples_in]
    network = None
    if obj.get("network") is not None:
        try:
            network = _network(obj["network"], now, skew)
        except SchemaError:
            network = None      # campo auxiliar: se vier malformado, descarta SÓ ele; as métricas continuam valendo
    return ({"agent_id": agent_id, "version": ver, "interval_s": interval, "host": host, "network": network}, samples)
