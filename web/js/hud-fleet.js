/* Jarvis · aba Frota: hardware (CPU/RAM/disco), saúde e alertas de cada PC, lidos do HUB (nuvem).
 * Nada é inventado aqui: tudo vem de /api/v1/fleet (S.hub). Todo texto do hub passa por esc() antes de entrar no DOM. */
(() => {
  'use strict';
  const { $, $$, esc, S, on, icon, setHTML } = HUD;

  const ST = { online: 'Online', degraded: 'Degradado', offline: 'Offline', ghost: 'Fantasma', pending: 'Aguardando' };
  const DOT = { online: 'on', degraded: 'warn', offline: 'off', ghost: 'ghost', pending: 'wait' };
  const lvl = v => v == null ? '' : v >= 90 ? 'bad' : v >= 70 ? 'mid' : 'good';
  const ago = s => s == null ? '—' : s < 90 ? Math.round(s) + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : Math.round(s / 3600) + ' h';
  const hhmm = t => new Date(t * 1000).toLocaleTimeString('pt-BR');
  const upt = s => s == null ? '—' : s >= 86400 ? Math.floor(s / 86400) + 'd ' + Math.floor(s % 86400 / 3600) + 'h' : s >= 3600 ? Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm' : Math.floor(s / 60) + ' min';

  const bar = (label, v) => `<div class="fbar ${lvl(v)}"><span>${label}</span><div class="ftrack"><i style="width:${v == null ? 0 : Math.max(0, Math.min(100, v))}%"></i></div><b>${v == null ? '—' : Math.round(v) + '%'}</b></div>`;
  function spark(h) {                                        // h = [[ts, cpu, ram], ...]
    if (!h || h.length < 2) return '';
    const pts = h.map((r, i) => `${(i * 200 / (h.length - 1)).toFixed(1)},${(48 - Math.min(Math.max(r[1], 0), 100) / 100 * 42).toFixed(1)}`);
    return `<svg viewBox="0 0 200 50" preserveAspectRatio="none" class="fspk" aria-label="CPU nos últimos minutos"><polyline points="${pts.join(' ')}"/></svg>`;
  }

  function card(a) {
    const m = a.metrics || {}, off = a.status === 'offline' || a.status === 'ghost';
    const reasons = (a.reasons || []).filter(r => r.sev !== 'info').map(r => `<li class="${esc(r.sev)}">${esc(r.msg)}</li>`).join('');
    const svcs = (a.services || []).map(s => `<span class="fchip"><span class="dot ${s.ok ? 'on' : 'off'}"></span>${esc(s.name)}</span>`).join('');
    const net = a.net ? `${a.net.online} de ${a.net.total} na rede` : '';
    return `<article class="card fleet ${off ? 'is-off' : ''}" data-id="${esc(a.id)}">
      <div class="top"><span class="ic">${icon('pc')}</span><div style="min-width:0"><h3>${esc(a.name)}</h3>
        <div class="meta">${esc(a.id)} · v${esc(a.version || '?')} · ${esc((a.host && a.host.hostname) || '?')}</div></div></div>
      <div class="st"><span class="dot ${DOT[a.status] || 'wait'}"></span><span>${esc(ST[a.status] || a.status)}</span>
        <span class="meta">· último heartbeat <b class="age" data-id="${esc(a.id)}">—</b></span></div>
      ${bar('CPU', m.cpu)}${bar('RAM', m.ram)}${bar('Disco', m.disk)}
      <div class="row"><span class="meta">latência até o hub ${m.rtt_ms == null ? '—' : Math.round(m.rtt_ms) + ' ms'}</span><span class="meta">uptime ${upt(m.uptime_s)}</span></div>
      ${spark(a.history)}
      ${svcs || net ? `<div class="fchips">${svcs}${net ? `<span class="fchip">${esc(net)}</span>` : ''}</div>` : ''}
      ${reasons ? `<ul class="freasons">${reasons}</ul>` : ''}
    </article>`;
  }

  function tickAges() {
    if (!S.hub) return;
    $$('#fgrid .age').forEach(n => {
      const a = S.hub.agents.find(x => x.id === n.dataset.id); if (!a) return;
      n.textContent = a.age_s == null ? 'nunca' : 'há ' + ago(a.age_s + (Date.now() - S.hub.rx) / 1000);
    });
  }

  function render() {
    const g = $('#fgrid'), msg = $('#fleetMsg'), sum = $('#fleetSum'), evh = $('#fevH'), ev = $('#fev');
    const say = t => { msg.hidden = !t; msg.textContent = t || ''; };
    if (!HUD.hubOn()) {
      say('Hub de telemetria não configurado. Abra Configurações › Conexão e informe a URL do hub e o token de leitura (CC_VIEWER_TOKEN).');
      sum.textContent = ''; setHTML(g, ''); evh.hidden = true; setHTML(ev, ''); return;
    }
    const h = S.hub;
    if (!h) { say(S.hubErro ? S.hubErro.error : 'Consultando o hub…'); sum.textContent = ''; setHTML(g, ''); evh.hidden = true; setHTML(ev, ''); return; }
    say(S.hubErro ? 'Hub sem resposta agora: mostrando a última leitura. ' + S.hubErro.error : (h.agents.length ? '' : 'O hub não tem agentes cadastrados (variável CC_AGENTS no Render).'));
    const n = s => h.agents.filter(a => a.status === s).length;
    sum.textContent = ['online', 'degraded', 'offline', 'ghost'].filter(s => n(s)).map(s => `${n(s)} ${ST[s].toLowerCase()}`).join(' · ') || '';
    setHTML(g, [...h.agents].sort((a, b) => a.name.localeCompare(b.name)).map(card).join(''));
    evh.hidden = !h.events.length;
    setHTML(ev, h.events.slice().reverse().map(e => `<li class="${e.level === 'crit' ? 'bad' : e.level === 'warn' ? 'warn' : ''}"><time>${hhmm(e.ts)}</time><span>${esc(e.msg)}${e.count > 1 ? ` <b>×${e.count}</b>` : ''}${e.ip ? ` <em>${esc(e.ip)}</em>` : ''}</span></li>`).join(''));
    tickAges();
  }

  on('data', render);
  on('view', v => { if (v === 'fleet') { render(); if (HUD.hubOn()) HUD.hubRefresh(); } });
  setInterval(() => { if (document.visibilityState === 'visible') tickAges(); }, 1000);
  render();
})();
