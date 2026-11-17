// node web/tests/hub.test.js — modo HUB do painel (sem navegador): nada de chamadas ao agente, polling do hub, token errado para de insistir, telas Frota/Rede
process.on('uncaughtException', e => { console.error('ERRO NO LISTENER:', e); process.exit(1); });
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');

class El {
  constructor() { this.childNodes = []; this.parent = null; this.hidden = false; this.dataset = {}; this._html = ''; this.textContent = ''; this.className = '';
    const set = new Set(); this.classList = { toggle: (c, on) => (on ? set.add(c) : set.delete(c)), add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) }; }
  get innerHTML() { return this._html; } set innerHTML(v) { this._html = v; }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() { return this.parent ? this.parent.childNodes[this.parent.childNodes.indexOf(this) + 1] || null : null; }
  insertBefore(n, ref) { if (n.parent) n.remove(); const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length; this.childNodes.splice(i, 0, n); n.parent = this; return n; }
  remove() { if (this.parent) { this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1); this.parent = null; } }
  addEventListener() {} click() {} setAttribute() {}
}
const FLEET = { server_ts: 1763160000, events: [{ id: 1, ts: 1763159990, level: 'warn', kind: 'x', agent: null, ip: '1.2.3.4', msg: 'Painel com token inválido', count: 2 }],
  agents: [
    { id: 'pc-principal', name: 'PC Principal', status: 'online', reasons: [], age_s: 4, version: '4.0.0', host: { hostname: 'DESKTOP-01' }, interval_s: 15,
      metrics: { cpu: 34.2, ram: 52.1, disk: 91, rtt_ms: 24, uptime_s: 93000 }, services: [{ name: 'Docker', ok: true, critical: false }], history: [[1, 10, 1], [2, 40, 1], [3, 30, 1]], net: { online: 5, total: 7, scanned_at: 1 } },
    { id: 'notebook', name: 'Notebook', status: 'offline', reasons: [{ sev: 'crit', msg: 'Sem heartbeat há 90 s' }], age_s: 90, version: '4.0.0', host: { hostname: '<img src=x>' }, interval_s: 15, metrics: null, services: [], history: [], net: null } ] };
const NET = { agents: [{ id: 'pc-principal', name: 'PC Principal', network: { scanned_at: 1763159999, subnet: '192.168.0.0/24', devices: [
  { ip: '192.168.0.1', mac: 'AA:00:00:00:00:01', name: 'Roteador', status: 'online', latency_ms: 3.1, method: 'icmp', last_seen: 1763159999 },
  { ip: '192.168.0.9', mac: 'AA:00:00:00:00:09', name: 'TV', status: 'offline', latency_ms: null, method: null, last_seen: 1763100000 } ] } }, { id: 'notebook', name: 'Notebook', network: null }] };

