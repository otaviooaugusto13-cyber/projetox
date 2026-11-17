"""
Coleta de métricas vitais — desenhada para custo quase zero:
  * psutil.cpu_percent(interval=None) NÃO bloqueia: devolve a média desde a última chamada
    (com heartbeat a cada 15 s = média real de 15 s, sem nenhum sleep de amostragem).
  * Checagem de processos (varre a lista inteira do SO) é a parte cara: roda numa thread, no máximo a cada 30 s.
  * Checagem de portas usa asyncio.open_connection com timeout de 0,5 s (não bloqueia o loop).
  * Sem estruturas que crescem: cada amostra tem poucas centenas de bytes.
"""
from __future__ import annotations

import asyncio
import os
import platform
import time
import uuid
from typing import List, Optional

import psutil

from .config import AGENT_VERSION, AgentConfig

PROC_TTL_S = 30
MAX_NET_DEVICES = 120          # ~17 KB no pior caso; o hub aceita corpo de até 64 KB


class Collector:
    def __init__(self, cfg: AgentConfig):
        self.cfg = cfg
        self.boot_id = uuid.uuid4().hex                  # identifica ESTA execução do agente (dedupe por seq no hub)
        self.seq = 0
        self._proc_cache = {"t": 0.0, "names": set()}
        self._self = psutil.Process()
        psutil.cpu_percent(interval=None)                 # "prime": a 1ª leitura sempre devolve 0.0
        self._boot_ts = psutil.boot_time()

    # ---------------- identidade estática (vai no envelope, não em cada amostra) ----------------
    @staticmethod
    def host_info() -> dict:
        safe = lambda s: "".join(ch for ch in str(s) if ch.isalnum() or ch in " .-_")[:60] or "?"
        return {"hostname": safe(platform.node()), "os": safe(f"{platform.system()} {platform.release()}"),
                "python": safe(platform.python_version())}

    # ---------------- serviços ----------------
    @staticmethod
    async def _port_open(port: int) -> bool:
        try:
            _r, w = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), timeout=0.5)
            w.close()
            return True
        except (OSError, asyncio.TimeoutError):
            return False

    def _scan_procs(self) -> set:
        names = set()
        for p in psutil.process_iter(["name"]):          # cada acesso pode falhar (processo morreu / sem permissão)
            try:
                n = p.info.get("name")
                if n:
                    names.add(n.lower())
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        return names

    async def _procs(self) -> set:
        if time.monotonic() - self._proc_cache["t"] > PROC_TTL_S:
            try:
                self._proc_cache["names"] = await asyncio.to_thread(self._scan_procs)
                self._proc_cache["t"] = time.monotonic()
            except Exception:                              # nunca derruba a coleta por causa de um serviço
                pass
        return self._proc_cache["names"]

    async def services(self) -> List[dict]:
        out = []
        for s in self.cfg.services:
            ok = False
            try:
                if s["kind"] == "port":
                    ok = await self._port_open(s["target"])
                else:
                    names = await self._procs()
                    ok = any(t in names for t in s["target"])
            except Exception:
                ok = False
            out.append({"name": s["name"], "ok": ok, "critical": s.get("critical", True)})
        return out

    # ---------------- rede local (estado atual, NÃO série temporal) ----------------
    @staticmethod
    def network() -> Optional[dict]:
        """Dispositivos REAIS da LAN vistos pelo netscan (ARP + ping/TCP). None = sem dados ainda ou desativado
        (CC_NET_SCAN=off). Vai no envelope, não em cada amostra: o buffer offline continua pequeno."""
        if os.environ.get("CC_NET_SCAN", "on").lower() == "off":
            return None
        try:
            from netscan import get_scanner          # agent/netscan.py (mesma instância do agent.py quando embutido)
        except ImportError:
            return None
        sc = get_scanner()
        sc.start()                                    # idempotente; no modo standalone é quem inicia a varredura
        snap = sc.snapshot()
        if not snap:
            return None
        devs = [{"ip": d["ip"], "mac": d["mac"], "name": d["name"], "status": d["status"],
                 "latency_ms": d["latency_ms"], "method": d["method"], "last_seen": d["last_seen"]}
                for d in snap["devices"][:MAX_NET_DEVICES]]          # já vem online primeiro
        return {"scanned_at": snap["scanned_at"], "subnet": snap["subnet"], "devices": devs}

    # ---------------- amostra completa ----------------
    async def sample(self, rtt_ms: Optional[float]) -> dict:
        self.seq += 1
        m = {}
        try:
            m["cpu"] = round(psutil.cpu_percent(interval=None), 1)
        except Exception:
            m["cpu"] = 0.0
        try:
            vm = psutil.virtual_memory()
            m["ram"], m["ram_total_gb"] = round(vm.percent, 1), round(vm.total / 2**30, 1)
        except Exception:
            m["ram"], m["ram_total_gb"] = 0.0, None
        try:
            du = psutil.disk_usage(self.cfg.disk_path)
            m["disk"], m["disk_total_gb"], m["disk_free_gb"] = round(du.percent, 1), round(du.total / 2**30, 1), round(du.free / 2**30, 1)
        except Exception:
            m["disk"], m["disk_total_gb"], m["disk_free_gb"] = 0.0, None, None
        m["uptime_s"] = max(0, int(time.time() - self._boot_ts))
        try:
            m["load1"] = round(os.getloadavg()[0], 2)      # inexistente no Windows
        except (AttributeError, OSError):
            m["load1"] = None
        try:
            m["agent_rss_mb"] = round(self._self.memory_info().rss / 2**20, 1)   # auto-observabilidade do próprio agente
        except Exception:
            m["agent_rss_mb"] = None
        m["rtt_ms"] = None if rtt_ms is None else round(rtt_ms, 1)
        return {"boot_id": self.boot_id, "seq": self.seq, "ts": round(time.time(), 3), "metrics": m,
                "services": await self.services(), "flags": ["start"] if self.seq == 1 else []}


__all__ = ["Collector", "AGENT_VERSION"]
