/* Jarvis · voz (Web Speech API pt-BR), personalidade e execução de comandos reais no agente.
 * Reconhecimento e síntese rodam no navegador (Chrome/Edge). O microfone exige HTTPS ou localhost
 * (ou o endereço liberado em chrome://flags/#unsafely-treat-insecure-origin-as-secure). */
(() => {
  'use strict';
  const { $, cfg, S, api, acao, refresh, toast } = HUD;
  const NLU = window.JarvisNLU;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const core = $('#core'), hint = $('#coreHint'), heardEl = $('#heard'), saidEl = $('#said');

  let state = 'idle';
  let rec = null, wantRec = false, mode = 'wake';          // mode: 'wake' (escuta contínua) | 'tap' (um comando)
  let awaitUntil = 0, pending = null, speaking = false, restartT = null, fails = 0;

  const setState = s => { state = s; core.dataset.state = s; updateHint(); };
  function updateHint(msg, warn) {
    hint.classList.toggle('warn', !!warn);
    if (msg) { hint.textContent = msg; return; }
    if (state === 'listening') hint.textContent = mode === 'wake' && Date.now() > awaitUntil ? 'Aguardando “Jarvis”…' : 'Estou ouvindo…';
    else if (state === 'thinking') hint.textContent = 'Processando…';
    else if (state === 'speaking') hint.textContent = '';
    else if (!SR) hint.textContent = 'Este navegador não reconhece voz. Use o Chrome ou digite o comando.';
    else if (!window.isSecureContext) { hint.textContent = 'O microfone precisa de HTTPS. Veja Configurações › Jarvis.'; hint.classList.add('warn'); }
    else hint.textContent = cfg.escuta ? 'Escuta contínua ligada. Diga “Jarvis” ou toque no núcleo.' : 'Toque no núcleo para falar';
  }

  /* ---------- fala ---------- */
  const T = () => (cfg.tratamento || 'senhor').trim() || 'senhor';
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const fmt = s => s.replace(/\{t\}/g, T());
  let voices = [];
  const loadVoices = () => { voices = (window.speechSynthesis ? speechSynthesis.getVoices() : []).filter(v => /^pt/i.test(v.lang)); };
  if (window.speechSynthesis) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
  function bestVoice() {
    if (cfg.voz) { const v = voices.find(x => x.name === cfg.voz); if (v) return v; }
    const br = voices.filter(v => /pt[-_]BR/i.test(v.lang));
    return br.find(v => /daniel|antonio|ricardo|felipe|male|masc/i.test(v.name)) || br.find(v => /google/i.test(v.name)) || br[0] || voices[0] || null;
  }
  function say(text) {
    text = fmt(text);
    saidEl.textContent = text;
    return new Promise(res => {
      if (!cfg.falar || !window.speechSynthesis) { res(); return; }
      try { speechSynthesis.cancel(); } catch (e) { /* ok */ }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'pt-BR'; u.rate = +cfg.velocidade || 1; u.pitch = +cfg.tom || 0.85;
      const v = bestVoice(); if (v) u.voice = v;
      speaking = true; pauseRec(); setState('speaking');
      const done = () => { if (!speaking) return; speaking = false; setState('idle'); resumeRec(); res(); };
      u.onend = done; u.onerror = done;
      setTimeout(done, Math.min(30000, 2500 + text.length * 110));      // rede de segurança se o navegador não disparar onend
      speechSynthesis.speak(u);
    });
  }

  /* ---------- reconhecimento ---------- */
  function ensureRec() {
    if (rec || !SR) return rec;
    rec = new SR();
    rec.lang = 'pt-BR'; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) heard(e.results[i][0].transcript);
    };
    rec.onerror = e => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      fails++;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        wantRec = false; cfg.escuta = false; HUD.saveCfg(); setState('error');
        updateHint('Microfone bloqueado. Permita o acesso ao microfone para este endereço (e use HTTPS).', true);
      } else if (e.error === 'audio-capture') { wantRec = false; setState('error'); updateHint('Nenhum microfone encontrado.', true); }
      else if (e.error === 'network') { wantRec = false; setState('error'); updateHint('O reconhecimento de voz do Chrome precisa de internet.', true); }
    };
    rec.onend = () => {
      if (state === 'listening') setState('idle');
      if (wantRec && !speaking) { clearTimeout(restartT); restartT = setTimeout(startRec, Math.min(4000, 300 + fails * 700)); }
    };
    return rec;
  }
  function startRec() {
    if (!SR || !window.isSecureContext || speaking) return;
    ensureRec();
    rec.continuous = mode === 'wake';
    try { rec.start(); setState('listening'); fails = Math.max(0, fails - 1); } catch (e) { /* já estava rodando */ }
  }
  function pauseRec() { clearTimeout(restartT); if (rec) { try { rec.abort(); } catch (e) { /* ok */ } } }
  function resumeRec() { if (wantRec) { clearTimeout(restartT); restartT = setTimeout(startRec, 350); } }
  function stopRec() { wantRec = false; clearTimeout(restartT); if (rec) { try { rec.abort(); } catch (e) { /* ok */ } } if (state === 'listening') setState('idle'); }

  /* escuta contínua (palavra de ativação) — chamada pelas configurações */
  function setContinuous(on) {
    cfg.escuta = !!on; HUD.saveCfg();
    if (on && SR && window.isSecureContext) { mode = 'wake'; wantRec = true; startRec(); } else if (!on) { stopRec(); }
    updateHint();
  }

  /* um comando: toque no núcleo */
  function listenOnce() {
    if (!SR || !window.isSecureContext) { updateHint(); toast(!SR ? 'Este navegador não reconhece voz. Digite o comando.' : 'O microfone precisa de HTTPS. Veja Configurações › Jarvis.', true); return; }
    try { speechSynthesis && speechSynthesis.cancel(); } catch (e) { /* ok */ }
    speaking = false; pauseRec();
    mode = 'tap'; wantRec = true; awaitUntil = Date.now() + 9000;
    setTimeout(() => { startRec(); }, 150);
    setTimeout(() => { if (mode === 'tap' && state === 'listening') { wantRec = cfg.escuta; mode = cfg.escuta ? 'wake' : 'tap'; if (!cfg.escuta) stopRec(); } }, 9000);
  }

  function heard(raw) {
    const text = String(raw || '').trim();
    if (!text) return;
    const w = NLU.wake(text);
    const inWindow = Date.now() < awaitUntil;
    if (mode === 'wake' && !w.achou && !inWindow && !pending) return;       // ignora conversa alheia
    heardEl.textContent = `“${text}”`;
    if (mode === 'tap') { wantRec = cfg.escuta; mode = cfg.escuta ? 'wake' : 'tap'; if (!cfg.escuta) pauseRec(); }
    const cmd = w.achou ? w.resto : text;
    if (w.achou && !NLU.norm(cmd)) {
      awaitUntil = Date.now() + 8000;
      say(pick(['Pois não, {t}.', 'À sua disposição, {t}.', 'Às ordens, {t}.', 'Sim, {t}?']));
      return;
    }
    run(cmd);
  }

  /* ---------- execução ---------- */
  const lista = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' e ' + a[a.length - 1];
  const nomeFala = d => d.nome;
  const FEM = new Set(['luz', 'tomada', 'camera', 'alexa', 'rotina']);        // concordância de gênero: "ligada" x "ligado"
  const fem = ds => ds.every(d => FEM.has(d.categoria));

  async function run(texto) {
    setState('thinking');
    try {
      if (pending) {                                               // resposta a "qual deles?"
        const p = pending; pending = null;
        const m = NLU.match(texto, p.candidatos);
        if (m.length === 1) return await executar(p.acao, m);
        if (/cancel|nenhum|esquece/i.test(NLU.norm(texto))) return say('Cancelado, {t}.');
      }
      const it = NLU.parse(texto);
      switch (it.tipo) {
        case 'vazio': return say('Não ouvi nada, {t}.');
        case 'cancelar': return say(pick(['Certo, {t}.', 'Cancelado, {t}.']));
        case 'obrigado': return say(pick(['Às ordens, {t}.', 'Sempre um prazer, {t}.']));
        case 'hora': { const d = new Date(); return say(`São ${d.getHours()} horas e ${d.getMinutes()} minutos, {t}.`); }
        case 'data': return say('Hoje é ' + new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }) + ', {t}.');
        case 'ajuda': return say('Posso ligar e desligar seus aparelhos, disparar rotinas, informar o estado da rede e dos dispositivos. Por exemplo: ligar a luz da sala, ou status da rede.');
        case 'rede': return await relatorioRede();
        case 'aparelhos': return await relatorioAparelhos();
        case 'acao': return await comando(it);
        default: return say('Desculpe, {t}, não compreendi o comando.');
      }
    } catch (e) {
      setState('error'); say('Houve uma falha interna, {t}: ' + (e && e.message ? e.message : 'erro desconhecido') + '.');
    }
  }

  async function relatorioRede() {
    await say('Verificando a rede, {t}.');
    const r = await refresh();
    if (!r.ok) return say(`Não consigo falar com o agente, {t}. ${r.error}`);
    const p = S.ping || {}, on = S.lan.filter(x => x.online).length;
    const partes = [];
    if (p.internet == null) partes.push('Sem conectividade com a internet');
    else partes.push(`Internet operante, ${p.internet} milissegundos`);
    partes.push(p.gateway == null ? 'o roteador não respondeu' : `roteador em ${p.gateway} milissegundos`);
    partes.push(`${on} ${on === 1 ? 'dispositivo ativo' : 'dispositivos ativos'} na rede local`);
    return say(lista(partes).replace(/^./, c => c.toUpperCase()) + ', {t}.');
  }

  async function relatorioAparelhos() {
    await say('Verificando dispositivos na rede, {t}.');
    await api('/api/home/atualizar', { method: 'POST' });
    await new Promise(r => setTimeout(r, 3500));
    const r = await refresh();
    if (!r.ok) return say(`Não consigo falar com o agente, {t}. ${r.error}`);
    const d = S.aparelhos.filter(x => x.categoria !== 'rotina');
    if (!d.length) return say('Não há aparelhos cadastrados, {t}. Abra as configurações para adicionar.');
    const off = d.filter(x => x.online === false), on = d.filter(x => x.online === true), sem = d.filter(x => x.online == null);
    let t = `${on.length} de ${d.length} aparelhos online`;
    if (off.length) t += `. Offline: ${lista(off.map(nomeFala))}`;
    if (sem.length) t += `. Sem monitoramento: ${sem.length}`;
    return say(t + ', {t}.');
  }

  async function comando(it) {
    const todos = S.aparelhos;
    if (!todos.length) return say('Ainda não há aparelhos cadastrados, {t}.');
    if (it.todas) {
      const alvo = todos.filter(d => d.categoria === it.todas && d.controlavel);
      if (!alvo.length) return say('Não encontrei aparelhos controláveis dessa categoria, {t}.');
      return await executar(it.acao, alvo);
    }
    const cand = NLU.match(it.alvo, todos);
    if (!cand.length) return say('Não encontrei esse aparelho, {t}.');
    if (cand.length > 1) {
      pending = { acao: it.acao, candidatos: cand };
      awaitUntil = Date.now() + 9000;
      if (mode === 'tap') { mode = 'tap'; wantRec = true; }
      await say(`Encontrei ${cand.length}: ${lista(cand.map(nomeFala))}. Qual deles, {t}?`);
      if (wantRec || cfg.escuta) { mode = cfg.escuta ? 'wake' : 'tap'; wantRec = true; resumeRec(); }
      return;
    }
    return await executar(it.acao, cand);
  }

  async function executar(a, alvos) {
    const ok = [], falhas = [], avisos = [];
    for (const d of alvos) {
      if (!d.controlavel) { falhas.push(`${nomeFala(d)} não tem acionamento configurado`); continue; }
      const real = d.categoria === 'rotina' ? 'acionar' : (a === 'acionar' ? 'ligar' : a);
      const r = await acao(d.id, real);
      if (r.ok) {
        ok.push({ d, real });
        const novo = S.aparelhos.find(x => x.id === d.id);
        if (novo && novo.online === false && real !== 'acionar') avisos.push(`${nomeFala(d)} consta offline na rede`);
      } else falhas.push(`${nomeFala(d)}: ${r.msg}`);
    }
    let t = '';
    if (ok.length) {
      const v = ok[0].real;
      const nomes = lista(ok.map(x => nomeFala(x.d)));
      t = v === 'acionar' ? (ok.length > 1 ? `Rotinas ${nomes} acionadas` : `Rotina ${nomes} acionada`)
        : (() => { const f = fem(ok.map(x => x.d)), pl = ok.length > 1, sfx = (f ? 'a' : 'o') + (pl ? 's' : ''); return `${nomes} ${v === 'ligar' ? 'ligad' : v === 'desligar' ? 'desligad' : 'alternad'}${sfx}`; })();
      t += ', {t}.';
    }
    if (avisos.length) t += ' Atenção: ' + lista(avisos) + '.';
    if (falhas.length) t += ' Não consegui: ' + falhas.join('; ') + '.';
    return say(t.trim() || 'Nada a fazer, {t}.');
  }

  /* ---------- eventos da interface ---------- */
  core.addEventListener('click', () => {
    if (speaking) { try { speechSynthesis.cancel(); } catch (e) { /* ok */ } return; }
    if (state === 'listening' && mode === 'tap') { stopRec(); return; }
    if (state === 'listening' && mode === 'wake') { awaitUntil = Date.now() + 9000; say('Pois não, {t}.'); return; }
    listenOnce();
  });
  $('#typeForm').addEventListener('submit', e => {
    e.preventDefault();
    const i = $('#typeIn'), v = i.value.trim(); if (!v) return;
    i.value = ''; const w = NLU.wake(v); heardEl.textContent = `“${v}”`; run(w.achou ? w.resto || 'ajuda' : v);
  });

  updateHint();
  if (cfg.escuta && SR && window.isSecureContext) {
    // O Chrome só libera fala/microfone depois de um toque: espera o primeiro toque na tela para ligar a escuta contínua.
    const arm = () => { document.removeEventListener('pointerdown', arm, true); setContinuous(true); };
    document.addEventListener('pointerdown', arm, true);
    updateHint('Toque em qualquer ponto para ativar a escuta contínua.');
  }

  window.Jarvis = { say, run, setContinuous, supported: !!SR, voices: () => { loadVoices(); return voices; }, updateHint };
})();
