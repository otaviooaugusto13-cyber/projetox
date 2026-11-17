/* =================== CONFIGURAÇÃO (padrões em config.js; edite no app em ⚙) =================== */
const CFG = loadCfg();
const HOSTS = CFG.hosts, REFRESH_MS = CFG.refreshMs, WEATHER = CFG.weather, CAMERAS = CFG.cameras;
let TEST_HOT = false;   // botão "Testar alerta crítico" (⚙)

/* =================== UTILITÁRIOS =================== */
const $ = (s, r = document) => r.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const level = v => v >= 90 ? 'crit' : v >= 75 ? 'warn' : '';
const f = (n, d = 1) => Number(n).toFixed(d);
const rnd = (a, b) => a + Math.random() * (b - a);
const drift = (v, a, b, k = 8) => Math.max(a, Math.min(b, v + rnd(-k, k)));

const SVG = { // ícones estilo Lucide
  mouse:'<rect x="5" y="2" width="14" height="20" rx="7"/><path d="M12 6v4"/>',
  keyboard:'<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>',
  headset:'<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  gamepad:'<path d="M6 12h4M8 10v4M15 13h.01M18 11h.01"/><rect x="2" y="6" width="20" height="12" rx="2"/>',
  tablet:'<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M10 18h4"/>',
  shield:'<path d="M12 2 4 5v6c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5z"/><path d="m9 12 2 2 4-4"/>',
  cam:'<path d="M3 7h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H3z"/><path d="M17 11l4-2v6l-4-2"/>',
  sliders:'<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  battery:'<rect x="2" y="7" width="16" height="10" rx="2"/><path d="M22 11v2"/>',
  wifi:'<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><path d="M12 20h.01"/>',
  phone:'<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
  watch:'<circle cx="12" cy="12" r="6"/><path d="M12 10v2l1 1"/><path d="m16.1 7.7-.8-4a2 2 0 0 0-2-1.7h-2.6a2 2 0 0 0-2 1.7l-.8 4"/><path d="m7.9 16.3.8 4a2 2 0 0 0 2 1.7h2.6a2 2 0 0 0 2-1.7l.8-4"/>',
  buds:'<path d="M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0"/><path d="M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4"/>',
  bulb:'<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6M10 22h4"/>',
  target:'<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  moon:'<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  power:'<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  code:'<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  micoff:'<path d="M2 2l20 20"/><path d="M18.9 13.2A7 7 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.3V5a3 3 0 0 0-5.7-1.3"/><path d="M9 9v3a3 3 0 0 0 5.1 2.1"/><path d="M12 19v3"/>',
  leaf:'<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10Z"/><path d="M2 21c0-3 1.9-5.4 5.1-6C9.5 14.5 12 13 13 12"/>',
};
const icon = n => `<svg viewBox="0 0 24 24">${SVG[n] || SVG.battery}</svg>`;

/* Abas (com hash: #sys #net #sec #cam #auto) e modo gamer */
const TABS = ['sys', 'net', 'sec', 'fleet', 'cam', 'auto'];
function goTab(name) {
  if (!TABS.includes(name)) name = 'sys';
  document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  TABS.forEach(id => $('#tab-' + id).hidden = id !== name);
  try { history.replaceState(null, '', '#' + name); } catch (e) {}
  if (window.Sentinel) window.Sentinel.visible(name === 'sec');
  if (window.Fleet) window.Fleet.visible(name === 'fleet');
}
document.querySelectorAll('.tab[data-tab]').forEach(b => b.onclick = () => goTab(b.dataset.tab));
function setGamer(on) {
  document.body.classList.toggle('gamer', on); $('#gamerBtn').setAttribute('aria-checked', on);
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = on ? '#0a0612' : '#090C12';
  try { localStorage.setItem('gamer', on ? '1' : '0'); } catch (e) {}
}
try { setGamer(localStorage.getItem('gamer') === '1'); } catch (e) {}
$('#gamerBtn').onclick = () => { setGamer(!document.body.classList.contains('gamer')); log(document.body.classList.contains('gamer') ? 'Tema: modo gamer (roxo/ciano)' : 'Tema: modo normal (azul neon)', 'i'); };

/* =================== RELÓGIO FLIP =================== */
const digitHTML = c => `<div class="fc ${c}"><div class="h t"><span></span></div><div class="h b"><span></span></div>
  <div class="leaf"><div class="h t"><span></span></div><div class="h k"><span></span></div></div></div>`;
const SEP = '<div class="sep"><i></i><i></i></div>';
$('#clock').innerHTML = [0, 1, 2].map(g => digitHTML(g === 2 ? 's' : '') + digitHTML(g === 2 ? 's' : ''))
  .reduce((a, b, i) => a + (i ? SEP : '') + b);
const digits = [...document.querySelectorAll('#clock .fc')];
function setDigit(el, v) {
  const cur = el.dataset.v; if (cur === v) return;
  const [top, bot, front, back] = el.querySelectorAll('span');
  if (cur === undefined) { [top, bot, front, back].forEach(s => s.textContent = v); el.dataset.v = v; return; }
  top.textContent = v; front.textContent = cur; back.textContent = v;
  const leaf = el.querySelector('.leaf');
  leaf.classList.remove('go'); void leaf.offsetWidth; leaf.classList.add('go');
  setTimeout(() => { bot.textContent = v; leaf.classList.remove('go'); front.textContent = v; }, 500);
  el.dataset.v = v;
}
function tick() {
  const d = new Date();
  const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join('');
  digits.forEach((el, i) => setDigit(el, t[i]));
  $('#wday').textContent = d.toLocaleDateString('pt-BR', { weekday: 'long' });
  $('#date').textContent = d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}
