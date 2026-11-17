"""Estado da frota: ingestão idempotente de amostras, classificação de saúde e log de segurança."""
from __future__ import annotations

import collections
import threading
import time
from typing import Callable, Optional

from .config import Settings

HISTORY = 60          # pontos de histórico por agente (sparkline)
KEEP_BOOTS = 5        # quantos boot_ids recentes lembramos para deduplicar por seq
SEC_RETENTION_S = 600


class SecurityLog:
    """Eventos de segurança com agrupamento: a mesma falha repetida vira 1 linha com contador (anti-inundação)."""

    def __init__(self, publish: Callable[[str, dict], None], maxlen: int = 200, dedupe_s: int = 60):
        self._events: "collections.deque[dict]" = collections.deque(maxlen=maxlen)
        self._publish, self._dedupe_s = publish, dedupe_s
        self._next = 1
        self._lock = threading.Lock()

    def add(self, level: str, kind: str, msg: str, agent: Optional[str] = None, ip: Optional[str] = None,
            now: Optional[float] = None) -> dict:
        now = now or time.time()
        with self._lock:
            hit = None
            for ev in reversed(self._events):
                if now - ev["ts"] > self._dedupe_s:
                    break
                if ev["kind"] == kind and ev["agent"] == agent and ev["ip"] == ip:
                    hit = ev
                    break
            if hit is not None:
                hit["count"] += 1
                hit["ts"] = now
                out = dict(hit)
            else:
                out = {"id": self._next, "ts": now, "level": level, "kind": kind, "agent": agent, "ip": ip,
                       "msg": msg, "count": 1}
                self._next += 1
                self._events.append(dict(out))
        self._publish("security", out)
        return out

    def recent(self, limit: int = 60) -> list:
        with self._lock:
            return [dict(e) for e in list(self._events)[-limit:]]

    def for_agent(self, agent: str, now: float) -> list:
        with self._lock:
            return [dict(e) for e in self._events if e["agent"] == agent and now - e["ts"] <= SEC_RETENTION_S]


class Agent:
    def __init__(self, ident: str, name: str):
        self.id, self.name = ident, name
        self.version = None
        self.host: dict = {}
        self.interval_s = 15.0
        self.first_rx: Optional[float] = None
        self.last_rx: Optional[float] = None
        self.last_ip: Optional[str] = None
        self.sample: Optional[dict] = None             # amostra com maior ts já recebida
        self.rx_batches = 0
        self.rx_samples = 0
        self.backlog_flushes = 0
        self.last_backlog_ts: Optional[float] = None
        self.boots: "collections.OrderedDict[str, int]" = collections.OrderedDict()
        self.history: "collections.deque[list]" = collections.deque(maxlen=HISTORY)
        self.requests: "collections.deque[float]" = collections.deque(maxlen=200)   # rate limit por agente
        self.skew_s = 0.0                                # (relógio do agente - relógio do hub) no último envio
        self.network: Optional[dict] = None              # último snapshot da LAN (maior scanned_at)


