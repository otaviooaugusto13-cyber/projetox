// node web/tests/render.test.js — renderização dos cards reais da LAN (DOM simulado, sem navegador)
process.on('uncaughtException', e => { console.error('ERRO NO LISTENER:', e); process.exit(1); });
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');

class El {
  constructor() { this.childNodes = []; this.parent = null; this.hidden = false; this.dataset = {}; this._html = ''; this.htmlSets = 0; this.textContent = ''; this.className = '';
    const set = new Set(); this.classList = { toggle: (c, on) => (on ? set.add(c) : set.delete(c)), add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) }; }
  get innerHTML() { return this._html; } set innerHTML(v) { this._html = v; this.htmlSets++; }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() { return this.parent ? this.parent.childNodes[this.parent.childNodes.indexOf(this) + 1] || null : null; }
  insertBefore(n, ref) { if (n.parent) n.remove(); const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length; this.childNodes.splice(i, 0, n); n.parent = this; return n; }
  remove() { if (this.parent) { this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1); this.parent = null; } }
  addEventListener() {} click() {} setAttribute() {}
}
const els = new Map(); const q = s => (els.has(s) || els.set(s, new El()), els.get(s));
const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', body: new El(), querySelector: q, querySelectorAll: () => [], createElement: () => new El() });
const win = Object.assign(new EventTarget(), { isSecureContext: false });
const ctx = { window: win, document: doc, EventTarget, CustomEvent, AbortController, console, navigator: {}, location: { origin: 'http://x', protocol: 'http:', hash: '#net' },
  performance, history: { replaceState() {} }, localStorage: { getItem: () => '{}', setItem() {} }, fetch: () => new Promise(() => {}), setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Date, Math, JSON, Map, Set, Promise,
  WebSocket: class { constructor() {} send() {} close() {} } };
ctx.window = ctx; ctx.addEventListener = () => {}; ctx.isSecureContext = false;      // no navegador window === globalThis
vm.createContext(ctx);
for (const f of ['hud-core.js', 'hud-home.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), ctx);
const HUD = ctx.HUD; const S = HUD.S;

const dev = (o) => ({ name: 'x', ip: '192.168.0.2', mac: 'AA:00:00:00:00:02', online: true, status: 'online', latency_ms: 5, method: 'icmp', role: null, last_seen: Date.now() / 1000, ago: null, ...o });
const push = (lan) => { S.resumo = { ok: 1 }; S.erro = null; S.ultimo = Date.now(); S.lan = lan; S.aparelhos = []; S.ping = {}; S.scan = { scanned_at: Date.now() / 1000, subnet: '192.168.0.0/24' }; HUD.emit('data', S); };
const grid = q('#ngrid'); let n = 0; const ok = m => console.log(`ok ${++n} - ${m}`);

const A = dev({ name: 'Roteador', ip: '192.168.0.1', mac: 'AA:00:00:00:00:01', latency_ms: 12.34, role: 'Gateway' });
const B = dev({ name: 'Celular', ip: '192.168.0.23', mac: 'AA:00:00:00:00:23', latency_ms: 140 });
const C = dev({ name: 'TV', ip: '192.168.0.62', mac: 'AA:00:00:00:00:62', latency_ms: null, method: 'arp' });
push([A, B, C]);
assert.strictEqual(grid.childNodes.length, 3);
assert.match(grid.childNodes[0].innerHTML, /12\.3/); assert.match(grid.childNodes[0].innerHTML, /Gateway/); assert.match(grid.childNodes[1].innerHTML, /q-bad/); assert.match(grid.childNodes[2].innerHTML, /— ms/);
ok('renderiza um card por dispositivo com IP, MAC, status e latência (cores por faixa; sem latência = "— ms", nunca número inventado)');

const ids = [...grid.childNodes], sets = ids.map(e => e.htmlSets);
push([A, B, C]);
assert.deepStrictEqual([...grid.childNodes], ids); assert.deepStrictEqual(grid.childNodes.map(e => e.htmlSets), sets);
ok('mesma leitura = nenhum nó recriado e nenhum innerHTML reescrito (custo ~0 de CPU)');

push([A, { ...B, latency_ms: 20 }, C]);
assert.deepStrictEqual(grid.childNodes.map(e => e.htmlSets), [sets[0], sets[1] + 1, sets[2]]); assert.match(grid.childNodes[1].innerHTML, /q-good/);
ok('mudou a latência de 1 aparelho = só aquele card é atualizado');

push([A, C, { ...B, online: false, status: 'offline', latency_ms: null, ago: 99, last_seen: Date.now() / 1000 - 99 }]);
assert.strictEqual(grid.childNodes[2], ids[1]); assert.match(grid.childNodes[2].className, /is-off/); assert.match(grid.childNodes[2].innerHTML, /Offline/);
ok('dispositivo que caiu vai para o fim e fica "Offline" reaproveitando o mesmo elemento');

push([A, C]);
assert.strictEqual(grid.childNodes.length, 2); ok('dispositivo que sumiu da lista é removido do DOM');

push([]); assert.strictEqual(grid.childNodes.length, 0); assert.strictEqual(q('#nempty').hidden, false); assert.match(q('#nempty').textContent, /Nenhum dispositivo/);
ok('lista vazia com varredura concluída mostra mensagem real, sem cards');

S.scan = null; S.lan = []; HUD.emit('data', S); assert.match(q('#nempty').textContent, /inicial em andamento/);
ok('antes da 1ª varredura mostra "em andamento" em vez de "nenhum dispositivo"');

HUD.LIVE.status = 'open'; HUD.emit('live', HUD.LIVE); assert.strictEqual(q('#link').dataset.s, 'ok'); assert.strictEqual(q('#linkTxt').textContent, 'ao vivo');
HUD.LIVE.status = 'retrying'; HUD.LIVE.tries = 3; S.ultimo = Date.now() - 60000; HUD.emit('live', HUD.LIVE);
assert.strictEqual(q('#link').dataset.s, 'wait'); assert.match(q('#linkTxt').textContent, /reconectando… \(3\)/); assert.ok(doc.body.classList.contains('stale'));
ok('indicador: "ao vivo" → "reconectando… (n)" com a tela esmaecida; última leitura continua visível');
S.erro = { kind: 'auth', error: 'x' }; HUD.emit('live', HUD.LIVE); assert.strictEqual(q('#linkTxt').textContent, 'token recusado'); ok('token recusado aparece como erro, não como "reconectando"');
console.log(`\n${n} verificações passaram`);