tick(); setInterval(tick, 1000);

/* =================== ALERTA CRÍTICO (borda vermelha pulsante) =================== */
const crit = new Map();   // chave -> { msg, el }
function setCrit(key, on, msg, el) {
  const had = crit.has(key);
  if (on && !had) { crit.set(key, { msg, el }); if (el) el.classList.add('alarm'); log('CRÍTICO: ' + msg, 'e'); }
  if (!on && had) { const c = crit.get(key); if (c.el) c.el.classList.remove('alarm'); crit.delete(key); log('Normalizado: ' + c.msg, ''); }
  document.body.classList.toggle('has-crit', crit.size > 0);
}

/* =================== CARDS DE MÁQUINA =================== */
const R = 40, C = 2 * Math.PI * R, N = 60;
const gauge = (id, label) => `<div class="g" data-m="${id}"><div class="rw">
  <svg viewBox="0 0 100 100"><circle class="bg" cx="50" cy="50" r="${R}"/><circle class="fg" cx="50" cy="50" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>
  <b class="mono val">--</b></div><div class="lbl">${label}</div><div class="sub mono">—</div></div>`;

const state = HOSTS.map(() => ({ cpu: [], down: [], up: [], mock: { cpu: 30, ram: 50, gpu: 20, dn: 20, up: 3 } }));
HOSTS.forEach((h, i) => $('#machines').insertAdjacentHTML('beforeend', `
  <div class="card mc glow" id="m${i}">
    <div class="mh"><h2>${h.name}</h2><small class="mono"><span class="info">—</span> · <span class="mode">completo</span></small></div>
    <div class="gauges">${gauge('cpu', 'CPU')}${gauge('gpu', 'GPU')}${gauge('ram', 'RAM')}${gauge('disk', 'Disco')}</div>
    <div class="det"><div class="spk"><div class="sh"><span>Uso da CPU</span><b class="mono cpuNow">--</b></div>
      <svg viewBox="0 0 200 50" preserveAspectRatio="none"><polygon class="ar cpuA"/><polyline class="ln cpuL"/></svg></div>
    <div class="spk"><div class="sh"><span>Rede</span><b class="mono netNow">↓ -- ↑ --</b></div>
      <svg viewBox="0 0 200 50" preserveAspectRatio="none"><polygon class="ar dnA"/><polyline class="ln dnL"/><polyline class="ln up upL"/></svg></div></div>
  </div>`));

function setGauge(card, id, v, sub) {
  const el = $(`[data-m="${id}"]`, card), fg = $('.fg', el);
  fg.style.strokeDashoffset = C * (1 - Math.min(v, 100) / 100);
  fg.setAttribute('class', 'fg ' + level(v));
  $('.val', el).textContent = Math.round(v) + '%';
  $('.sub', el).textContent = sub || '\u00A0';
}
const pts = (d, max) => d.map((v, i) => `${(200 - (d.length - 1 - i) * 200 / (N - 1)).toFixed(1)},${(48 - Math.min(v, max) / max * 42).toFixed(1)}`);
function draw(card, cls, data, max) {
  const p = pts(data, max), x0 = p.length ? p[0].split(',')[0] : 0;
  $('.' + cls + 'L', card).setAttribute('points', p.join(' '));
  const a = $('.' + cls + 'A', card); if (a) a.setAttribute('points', `${p.join(' ')} 200,50 ${x0},50`);
}
const push = (arr, v) => { arr.push(v); if (arr.length > N) arr.shift(); };
const tc = (t, c) => [t != null ? Math.round(t) + '°C' : null, c != null ? f(c, 1) + ' GHz' : null].filter(Boolean).join(' · ');
const gb = (u, t) => `${f(u, t > 99 ? 0 : 1)} / ${f(t, t > 99 ? 0 : 0)} GB`;

function render(i, s) {
  const card = $('#m' + i), st = state[i];
  if (TEST_HOT && i === 0) s = { ...s, cpu_temp: 86 };
  const hot = Math.max(s.cpu_temp ?? 0, s.gpu ? s.gpu.temp ?? 0 : 0);
  setCrit('temp' + i, hot > 80, `${HOSTS[i].name}: temperatura ${Math.round(hot)}°C (limite 80°C)`, card);
  setGauge(card, 'cpu', s.cpu, tc(s.cpu_temp, s.cpu_clock));
  setGauge(card, 'gpu', s.gpu ? s.gpu.percent : 0, s.gpu ? tc(s.gpu.temp, s.gpu.clock) : 'sem GPU');
  setGauge(card, 'ram', s.ram, gb(s.ram_used, s.ram_total));
  setGauge(card, 'disk', s.disk, gb(s.disk_used, s.disk_total));
  alertOnce("cpu" + i, s.cpu > 90, `${HOSTS[i].name}: CPU acima de 90%`, "w");
  push(st.cpu, s.cpu); push(st.down, s.net.down); push(st.up, s.net.up);
  draw(card, 'cpu', st.cpu, 100);
  const nmax = Math.max(10, ...st.down, ...st.up) * 1.2;
  draw(card, 'dn', st.down, nmax);
  $('.upL', card).setAttribute('points', pts(st.up, nmax).join(' '));
  $('.cpuNow', card).textContent = f(s.cpu, 0) + '%';
  $('.netNow', card).textContent = `↓ ${f(s.net.down)} ↑ ${f(s.net.up)} Mbps`;
}

