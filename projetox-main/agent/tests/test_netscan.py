import ipaddress, os, sys, unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import netscan as ns


class ScanCycle(unittest.TestCase):
    def setUp(self):
        self.neigh = []
        self.probes = {}
        net = ipaddress.ip_network("192.168.0.0/24")
        self.patches = [
            mock.patch.object(ns, "local_network", return_value=("192.168.0.10", net, "AA:00:00:00:00:10")),
            mock.patch.object(ns, "read_neighbors", side_effect=lambda: list(self.neigh)),
            mock.patch.object(ns, "probe", side_effect=lambda ip: self.probes.get(ip, (None, None))),
            mock.patch.object(ns.NetScanner, "_poke", return_value=None),
            mock.patch.object(ns.NetScanner, "_resolve_name", return_value=None),
        ]
        for p in self.patches:
            p.start()
        self.sc = ns.NetScanner(gateway="192.168.0.1")
        self.sc._stop.wait = lambda *_a, **_k: False       # sem esperar 1,2 s nos testes

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def devs(self):
        return {d["mac"]: d for d in self.sc.snapshot()["devices"]}

    def test_online_com_latencia_real_e_papeis(self):
        self.neigh = [("192.168.0.1", "A4:00:00:00:00:01", "REACHABLE"), ("192.168.0.23", "3C:00:00:00:00:23", "STALE")]
        self.probes = {"192.168.0.1": (2.5, "icmp"), "192.168.0.23": (None, "tcp") and (8.1, "tcp")}
        self.sc._cycle()
        d = self.devs()
        self.assertEqual(d["A4:00:00:00:00:01"]["latency_ms"], 2.5)
        self.assertEqual(d["A4:00:00:00:00:01"]["role"], "Gateway")
        self.assertEqual(d["3C:00:00:00:00:23"]["method"], "tcp")
        self.assertEqual(d["AA:00:00:00:00:10"]["role"], "Este PC")
        self.assertEqual(self.sc.snapshot()["subnet"], "192.168.0.0/24")

    def test_histerese_so_fica_offline_apos_varios_ciclos(self):
        self.neigh = [("192.168.0.23", "3C:00:00:00:00:23", "STALE")]
        self.probes = {"192.168.0.23": (5.0, "icmp")}
        self.sc._cycle()
        self.probes = {}                                      # celular dormiu: sem ping/TCP, ARP só STALE
        for i in range(ns.MISS_LIMIT - 1):
            self.sc._cycle()
            self.assertTrue(self.devs()["3C:00:00:00:00:23"]["online"], f"ciclo {i}")
        self.sc._cycle()
        x = self.devs()["3C:00:00:00:00:23"]
        self.assertFalse(x["online"]); self.assertEqual(x["status"], "offline"); self.assertIsNone(x["latency_ms"])

    def test_ip_trocado_por_dhcp_nao_deixa_fantasma_online(self):
        self.neigh = [("192.168.0.50", "11:00:00:00:00:11", "REACHABLE")]
        self.probes = {"192.168.0.50": (3.0, "icmp")}
        self.sc._cycle()
        self.neigh = [("192.168.0.50", "22:00:00:00:00:22", "REACHABLE")]   # outro aparelho pegou o IP
        self.probes = {"192.168.0.50": (4.0, "icmp")}
        for _ in range(ns.MISS_LIMIT + 1):
            self.sc._cycle()
        d = self.devs()
        self.assertTrue(d["22:00:00:00:00:22"]["online"])
        self.assertFalse(d["11:00:00:00:00:11"]["online"])

    def test_nome_do_alias_e_sanitizado(self):
        self.neigh = [("192.168.0.9", "33:00:00:00:00:33", "REACHABLE")]
        self.sc._aliases = lambda: {"33:00:00:00:00:33": "<b>Sala</b>\"x\""}
        self.probes = {"192.168.0.9": (1.0, "icmp")}
        self.sc._cycle()
        self.assertEqual(self.devs()["33:00:00:00:00:33"]["name"], "bSala/bx")


class Parsers(unittest.TestCase):
    def test_regex_de_latencia_en_e_ptbr(self):
        for txt, v in (("time=1.23 ms", 1.23), ("tempo=2ms", 2.0), ("tempo<1ms", 1.0), ("time=12,5 ms", 12.5)):
            self.assertEqual(round(float(ns.LAT_RE.search(txt).group(1).replace(",", ".")), 2), v)

    def test_neighbors_linux_ignora_failed_e_multicast(self):
        out = ("192.168.0.1 dev wlan0 lladdr a4:2b:b0:1c:55:90 REACHABLE\n"
               "192.168.0.7 dev wlan0  FAILED\n"
               "224.0.0.251 dev wlan0 lladdr 01:00:5e:00:00:fb PERMANENT\n"
               "192.168.0.23 dev wlan0 lladdr 3c:5a:b4:91:0e:d2 STALE\n")
        with mock.patch.object(ns.subprocess, "run", return_value=mock.Mock(stdout=out)), mock.patch.object(ns, "IS_WIN", False):
            got = ns.read_neighbors()
        self.assertEqual(got, [("192.168.0.1", "A4:2B:B0:1C:55:90", "REACHABLE"), ("192.168.0.23", "3C:5A:B4:91:0E:D2", "STALE")])


if __name__ == "__main__":
    unittest.main()
