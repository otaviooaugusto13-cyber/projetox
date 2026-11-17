"""
Command Center · varredura REAL da rede local.

Nenhum dado é inventado: cada dispositivo vem da tabela de vizinhos do sistema operacional
(`ip neigh` / `arp -a`) e é confirmado por sondagem de verdade (ICMP -> TCP -> ARP).

Como funciona (um ciclo, a cada CC_NET_INTERVAL s, padrão 15):
  1. "Cutuca" a sub-rede com UDP na porta 9 (barato, não espera resposta). Só serve para o kernel
     resolver ARP dos hosts vivos: o firewall do alvo não impede o ARP de responder.
  2. Lê a tabela de vizinhos (com o estado do kernel no Linux: REACHABLE/STALE/FAILED...).
  3. Sonda só quem importa (vizinhos + dispositivos já conhecidos), em pool pequeno de threads:
       ping 1 pacote  -> latência em ms (float)
       senão TCP      -> latência = tempo do connect (aceito OU recusado prova que está vivo)
       senão ARP      -> vivo, mas SEM latência (None; nunca um número inventado)
  4. Histerese: só vira "offline" após MISS_LIMIT ciclos seguidos sem sinal. Celular com a tela
     apagada deixa de responder ping por segundos; sem isso o painel ficaria piscando.
  5. Nome por DNS reverso roda em threads separadas, uma vez por dispositivo (com nova tentativa
     espaçada): um DNS lento NUNCA trava o ciclo.

Só biblioteca padrão + psutil (que o agente já usa).
"""
from __future__ import annotations

import ipaddress
import json
import os
import platform
import re
import socket
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Dict, List, Optional, Tuple

import psutil

IS_WIN = platform.system() == "Windows"
MISS_LIMIT = 3                         # ciclos sem sinal até declarar offline (3 x 15 s = 45 s)
MAX_HOSTS = 1022                       # nunca varre mais que um /22
MAX_DEVICES = 256
TCP_PORTS = (80, 443, 22, 445, 8009, 62078, 8080)
TCP_TIMEOUT = 0.3
PING_TIMEOUT_S = 1
NAME_RETRY_S = 600
IP_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")
NEIGH_RE = re.compile(r"(\d{1,3}(?:\.\d{1,3}){3}).*?([0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5})")
LAT_RE = re.compile(r"(?:time|tempo)\s*[=<]\s*([\d.,]+)", re.I)
SAFE_NAME = re.compile(r"[^\w .:/()\[\]+\-@#]", re.UNICODE)    # mesmo alfabeto que o hub aceita
BAD_STATES = {"FAILED", "INCOMPLETE"}


def _ip_key(ip: str) -> Tuple[int, ...]:
    return tuple(int(x) for x in ip.split("."))


def _clean_name(s: Optional[str]) -> Optional[str]:
    s = SAFE_NAME.sub("", str(s or "")).strip()[:60]
    return s or None