/* =================== PERIFÉRICOS =================== */
let netDev = [], lastPeriph = null;
const MOCK_PERIPH = [
  { name: 'Mouse', icon: 'mouse', level: 62, conn: '2.4GHz Wireless' },
  { name: 'Teclado', icon: 'keyboard', level: 78, conn: 'Bluetooth' },
  { name: 'Headset', icon: 'headset', level: 27, charging: true, conn: '2.4GHz Wireless' },
  { name: 'Controle', icon: 'gamepad', level: 12, conn: 'Bluetooth' },
  { name: 'Celular', model: 'Galaxy S24 Ultra', icon: 'phone', level: 84, charging: true, conn: 'Wi-Fi' },
  { name: 'Relógio', model: 'Galaxy Watch 7', icon: 'watch', level: 56, conn: 'Bluetooth' },
  { name: 'Fones', model: 'Galaxy Buds Pro', icon: 'buds', level: 41, conn: 'Bluetooth' },
];
const batColor = l => l == null ? 'var(--muted)' : l > 50 ? '#35d07f' : l > 20 ? '#e0b341' : '#ff4d5e';  // verde >50 · amarelo >20 · vermelho baixo
const BOLT = '<svg viewBox="0 0 24 24"><polygon points="13 2 4 14 11.5 14 11 22 20 10 12.5 10 13 2"/></svg>';
let tabBat = { ok: false, level: null, charging: false, secs: null };
if (navigator.getBattery) navigator.getBattery().then(b => {   // Battery Status API (só em HTTPS/localhost, Chrome/Android)
  const up = () => { tabBat = { ok: true, level: Math.round(b.level * 100), charging: b.charging, secs: b.charging ? b.chargingTime : b.dischargingTime }; if (lastPeriph) renderPeriph(lastPeriph); };
  ['levelchange', 'chargingchange', 'chargingtimechange', 'dischargingtimechange'].forEach(ev => b.addEventListener(ev, up)); up();
}).catch(() => {});
const eta = s => (s && isFinite(s) && s > 0) ? (s >= 3600 ? Math.floor(s / 3600) + 'h ' : '') + Math.round(s % 3600 / 60) + 'min' : null;
function renderPeriph(list) {
  lastPeriph = list;
  list.forEach(d => alertOnce('bat' + d.name, d.level <= 20, `${d.name}: bateria baixa (${d.level}%)`, 'w'));
  const tablet = { name: 'Tablet', model: 'este painel', icon: 'tablet', level: tabBat.level, charging: tabBat.charging,
    conn: tabBat.ok ? (eta(tabBat.secs) ? (tabBat.charging ? 'cheio em ' : 'restam ') + eta(tabBat.secs) : 'Bateria local') : 'Bateria indisponível aqui' };
  if (tabBat.ok) alertOnce('battab', tabBat.level <= 20 && !tabBat.charging, `Tablet: bateria baixa (${tabBat.level}%)`, 'w');
  const card = d => {
    const st = [d.charging ? 'Carregando' : null, d.conn].filter(Boolean).join(' · '), lv = d.level;
    return `<div class="card pc ${lv == null ? 'nodata' : ''}" style="--c:${batColor(lv)}"><div class="ic">${icon(d.icon)}</div><div class="pi">
      <div class="pr"><span class="pn">${esc(d.name)}${d.model ? `<em>${esc(d.model)}</em>` : ''}</span><span class="pv mono">${d.charging ? BOLT : ''}${lv == null ? '—' : lv + '%'}</span></div>
      <div class="bar"><i style="width:${lv == null ? 0 : lv}%"></i></div><div class="cn">${esc(st || 'Wireless')}</div></div></div>`;
  };
  const on = netDev.filter(d => d.online).length, tot = netDev.length;
  const wifi = `<div class="card pc" data-go="net" style="--c:var(--accent)"><div class="ic">${icon('wifi')}</div><div class="pi">
      <div class="pr"><span class="pn">Wi-Fi &amp; Rede</span><span class="pv mono">${on}/${tot}</span></div>
      <div class="bar"><i style="width:${tot ? on / tot * 100 : 0}%"></i></div><div class="cn">${on} online · ver detalhes</div></div></div>`;
  const sm = window.Sentinel ? window.Sentinel.summary() : { score: null, unknown: 0, hits: 0 };
  const sc = sm.score == null ? 'var(--muted)' : sm.score >= 80 ? '#35d07f' : sm.score >= 55 ? '#e0b341' : '#ff4d5e';
  const sec = `<div class="card pc" data-go="sec" style="--c:${sc}"><div class="ic">${icon('shield')}</div><div class="pi">
      <div class="pr"><span class="pn">Sentinel</span><span class="pv mono">${sm.score == null ? '—' : sm.score}</span></div>
      <div class="bar"><i style="width:${sm.score || 0}%"></i></div><div class="cn">${sm.unknown} desconhecidos · ${sm.hits} tripwires</div></div></div>`;
  $('#periph').innerHTML = list.map(card).join('') + card(tablet) + wifi + sec;
}

