/* Jarvis · núcleo: configuração local, cliente da API do agente, estado compartilhado, utilitários.
 * Nenhum dado fictício: tudo vem do agente (agent.py) na sua rede. Sem agente, a tela mostra o erro real. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- configuração (localStorage) ---------- */
  const KEY = 'jv.cfg';
  const DEF = { endpoint: '', token: '', tratamento: 'senhor', falar: true, escuta: false, voz: '', velocidade: 1, tom: 0.85 };
  const cfg = { ...DEF };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* armazenamento bloqueado */ }
  const saveCfg = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); return true; } catch (e) { return false; } };

  /* ---------- eventos ---------- */
  const bus = new EventTarget();
  const on = (n, fn) => bus.addEventListener(n, e => fn(e.detail));
  const emit = (n, d) => bus.dispatchEvent(new CustomEvent(n, { detail: d }));

  /* ---------- API do agente ---------- */
  const base = () => (cfg.endpoint || '').trim().replace(/\/+$/, '');
  async function api(path, { method = 'GET', body, timeout = 9000 } = {}) {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(base() + path, {
        method, signal: ctl.signal, cache: 'no-store',
        headers: { 'X-CC-Token': cfg.token || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json().catch(() => null);
      if (r.status === 401) return { ok: false, kind: 'auth', error: 'Token recusado pelo agente. Confira o token em Configurações › Conexão.' };
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
  const S = { resumo: null, erro: null, ultimo: 0, lan: [], aparelhos: [], ping: {}, scan: null };
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
  function reconnect() {                                    // após mudar endpoint/token, ou voltar a rede
    teardown(ws); ws = null; clearTimeout(retryT); LIVE.tries = 0; stopPoll();
    wantLive = true; connect(); refresh();
  }
  /* Tela apagada/aba oculta: fecha tudo (zero bateria); ao voltar, reconecta na hora e já pede um dado. */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { LIVE.tries = 0; startPoll(5000); connect(); }   // o hello do WS para o polling
    else { clearTimeout(retryT); clearInterval(wdT); stopPoll(); teardown(ws); ws = null; if (LIVE.status !== 'auth') setLive('idle'); }
  });
  window.addEventListener('online', () => { if (wantLive) reconnect(); });
  const connectedNow = () => LIVE.status === 'open' || (S.ultimo && !S.erro && Date.now() - S.ultimo < FRESH_MS);

  function startPolling() { startLive(); startPoll(3000); }   // nome mantido: hud-home.js continua chamando startPolling()

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

  window.HUD = { $, $$, esc, cfg, saveCfg, api, S, LIVE, on, emit, refresh, startPolling, reconnect, connectedNow, setHTML, FRESH_MS, acao, icon, ICONS, CAT, estado, ago, toast };
})();
