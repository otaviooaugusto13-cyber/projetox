/* Command Center · configuração padrão
 * Tudo aqui pode ser alterado no app, em ⚙ Configurações (salvo no localStorage do tablet).
 * IMPORTANTE: o painel hospedado em HTTPS (Render) só consegue falar com agentes em HTTPS. Veja README → "HTTPS e mixed content". */
window.CC_DEFAULTS = {
  hosts: [   // um item por máquina rodando agent.py
    { name: 'PC Principal', url: 'http://192.168.0.10:5000', token: '' },
    { name: 'Notebook',     url: 'http://192.168.0.11:5000', token: '' },
  ],
  weather: { lat: -22.436, lon: -46.822 },          // Open-Meteo · troque pela sua cidade
  cameras: [                                         // src: URL MJPEG/JPEG (RTSP precisa de go2rtc, veja README)
    { name: 'Bancada', src: '', rec: true,  snapMs: 0 },
    { name: 'Entrada', src: '', rec: true,  snapMs: 0 },
    { name: 'Quintal', src: '', rec: false, snapMs: 0 },
    { name: 'Garagem', src: '', rec: false, snapMs: 0 },
  ],
  hub: { url: '', token: '' },   // hub de telemetria (aba Frota); vazio = DEMO
  refreshMs: 2000,
  sim: false,          // true = força dados simulados (útil para demo/gravação)
  keepAwake: true,     // mantém a tela ligada (Wake Lock)
};

const CFG_KEY = 'cc.cfg';
function loadCfg() {
  const d = JSON.parse(JSON.stringify(window.CC_DEFAULTS));
  try {
    const o = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
    Object.keys(d).forEach(k => { if (o[k] !== undefined) d[k] = o[k]; });
  } catch (e) {}
  d.hosts = (d.hosts || []).map(h => ({ name: h.name || 'Máquina', url: String(h.url || '').trim().replace(/\/+$/, ''), token: String(h.token || '').trim() }));
  if (!d.hosts.length) d.hosts = JSON.parse(JSON.stringify(window.CC_DEFAULTS.hosts));
  return d;
}
function saveCfg(c) { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); return true; } catch (e) { return false; } }