/* =================== CÂMERAS (REC / ONLINE) =================== */
const camSeen = {};
CAMERAS.forEach((c, i) => $('#camGrid').insertAdjacentHTML('beforeend', `<div class="card cam" id="cam${i}">
  ${c.src ? `<img alt="${esc(c.name)}" referrerpolicy="no-referrer">` : `<div class="empty">${icon('cam').replace('<svg', '<svg')}<span>Preparado para feed IP · aguardando URL<br><small class="muted">MJPEG/JPEG · RTSP via go2rtc (⚙ → Câmeras)</small></span></div>`}
  <div class="ctag"><span>${esc(c.name)}</span></div>
  <div class="pills"><span class="cpill rec" hidden><i></i>REC</span><span class="cpill st"><i></i><b>${c.src ? 'CONECTANDO' : 'SEM FEED'}</b></span></div>
  <div class="tc mono"></div><div class="cid mono">CAM ${String(i + 1).padStart(2, '0')}</div></div>`));
function camState(i, online) {
  const el = $('#cam' + i), c = CAMERAS[i]; if (!el) return;
  const st = $('.st', el); st.className = 'cpill st ' + (online ? 'on' : 'off'); $('b', st).textContent = online ? 'ONLINE' : 'OFFLINE';
  $('.rec', el).hidden = !(online && c.rec);
  if (online) camSeen[i] = true;
  setCrit('cam' + i, !online && camSeen[i], `Câmera ${c.name} fora do ar`, el);
}
CAMERAS.forEach((c, i) => {
  if (!c.src) return;
  const img = $('#cam' + i + ' img'), load = () => { img.src = c.snapMs ? c.src + (c.src.includes('?') ? '&' : '?') + 't=' + Date.now() : c.src; };
  img.onload = () => camState(i, true); img.onerror = () => camState(i, false);
  load(); if (c.snapMs) setInterval(load, Math.max(500, c.snapMs)); else setInterval(() => { if (!camSeen[i] || img.naturalWidth === 0) load(); }, 10000);
});
setInterval(() => CAMERAS.forEach((c, i) => { const t = $('#cam' + i + ' .tc'); if (t) t.textContent = camSeen[i] ? new Date().toLocaleTimeString('pt-BR') : ''; }), 1000);

