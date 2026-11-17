// node web/tests/live.test.js  — testa o transporte ao vivo do hud-core.js com WebSocket/relógio simulados (sem navegador)
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');

function harness() {
  let now = 1_000_000, id = 0; const timers = new Map();
  const fake = {
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: now + ms, ms, every: 0 }); return id; },
    setInterval: (fn, ms) => { timers.set(++id, { fn, at: now + ms, ms, every: ms }); return id; },
    clearTimeout: i => timers.delete(i), clearInterval: i => timers.delete(i),
  };
  const advance = ms => {
    const end = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [i, t] = next; now = t.at;
      if (t.every) t.at += t.every; else timers.delete(i);
      t.fn();
    }
    now = end;
  };
  const sockets = []; let fetches = 0;
  class WS { constructor(url) { this.url = url; this.sent = []; sockets.push(this); } send(d) { this.sent.push(JSON.parse(d)); } close() { this.closed = true; } }
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', querySelector() { return null; }, querySelectorAll() { return []; } });
  const win = Object.assign(new EventTarget(), { isSecureContext: false, WebSocket: WS });
  const ctx = {
    window: win, document: doc, WebSocket: WS, EventTarget, CustomEvent, AbortController, console,
    localStorage: { getItem: () => JSON.stringify({ endpoint: 'http://192.168.0.5:5000', token: 'tok' }), setItem() {} },
    navigator: {}, location: { origin: 'http://192.168.0.5:5000', protocol: 'http:' },
    fetch: async () => { fetches++; return { status: 200, ok: true, json: async () => ({ ts: 1, rede: { lan: [], ping: {} }, aparelhos: [] }) }; },
    Date: { now: () => now }, Math, JSON, Map, Set, Promise,
    ...fake,
  };
  ctx.window.document = doc; ctx.window.navigator = ctx.navigator; ctx.window.addEventListener = win.addEventListener.bind(win);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'hud-core.js'), 'utf8'), ctx);
  return { HUD: ctx.window.HUD, sockets, advance, doc, win, fetches: () => fetches, timers };
}
const msg = (ws, o) => ws.onmessage({ data: JSON.stringify(o) });
const tick = () => new Promise(r => setImmediate(r));
let n = 0; const ok = name => console.log(`ok ${++n} - ${name}`);

(async () => {
  { // 1) conecta, autentica e recebe estado real
    const h = harness(); h.HUD.startPolling();
    assert.strictEqual(h.sockets.length, 1); assert.strictEqual(h.sockets[0].url, 'ws://192.168.0.5:5000/ws/live');
    h.sockets[0].onopen(); assert.deepStrictEqual(h.sockets[0].sent[0], { type: 'auth', token: 'tok' });
    msg(h.sockets[0], { type: 'hello', v: 1 });
    msg(h.sockets[0], { type: 'state', seq: 1, data: { ts: 1, rede: { lan: [{ mac: 'AA', ip: '1.1.1.1', online: true, latency_ms: 3.2 }], ping: { gateway: 2 }, scan: { scanned_at: 1, subnet: 'x' } }, aparelhos: [] } });
    assert.strictEqual(h.HUD.LIVE.status, 'open'); assert.strictEqual(h.HUD.S.lan[0].latency_ms, 3.2);
    ok('conecta, envia token na 1ª mensagem (não na URL) e aplica o array real');
    const f0 = h.fetches(); h.advance(30000); assert.strictEqual(h.fetches(), f0, 'WS aberto = sem polling');
    ok('com o WebSocket aberto o polling HTTP fica parado');
  }
  { // 2) queda -> backoff exponencial com teto de 30 s + polling de fallback
    const h = harness(); h.HUD.startPolling();
    const delays = [];
    for (let i = 0; i < 8; i++) {
      const s = h.sockets[h.sockets.length - 1]; s.onclose({ code: 1006 });
      assert.strictEqual(h.HUD.LIVE.status, 'retrying'); delays.push(h.HUD.LIVE.nextIn);
      h.advance(h.HUD.LIVE.nextIn + 1);
    }
    delays.forEach((d, i) => { assert.ok(d >= 500 && d <= Math.min(30000, 1000 * 2 ** i), `delay[${i}]=${d}`); });
    assert.ok(Math.max(...delays) <= 30000);
    ok('backoff exponencial com jitter, nunca acima de 30 s: ' + delays.join(', '));
    assert.ok(h.fetches() > 0); ok('enquanto reconecta, o polling lento busca dados reais');
  }
  { // 3) sessão estável zera o backoff
    const h = harness(); h.HUD.startPolling();
    let s = h.sockets[0]; s.onclose({ code: 1006 }); h.advance(h.HUD.LIVE.nextIn + 1);
    s = h.sockets[1]; s.onopen(); msg(s, { type: 'hello' }); h.advance(11000); s.onclose({ code: 1006 });
    assert.strictEqual(h.HUD.LIVE.tries, 1); ok('conexão estável por ≥10 s zera o backoff');
  }
  { // 4) token recusado: para de tentar
    const h = harness(); h.HUD.startPolling();
    h.sockets[0].onclose({ code: 4001 }); h.advance(120000);
    assert.strictEqual(h.sockets.length, 1); assert.strictEqual(h.HUD.LIVE.status, 'auth'); ok('4001 (token recusado) não entra em loop de reconexão');
  }
  { // 5) watchdog: silêncio de 20 s derruba e reconecta
    const h = harness(); h.HUD.startPolling();
    const s = h.sockets[0]; s.onopen(); msg(s, { type: 'hello' });
    h.advance(26000); assert.ok(s.closed, 'fechou o socket mudo'); assert.strictEqual(h.HUD.LIVE.status, 'retrying'); h.advance(31000);
    assert.strictEqual(h.sockets.length, 2); ok('watchdog detecta conexão meio-aberta e reconecta');
  }
  { // 6) aba oculta fecha tudo; ao voltar reconecta na hora
    const h = harness(); h.HUD.startPolling();
    const s = h.sockets[0]; s.onopen(); msg(s, { type: 'hello' });
    await tick(); await tick();                     // deixa o fetch inicial (do startPoll) terminar e limpar o timer de aborto
    h.doc.visibilityState = 'hidden'; h.doc.dispatchEvent(new Event('visibilitychange'));
    assert.ok(s.closed); assert.strictEqual(h.timers.size, 0, 'nenhum timer vivo com a tela apagada'); h.advance(600000); assert.strictEqual(h.sockets.length, 1);
    h.doc.visibilityState = 'visible'; h.doc.dispatchEvent(new Event('visibilitychange'));
    assert.strictEqual(h.sockets.length, 2); ok('tela apagada = zero timers/socket; ao acordar reconecta imediatamente');
  }
  console.log(`\n${n} verificações passaram`);
})().catch(e => { console.error(e); process.exit(1); });
