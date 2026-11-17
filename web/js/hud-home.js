/* Jarvis · tela inicial (rede + aparelhos ativos) e a aba Aparelhos. Tudo renderizado a partir do que o agente devolve. */
(() => {
  'use strict';
  const { $, $$, esc, S, LIVE, on, icon, CAT, estado, ago, acao, toast, refresh, setHTML } = HUD;
  let filtro = 'todos';

  /* ---------- relógio ---------- */
  function tick() {
    const d = new Date();
    $('#clkT').textContent = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    $('#clkD').textContent = d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  tick(); setInterval(tick, 5000);

  /* ---------- navegação ---------- */
  const VIEWS = ['home', 'devices', 'net', 'fleet'];
  function go(v) {
    if (!VIEWS.includes(v)) v = 'home';
    $$('.seg button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    $('#v-home').hidden = v !== 'home'; $('#v-devices').hidden = v !== 'devices'; $('#v-net').hidden = v !== 'net'; $('#v-fleet').hidden = v !== 'fleet';
    HUD.emit('view', v);
    try { history.replaceState(null, '', '#' + v); } catch (e) { /* ok */ }
  }
  $$('.seg button').forEach(b => b.onclick = () => go(b.dataset.v));
  $('#devAll').onclick = () => go(HUD.agentOn() ? 'devices' : 'fleet');
  go(location.hash.slice(1));

  /* ---------- acionamento (botões da interface) ---------- */
  async function toggle(id, btn) {
    const d = S.aparelhos.find(x => x.id === id); if (!d) return;
    const a = d.categoria === 'rotina' ? 'acionar' : (d.power ? 'desligar' : 'ligar');
    btn.classList.add('busy'); btn.disabled = true;
    const r = await acao(id, a);
    btn.classList.remove('busy'); btn.disabled = false;     // a lista pode não mudar (comando falhou): não deixa o botão preso
    toast(r.ok ? `${d.nome}: ${a === 'acionar' ? 'rotina acionada' : a === 'ligar' ? 'ligado' : 'desligado'}` : `${d.nome}: ${r.msg}`, !r.ok);
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (b && !b.disabled) toggle(b.dataset.act, b);
  });

  const switchBtn = d => `<button class="sw" role="switch" aria-checked="${d.power === true}" aria-label="${esc(d.nome)}" data-act="${d.id}"></button>`;

  /* ---------- link com o agente (indicador sutil de tempo real / reconexão) ---------- */
  function renderLink() {
    const l = $('#link'), t = $('#linkTxt'), set = (s, txt, title = '') => { l.dataset.s = s; t.textContent = txt; l.title = title; };
    if (!HUD.agentOn() && HUD.hubOn()) {                      // modo hub: o indicador mostra o hub, não um agente inexistente
      const h = HUD.hubStatus(); set(h.s, h.txt, h.title);
      document.body.classList.toggle('stale', !!S.hub && h.s !== 'ok');
      return;
    }
    const fresh = HUD.connectedNow();
    if (S.erro && S.erro.kind === 'auth') set('bad', 'token recusado', S.erro.error);
    else if (LIVE.status === 'open') set('ok', 'ao vivo');
    else if (fresh) set('ok', 'agente conectado', 'Tempo real indisponível: usando consulta periódica.');
    else if (S.resumo) set('wait', LIVE.tries > 1 ? `reconectando… (${LIVE.tries})` : 'reconectando…', 'Mostrando a última leitura enquanto reconecta.');
    else if (S.erro) set('bad', 'agente inacessível', S.erro.error);
    else set('wait', 'conectando…');
    document.body.classList.toggle('stale', !!S.resumo && !fresh);   // dados antigos ficam levemente esmaecidos
  }
  on('live', renderLink);
  setInterval(() => { if (document.visibilityState === 'visible') renderLink(); }, 4000);   // detecta "dado ficou velho" sem evento

  /* ---------- coluna Rede ---------- */
  /* Modo hub: coluna Rede resume a frota (o hub não mede ping de internet/roteador; nada disso é inventado aqui). */
  function renderNetHub() {
    const v = $('#netVerdict'), sub = $('#netSub'), h = S.hub, e = S.hubErro, lv = HUD.lanView();
    $('#kvNetL').textContent = 'Hub'; $('#kvGwL').textContent = 'Agentes'; $('#netFoot').textContent = 'Dados enviados pelos agentes ao hub.';
    const lanOn = lv && lv.lan ? lv.lan.filter(x => x.online).length : null;
    $('#kvLan').innerHTML = lanOn == null ? '—' : `${lanOn}<small>${lanOn === 1 ? 'dispositivo' : 'dispositivos'}</small>`;
    if (!h) {
      $('#kvNet').textContent = $('#kvGw').textContent = '—';
      if (e) { v.dataset.s = 'bad'; v.textContent = e.kind === 'auth' ? 'Token recusado' : 'Hub inacessível'; sub.textContent = e.error; }
      else { v.dataset.s = 'wait'; v.textContent = 'Conectando…'; sub.textContent = 'Consultando o hub (no plano gratuito a 1ª resposta pode demorar).'; }
      return;
    }
    const ags = h.agents, n = st => ags.filter(a => a.status === st).length, on = n('online');
    const bad = n('offline') + n('ghost'), warn = n('degraded') + n('pending');
    if (!ags.length) { v.dataset.s = 'warn'; v.textContent = 'Sem agentes'; sub.textContent = 'O hub não tem agentes cadastrados (CC_AGENTS).'; }
    else if (bad) { v.dataset.s = 'bad'; v.textContent = bad === 1 ? 'Um agente offline' : 'Agentes offline'; sub.textContent = ags.filter(a => a.status === 'offline' || a.status === 'ghost').map(a => a.name).join(', ') + ' sem enviar dados.'; }
    else if (warn) { v.dataset.s = 'warn'; v.textContent = 'Atenção'; sub.textContent = ags.filter(a => a.status !== 'online').map(a => a.name).join(', ') + ' com alerta ou aguardando.'; }
    else { v.dataset.s = 'ok'; v.textContent = 'Tudo online'; sub.textContent = 'Todos os agentes enviando dados.'; }
    if (e) sub.textContent = 'Hub sem resposta agora: mostrando a última leitura.';
    $('#kvNet').innerHTML = `${h.ms}<small>ms</small>`;
    $('#kvGw').innerHTML = `${on}<small>/ ${ags.length} online</small>`;
  }

  function renderNet() {
    if (!HUD.agentOn() && HUD.hubOn()) return renderNetHub();
    $('#kvNetL').textContent = 'Internet'; $('#kvGwL').textContent = 'Roteador'; $('#netFoot').textContent = 'Medido pelo PC onde o agente roda.';
    const v = $('#netVerdict'), sub = $('#netSub'), p = S.ping || {};
    const ms = x => x == null ? '<span class="bad">sem resposta</span>' : `${x}<small>ms</small>`;
    if (S.erro && !S.resumo) {
      v.dataset.s = 'bad'; v.textContent = S.erro.kind === 'auth' ? 'Token recusado' : 'Agente inacessível';
      sub.textContent = S.erro.error;
      $('#kvNet').textContent = $('#kvGw').textContent = $('#kvLan').textContent = '—';
      return;
    }
    if (!S.resumo) return;
    const lanOn = S.lan.filter(x => x.online).length;
    if (S.erro) { v.dataset.s = 'warn'; v.textContent = 'Dados desatualizados'; sub.textContent = 'O agente parou de responder. Mostrando a última leitura.'; }
    else if (p.internet == null && p.gateway == null) {
      if (performance.now() < 8000) { v.dataset.s = 'wait'; v.textContent = 'Medindo…'; sub.textContent = 'O agente está medindo a rede.'; }
      else { v.dataset.s = 'bad'; v.textContent = 'Sem resposta de rede'; sub.textContent = 'Nem o roteador nem a internet responderam ao ping do agente (o comando ping do PC precisa estar disponível).'; }
    }
    else if (p.gateway == null) { v.dataset.s = 'bad'; v.textContent = 'Roteador sem resposta'; sub.textContent = `Confira CC_GATEWAY no .env do agente (padrão 192.168.0.1).`; }
    else if (p.internet == null) { v.dataset.s = 'bad'; v.textContent = 'Sem internet'; sub.textContent = 'O roteador responde, mas a saída para a internet falhou.'; }
    else { v.dataset.s = 'ok'; v.textContent = 'Rede estável'; sub.textContent = p.internet > 120 ? 'Latência alta para a internet.' : 'Roteador e internet respondendo.'; }
    $('#kvNet').innerHTML = ms(p.internet);
    $('#kvGw').innerHTML = ms(p.gateway);
    $('#kvLan').innerHTML = `${lanOn}<small>${lanOn === 1 ? 'dispositivo' : 'dispositivos'}</small>`;
  }

  /* ---------- coluna Aparelhos (resumo) ---------- */
  const fcls = st => ({ online: 'on', degraded: 'warn', offline: 'off', ghost: 'ghost' }[st] || 'wait');
  const FST = { online: 'Online', degraded: 'Degradado', offline: 'Offline', ghost: 'Fantasma', pending: 'Aguardando' };
  const pc = v => v == null ? '—' : Math.round(v) + '%';
  function renderMiniHub() {                                 // coluna direita no modo hub: hardware de cada PC
    const ul = $('#devMini'), sum = $('#devSum'), all = $('#devAll'), h = S.hub;
    $('#devTitle').textContent = 'Frota';
    all.textContent = 'Abrir frota';
    if (!h) { sum.textContent = S.hubErro ? 'Sem dados do hub.' : 'Carregando…'; setHTML(ul, ''); all.hidden = true; return; }
    const on = h.agents.filter(a => a.status === 'online').length;
    sum.textContent = `${on} de ${h.agents.length} online`;
    all.hidden = !h.agents.length;
    setHTML(ul, h.agents.map(a => { const m = a.metrics || {};
      return `<li class="${a.status === 'offline' || a.status === 'ghost' ? 'is-off' : ''}"><span class="dot ${fcls(a.status)}"></span>
        <div><b>${esc(a.name)}</b><small>${a.metrics ? `CPU ${pc(m.cpu)} · RAM ${pc(m.ram)} · Disco ${pc(m.disk)}` : esc(FST[a.status] || a.status)}</small></div></li>`; }).join(''));
  }

  function renderMini() {
    if (!HUD.agentOn() && HUD.hubOn()) return renderMiniHub();
    $('#devTitle').textContent = 'Aparelhos';
    const list = S.aparelhos.filter(d => d.categoria !== 'rotina');
    const ul = $('#devMini'), sum = $('#devSum'), all = $('#devAll');
    if (!S.resumo) { sum.textContent = S.erro ? 'Sem dados do agente.' : 'Carregando…'; setHTML(ul, ''); all.hidden = true; return; }
    if (!list.length) {
      sum.textContent = '';
      setHTML(ul, `<li class="empty" style="display:block;border:0;background:none;padding:0"><p class="empty">Nenhum aparelho cadastrado ainda.</p><button class="btn" id="emptyAdd">Adicionar aparelho</button></li>`);
      $('#emptyAdd').onclick = () => $('#btnCfg').click();
      all.hidden = true; return;
    }
    const online = list.filter(d => d.online === true), off = list.filter(d => d.online === false), lig = list.filter(d => d.power === true);
    sum.textContent = `${online.length} online · ${off.length} offline${lig.length ? ` · ${lig.length} ligado${lig.length > 1 ? 's' : ''}` : ''}`;
    // essencial: o que está ligado/online primeiro; offline depois (aparece o que precisa de atenção)
    const ordem = [...lig, ...online.filter(d => d.power !== true), ...off, ...list.filter(d => d.online == null)];
    const uniq = [...new Map(ordem.map(d => [d.id, d])).values()].slice(0, 6);
    setHTML(ul, uniq.map(d => {
      const e = estado(d);
      return `<li class="${d.online === false ? 'is-off' : ''}"><span class="dot ${e.cls}"></span>
        <div><b>${esc(d.nome)}</b><small>${esc(e.pw || e.txt)}</small></div>
        ${d.controlavel ? switchBtn(d) : ''}</li>`;
    }).join(''));
    all.hidden = false; all.textContent = list.length > uniq.length ? `Ver todos (${list.length})` : 'Abrir aparelhos';
  }

  /* ---------- rotinas (faixa) ---------- */
  function renderRout() {
    const r = S.aparelhos.filter(d => d.categoria === 'rotina' && d.controlavel), el = $('#routStrip');
    el.hidden = !r.length; if (!r.length) return;
    setHTML(el, `<span class="lbl">Rotinas</span>` + r.slice(0, 6).map(d => `<button class="chip ${d.ultimo_comando && !d.ultimo_comando.ok ? 'fail' : ''}" data-act="${d.id}">${icon('rotina')}${esc(d.nome)}</button>`).join(''));
  }

  /* ---------- aba Aparelhos ---------- */
  function renderFilters() {
    const cats = [...new Set(S.aparelhos.map(d => d.categoria))];
    if (filtro !== 'todos' && !cats.includes(filtro)) filtro = 'todos';
    setHTML($('#filters'), cats.length > 1 ? ['todos', ...cats].map(c => `<button data-f="${c}" class="${filtro === c ? 'on' : ''}">${c === 'todos' ? 'Todos' : esc(CAT[c] || c)}</button>`).join('') : '');
  }
  function card(d) {
    const e = estado(d), rot = d.categoria === 'rotina', lit = d.power === true;
    const meta = [CAT[d.categoria] || d.categoria, d.ip, d.mac].filter(Boolean).join(' · ');
    const last = d.ultimo_comando ? `${d.ultimo_comando.ok ? 'Último comando' : 'Falhou'} ${ago(d.ultimo_comando.ts)}${d.ultimo_comando.ok ? '' : ': ' + d.ultimo_comando.msg}` : '';
    return `<article class="card ${d.online === false ? 'is-off' : ''} ${lit ? 'lit' : ''}">
      <div class="top"><span class="ic">${icon(d.categoria)}</span><div style="min-width:0"><h3>${esc(d.nome)}</h3><div class="meta">${esc(meta)}</div></div></div>
      <div class="st"><span class="dot ${e.cls}"></span><span>${esc(rot && !d.monitorado ? 'Rotina' : e.txt)}</span>${e.det && d.monitorado ? `<span class="meta">· ${esc(e.det)}</span>` : ''}</div>
      <div class="why">${esc(d.online === false && d.motivo ? d.motivo : '')}</div>
      <div class="row"><span class="meta">${esc(e.pw || last)}</span>
        ${d.controlavel ? (rot ? `<button class="act" data-act="${d.id}">Acionar</button>` : switchBtn(d)) : '<span class="meta">somente monitoramento</span>'}</div>
    </article>`;
  }
  function renderGrid() {
    const g = $('#dgrid');
    if (!HUD.agentOn()) { setHTML(g, '<p class="noitems">Aparelhos Smart Life/Alexa são controlados pelo agente local. Para usá-los, informe o endereço HTTPS do agente em Configurações › Conexão. O hardware dos PCs está na aba Frota.</p>'); return; }
    if (S.erro && !S.resumo) { setHTML(g, `<p class="noitems">${esc(S.erro.error)}</p>`); return; }
    if (!S.resumo) return;
    const list = S.aparelhos.filter(d => filtro === 'todos' || d.categoria === filtro);
    if (!S.aparelhos.length) { setHTML(g, '<p class="noitems">Nenhum aparelho cadastrado. Use “Novo aparelho” para começar.</p>'); return; }
    const rot = list.filter(d => d.categoria === 'rotina'), outros = list.filter(d => d.categoria !== 'rotina');
    setHTML(g, outros.map(card).join('') + (rot.length ? `<div class="sechead">Rotinas</div>` + rot.map(card).join('') : ''));
  }
  $('#filters').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (b) { filtro = b.dataset.f; renderFilters(); renderGrid(); } });
  $('#devAdd').onclick = () => { $('#btnCfg').click(); setTimeout(() => window.HUDSettings && HUDSettings.novo(), 50); };

  /* ---------- aba Rede: um card por dispositivo REAL da LAN (vem do array rede.lan do agente) ---------- */
  const METODO = { icmp: 'ping', tcp: 'TCP', arp: 'tabela ARP', local: 'este computador' };
  const quality = ms => ms == null ? '' : ms < 30 ? 'q-good' : ms < 100 ? 'q-mid' : 'q-bad';
  const nodes = new Map();                                   // mac -> { el, sig }  (reconciliação por chave)

  function lanCard(d) {
    const on = d.online === true;
    const lat = d.latency_ms != null ? `<span class="lat ${quality(d.latency_ms)}">${d.latency_ms.toFixed(1)}<small> ms</small></span>`
      : `<span class="lat none">${on ? '— ms' : ''}</span>`;
    const how = on ? (METODO[d.method] || '') : (d.last_seen ? `visto ${ago(d.last_seen)}` : 'sem sinal');
    const ic = d.role === 'Gateway' ? 'roteador' : d.role === 'Este PC' ? 'pc' : 'outro';
    return `<div class="top"><span class="ic">${icon(ic)}</span><div style="min-width:0"><h3>${esc(d.name)}${d.role ? `<span class="tag">${esc(d.role)}</span>` : ''}</h3>
        <div class="meta">${esc(d.ip)} · ${esc(d.mac)}</div></div></div>
      <div class="st"><span class="dot ${on ? 'on' : 'off'}"></span><span>${on ? 'Online' : 'Offline'}</span></div>
      <div class="row">${lat}<span class="meta">${esc(how)}</span></div>`;
  }
  function renderLan() {
    const grid = $('#ngrid'), msg = $('#nempty'), sum = $('#netSummary');
    const say = t => { msg.hidden = !t; msg.textContent = t || ''; };
    const lv = HUD.lanView();                                // agente (se conectado) ou hub
    if (!lv) { const e = S.erro || S.hubErro; say(e ? e.error : 'Carregando…'); sum.textContent = ''; if (e) clearLan(); return; }
    const LAN = lv.lan, on = LAN.filter(d => d.online).length, sc = lv.scan;
    sum.textContent = sc ? `${on} online · ${LAN.length - on} offline · ${sc.subnet || 'rede local'} · varredura ${ago(sc.scanned_at)}${lv.hub && sc.from ? ' · via ' + sc.from : ''}` : '';
    say(!sc ? (lv.hub ? 'Nenhum agente enviou a lista de dispositivos ao hub ainda. Aguarde a 1ª varredura (o agente precisa estar com CC_NET_SCAN=on).' : 'Varredura inicial em andamento… os dispositivos aparecem em instantes.')
      : !LAN.length ? 'Nenhum dispositivo respondeu na varredura.' : '');
    const seen = new Set(); let prev = null;
    for (const d of LAN) {
      seen.add(d.mac);
      let n = nodes.get(d.mac);
      if (!n) { const el = document.createElement('article'); n = { el, sig: '' }; nodes.set(d.mac, n); }
      const cls = `card net ${d.online ? '' : 'is-off'}`, html = lanCard(d), sig = cls + html;
      if (n.sig !== sig) { n.el.className = cls; n.el.innerHTML = html; n.sig = sig; }   // só o card que mudou
      const want = prev ? prev.nextSibling : grid.firstChild;
      if (n.el !== want) grid.insertBefore(n.el, want);   // só mexe na ordem quando ela mudou
      prev = n.el;
    }
    for (const [k, n] of nodes) if (!seen.has(k)) { n.el.remove(); nodes.delete(k); }
  }
  function clearLan() { for (const n of nodes.values()) n.el.remove(); nodes.clear(); }

  on('data', () => {
    renderLink(); renderNet(); renderMini(); renderRout(); renderFilters(); renderGrid(); renderLan();
  });
  HUD.startPolling();
})();