/* =================== DADOS (API real + mock) =================== */
function mockStats(i) {
  const m = state[i].mock;
  m.cpu = drift(m.cpu, 4, 96, 12); m.ram = drift(m.ram, 35, 80, 2); m.gpu = drift(m.gpu, 2, 90, 10);
  m.dn = drift(m.dn, 0, 300, 40); m.up = drift(m.up, 0, 40, 5);
  return { cpu: m.cpu, cpu_temp: 40 + m.cpu * .35, cpu_clock: 3.2 + m.cpu / 60, ram: m.ram, ram_used: m.ram * .32, ram_total: 32,
    disk: 58, disk_used: 276, disk_total: 476, gpu: { percent: m.gpu, temp: 38 + m.gpu * .4, clock: 1.4 + m.gpu / 80 },
    net: { down: m.dn, up: m.up } };
}
const tokenFor = url => (HOSTS.find(h => h.url && url.startsWith(h.url)) || {}).token || '';
const isHost = url => HOSTS.some(h => h.url && url.startsWith(h.url));
async function getJSON(url, ms = 1500) {
  if (isHost(url) ? CFG.sim : false) throw new Error('sim');
  if (!url.startsWith('http')) throw new Error('sem endpoint');
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms), tk = tokenFor(url);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: tk ? { 'X-CC-Token': tk } : {} });
    if (r.status === 401) { const e = new Error('401'); e.auth = true; throw e; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
const hostSeen = {}, hostErr = {};
async function poll(i) {
  const t0 = performance.now();
  try { const s = await getJSON(HOSTS[i].url + '/api/stats'); return { s, ms: performance.now() - t0, live: true }; }
  catch (e) { return { s: mockStats(i), live: false, err: e }; }
}
async function refresh() {
  const res = await Promise.all(HOSTS.map((_, i) => poll(i)));
  res.forEach((r, i) => {
    render(i, r.s); $('#m' + i + ' .info').textContent = r.live ? r.s.host : 'simulado';
    if (r.live) { if (hostErr[i]) log(`${HOSTS[i].name}: agente reconectado`, ''); hostSeen[i] = true; hostErr[i] = null; }
    else {
      const why = r.err && r.err.auth ? 'token inválido' : (CFG.sim ? null : 'sem resposta');
      if (why && hostErr[i] !== why && (hostSeen[i] || r.err?.auth)) log(`${HOSTS[i].name}: agente ${why}`, 'e');
      if (why) hostErr[i] = why;
    }
    setCrit('host' + i, !r.live && !!hostSeen[i], `${HOSTS[i].name} fora do ar`, $('#m' + i));
  });
  const live = res.filter(r => r.live), auth = res.some(r => r.err && r.err.auth);
  $('#linkDot').classList.toggle('live', live.length > 0);
  $('#linkTxt').textContent = live.length
    ? `API Online • ${Math.round(Math.max(...live.map(r => r.ms)))}ms${live.length < HOSTS.length ? ` • ${live.length}/${HOSTS.length}` : ''}`
    : CFG.sim ? 'Modo simulado (forçado)' : auth ? 'Token inválido · simulado' : 'Modo simulado';
  try { renderPeriph(await getJSON(HOSTS[0].url + '/api/peripherals')); }
  catch (e) { renderPeriph(MOCK_PERIPH.map(d => ({ ...d, conn: d.conn + ' · simulado' }))); }
}
/* =================== TERMINAL (log estilo hacker, auto-scroll) =================== */
const TAGS = { '': ['OK', 'ok'], w: ['WARN', 'w'], e: ['ERR', 'e'], s: ['SEC', 's'], i: ['INFO', 'i'] };
const flags = new Set(); let logN = 0;
function log(msg, k = '') {
  const box = $('#term'); if (!box) return;
  const [tag, cls] = TAGS[k] || TAGS[''];
  box.querySelector('.cur')?.remove();
  const row = document.createElement('div');
  row.innerHTML = `<time>${new Date().toLocaleTimeString('pt-BR')}</time><span class="tg1 ${cls}">[${tag}]</span> ${esc(msg)}`;
  box.appendChild(row);
  const cur = document.createElement('div'); cur.className = 'cur'; box.appendChild(cur);
  while (box.children.length > 202) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight; logN++;
  $('#termInfo').textContent = `${logN} linhas`;
}
function alertOnce(key, cond, msg, k) { if (cond && !flags.has(key)) { flags.add(key); log(msg, k); } if (!cond) flags.delete(key); }

/* =================== PING, SERVIÇOS E CLIMA =================== */
const PING_T = [{ k: 'gateway', name: 'Gateway', sub: 'roteador local' }, { k: 'cloudflare', name: 'Cloudflare', sub: '1.1.1.1' }, { k: 'google', name: 'Google', sub: '8.8.8.8' }];
const pingH = { gateway: [], cloudflare: [], google: [] }, pingSeen = {};
$('#pings').innerHTML = PING_T.map(t => `<div class="card pg" data-p="${t.k}"><div class="ph2"><span>${t.name} <span class="muted mono" style="font-weight:400;font-size:11px;margin-left:6px">${t.sub}</span></span><span class="dot"></span></div>
  <div class="big mono"><span class="ms">--</span><small>ms</small></div>
  <svg viewBox="0 0 200 50" preserveAspectRatio="none"><polygon class="ar" style="opacity:.13"/><polyline class="ln"/></svg>
  <div class="st mono"><span class="mn"></span><span class="av"></span><span class="mx"></span></div></div>`).join('');
const pCol = v => v == null ? '#ff4d5e' : v < 40 ? '#35d07f' : v < 120 ? '#e0b341' : '#ff4d5e';
function renderPing(p) {
  if (p.cloudflare == null) p.cloudflare = p.internet;
  const ok = p.gateway != null && p.internet != null && p.internet < 150;
  $('#pingDot').className = 'dot ' + (ok ? 'live' : 'bad');
  $('#pingTxt').textContent = `Gateway: ${p.gateway ?? '--'}ms • Internet: ${p.internet ?? '--'}ms`;
  alertOnce('net', p.internet == null, 'Sem resposta da internet', 'e');
  PING_T.forEach(t => {
    const v = p[t.k], h = pingH[t.k];
    if (v != null) pingSeen[t.k] = true; h.push(v == null ? 0 : v); if (h.length > N) h.shift();
    const c = $(`[data-p="${t.k}"]`), vals = h.filter(x => x > 0), col = pCol(v);
    c.style.setProperty('--c', col);
    setCrit('ping' + t.k, v == null && !!pingSeen[t.k], `${t.name} sem resposta (latência)`, c);
    $('.ms', c).textContent = v == null ? 'timeout' : v;
    $('.dot', c).style.cssText = `background:${col};box-shadow:0 0 8px ${col}`;
    const max = Math.max(20, ...h) * 1.3, pp = pts(h, max), x0 = pp[0].split(',')[0];
    $('.ln', c).setAttribute('points', pp.join(' ')); $('.ar', c).setAttribute('points', `${pp.join(' ')} 200,50 ${x0},50`);
    $('.mn', c).textContent = vals.length ? 'mín ' + Math.min(...vals) : '';
    $('.av', c).textContent = vals.length ? 'méd ' + Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : '';
    $('.mx', c).textContent = vals.length ? 'máx ' + Math.max(...vals) : '';
  });
}
const svcPrev = {}, svcSeen = {};
function renderServices(list) {
  $('#chips').innerHTML = list.map(s => `<span class="chip"><span class="dot ${s.ok ? 'live' : 'bad'}"></span>${s.name} <em class="mono">${s.detail || ''}</em></span>`).join('');
  setCrit('svc', list.some(s => !s.ok && svcSeen[s.name]), 'Serviço crítico fora do ar: ' + list.filter(s => !s.ok).map(s => s.name).join(', '), $('.svc'));
  list.forEach(s => { if (s.ok) svcSeen[s.name] = true; });
  list.forEach(s => { if (svcPrev[s.name] !== undefined && svcPrev[s.name] !== s.ok) log(`${s.name} ${s.ok ? 'restabelecido' : 'fora do ar'}`, s.ok ? '' : 'e'); svcPrev[s.name] = s.ok; });
}
async function extras() {
  const base = HOSTS[0].url; let ping, svc;
  try { ping = await getJSON(base + '/api/ping'); } catch (e) { const cf = Math.round(rnd(9, 15)); ping = { gateway: Math.round(rnd(1, 4)), internet: cf, cloudflare: cf, google: Math.round(rnd(10, 18)) }; }
  try { svc = await getJSON(base + '/api/services'); }
  catch (e) { svc = [{ name: 'API Python', ok: true, detail: ':5000' }, { name: 'Docker', ok: true, detail: 'simulado' }, { name: 'Servidor Web', ok: true, detail: ':8080' }]; }
  renderPing(ping); renderServices(svc);
}
const WMO = { 0:'Céu limpo', 1:'Quase limpo', 2:'Parcialmente nublado', 3:'Nublado', 45:'Neblina', 48:'Neblina', 51:'Garoa', 53:'Garoa', 55:'Garoa', 61:'Chuva fraca', 63:'Chuva', 65:'Chuva forte', 80:'Pancadas de chuva', 81:'Pancadas de chuva', 82:'Pancadas fortes', 95:'Trovoadas', 96:'Trovoadas', 99:'Trovoadas' };
async function weather() {
  try {
    const j = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${WEATHER.lat}&longitude=${WEATHER.lon}&current=temperature_2m,weather_code&timezone=auto`, 5000);
    $('#wTxt').textContent = `${Math.round(j.current.temperature_2m)}°C • ${WMO[j.current.weather_code] || '—'}`;
  } catch (e) { $('#wTxt').textContent = 'Clima indisponível'; }
}

/* =================== AUTOMAÇÕES: ILUMINAÇÃO =================== */
const base = () => HOSTS[0].url;
async function post(url, body) {
  if (CFG.sim) throw new Error('sim');
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000), tk = tokenFor(url);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { 'X-CC-Token': tk } : {}) }, body: JSON.stringify(body || {}), signal: ctl.signal });
    if (r.status === 401) { const e = new Error('401'); e.auth = true; throw e; }
    return await r.json();
  } finally { clearTimeout(t); }
}
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }

const LIGHTS = [{ id: 'strip', name: 'Fita LED da Bancada' }, { id: 'room', name: 'Luz Principal do Quarto' }, { id: 'panel', name: 'Painel LED de Fundo' }];
const lt = { strip: { on: true, b: 80 }, room: { on: false, b: 100 }, panel: { on: true, b: 60 } };
let curScene = null; const timers = {};

$('#lights').innerHTML = LIGHTS.map(l => `<div class="card lt" data-id="${l.id}">
  <svg class="lamp" viewBox="0 0 24 24">${SVG.bulb}</svg><h3>${l.name}</h3>
  <div class="row"><span class="muted st">Desligada</span><button class="tg" aria-label="Ligar ou desligar ${l.name}"></button></div>
  <div style="width:100%"><div class="row" style="margin-bottom:10px"><span class="muted">Intensidade</span><b class="mono bv">0%</b></div>
  <input class="rg" type="range" min="0" max="100" aria-label="Intensidade ${l.name}"></div></div>`).join('');

function paint(id) {
  const c = $(`[data-id="${id}"]`), s = lt[id];
  c.classList.toggle('on', s.on); $('.tg', c).classList.toggle('on', s.on);
  $('.st', c).textContent = s.on ? 'Ligada' : 'Desligada'; $('.bv', c).textContent = s.b + '%';
  const r = $('.rg', c); r.value = s.b; r.style.setProperty('--v', s.b + '%');
  $('.lamp', c).style.opacity = s.on ? .45 + .55 * s.b / 100 : .7;
}
function send(id, now) {
  clearTimeout(timers[id]);
  timers[id] = setTimeout(() => post(`${base()}/api/lights/${id}`, { on: lt[id].on, brightness: lt[id].b }).catch(() => {}), now ? 0 : 200);
}
function paintScenes() { document.querySelectorAll('[data-s]').forEach(b => b.classList.toggle('on', b.dataset.s === curScene)); }
$('#lights').addEventListener('click', e => {
  const t = e.target.closest('.tg'); if (!t) return;
  const id = t.closest('[data-id]').dataset.id; lt[id].on = !lt[id].on; curScene = null; paintScenes(); paint(id); send(id, true);
});
$('#lights').addEventListener('input', e => {
  const r = e.target.closest('.rg'); if (!r) return;
  const id = r.closest('[data-id]').dataset.id; lt[id].b = +r.value; lt[id].on = lt[id].b > 0; curScene = null; paintScenes(); paint(id); send(id);
});
LIGHTS.forEach(l => paint(l.id));
(async () => { try { const j = await getJSON(base() + '/api/lights'); LIGHTS.forEach(l => { if (j[l.id]) { lt[l.id] = { on: j[l.id].on, b: j[l.id].brightness }; paint(l.id); } }); } catch (e) {} })();

/* Cenas rápidas: [ligada, brilho|null] por luz */
const SCENES = [
  { id: 'focus', name: 'Modo Foco / Trabalho', sub: 'Luz forte e neutra', icon: 'target', v: { strip: [1, 70], room: [1, 100], panel: [1, 40] } },
  { id: 'neon',  name: 'Modo Gamer Neon', sub: 'Bancada e painel no máximo', icon: 'gamepad', v: { strip: [1, 100], room: [0, null], panel: [1, 100] } },
  { id: 'night', name: 'Modo Noturno / Cinema', sub: 'Só luz de fundo, baixa', icon: 'moon', v: { strip: [1, 20], room: [0, null], panel: [1, 15] } },
  { id: 'off',   name: 'Desligar Tudo', sub: 'Apaga todas as luzes', icon: 'power', v: { strip: [0, null], room: [0, null], panel: [0, null] } },
];
$('#scenes').innerHTML = SCENES.map(s => `<button class="card btn" data-s="${s.id}"><svg viewBox="0 0 24 24">${SVG[s.icon]}</svg><span>${s.name}<small>${s.sub}</small></span></button>`).join('');
$('#scenes').addEventListener('click', e => {
  const b = e.target.closest('[data-s]'); if (!b) return;
  const sc = SCENES.find(x => x.id === b.dataset.s);
  Object.entries(sc.v).forEach(([id, [on, br]]) => { lt[id].on = !!on; if (br != null) lt[id].b = br; paint(id); send(id, true); });
  curScene = sc.id === 'off' ? null : sc.id; paintScenes(); toast('Cena: ' + sc.name);
});

/* Ações rápidas (webhooks locais no PC) */
const QA = [
  { id: 'dev',  name: 'Iniciar Ambiente Dev', sub: 'IDE, containers e terminal', icon: 'code' },
  { id: 'mute', name: 'Silenciar Microfone', sub: 'Alterna o mute do sistema', icon: 'micoff' },
  { id: 'eco',  name: 'Modo Economia', sub: 'Plano de energia econômico', icon: 'leaf' },
];
$('#qa').innerHTML = QA.map(a => `<button class="card btn" data-a="${a.id}"><svg viewBox="0 0 24 24">${SVG[a.icon]}</svg><span>${a.name}<small>${a.sub}</small></span></button>`).join('');
$('#qa').addEventListener('click', async e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const a = QA.find(x => x.id === b.dataset.a); toast(`Executando: ${a.name}…`);
  try { const r = await post(`${base()}/api/action/${a.id}`); toast(`${a.name}: ${r.msg}`); log(`${a.name}: ${r.msg}`, r.ok ? '' : 'w'); }
  catch (e) { toast(`Simulado: ${a.name} (API offline)`); }
});

/* Cards de máquina: 1 clique = compacto · 2 cliques = completo (lembra a escolha) */
function setMode(i, m, anim = true) {
  const c = $('#m' + i), h0 = c.offsetHeight;
  c.classList.toggle('compact', m === 'compact');
  $('.mode', c).textContent = m === 'compact' ? 'compacto' : 'completo';
  const h1 = c.offsetHeight;   // anima a altura entre os dois estados (FLIP)
  if (anim && h0 !== h1) { c.style.height = h0 + 'px'; void c.offsetHeight; c.style.height = h1 + 'px'; setTimeout(() => { c.style.height = ''; }, 400); }
  try { localStorage.setItem('mode' + i, m); } catch (e) {}
}
HOSTS.forEach((_, i) => {
  const c = $('#m' + i); let taps = 0, t;
  c.title = '1 toque: compacto · 2 toques: completo';
  c.addEventListener('pointerup', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    taps++; clearTimeout(t);
    t = setTimeout(() => { setMode(i, taps >= 2 ? 'full' : 'compact'); taps = 0; }, 260);   // espera o 2º toque
  });
  let saved = null; try { saved = localStorage.getItem('mode' + i); } catch (e) {}
  setMode(i, saved === 'compact' ? 'compact' : 'full', false);
});

/* Dispositivos da rede local */
const agoTxt = sec => sec < 90 ? sec + 's' : sec < 5400 ? Math.round(sec / 60) + ' min' : Math.round(sec / 3600) + ' h';
const MOCK_DEV = [
  { name: 'Roteador', ip: '192.168.0.1', mac: 'A4:2B:B0:1C:55:90', online: true, role: 'Gateway' },
  { name: 'PC Principal', ip: '192.168.0.10', mac: '9C:6B:00:3E:A1:47', online: true, role: 'Este PC' },
  { name: 'Notebook', ip: '192.168.0.11', mac: 'F8:34:41:7D:20:B3', online: true },
  { name: 'Galaxy S24 Ultra', ip: '192.168.0.23', mac: '3C:5A:B4:91:0E:D2', online: true },
  { name: 'Tablet da Bancada', ip: '192.168.0.31', mac: '48:2C:A0:5B:6F:18', online: true },
  { name: 'Fita LED (WLED)', ip: '192.168.0.41', mac: 'EC:FA:BC:02:7A:C5', online: true },
  { name: 'Câmera Bancada', ip: '192.168.0.51', mac: 'C0:56:E3:A8:34:7E', online: true },
  { name: 'Smart TV', ip: '192.168.0.62', mac: '70:2A:D5:18:E9:40', online: true },
  { name: 'Impressora', ip: '192.168.0.70', mac: '00:1B:A9:6C:12:F0', online: false, ago: 3600 },
];
function renderDevices(list, live) {
  netDev = list;
  const on = list.filter(d => d.online).length;
  $('#devCount').textContent = `${on} online · ${list.length - on} offline${live ? '' : ' · simulado'}`;
  $('#devRows').innerHTML = list.map(d => `<tr><td>${esc(d.name)}${d.role ? `<span class="tag">${esc(d.role)}</span>` : ''}</td>
    <td class="mono">${esc(d.ip)}</td><td class="mono">${esc(d.mac)}</td>
    <td><span class="sd"><span class="dot ${d.online ? 'live' : ''}"></span>${d.online ? 'Online' : 'Offline'}${!d.online && d.ago != null ? `<span class="muted mono">· há ${agoTxt(d.ago)}</span>` : ''}</span></td></tr>`).join('');
  if (window.Sentinel) window.Sentinel.onNetwork(list, live);
  if (lastPeriph) renderPeriph(lastPeriph);   // atualiza os cards "Wi-Fi" e "Sentinel" da aba Sistema
}
async function netPoll() { try { renderDevices(await getJSON(HOSTS[0].url + '/api/network', 4000), true); } catch (e) { renderDevices(MOCK_DEV, false); } }
$('#periph').addEventListener('click', e => { const g = e.target.closest('[data-go]'); if (g) goTab(g.dataset.go); });
netPoll(); setInterval(netPoll, 8000);

/* =================== MIXER DE VOLUME (por canal) =================== */
const MIX_DEF = [
  { id: 'master', name: 'Master', v: 70 }, { id: 'music', name: 'Música', v: 55 }, { id: 'game', name: 'Jogos', v: 80 },
  { id: 'chat', name: 'Chat', v: 65 }, { id: 'web', name: 'Navegador', v: 40 },
];
let mix = MIX_DEF.map(c => ({ ...c, mute: false, avail: true })), mixLive = false;
function paintMixer() {
  $('#mixTag').textContent = mixLive ? '· Windows (pycaw)' : '· simulado';
  $('#mixer').innerHTML = mix.map(c => `<div class="ch ${c.mute ? 'muted' : ''} ${c.avail ? '' : 'dis'}" data-c="${c.id}">
    <b class="mono">${c.avail ? c.v : '--'}</b>
    <div class="fader" role="slider" aria-label="Volume ${esc(c.name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${c.v}" tabindex="0"><div class="fill" style="height:${c.v}%"></div><div class="knob" style="bottom:${c.v}%"></div></div>
    <button class="mb ${c.mute ? 'on' : ''}" aria-label="Mudo ${esc(c.name)}">M</button><span class="nm">${esc(c.avail ? c.name : c.name + ' (sem app)')}</span></div>`).join('');
}
const mixT = {};
function mixSend(c) { clearTimeout(mixT[c.id]); mixT[c.id] = setTimeout(() => post(`${base()}/api/mixer/${c.id}`, { volume: c.v, mute: c.mute }).catch(() => {}), 120); }
function faderSet(el, clientY) {
  const r = el.getBoundingClientRect(), c = mix.find(x => x.id === el.closest('.ch').dataset.c);
  c.v = Math.round(Math.max(0, Math.min(100, (r.bottom - clientY) / r.height * 100)));
  const ch = el.closest('.ch'); $('.fill', el).style.height = c.v + '%'; $('.knob', el).style.bottom = c.v + '%'; $('b', ch).textContent = c.v; el.setAttribute('aria-valuenow', c.v);
  mixSend(c);
}
$('#mixer').addEventListener('pointerdown', e => {
  const f = e.target.closest('.fader'); if (!f) return;
  f.setPointerCapture(e.pointerId); faderSet(f, e.clientY);
  const mv = ev => faderSet(f, ev.clientY), up = () => { f.removeEventListener('pointermove', mv); f.removeEventListener('pointerup', up); f.removeEventListener('pointercancel', up); };
  f.addEventListener('pointermove', mv); f.addEventListener('pointerup', up); f.addEventListener('pointercancel', up);
});
$('#mixer').addEventListener('keydown', e => {
  const f = e.target.closest('.fader'); if (!f || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const c = mix.find(x => x.id === f.closest('.ch').dataset.c); c.v = Math.max(0, Math.min(100, c.v + (e.key === 'ArrowUp' ? 5 : -5))); paintMixer(); mixSend(c); e.preventDefault();
});
$('#mixer').addEventListener('click', e => {
  const b = e.target.closest('.mb'); if (!b) return;
  const c = mix.find(x => x.id === b.closest('.ch').dataset.c); c.mute = !c.mute; paintMixer(); mixSend(c);
});
async function mixPoll() {
  try {
    const j = await getJSON(base() + '/api/mixer', 2500);
    if (j.available) { mixLive = true; mix = j.channels.map(c => ({ id: c.id, name: c.name, v: c.volume, mute: c.mute, avail: c.available })); }
    else mixLive = false;
  } catch (e) { mixLive = false; }
  if (!document.querySelector('.fader:active') && !$('#tab-auto').hidden) paintMixer();
}
paintMixer(); mixPoll(); setInterval(mixPoll, 4000);

/* =================== BOOT (sequência estilo terminal) =================== */
function boot() {
  const lines = [
    ['Command Center v3 · iniciando', 'i'], [`${HOSTS.length} agente(s) configurado(s)`, 'i'],
    [CFG.sim ? 'Modo simulado forçado' : 'Procurando agentes na rede…', 'i'], ['Sentinel armado', 's'],
  ];
  lines.forEach((l, k) => setTimeout(() => log(l[0], l[1]), 250 * (k + 1)));
}
boot();

extras(); setInterval(extras, 2000);
weather(); setInterval(weather, 600000);
refresh(); setInterval(refresh, REFRESH_MS);
goTab((location.hash || '#sys').slice(1)); window.addEventListener('hashchange', () => goTab(location.hash.slice(1)));
