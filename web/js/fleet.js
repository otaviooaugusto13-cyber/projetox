/* ======================================================================
 * FROTA · painel de telemetria e saúde Zero-Trust em tempo real
 *  - Recebe do hub (SSE via fetch streaming, com cabeçalho Authorization) o estado de cada agente.
 *  - Estados: Online · Degradado · Offline · Fantasma · Aguardando. Alertas de segurança do hub aparecem no feed.
 *  - Se o stream cair: reconecta com backoff e usa polling de /api/v1/fleet como plano B (rótulo mostra o modo).
 *  - Sem hub configurado (⚙): mostra DEMO claramente rotulado.
 *  - Todo texto vindo do hub passa por esc() antes de entrar no DOM.
 * ====================================================================== */
(() => {
  const HUB = (CFG.hub && CFG.hub.url ? CFG.hub.url : '').replace(/\/+$/, '');
  const TOKEN = (CFG.hub && CFG.hub.token) || '';
  const ST = { online: 'Online', degraded: 'Degradado', offline: 'Offline', ghost: 'Fantasma', pending: 'Aguardando' };
  const SEC_WINDOW_MS = 5 * 60e3;
  const agents = new Map();            // id -> { ...resumo, rx: performance.now() quando chegou }
  let events = [], mode = 'idle', demo = false;

  const el = { grid: $('#fleetGrid'), sum: $('#fleetSum'), mode: $('#fleetMode'), feed: $('#fleetFeed'), evSum: $('#fleetEv') };
  const ago = s => s == null ? '—' : s < 90 ? Math.round(s) + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : Math.round(s / 3600) + ' h';
  const hhmm = t => new Date(t * 1000).toLocaleTimeString('pt-BR');
  const upt = s => s == null ? '—' : s >= 86400 ? Math.floor(s / 86400) + 'd ' + Math.floor(s % 86400 / 3600) + 'h' : s >= 3600 ? Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm' : Math.floor(s / 60) + ' min';
  const col = st => ({ online: '#35d07f', degraded: '#e0b341', offline: '#ff4d5e', ghost: '#9a6bff', pending: '#7d8899' }[st] || '#7d8899');
  const bar = (label, v) => `<div class="fbar ${level(v ?? 0)}"><span>${label}</span><div class="bar"><i style="width:${v ?? 0}%"></i></div><b class="mono">${v == null ? '—' : Math.round(v) + '%'}</b></div>`;

  function spark(h) {
    if (!h || h.length < 2) return '';
    const p = h.map((r, i) => `${(i * 200 / (h.length - 1)).toFixed(1)},${(48 - Math.min(r[1], 100) / 100 * 42).toFixed(1)}`);
    return `<svg viewBox="0 0 200 50" preserveAspectRatio="none" class="fspk"><polyline class="ln" points="${p.join(' ')}"/></svg>`;
  }

  function card(a) {
    const m = a.metrics || {}, c = col(a.status);
    const reasons = (a.reasons || []).map(r => `<li class="${esc(r.sev)}">${esc(r.msg)}</li>`).join('');
    const svcs = (a.services || []).map(s => `<span class="chip"><span class="dot ${s.ok ? 'live' : 'bad'}"></span>${esc(s.name)}</span>`).join('');
    return `<div class="card fc2 st-${esc(a.status)}" data-id="${esc(a.id)}" style="--c:${c}">
      <div class="fh"><div><h2>${esc(a.name)}</h2><small class="mono muted">${esc(a.id)} · v${esc(a.version || '?')} · ${esc((a.host && a.host.hostname) || '?')}</small></div>
        <span class="fbadge mono">${ST[a.status] || esc(a.status)}</span></div>
      <div class="fhb mono"><span class="dot" style="background:${c};box-shadow:0 0 8px ${c}"></span>último heartbeat <b class="age" data-id="${esc(a.id)}">—</b></div>
      ${bar('CPU', m.cpu)}${bar('RAM', m.ram)}${bar('Disco', m.disk)}
      <div class="fmeta mono"><span>latência ${m.rtt_ms == null ? '—' : Math.round(m.rtt_ms) + ' ms'}</span><span>uptime ${upt(m.uptime_s)}</span><span>agente ${m.agent_rss_mb == null ? '—' : Math.round(m.agent_rss_mb) + ' MB'}</span></div>
      ${spark(a.history)}
      ${svcs ? `<div class="chips">${svcs}</div>` : ''}
      ${reasons ? `<ul class="freasons">${reasons}</ul>` : ''}
    </div>`;
  }

  /* ---------- render ---------- */
  let lastHTML = '';
  function render() {
    const list = [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
    const html = list.map(card).join('');
    if (html !== lastHTML) { el.grid.innerHTML = html || `<div class="card fempty">${HUB || demo ? 'Aguardando dados do hub…' : 'Hub de telemetria não configurado. Abra ⚙ Configurações → Hub de telemetria (URL + token de leitura).'}</div>`; lastHTML = html; }
    const n = s => list.filter(a => a.status === s).length;
    el.sum.innerHTML = ['online', 'degraded', 'offline', 'ghost'].map(s => `<span class="fpill" style="--c:${col(s)}"><i></i>${ST[s]} <b class="mono">${n(s)}</b></span>`).join('');
    const nowS = Date.now() / 1000;
    const recent = events.filter(e => nowS - e.ts < SEC_WINDOW_MS / 1000 && e.level === 'crit');
    el.evSum.textContent = `${events.length} evento(s)${demo ? ' · DEMO' : ''}`;
    el.feed.innerHTML = events.length ? events.slice().reverse().map(e =>
      `<li class="${e.level === 'crit' ? 'e' : e.level === 'warn' ? 'w' : ''}"><time>${hhmm(e.ts)}</time><span>${esc(e.msg)}${e.count > 1 ? ` <b class="mono">×${e.count}</b>` : ''}${e.ip ? ` <em class="mono muted">${esc(e.ip)}</em>` : ''}</span></li>`).join('')
      : '<li class="empty">Nenhum evento de segurança. Tudo calmo.</li>';
    // integra ao sistema de alerta crítico do painel (borda vermelha)
    if (!demo) list.forEach(a => setCrit('fleet-' + a.id, a.status === 'offline', `${a.name}: sem heartbeat (offline)`, null));
    if (!demo) setCrit('fleet-sec', recent.length > 0, 'Frota: alerta de segurança — ' + (recent[recent.length - 1] || {}).msg, null);
    tickAges();
  }
  function tickAges() {
    document.querySelectorAll('.age').forEach(n => {
      const a = agents.get(n.dataset.id); if (!a) return;
      n.textContent = a.age_s == null ? 'nunca' : 'há ' + ago(a.age_s + (performance.now() - a.rx) / 1000);
    });
  }
  setInterval(tickAges, 1000);

  function setMode(m, txt) {
    mode = m; el.mode.textContent = txt;
    el.mode.className = 'pill fmode ' + (m === 'live' ? 'ok' : m === 'poll' ? 'warn' : '');
  }

  /* ---------- aplicar dados ---------- */
  const putAgent = a => { agents.set(a.id, { ...a, rx: performance.now() }); };
  function applySnapshot(s) { agents.clear(); (s.agents || []).forEach(putAgent); events = s.events || []; render(); }
  function applyAgent(a) { putAgent(a); render(); }
  function applySecurity(e) {
    const i = events.findIndex(x => x.id === e.id);
    if (i >= 0) events[i] = e; else { events.push(e); events = events.slice(-60); if (e.level === 'crit') toast('🛡 ' + e.msg); log('Frota: ' + e.msg, e.level === 'crit' ? 'e' : 's'); }
    render();
  }

  /* ---------- SSE com fetch (permite enviar Authorization; EventSource não permite) ---------- */
  let ctl = null, retry = 1000, fails = 0, timer = 0, pollT = 0;
  async function connect() {
    clearTimeout(timer);
    ctl = new AbortController();
    let lastByte = performance.now();
    const watchdog = setInterval(() => { if (performance.now() - lastByte > 35000) ctl.abort(); }, 5000);   // hub dá ping a cada 15 s
    try {
      const r = await fetch(HUB + '/api/v1/stream', { headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'text/event-stream' }, signal: ctl.signal, cache: 'no-store' });
      if (r.status === 401) { setMode('auth', 'token de leitura inválido'); log('Frota: token do hub inválido', 'e'); return; }   // não insiste
      if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
      fails = 0; retry = 1000; stopPoll(); setMode('live', 'tempo real · SSE');
      const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        lastByte = performance.now(); buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) { handleFrame(buf.slice(0, i)); buf = buf.slice(i + 2); }
      }
    } catch (e) { fails++; }
    finally { clearInterval(watchdog); }
    if (mode === 'auth') return;
    if (fails >= 2) startPoll();
    else setMode('retry', 'reconectando…');
    timer = setTimeout(connect, retry); retry = Math.min(retry * 2, 15000);     // backoff exponencial até 15 s
  }
  function handleFrame(txt) {
    let ev = 'message', data = '';
    txt.split('\n').forEach(l => { if (l.startsWith('event:')) ev = l.slice(6).trim(); else if (l.startsWith('data:')) data += l.slice(5).trim(); });
    if (!data) return;                                   // comentário ": ping"
    let j; try { j = JSON.parse(data); } catch (e) { return; }
    if (ev === 'snapshot') applySnapshot(j); else if (ev === 'agent') applyAgent(j); else if (ev === 'security') applySecurity(j);
  }

  /* ---------- plano B: polling ---------- */
  async function pollOnce() {
    try {
      const r = await fetch(HUB + '/api/v1/fleet', { headers: { Authorization: 'Bearer ' + TOKEN }, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      applySnapshot(await r.json()); setMode('poll', 'polling · 5 s');
    } catch (e) { setMode('down', 'hub inacessível'); }
  }
  function startPoll() { if (!pollT) { pollOnce(); pollT = setInterval(pollOnce, 5000); } }
  function stopPoll() { clearInterval(pollT); pollT = 0; }

  /* ---------- DEMO (sem hub configurado) ---------- */
  function startDemo() {
    demo = true; setMode('demo', 'DEMO · dados simulados');
    const now = () => Date.now() / 1000;
    const mk = (id, name, st, cpu, ram, extra = {}) => ({ id, name, status: st, reasons: [], age_s: st === 'online' ? 3 : st === 'degraded' ? 20 : 120, version: '4.0.0',
      host: { hostname: id }, interval_s: 15, metrics: { cpu, ram, disk: 58, rtt_ms: 24, uptime_s: 93000, agent_rss_mb: 24 }, services: [{ name: 'Agente CC', ok: true }, { name: 'Docker', ok: st !== 'degraded' }],
      history: Array.from({ length: 40 }, (_, i) => [i, cpu + Math.sin(i / 3) * 8, ram]), ...extra });
    const d = [mk('pc-principal', 'PC Principal', 'online', 34, 52), mk('notebook', 'Notebook', 'degraded', 93, 71, { reasons: [{ sev: 'warn', msg: 'CPU em 93%' }, { sev: 'crit', msg: 'Serviço fora do ar: Docker' }] }),
      mk('servidor-nas', 'NAS', 'offline', 0, 0, { reasons: [{ sev: 'crit', msg: 'Sem heartbeat há 120 s' }], metrics: null }), mk('raspberry', 'Raspberry Pi', 'ghost', 0, 0, { age_s: 5400, reasons: [{ sev: 'crit', msg: 'Sem heartbeat há 90 min (nó fantasma)' }], metrics: null })];
    d.forEach(putAgent);
    events = [{ id: 1, ts: now() - 40, level: 'crit', msg: 'Assinatura inválida para Notebook (possível spoofing/adulteração)', ip: '203.0.113.7', count: 3 },
      { id: 2, ts: now() - 300, level: 'warn', msg: 'Agente não cadastrado tentou conectar: intruso-x', ip: '198.51.100.9', count: 1 }];
    render();
  }

  window.Fleet = { visible: v => { if (v) tickAges(); } };
  if (CFG.sim || !HUB || !TOKEN) startDemo(); else { setMode('retry', 'conectando…'); render(); connect(); }
})();
