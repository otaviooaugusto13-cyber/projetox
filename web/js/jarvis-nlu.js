/* Jarvis · entendimento de comandos em português (puro, sem DOM: testável em Node). */
(function (root) {
  'use strict';
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  const STOP = new Set(['a', 'o', 'as', 'os', 'da', 'do', 'das', 'dos', 'de', 'e', 'no', 'na', 'nos', 'nas', 'um', 'uma', 'por', 'favor',
    'pra', 'para', 'que', 'meu', 'minha', 'ai', 'la', 'jarvis', 'rotina', 'aparelho', 'dispositivo', 'tudo']);
  const VERBS = new Set(['liga', 'ligar', 'ligue', 'acende', 'acender', 'acenda', 'ativa', 'ativar', 'ative', 'desliga', 'desligar', 'desligue',
    'apaga', 'apagar', 'apague', 'desativa', 'desativar', 'desative', 'alterna', 'alternar', 'inverte', 'inverter', 'executa', 'executar',
    'execute', 'dispara', 'disparar', 'dispare', 'roda', 'rodar', 'inicia', 'iniciar', 'inicie', 'aciona', 'acionar', 'acione']);
  const CAT_WORDS = {
    luz: ['luz', 'luzes', 'lampada', 'lampadas', 'iluminacao', 'abajur', 'fita', 'led'],
    tomada: ['tomada', 'tomadas', 'plug'], pc: ['pc', 'computador', 'notebook'], tv: ['tv', 'televisao', 'televisor'],
    alexa: ['alexa', 'echo'], ar: ['ar', 'condicionado', 'climatizador'], camera: ['camera', 'cameras'], celular: ['celular', 'telefone'],
    roteador: ['roteador', 'modem'], rotina: ['rotina', 'rotinas'],
  };
  const WAKE = /\b(?:j|g|ch|dj)[aá]r?[vb][ie][sz]\b/i;

  const stem = t => t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t;
  const SYN = {};   // sinônimos -> palavra canônica da categoria (televisão = tv, lâmpada = luz...)
  Object.values(CAT_WORDS).forEach(ws => ws.forEach(w => { SYN[stem(w)] = stem(ws[0]); }));
  const canon = t => SYN[stem(t)] || stem(t);
  const tokens = s => norm(s).split(' ').filter(t => t && !STOP.has(t) && !VERBS.has(t)).map(canon);

  /* Pontua cada aparelho pela fração de palavras do nome (e da categoria) presentes no que foi dito. */
  function match(text, devices) {
    const q = new Set(tokens(text));
    if (!q.size) return [];
    const scored = devices.map(d => {
      const nameT = tokens(d.nome);
      const cat = CAT_WORDS[d.categoria] ? canon(CAT_WORDS[d.categoria][0]) : null;
      const all = new Set([...nameT, ...(cat && !nameT.includes(cat) ? [cat] : [])]);
      const hit = [...all].filter(t => q.has(t)).length;
      const nameHit = nameT.filter(t => q.has(t)).length;
      const full = nameT.length && nameT.every(t => q.has(t));
      return { d, score: all.size ? hit / all.size : 0, nameHit, full, spec: nameT.length };
    }).filter(x => x.nameHit > 0 || (x.score >= 0.5 && x.score > 0));
    if (!scored.length) return [];
    const rank = x => x.score + (x.full ? 1 : 0) + (x.full ? x.spec * 0.1 : 0);   // empate: o nome mais específico vence
    const best = Math.max(...scored.map(rank));
    return scored.filter(x => rank(x) === best).map(x => x.d);
  }

  /* "todas as luzes" -> categoria; senão null */
  function plural(text) {
    const n = ' ' + norm(text) + ' ';
    if (!/ (todas|todos|tudo) /.test(n)) return null;
    for (const [cat, words] of Object.entries(CAT_WORDS)) if (words.some(w => n.includes(' ' + w + ' '))) return cat;
    return null;
  }

  /* Retorna { tipo, ... }. `texto` já sem a palavra de ativação. */
  function parse(texto) {
    const n = norm(texto);
    if (!n) return { tipo: 'vazio' };
    const has = re => re.test(n);
    if (has(/\b(cancela|cancelar|esquece|deixa pra la|silencio|fique quieto|para de falar)\b/)) return { tipo: 'cancelar' };
    if (has(/\bobrigad[oa]\b|\bvaleu\b/)) return { tipo: 'obrigado' };
    if (has(/\bque horas\b|\bhoras sao\b|\bhora certa\b/)) return { tipo: 'hora' };
    if (has(/\bque dia\b|\bdata de hoje\b|\bqual a data\b/)) return { tipo: 'data' };
    if (has(/\b(o que|oque) (voce|vc) (pode|sabe|faz)\b|\bajuda\b|\bcomandos\b/)) return { tipo: 'ajuda' };
    if (has(/\b(status|situacao|estado|como (esta|anda|vai)|teste|verificar|verifique|checar|cheque)\b.*\b(rede|internet|wifi|wi fi|conexao)\b/)
      || has(/^(rede|internet|wifi|wi fi)$/)) return { tipo: 'rede' };
    if (has(/\b(quais|que|quantos|quantas|verificar|verifique|checar|cheque|status|situacao|relatorio|lista|listar)\b.*\b(aparelhos?|dispositivos?)\b/)
      || has(/\b(aparelhos?|dispositivos?)\b.*\b(online|offline|conectados?|ligados?|ativos?|desconectados?)\b/)) return { tipo: 'aparelhos' };

    const off = has(/\b(desliga|desligar|desligue|apaga|apagar|apague|desativa|desativar|desative)\b/);
    const onv = !off && has(/\b(liga|ligar|ligue|acende|acender|acenda|ativa|ativar|ative)\b/);
    const tog = has(/\b(alterna|alternar|inverte|inverter)\b/);
    const exe = has(/\b(executa|executar|execute|dispara|disparar|dispare|roda|rodar|inicia|iniciar|inicie|aciona|acionar|acione)\b/) || has(/\brotina\b/);
    if (off || onv || tog || exe) {
      const acao = off ? 'desligar' : tog ? 'alternar' : (exe && !onv) ? 'acionar' : 'ligar';
      return { tipo: 'acao', acao, todas: plural(n), alvo: n, rotina: has(/\brotina\b/) };
    }
    return { tipo: 'desconhecido', texto: n };
  }

  /* Separa a palavra de ativação do resto: { achou, resto } */
  function wake(texto) {
    const m = WAKE.exec(texto || '');
    if (!m) return { achou: false, resto: texto || '' };
    return { achou: true, resto: ((texto.slice(0, m.index) + ' ' + texto.slice(m.index + m[0].length)).replace(/^[\s,.:;!?-]+|[\s,.:;!?-]+$/g, '')).trim() };
  }

  const api = { norm, parse, match, plural, wake };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.JarvisNLU = api;
})(typeof window !== 'undefined' ? window : globalThis);