class FleetStore:
    def __init__(self, cfg: Settings, security: SecurityLog, now_fn: Callable[[], float] = time.time):
        self.cfg, self.sec, self._now = cfg, security, now_fn
        self.started = now_fn()
        self._lock = threading.RLock()
        self.agents = {i: Agent(i, a["name"]) for i, a in cfg.agents.items()}

    # ---------- limite de taxa por agente autenticado ----------
    def allow_request(self, agent_id: str, now: float) -> bool:
        with self._lock:
            ag = self.agents[agent_id]
            while ag.requests and now - ag.requests[0] > 60:
                ag.requests.popleft()
            if len(ag.requests) >= self.cfg.agent_rate_per_min:
                return False
            ag.requests.append(now)
            return True

    # ---------- ingestão ----------
    def ingest(self, head: dict, samples: list, ip: Optional[str], now: float, skew_s: float = 0.0) -> dict:
        """Aplica as amostras de forma idempotente: reenvio do mesmo lote (ack perdido) não duplica nada."""
        with self._lock:
            ag = self.agents[head["agent_id"]]
            if ag.version and ag.version != head["version"]:
                self.sec.add("warn", "version_change", f"{ag.name}: versão do agente mudou {ag.version} → {head['version']}",
                             ag.id, None, now)
            if ag.last_ip and ip and ag.last_ip != ip:
                self.sec.add("warn", "ip_change", f"{ag.name}: origem do heartbeat mudou ({ag.last_ip} → {ip})", ag.id, ip, now)
            ag.version, ag.host, ag.interval_s = head["version"], head["host"], head["interval_s"]
            ag.last_ip, ag.skew_s = ip, skew_s
            accepted = dup = 0
            for s in sorted(samples, key=lambda x: (x["ts"], x["seq"])):
                last = ag.boots.get(s["boot_id"])
                if last is not None and s["seq"] <= last:
                    dup += 1
                    continue
                ag.boots[s["boot_id"]] = s["seq"]
                ag.boots.move_to_end(s["boot_id"])
                while len(ag.boots) > KEEP_BOOTS:
                    ag.boots.popitem(last=False)
                accepted += 1
                if ag.sample is None or s["ts"] >= ag.sample["ts"]:
                    ag.sample = s
                m = s["metrics"]
                ag.history.append([round(s["ts"], 1), round(m["cpu"], 1), round(m["ram"], 1)])
            net = head.get("network")
            if net and (ag.network is None or net["scanned_at"] >= ag.network["scanned_at"]):
                ag.network = net                          # backlog antigo reenviado não sobrescreve o mais novo
            ag.history = collections.deque(sorted(ag.history), maxlen=HISTORY)
            if len(samples) > 1 and accepted:
                ag.backlog_flushes += 1
                ag.last_backlog_ts = now
            if ag.first_rx is None:
                ag.first_rx = now
            ag.last_rx = now
            ag.rx_batches += 1
            ag.rx_samples += accepted
            return {"accepted": accepted, "duplicates": dup,
                    "ack_seq": max((s["seq"] for s in samples), default=0)}

    # ---------- classificação ----------
    def classify(self, ag: Agent, now: float):
        c = self.cfg
        reasons = []
        if ag.last_rx is None:
            if now - self.started > c.ghost_after_s:
                return "ghost", [{"code": "never_seen", "sev": "crit", "msg": "Agente cadastrado nunca enviou heartbeat"}]
            return "pending", [{"code": "pending", "sev": "info", "msg": "Aguardando o primeiro heartbeat"}]
        age = now - ag.last_rx
        if age > c.ghost_after_s:
            return "ghost", [{"code": "ghost", "sev": "crit", "msg": f"Sem heartbeat há {int(age // 60)} min (nó fantasma)"}]
        if age > ag.interval_s * c.offline_factor:
            return "offline", [{"code": "offline", "sev": "crit", "msg": f"Sem heartbeat há {int(age)} s"}]
        if age > ag.interval_s * c.degraded_factor:
            reasons.append({"code": "late", "sev": "warn", "msg": f"Heartbeat atrasado ({int(age)} s)"})
        s = ag.sample
        if s:
            m = s["metrics"]
            for key, lim, label in (("cpu", c.cpu_warn, "CPU"), ("ram", c.ram_warn, "RAM"), ("disk", c.disk_warn, "Disco")):
                if m[key] >= lim:
                    reasons.append({"code": key + "_high", "sev": "warn", "msg": f"{label} em {m[key]:.0f}%"})
            if m["rtt_ms"] is not None and m["rtt_ms"] >= c.rtt_warn_ms:
                reasons.append({"code": "rtt_high", "sev": "warn", "msg": f"Latência até o hub {m['rtt_ms']:.0f} ms"})
            for sv in s["services"]:
                if not sv["ok"]:
                    reasons.append({"code": "svc_down", "sev": "crit" if sv["critical"] else "warn",
                                    "msg": f"Serviço fora do ar: {sv['name']}"})
        if abs(ag.skew_s) > 15:
            reasons.append({"code": "clock_skew", "sev": "warn", "msg": f"Relógio do agente {ag.skew_s:+.0f} s fora de sincronia"})
        if ag.version and tuple(int(x) for x in ag.version.split(".")) < c.min_agent_version:
            reasons.append({"code": "outdated", "sev": "warn", "msg": f"Agente desatualizado ({ag.version})"})
        if any(e["level"] in ("warn", "crit") for e in self.sec.for_agent(ag.id, now)):
            reasons.append({"code": "sec_alert", "sev": "warn", "msg": "Alertas de segurança recentes"})
        if ag.last_backlog_ts and now - ag.last_backlog_ts < 120:
            reasons.append({"code": "backlog", "sev": "info", "msg": "Reconectou e enviou dados do buffer offline"})
        degraded = any(r["sev"] in ("warn", "crit") for r in reasons)
        return ("degraded" if degraded else "online"), reasons

    def summary(self, ag: Agent, now: float) -> dict:
        status, reasons = self.classify(ag, now)
        s = ag.sample
        return {
            "id": ag.id, "name": ag.name, "status": status, "reasons": reasons,
            "age_s": None if ag.last_rx is None else round(now - ag.last_rx, 1),
            "version": ag.version, "host": ag.host, "interval_s": ag.interval_s,
            "metrics": s["metrics"] if s else None, "services": s["services"] if s else [],
            "history": list(ag.history), "rx_samples": ag.rx_samples,
            "backlog_flushes": ag.backlog_flushes,
            "net": None if not ag.network else {
                "online": sum(1 for d in ag.network["devices"] if d["status"] == "online"),
                "total": len(ag.network["devices"]), "scanned_at": ag.network["scanned_at"]},
            "alerts": self.sec.for_agent(ag.id, now),
        }

    def snapshot(self, now: Optional[float] = None) -> dict:
        now = now or self._now()
        with self._lock:
            agents = [self.summary(a, now) for a in self.agents.values()]
        return {"server_ts": now, "agents": agents, "events": self.sec.recent()}

    def network_snapshot(self) -> dict:
        """Lista de dispositivos por agente (só leitura; separada do SSE para não inflar cada evento)."""
        with self._lock:
            return {"agents": [{"id": a.id, "name": a.name, "network": a.network} for a in self.agents.values()]}

    def signature(self, now: float) -> dict:
        """Impressão digital leve do estado visível (status + motivos) para só publicar quando mudar."""
        with self._lock:
            out = {}
            for a in self.agents.values():
                status, reasons = self.classify(a, now)
                out[a.id] = (status, tuple(r["code"] for r in reasons))
            return out
