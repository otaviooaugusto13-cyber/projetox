/* Jarvis · núcleo: configuração local, cliente da API do agente, estado compartilhado, utilitários.
 * Nenhum dado fictício: tudo vem do agente (agent.py) na sua rede. Sem agente, a tela mostra o erro real. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- configuração (localStorage) ---------- */
  const KEY = 'jv.cfg';
  // hubUrl/hubToken: hub de telemetria na nuvem (Render). hubToken = CC_VIEWER_TOKEN (token de LEITURA; nunca a chave do agente).
  const DEF = { endpoint: '', token: '', hubUrl: 'https://command-center-hub.onrender.com', hubToken: '', tratamento: 'senhor', falar: true, escuta: false, voz: '', velocidade: 1, tom: 0.85 };
  const cfg = { ...DEF };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* armazenamento bloqueado */ }
  const saveCfg = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); return true; } catch (e) { return false; } };

  /* ---------- eventos ---------- */
  const bus = new EventTarget();
  const on = (n, fn) => bus.addEventListener(n, e => fn(e.detail));
  const emit = (n, d) => bus.dispatchEvent(new CustomEvent(n, { detail: d }));

  /* ---------- modos de conexão ----------
   * Hub  : painel no Render lê o hub (HTTPS) com o token de leitura. Não procura agente nenhum.
   * Agente: endereço do agente informado (aparelhos Smart Life/Alexa, voz) OU painel servido pelo próprio agente (nada configurado).
   * Com o hub configurado e sem endereço de agente, NENHUMA chamada vai ao agente (antes iam à mesma origem do Render → HTTP 404). */
  const hubBase = () => (cfg.hubUrl || '').trim().replace(/\/+$/, '');
  const hubOn = () => !!(cfg.hubToken && hubBase());
  // Endereço http:// guardado de antes + painel em HTTPS = o Chrome SEMPRE bloqueia (mixed content). Com hub configurado, ignora-o em vez de mostrar "Agente inacessível".
  const agentBlocked = () => location.protocol === 'https:' && /^http:\/\/(?!localhost|127\.0\.0\.1)/i.test((cfg.endpoint || '').trim());
  const agentOn = () => (cfg.endpoint || '').trim() ? !(hubOn() && agentBlocked()) : !hubOn();

  /* ---------- API do agente ---------- */
  const base = () => (cfg.endpoint || '').trim().replace(/\/+$/, '');
  const NOAGENT = { ok: false, kind: 'noagent', error: 'Nenhum agente local configurado. Aparelhos e comandos dependem do agente: informe o endereço HTTPS dele em Configurações › Conexão.' };
  async function api(path, { method = 'GET', body, timeout = 9000 } = {}) {
    if (!agentOn()) return { ...NOAGENT };
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(base() + path, {
        method, signal: ctl.signal, cache: 'no-store',
        headers: { 'X-CC-Token': cfg.token || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json().catch(() => null);
      if (r.status === 401) return { ok: false, kind: 'auth', error: 'Token recusado pelo agente. Confira o token em Configurações › Conexão.' };
      if (r.status === 404 && !base()) return { ok: false, kind: 'http', status: 404, data, error: 'Este endereço não é um agente (HTTP 404). Se o painel está no Render, configure o Hub em Configurações › Conexão (URL do hub + token de leitura).' };
      if (!r.ok) return { ok: false, kind: 'http', status: r.status, data, error: (data && (data.error || data.msg)) || `O agente respondeu HTTP ${r.status}` };
      return { ok: true, data };
    } catch (e) {
      const mixed = location.protocol === 'https:' && /^http:\/\//i.test(base());
      return { ok: false, kind: 'net', error: e.name === 'AbortError' ? 'O agente não respondeu a tempo.'
        : mixed ? 'O navegador bloqueou a chamada HTTP a partir de uma página HTTPS (mixed content). Abra o painel pelo endereço do agente ou use um endpoint HTTPS.'
        : 'Não foi possível alcançar o agente. Confira o endereço, se o agent.py está rodando e o firewall.' };
    } finally { clearTimeout(tm); }
  }

  /* ---------- estado ---------- */
  const S = { resumo: null, erro: null, ultimo: 0, lan: [], aparelhos: [], ping: {}, scan: null,
              hub: null, hubErro: null, hubUltimo: 0, hubLan: [], hubScan: null };
  const LIVE = { status: 'idle', tries: 0, nextIn: 0 };   // idle | connecting | open | retrying | auth | unsupported
  const FRESH_MS = 12000;                                   // dado mais velho que isso = "desatualizado"

  /* Atualiza o DOM só se o HTML mudou: em dias de uso contínuo evita milhares de reflows inúteis. */
  function setHTML(el, html) { if (el._h === html) return false; el._h = html; el.innerHTML = html; return true; }

  function apply(d) {                                       // ÚNICO ponto que grava dados do agente em S (WS e polling)
    S.resumo = d; S.erro = null; S.ultimo = Date.now();
    S.aparelhos = d.aparelhos || [];
    const r = d.rede || {};
    S.lan = r.lan || []; S.ping = r.ping || {}; S.scan = r.scan || null;
    emit('data', S);
  }

  /* ---------- polling HTTP: só é usado quando o WebSocket NÃO está aberto ---------- */
  let pollT = null, inflight = null;
  function refresh() {
    if (!agentOn()) return Promise.resolve({ ...NOAGENT });   // modo hub: sem agente, sem chamada (e sem "Agente inacessível" na tela)
    if (inflight) return inflight;
    inflight = api('/api/home/resumo').then(r => {
      if (r.ok) apply(r.data); else { S.erro = r; emit('data', S); }
      return r;
    }).finally(() => { inflight = null; });
    return inflight;
  }
  function startPoll(ms) {
    if (pollT) return;
    pollT = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, ms);
    refresh();
  }
  function stopPoll() { clearInterval(pollT); pollT = null; }

  /* ---------- tempo real: WebSocket com backoff exponencial + jitter ---------- */
  const BASE_MS = 1000, CAP_MS = 30000, STABLE_MS = 10000, WATCHDOG_MS = 20000;
  let ws = null, retryT = null, wdT = null, openedAt = 0, lastMsg = 0, wantLive = false;

  const setLive = (status, extra) => { Object.assign(LIVE, { status }, extra); emit('live', LIVE); };
  const wsUrl = () => {
    const b = base() || location.origin;
    if (!/^https?:/i.test(b)) return null;                  // file:// ou origem opaca: sem WebSocket
    return b.replace(/^http/i, 'ws') + '/ws/live';
  };
  // "full jitter": evita vários painéis reconectando no mesmo instante depois de uma queda do agente
  const delay = n => Math.round(BASE_MS / 2 + Math.random() * (Math.min(CAP_MS, BASE_MS * 2 ** n) - BASE_MS / 2));

  function teardown(sock) {                                 // fecha sem esperar o handshake (socket meio-aberto)
    if (!sock) return;
    sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
    try { sock.close(); } catch (e) { /* já fechado */ }
  }
  function scheduleRetry() {
    clearTimeout(retryT); clearInterval(wdT);
    if (!wantLive || document.visibilityState !== 'visible') return;
    const ms = delay(Math.max(0, LIVE.tries - 1));   // 1ª falha -> ≤1 s, depois 2, 4, 8… até 30 s
    setLive('retrying', { nextIn: ms });
    startPoll(5000);                                        // enquanto reconecta, o polling lento mantém dados reais ou o erro real
    retryT = setTimeout(connect, ms);
  }
  function connect() {
    clearTimeout(retryT);
    if (!wantLive || ws || document.visibilityState !== 'visible') return;
    const url = wsUrl();
    if (!('WebSocket' in window) || !url) { setLive('unsupported'); startPoll(3000); return; }
    setLive(LIVE.tries ? 'retrying' : 'connecting');
    let sock;
    try { sock = new WebSocket(url); } catch (e) { LIVE.tries++; scheduleRetry(); return; }
    ws = sock; openedAt = 0;
    sock.onopen = () => {
      openedAt = lastMsg = Date.now();
      sock.send(JSON.stringify({ type: 'auth', token: cfg.token || '' }));   // token fora da URL (não vai pra logs)
      clearInterval(wdT);
      wdT = setInterval(() => {                             // o servidor manda algo a cada ≤5 s; silêncio = conexão morta
        if (Date.now() - lastMsg > WATCHDOG_MS) { teardown(sock); ws = null; LIVE.tries++; scheduleRetry(); }
      }, 5000);
    };
    sock.onmessage = ev => {
      lastMsg = Date.now();
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'hello') { stopPoll(); setLive('open', { nextIn: 0 }); }
      else if (m.type === 'state' && m.data) { if (LIVE.status !== 'open') { stopPoll(); setLive('open'); } apply(m.data); }
    };
    sock.onerror = () => { /* o onclose sempre vem em seguida */ };
    sock.onclose = ev => {
      if (ws !== sock) return;
      ws = null; clearInterval(wdT);
      if (ev.code === 4001 || ev.code === 4003) {           // token/origem recusados: tentar de novo não adianta
        wantLive = false; setLive(ev.code === 4001 ? 'auth' : 'unsupported'); startPoll(5000); return;   // o polling mostra o erro real
      }
      if (openedAt && Date.now() - openedAt >= STABLE_MS) LIVE.tries = 0;   // sessão estável: zera o backoff
      LIVE.tries++;
      scheduleRetry();
    };
  }
  function startLive() { wantLive = true; LIVE.tries = 0; connect(); }
  function reconnect() {                                    // após mudar endpoint/token/hub, ou voltar a rede
    teardown(ws); ws = null; clearTimeout(retryT); LIVE.tries = 0; stopPoll();
    if (agentOn()) { wantLive = true; connect(); refresh(); }
    else {                                                  // só hub: esquece qualquer dado/erro antigo do agente
      wantLive = false; setLive('idle');
      Object.assign(S, { resumo: null, erro: null, ultimo: 0, lan: [], aparelhos: [], ping: {}, scan: null });
    }
    stopHub(); if (hubOn()) startHub(); else Object.assign(S, { hub: null, hubErro: null, hubUltimo: 0, hubLan: [], hubScan: null });
    emit('data', S);
  }
  /* Tela apagada/aba oculta: fecha tudo (zero bateria); ao voltar, reconecta na hora e já pede um dado. */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { if (agentOn()) { LIVE.tries = 0; startPoll(5000); connect(); } }   // o hello do WS para o polling
    else { clearTimeout(retryT); clearInterval(wdT); stopPoll(); teardown(ws); ws = null; if (LIVE.status !== 'auth') setLive('idle'); }
  });
  window.addEventListener('online', () => { if (wantLive || hubOn()) reconnect(); });
  const connectedNow = () => LIVE.status === 'open' || (S.ultimo && !S.erro && Date.now() - S.ultimo < FRESH_MS);

  /* ---------- HUB (telemetria na nuvem): polling HTTPS de /api/v1/fleet + /api/v1/network ----------
   * Polling (não SSE) de propósito: os agentes enviam a cada ~15 s, então 5 s já é "ao vivo", e o Render free
   * atravessa requisições curtas sem problema. Só roda com a tela visível. */
  const HUB_POLL_MS = 5000, HUB_STALE_MS = 25000;
  let hubT = null, hubInflight = null, hubStopped = false;

  async function hubApi(path, timeout = 20000) {            // 1ª chamada após o hub "dormir" no plano free pode levar ~30 s
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(hubBase() + path, { signal: ctl.signal, cache: 'no-store', headers: { Authorization: 'Bearer ' + cfg.hubToken } });
      const data = await r.json().catch(() => null);
      if (r.status === 401) return { ok: false, kind: 'auth', error: 'Token de leitura recusado pelo hub. Use o CC_VIEWER_TOKEN do Render (não o token do agente nem a chave-mestra).' };
      if (r.status === 429) return { ok: false, kind: 'rate', error: 'O hub bloqueou temporariamente (muitas tentativas). Aguarde 1 minuto.' };
      if (!r.ok) return { ok: false, kind: 'http', status: r.status, error: `O hub respondeu HTTP ${r.status}.${r.status === 404 ? ' Confira a URL do hub em Configurações › Conexão.' : ''}` };
      return { ok: true, data };
    } catch (e) {
      return { ok: false, kind: 'net', error: e.name === 'AbortError'
        ? 'O hub não respondeu a tempo (no plano gratuito ele pode estar acordando; tentando de novo).'
        : 'Não foi possível alcançar o hub. Confira a URL e se a origem deste painel está em CC_ALLOWED_ORIGINS no Render (bloqueio de CORS aparece assim).' };
    } finally { clearTimeout(tm); }
  }

  function applyHub(fleet, net, ms) {                       // ÚNICO ponto que grava dados do hub em S
    S.hub = { agents: fleet.agents || [], events: fleet.events || [], ts: fleet.server_ts, rx: Date.now(), ms };
    S.hubErro = null; S.hubUltimo = Date.now();
    // Lista de dispositivos da LAN: vem do agente que fez a varredura mais recente (o hub só repassa o que o agente enviou).
    const withNet = ((net && net.agents) || []).filter(a => a.network && Array.isArray(a.network.devices))
      .sort((a, b) => b.network.scanned_at - a.network.scanned_at);
    const pick = withNet[0];
    S.hubScan = pick ? { scanned_at: pick.network.scanned_at, subnet: pick.network.subnet, from: pick.name } : null;
    S.hubLan = pick ? pick.network.devices.map(d => ({
      ip: d.ip, mac: d.mac, name: d.name, online: d.status === 'online', status: d.status,
      latency_ms: d.latency_ms, method: d.method, last_seen: d.last_seen, role: null })) : [];
    emit('data', S);
  }

  function hubRefresh() {
    if (!hubOn()) return Promise.resolve({ ok: false, kind: 'nohub' });
    if (hubInflight) return hubInflight;
    const t0 = Date.now();
    hubInflight = (async () => {
      const f = await hubApi('/api/v1/fleet');
      if (!f.ok) {
        S.hubErro = f; emit('data', S);
        // Token errado: PARA de insistir. O hub conta falhas por IP e o IP público da sua casa é o mesmo do agente.
        if (f.kind === 'auth') stopHub(true);
        return f;
      }
      const n = await hubApi('/api/v1/network');            // auxiliar: se falhar, métricas continuam
      applyHub(f.data, n.ok ? n.data : null, Date.now() - t0);
      return f;
    })().finally(() => { hubInflight = null; });
    return hubInflight;
  }
  function startHub() {
    hubStopped = false;
    if (hubT || !hubOn()) return;
    hubT = setInterval(() => { if (!hubStopped && document.visibilityState === 'visible') hubRefresh(); }, HUB_POLL_MS);
    hubRefresh();
  }
  function stopHub(authFail) { clearInterval(hubT); hubT = null; hubStopped = !!authFail; }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && hubOn() && !hubStopped) { startHub(); hubRefresh(); } });

  /* Estado do link com o hub para a barra superior. */
  function hubStatus() {
    if (!hubOn()) return null;
    const e = S.hubErro, fresh = S.hub && Date.now() - S.hubUltimo < HUB_STALE_MS;
    if (e && e.kind === 'auth') return { s: 'bad', txt: 'token do hub recusado', title: e.error };
    if (S.hub && !e && fresh) return { s: 'ok', txt: 'hub conectado', title: 'Dados dos agentes via hub, atualizados a cada 5 s.' };
    if (S.hub) return { s: 'wait', txt: 'hub: reconectando…', title: (e && e.error) || 'Mostrando a última leitura enquanto reconecta.' };
    if (e) return { s: 'bad', txt: 'hub inacessível', title: e.error };
    return { s: 'wait', txt: 'conectando ao hub…', title: '' };
  }
  const lanView = () => S.resumo ? { lan: S.lan, scan: S.scan, hub: false } : S.hub ? { lan: S.hubLan, scan: S.hubScan, hub: true } : null;

  function startPolling() { if (agentOn()) { startLive(); startPoll(3000); } if (hubOn()) startHub(); }   // nome mantido: hud-home.js continua chamando startPolling()

  /* ---------- ações compartilhadas (UI e voz) ---------- */
  async function acao(id, a) {
    const r = await api(`/api/home/devices/${encodeURIComponent(id)}/acao`, { method: 'POST', body: { acao: a }, timeout: 15000 });
    const d = r.data || {};
    const res = { ok: !!(r.ok && d.ok), msg: d.msg || r.error || 'falha desconhecida', device: d.device || null, acao: d.acao || a };
    await refresh();
    return res;
  }

  /* ---------- apresentação ---------- */
  const ICONS = {
    luz: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6M10 22h4"/>',
    tomada: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>',
    pc: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    tv: '<rect x="2" y="5" width="20" height="13" rx="2"/><path d="M8 21h8M9 2l3 3 3-3"/>',
    alexa: '<rect x="5" y="2" width="14" height="20" rx="5"/><circle cx="12" cy="14" r="3"/><path d="M12 6h.01"/>',
    ar: '<path d="M12 2v20M4.9 7l14.2 10M19.1 7 4.9 17"/>',
    camera: '<path d="M3 7h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H3z"/><path d="M17 11l4-2v6l-4-2"/>',
    celular: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
    roteador: '<rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 17h.01M11 17h.01M8.5 10.5a5 5 0 0 1 7 0M6 8a8.5 8.5 0 0 1 12 0"/>',
    rotina: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    outro: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 12h6"/>',
  };
  const CAT = { luz: 'Luz', tomada: 'Tomada', pc: 'Computador', tv: 'Smart TV', alexa: 'Alexa', ar: 'Ar-condicionado (IR)', camera: 'Câmera', celular: 'Celular', roteador: 'Roteador', rotina: 'Rotina', outro: 'Outro' };
  const icon = c => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[c] || ICONS.outro}</svg>`;

  const ago = ts => {
    const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
    return s < 60 ? 'agora' : s < 3600 ? `há ${Math.floor(s / 60)} min` : `há ${Math.floor(s / 3600)} h`;
  };
  /* Estado legível de um aparelho (vem do agente; nada é inventado aqui). */
  function estado(d) {
    let cls = 'wait', txt = 'Verificando…', det = '';
    if (!d.monitorado) { txt = 'Sem monitoramento'; det = 'Informe o IP para monitorar'; }
    else if (d.online === true) {
      cls = 'on'; txt = 'Online';
      const l = d.lan;
      if (l && l.metodo === 'ping') det = `ping ${l.ms} ms`;
      else if (l && l.metodo && l.metodo.startsWith('tcp')) det = 'responde por TCP (ping bloqueado)';
      else if (l && l.metodo === 'arp') det = 'visto na tabela ARP';
      else if (!d.ip) det = 'confirmado pela nuvem Tuya';
    } else if (d.online === false) { cls = 'off'; txt = 'Offline'; det = d.motivo || 'sem resposta'; }
    else if (d.motivo) { det = d.motivo; }
    let pw = '';
    if (d.power === true) pw = 'Ligado'; else if (d.power === false) pw = 'Desligado';
    if (pw && d.power_fonte === 'ultimo_comando') pw += ' (último comando)';
    return { cls, txt, det, pw };
  }

  let toastT;
  function toast(msg, bad) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), bad ? 5000 : 2800);
  }

  /* ---------- PWA: service worker e tela sempre ligada ---------- */
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  let lock = null;
  async function keepAwake() { try { if ('wakeLock' in navigator && document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen'); } catch (e) { /* sem suporte */ } }
  document.addEventListener('visibilitychange', keepAwake); keepAwake();

  window.HUD = { $, $$, esc, cfg, saveCfg, api, S, LIVE, on, emit, refresh, startPolling, reconnect, connectedNow, setHTML, FRESH_MS, acao, icon, ICONS, CAT, estado, ago, toast,
                 hubOn, agentOn, hubRefresh, hubStatus, lanView, HUB_STALE_MS };
})();