function harness({ store, fetchImpl }) {
  let now = 1_000_000, id = 0; const timers = new Map(), calls = [];
  const fake = {
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: now + ms, every: 0 }); return id; },
    setInterval: (fn, ms) => { timers.set(++id, { fn, at: now + ms, every: ms }); return id; },
    clearTimeout: i => timers.delete(i), clearInterval: i => timers.delete(i) };
  const advance = async ms => { const end = now + ms; for (;;) { const nx = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!nx) break;
    const [i, t] = nx; now = t.at; if (t.every) t.at += t.every; else timers.delete(i); t.fn(); await new Promise(r => setImmediate(r)); } now = end; };
  const els = new Map(); const q = s => (els.has(s) || els.set(s, new El()), els.get(s));
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', body: new El(), querySelector: q, querySelectorAll: () => [], createElement: () => new El() });
  const ctx = { document: doc, EventTarget, CustomEvent, AbortController, console, navigator: {}, location: { origin: 'https://tablet-oq65.onrender.com', protocol: 'https:', hash: '#home' },
    performance, history: { replaceState() {} }, localStorage: { getItem: () => JSON.stringify(store), setItem() {} }, Date: class extends Date { static now() { return now; } }, Math, JSON, Map, Set, Promise,
    fetch: async (url, opt) => { calls.push({ url, opt }); return fetchImpl(url, opt); }, WebSocket: class { constructor() { throw new Error('WS não deveria abrir em modo hub'); } }, ...fake };
  ctx.window = ctx; ctx.addEventListener = () => {}; ctx.isSecureContext = true;
  vm.createContext(ctx);
  for (const f of ['hud-core.js', 'hud-home.js', 'hud-fleet.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), ctx);
  return { HUD: ctx.HUD, calls, advance, q };
}
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const hubFetch = (url, opt) => /\/api\/v1\/fleet$/.test(url) ? json(200, FLEET) : /\/api\/v1\/network$/.test(url) ? json(200, NET) : json(404, { ok: false });
const tick = () => new Promise(r => setImmediate(r));
let n = 0; const ok = m => console.log(`ok ${++n} - ${m}`);

(async () => {
  { // 1) só hub configurado: nenhuma chamada ao agente/mesma origem, token vai no cabeçalho Bearer
    const h = harness({ store: { hubUrl: 'https://command-center-hub.onrender.com/', hubToken: 'VIEWER' }, fetchImpl: hubFetch });
    assert.strictEqual(h.HUD.hubOn(), true); assert.strictEqual(h.HUD.agentOn(), false);
    h.HUD.startPolling(); await tick(); await tick();
    assert.ok(h.calls.length >= 2, 'consultou fleet e network');
    h.calls.forEach(c => { assert.match(c.url, /^https:\/\/command-center-hub\.onrender\.com\/api\/v1\/(fleet|network)$/); assert.strictEqual(c.opt.headers.Authorization, 'Bearer VIEWER'); });
    assert.ok(!h.calls.some(c => /api\/home|\/ws\/live|:5000/.test(c.url)), 'nenhuma chamada ao agente');
    ok('só hub: chama apenas /api/v1/fleet e /api/v1/network com Bearer; nada de /api/home, WebSocket ou :5000');
    assert.strictEqual(h.HUD.S.hub.agents.length, 2); assert.strictEqual(h.HUD.S.hubLan.length, 2); assert.strictEqual(h.HUD.S.hubLan[0].online, true); assert.strictEqual(h.HUD.S.hubLan[1].online, false);
    ok('dados do hub aplicados (agentes + LAN do agente que varreu)');
    assert.strictEqual(h.HUD.hubStatus().s, 'ok'); assert.strictEqual(h.q('#linkTxt').textContent, 'hub conectado'); assert.strictEqual(h.q('#link').dataset.s, 'ok');
    ok('indicador da barra mostra "hub conectado" (não "agente inacessível")');
    const c0 = h.calls.length; await h.advance(11000); assert.ok(h.calls.length >= c0 + 4, 'polling a cada 5 s'); ok('polling de 5 s mantém os dados atualizados');

    const html = h.q('#fgrid').innerHTML;
    assert.match(html, /PC Principal/); assert.match(html, /34%/); assert.match(html, /fbar bad/); assert.match(html, /polyline/); assert.match(html, /5 de 7 na rede/);
    assert.doesNotMatch(html, /<img src=x>/); assert.match(html, /&lt;img src=x&gt;/);
    ok('aba Frota: CPU/RAM/disco, barra vermelha ≥90 %, sparkline, rede; texto do hub escapado (sem HTML injetado)');
    assert.match(h.q('#fgrid').innerHTML, /Offline/); assert.match(h.q('#fev').innerHTML, /token inválido/); assert.match(h.q('#fev').innerHTML, /×2/);
    ok('agente offline aparece como Offline e o feed de eventos mostra o alerta com contador');

    assert.strictEqual(h.q('#netVerdict').dataset.s, 'bad'); assert.match(h.q('#netVerdict').textContent, /offline/i); assert.strictEqual(h.q('#kvNetL').textContent, 'Hub');
    assert.match(h.q('#devMini').innerHTML, /CPU 34%/); assert.strictEqual(h.q('#devTitle').textContent, 'Frota');
    ok('Início: coluna Rede resume a frota e a coluna direita mostra o hardware de cada PC');
    assert.strictEqual(h.q('#ngrid').childNodes.length, 2); assert.match(h.q('#netSummary').textContent, /via PC Principal/);
    ok('aba Rede lista os dispositivos reais que o agente enviou ao hub');
    const r = await h.HUD.api('/api/home/resumo'); assert.strictEqual(r.kind, 'noagent'); assert.ok(!h.calls.some(c => /api\/home/.test(c.url)));
    ok('comandos de aparelho sem agente falham com mensagem clara, sem bater na mesma origem (antes: HTTP 404)');
  }
  { // 2) token errado: mostra erro real e PARA de insistir (o hub conta falhas por IP)
    const h = harness({ store: { hubUrl: 'https://hub.example', hubToken: 'ERRADO' }, fetchImpl: () => json(401, { ok: false }) });
    h.HUD.startPolling(); await tick(); await tick();
    assert.strictEqual(h.HUD.S.hubErro.kind, 'auth'); assert.strictEqual(h.q('#link').dataset.s, 'bad'); assert.match(h.q('#netVerdict').textContent, /Token recusado/);
    const c0 = h.calls.length; await h.advance(60000); assert.strictEqual(h.calls.length, c0, 'sem novas tentativas');
    ok('token de leitura inválido: erro claro e polling parado (não gera 429 que derrubaria o heartbeat do agente)');
  }
  { // 3) hub fora do ar / CORS: erro real, e volta sozinho quando o hub responde
    let up = false; const h = harness({ store: { hubUrl: 'https://hub.example', hubToken: 'T' }, fetchImpl: (u, o) => { if (!up) throw new TypeError('Failed to fetch'); return hubFetch(u, o); } });
    h.HUD.startPolling(); await tick(); await tick();
    assert.strictEqual(h.HUD.S.hubErro.kind, 'net'); assert.match(h.HUD.S.hubErro.error, /CC_ALLOWED_ORIGINS/); assert.strictEqual(h.q('#link').dataset.s, 'bad');
    up = true; await h.advance(6000); await tick();
    assert.strictEqual(h.HUD.S.hubErro, null); assert.strictEqual(h.q('#link').dataset.s, 'ok');
    ok('falha de rede/CORS mostra a causa provável e se recupera sozinha quando o hub responde');
  }
  { // 4) hub E agente: agente continua sendo usado (aparelhos), hub alimenta a Frota
    const h = harness({ store: { hubUrl: 'https://hub.example', hubToken: 'T', endpoint: 'https://pc.tail.ts.net', token: 'AG' }, fetchImpl: (u, o) => /hub\.example/.test(u) ? hubFetch(u, o) : json(200, { ts: 1, rede: { lan: [], ping: {} }, aparelhos: [] }) });
    assert.strictEqual(h.HUD.agentOn(), true); assert.strictEqual(h.HUD.hubOn(), true); ok('com hub + endereço do agente, os dois ficam ativos');
  }
  { // 5) nada configurado (comportamento antigo, painel servido pelo agente): continua falando com a mesma origem
    const h = harness({ store: {}, fetchImpl: () => json(200, { ts: 1, rede: { lan: [], ping: {} }, aparelhos: [] }) });
    assert.strictEqual(h.HUD.hubOn(), false); assert.strictEqual(h.HUD.agentOn(), true); ok('sem hub configurado nada muda: modo agente como antes');
  }
  { // 6) painel no Render sem configuração: o 404 vira instrução, não "agente inacessível"
    const h = harness({ store: {}, fetchImpl: () => json(404, null) });
    const r = await h.HUD.api('/api/home/resumo'); assert.strictEqual(r.status, 404); assert.match(r.error, /configure o Hub/);
    ok('HTTP 404 na mesma origem orienta a configurar o hub');
  }
  console.log(`\n${n} verificações passaram`);
})().catch(e => { console.error(e); process.exit(1); });