# ----------------------------------------------------------------------------------------------
# Sistema operacional
# ----------------------------------------------------------------------------------------------
def local_ip() -> Optional[str]:
    """IP de saída da máquina (UDP connect não envia nada)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def local_network() -> Tuple[Optional[str], Optional[ipaddress.IPv4Network], Optional[str]]:
    """(ip, sub-rede, mac) da interface de saída. Máscara real via psutil; limita a /22."""
    ip = local_ip()
    if not ip:
        return None, None, None
    mask, mac = "255.255.255.0", None
    try:
        for addrs in psutil.net_if_addrs().values():
            if any(a.family == socket.AF_INET and a.address == ip for a in addrs):
                for a in addrs:
                    if a.family == socket.AF_INET and a.address == ip and a.netmask:
                        mask = a.netmask
                    elif a.family == psutil.AF_LINK and a.address:
                        mac = a.address.upper().replace("-", ":")
                break
    except Exception:
        pass
    override = os.environ.get("CC_NET_CIDR", "").strip()
    try:
        net = ipaddress.ip_network(override or f"{ip}/{mask}", strict=False)
    except ValueError:
        net = ipaddress.ip_network(f"{ip}/24", strict=False)
    if net.version != 4 or net.prefixlen < 22:
        net = ipaddress.ip_network(f"{ip}/24", strict=False)
    return ip, net, mac


def read_neighbors() -> List[Tuple[str, str, Optional[str]]]:
    """[(ip, mac, estado|None)] da tabela do SO. Sem broadcast/multicast e sem entradas mortas."""
    cmds = [["arp", "-a"]] if IS_WIN else [["ip", "neigh"], ["arp", "-an"]]
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if IS_WIN else 0
    for cmd in cmds:
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=5, creationflags=flags).stdout
        except Exception:
            continue
        rows: Dict[str, Tuple[str, str, Optional[str]]] = {}
        for line in out.splitlines():
            m = NEIGH_RE.search(line)
            if not m:
                continue
            ip, mac = m.group(1), m.group(2).upper().replace("-", ":")
            state = line.split()[-1].upper() if cmd[0] == "ip" and line.split() else None
            if (state in BAD_STATES or mac == "FF:FF:FF:FF:FF:FF" or mac.startswith("01:00:5E")
                    or ip.startswith(("224.", "239.", "255.", "127.")) or ip.endswith(".255")
                    or (IS_WIN and "static" in line.lower())):
                continue
            rows[ip] = (ip, mac, state)
        if rows:
            return list(rows.values())
    return []


def read_arp_pairs() -> List[Tuple[str, str]]:
    """Compatível com o que o agent.py/smarthome.py já esperam: [(ip, mac)]."""
    return [(ip, mac) for ip, mac, _s in read_neighbors()]


def ping_ms(ip: str) -> Optional[float]:
    cmd = (["ping", "-n", "1", "-w", str(PING_TIMEOUT_S * 1000), ip] if IS_WIN
           else ["ping", "-c", "1", "-W", str(PING_TIMEOUT_S), ip])
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if IS_WIN else 0
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=PING_TIMEOUT_S + 2,
                             creationflags=flags).stdout
    except Exception:
        return None
    m = LAT_RE.search(out)           # cobre "time=1.23 ms", "tempo=2ms" e "tempo<1ms" (-> 1.0)
    return round(float(m.group(1).replace(",", ".")), 1) if m else None


def tcp_ms(ip: str, ports=TCP_PORTS, timeout: float = TCP_TIMEOUT) -> Optional[float]:
    """Conexão aceita OU recusada prova que o host está vivo, mesmo com ICMP bloqueado."""
    for p in ports:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        t0 = time.perf_counter()
        try:
            s.connect((ip, p))
            return round((time.perf_counter() - t0) * 1000, 1)
        except ConnectionRefusedError:
            return round((time.perf_counter() - t0) * 1000, 1)
        except OSError as e:
            if getattr(e, "winerror", None) == 10061:        # WSAECONNREFUSED
                return round((time.perf_counter() - t0) * 1000, 1)
        finally:
            s.close()
    return None


def probe(ip: str) -> Tuple[Optional[float], Optional[str]]:
    ms = ping_ms(ip)
    if ms is not None:
        return ms, "icmp"
    ms = tcp_ms(ip)
    if ms is not None:
        return ms, "tcp"
    return None, None


# ----------------------------------------------------------------------------------------------
# Scanner
# ----------------------------------------------------------------------------------------------
class NetScanner:
    def __init__(self, gateway: str = "", aliases_file: str = "", interval_s: float = 15.0,
                 on_arp: Optional[Callable[[list], None]] = None):
        self.gateway = gateway
        self.aliases_file = aliases_file
        self.interval_s = max(5.0, interval_s)
        self.on_arp = on_arp
        self._devs: Dict[str, dict] = {}            # mac -> estado interno
        self._snap: Optional[dict] = None           # publicado inteiro a cada ciclo (nunca mutado)
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._listeners: List[Callable[[], None]] = []
        self._names = ThreadPoolExecutor(2, thread_name_prefix="cc-dns")
        self._alias_cache: Tuple[float, dict] = (-1.0, {})
        self.forget_s = float(os.environ.get("CC_NET_FORGET_H", "72")) * 3600

    # ---- API pública
    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="cc-netscan", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def subscribe(self, fn: Callable[[], None]) -> None:
        self._listeners.append(fn)

    def snapshot(self) -> Optional[dict]:
        """{'scanned_at', 'subnet', 'devices': [...]} ou None até a 1ª varredura terminar."""
        return self._snap

    # ---- internals
    def _aliases(self) -> dict:
        if not self.aliases_file:
            return {}
        try:
            mt = os.path.getmtime(self.aliases_file)
            if mt != self._alias_cache[0]:
                with open(self.aliases_file, encoding="utf-8") as f:
                    self._alias_cache = (mt, {k.upper(): v for k, v in json.load(f).items()})
        except (OSError, ValueError, AttributeError):
            self._alias_cache = (-1.0, {})
        return self._alias_cache[1]

    def _resolve_name(self, mac: str, ip: str) -> None:
        try:
            host = socket.gethostbyaddr(ip)[0].split(".")[0]
        except Exception:
            host = None
        with self._lock:
            d = self._devs.get(mac)
            if d is not None:
                d["host"] = _clean_name(host)

    def _loop(self) -> None:
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                self._cycle()
            except Exception as e:                    # o scanner nunca derruba o agente
                print(f"[aviso] varredura de rede: {e.__class__.__name__}: {e}")
            self._stop.wait(max(1.0, self.interval_s - (time.monotonic() - t0)))

    def _poke(self, me: str, net: ipaddress.IPv4Network) -> None:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            for i, h in enumerate(net.hosts()):
                if i >= MAX_HOSTS:
                    break
                if str(h) != me:
                    try:
                        s.sendto(b"\0", (str(h), 9))
                    except OSError:
                        pass
        finally:
            s.close()

    def _cycle(self) -> None:
        me, net, my_mac = local_network()
        if me and net:
            self._poke(me, net)
            self._stop.wait(1.2)                      # tempo para o kernel resolver ARP
        neigh = read_neighbors()
        if self.on_arp:
            try:
                self.on_arp([(ip, mac) for ip, mac, _s in neigh])
            except Exception:
                pass
        neigh_by_mac = {mac: (ip, st) for ip, mac, st in neigh}
        ip_owner = {ip: mac for ip, mac, _s in neigh}

        with self._lock:                              # alvos: vizinhos atuais + já conhecidos cujo IP ninguém tomou
            entries = {mac: ip for mac, (ip, _s) in neigh_by_mac.items()}
            for mac, d in self._devs.items():
                if mac not in entries and ip_owner.get(d["ip"], mac) == mac and d.get("method") != "local":
                    entries[mac] = d["ip"]
        entries.pop(my_mac or "", None)
        order = sorted(set(entries.values()) - {me or ""}, key=_ip_key)[:MAX_DEVICES]
        with ThreadPoolExecutor(min(12, max(1, len(order)))) as ex:
            results = dict(zip(order, ex.map(probe, order)))

        now = time.time()
        aliases = self._aliases()
        with self._lock:
            if me and my_mac:
                d = self._devs.setdefault(my_mac, {"mac": my_mac, "first": now, "misses": 0, "name_try": 0.0,
                                                   "host": _clean_name(socket.gethostname())})
                d.update(ip=me, online=True, last_seen=now, latency_ms=None, method="local", role="Este PC")
            for mac, ip in entries.items():
                if ip not in results:                 # cortado pelo limite MAX_DEVICES
                    continue
                d = self._devs.setdefault(mac, {"mac": mac, "ip": ip, "first": now, "misses": 0, "host": None,
                                                "name_try": 0.0, "online": False, "last_seen": 0.0, "role": None})
                d["ip"] = ip
                ms, how = results[ip]
                seen = neigh_by_mac.get(mac)
                if how:                               # ICMP ou TCP: prova direta
                    d.update(online=True, misses=0, last_seen=now, latency_ms=ms, method=how)
                elif seen and seen[1] in (None, "REACHABLE"):
                    d.update(online=True, misses=0, last_seen=now, latency_ms=None, method="arp")
                else:
                    d["misses"] += 1
                    d["latency_ms"] = None
                    if d["misses"] >= MISS_LIMIT:
                        d["online"], d["method"] = False, None
                d["role"] = "Gateway" if ip == self.gateway else None
            for mac, d in self._devs.items():         # sem entrada neste ciclo (IP tomado por outro / sumiu do ARP)
                if mac not in entries and d.get("method") != "local" and mac != my_mac:
                    d["misses"] += 1
                    d["latency_ms"] = None
                    if d["misses"] >= MISS_LIMIT:
                        d["online"], d["method"] = False, None
            for mac in [m for m, d in self._devs.items() if now - d.get("last_seen", 0) > self.forget_s]:
                del self._devs[mac]
            todo = [(m, d["ip"]) for m, d in self._devs.items()
                    if d.get("online") and not d.get("host") and now - d["name_try"] > NAME_RETRY_S]
            for m, _ip in todo:
                self._devs[m]["name_try"] = now
            devs = []
            for mac, d in self._devs.items():
                devs.append({
                    "ip": d["ip"], "mac": mac, "name": _clean_name(aliases.get(mac)) or d.get("host") or "Dispositivo desconhecido",
                    "online": bool(d["online"]), "status": "online" if d["online"] else "offline",
                    "latency_ms": d.get("latency_ms"), "method": d.get("method"),
                    "role": d.get("role"), "last_seen": round(d.get("last_seen", 0.0), 1),
                })
            devs.sort(key=lambda x: (not x["online"], _ip_key(x["ip"])))
            self._snap = {"scanned_at": round(now, 1), "subnet": str(net) if net else None, "devices": devs}
        for m, ip in todo:
            self._names.submit(self._resolve_name, m, ip)
        for fn in list(self._listeners):
            try:
                fn()
            except Exception:
                pass


# ---------------------------------------------------------------------------------------------- singleton
_singleton: Optional[NetScanner] = None
_singleton_mu = threading.Lock()


def get_scanner(gateway: Optional[str] = None, aliases_file: Optional[str] = None,
                on_arp: Optional[Callable[[list], None]] = None) -> NetScanner:
    """Uma única instância por processo: o agent.py e a telemetria compartilham a mesma varredura."""
    global _singleton
    with _singleton_mu:
        if _singleton is None:
            here = os.path.dirname(os.path.abspath(__file__))
            _singleton = NetScanner(
                gateway=gateway if gateway is not None else os.environ.get("CC_GATEWAY", "192.168.0.1"),
                aliases_file=aliases_file if aliases_file is not None else os.path.join(here, "devices.json"),
                interval_s=float(os.environ.get("CC_NET_INTERVAL", "15") or 15),
                on_arp=on_arp)
        return _singleton
