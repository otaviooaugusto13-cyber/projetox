/* Jarvis · Configurações: CRUD de aparelhos (salvo no agente, em aparelhos.json), conexão, voz e integrações. */
(() => {
  'use strict';
  const { $, $$, esc, cfg, saveCfg, api, S, icon, CAT, toast, refresh } = HUD;
  const dlg = $('#cfg');
  let tab = 'devs', editing = null, delArm = null, integ = null;

  const TIPOS = {
    nenhum: 'Somente monitorar (ping)',
    tuya: 'Smart Life / Tuya: liga e desliga',
    tuya_cena: 'Smart Life / Tuya: cena ou automação',
    webhook: 'Webhook / rotina Alexa (Voice Monkey, IFTTT…)',
  };

  const show = t => {
    tab = t;
    $$('#cfgTabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    ['devs', 'conn', 'voice', 'integ'].forEach(x => $('#p-' + x).hidden = x !== t);
    ({ devs: paneDevs, conn: paneConn, voice: paneVoice, integ: paneInteg })[t]();
  };
  $('#cfgTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { editing = null; show(b.dataset.t); } });
  $('#btnCfg').onclick = () => { editing = null; show(tab); dlg.showModal(); };
  $('#cfgClose').onclick = () => dlg.close();
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  HUD.on('data', () => { if (dlg.open && tab === 'devs' && !editing) paneDevs(); });

  /* ====================== APARELHOS ====================== */
  function paneDevs() {
    const p = $('#p-devs');
    if (editing) return form(p);
    const lista = S.aparelhos;
    const known = new Set(lista.map(d => d.ip).filter(Boolean));
    const found = (S.lan || []).filter(x => x.online && !known.has(x.ip) && x.role !== 'Gateway');
    p.innerHTML = `
      <div class="actions" style="margin:0 0 14px"><button class="btn" id="dNew">Novo aparelho</button></div>
      ${S.erro && !S.resumo ? `<p class="err">${esc(S.erro.error)}</p>` : ''}
      <h3>Cadastrados (${lista.length})</h3>
      <div class="list">${lista.length ? lista.map(d => `
        <div class="item"><span class="ic">${icon(d.categoria)}</span>
          <div><b>${esc(d.nome)}</b><small>${esc([CAT[d.categoria], d.ip, TIPOS[d.tipo]].filter(Boolean).join(' · '))}</small></div>
          <div class="btns"><button class="btn ghost" data-ed="${d.id}">Editar</button>
          <button class="btn danger" data-rm="${d.id}">${delArm === d.id ? 'Confirmar remoção' : 'Remover'}</button></div></div>`).join('')
        : '<p>Nenhum aparelho cadastrado.</p>'}</div>
      <h3>Encontrados na rede, ainda não cadastrados (${found.length})</h3>
      <p>Lista real da varredura ARP do agente. Toque em Adicionar para pré-preencher nome e IP.</p>
      <div class="list">${found.length ? found.map(x => `
        <div class="item"><span class="ic">${icon('outro')}</span>
          <div><b>${esc(x.name)}</b><small>${esc(x.ip)} · ${esc(x.mac)}</small></div>
          <div class="btns"><button class="btn ghost" data-ad="${esc(x.ip)}">Adicionar</button></div></div>`).join('')
        : '<p>Nada novo encontrado agora.</p>'}</div>`;
    $('#dNew').onclick = () => novo();
    p.onclick = async e => {
      const ed = e.target.closest('[data-ed]'), rm = e.target.closest('[data-rm]'), ad = e.target.closest('[data-ad]');
      if (ed) { editing = { ...S.aparelhos.find(d => d.id === ed.dataset.ed) }; paneDevs(); }
      else if (ad) { const x = found.find(f => f.ip === ad.dataset.ad); novo({ nome: x.name === 'Dispositivo desconhecido' ? '' : x.name, ip: x.ip }); }
      else if (rm) {
        if (delArm !== rm.dataset.rm) { delArm = rm.dataset.rm; paneDevs(); setTimeout(() => { if (delArm === rm.dataset.rm) { delArm = null; if (tab === 'devs' && !editing) paneDevs(); } }, 4000); return; }
        const r = await api('/api/home/devices/' + encodeURIComponent(delArm), { method: 'DELETE' }); delArm = null;
        toast(r.ok ? 'Aparelho removido' : r.error, !r.ok); await refresh(); paneDevs();
      }
    };
  }

  function novo(pre) { editing = { nome: '', ip: '', categoria: 'luz', tipo: 'nenhum', tuya_id: '', tuya_home: '', webhook_on: '', webhook_off: '', ...(pre || {}), _novo: true }; show('devs'); if (!dlg.open) dlg.showModal(); }

  function form(p) {
    const d = editing, rot = d.categoria === 'rotina';
    const opt = (o, sel) => Object.entries(o).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
    p.onclick = null;
    p.innerHTML = `
      <h3>${d._novo ? 'Novo aparelho' : 'Editar aparelho'}</h3>
      <div class="two">
        <div class="field"><label for="fNome">Nome</label><input id="fNome" value="${esc(d.nome)}" maxlength="60" placeholder="Luz da sala"></div>
        <div class="field"><label for="fCat">Categoria</label><select id="fCat">${opt(CAT, d.categoria)}</select></div>
      </div>
      <div class="field"><label for="fIp">IP local (para monitorar o status)</label><input id="fIp" inputmode="decimal" value="${esc(d.ip)}" placeholder="192.168.0.25"><small>Opcional. Dica: reserve o IP do aparelho no roteador para ele não mudar.</small></div>
      <div class="field"><label for="fTipo">Como acionar</label><select id="fTipo">${opt(TIPOS, d.tipo)}</select></div>
      <div id="fTuya" hidden>
        <div class="two">
          <div class="field"><label for="fTid" id="fTidL">ID do aparelho no Smart Life / Tuya</label><input id="fTid" value="${esc(d.tuya_id)}" placeholder="bf1234abcd5678efgh" autocapitalize="off" spellcheck="false"><small>Console Tuya IoT › Devices (ou app Smart Life › aparelho › detalhes).</small></div>
          <div class="field" id="fHomeW" hidden><label for="fHome">ID da casa (opcional)</label><input id="fHome" value="${esc(d.tuya_home)}" autocapitalize="off" spellcheck="false"></div>
        </div>
      </div>
      <div id="fHook" hidden>
        <div class="field"><label for="fOn" id="fOnL">Webhook de ligar</label><input id="fOn" value="${esc(d.webhook_on)}" placeholder="voicemonkey:luz-sala-ligar  ou  https://…" autocapitalize="off" spellcheck="false"></div>
        <div class="field" id="fOffW"><label for="fOff">Webhook de desligar</label><input id="fOff" value="${esc(d.webhook_off)}" placeholder="voicemonkey:luz-sala-desligar" autocapitalize="off" spellcheck="false">
          <small>Aceita URL completa, <code>voicemonkey:ID_DO_MONKEY</code> ou <code>ifttt:evento</code> (o token fica no .env do agente).</small></div>
      </div>
      <p class="err" id="fErr"></p>
      <div class="actions"><button class="btn" id="fSave">Salvar</button><button class="btn ghost" id="fCancel">Cancelar</button></div>`;
    const sync = () => {
      const t = $('#fTipo').value, c = $('#fCat').value;
      $('#fTuya').hidden = !(t === 'tuya' || t === 'tuya_cena'); $('#fHook').hidden = t !== 'webhook';
      $('#fHomeW').hidden = t !== 'tuya_cena';
      $('#fTidL').textContent = t === 'tuya_cena' ? 'ID da cena ou automação' : 'ID do aparelho no Smart Life / Tuya';
      $('#fOnL').textContent = c === 'rotina' ? 'Webhook da rotina' : 'Webhook de ligar';
      $('#fOffW').hidden = c === 'rotina';
    };
    $('#fTipo').onchange = sync;
    $('#fCat').onchange = () => { if ($('#fCat').value === 'rotina' && $('#fTipo').value === 'nenhum') $('#fTipo').value = 'webhook'; sync(); };
    sync();
    $('#fCancel').onclick = () => { editing = null; paneDevs(); };
    $('#fSave').onclick = async () => {
      const body = {
        nome: $('#fNome').value, ip: $('#fIp').value, categoria: $('#fCat').value, tipo: $('#fTipo').value,
        tuya_id: $('#fTid').value, tuya_home: $('#fHome').value, webhook_on: $('#fOn').value, webhook_off: $('#fOff').value,
      };
      const btn = $('#fSave'); btn.disabled = true;
      const r = d._novo ? await api('/api/home/devices', { method: 'POST', body }) : await api('/api/home/devices/' + encodeURIComponent(d.id), { method: 'PUT', body });
      btn.disabled = false;
      if (!r.ok) { $('#fErr').textContent = r.error; return; }
      toast(d._novo ? 'Aparelho adicionado' : 'Aparelho atualizado');
      editing = null; await refresh(); paneDevs();
    };
    $('#fNome').focus();
  }

  /* ====================== CONEXÃO ====================== */
  function paneConn() {
    const p = $('#p-conn');
    p.innerHTML = `
      <h3>Agente (agent.py)</h3>
      <p>Se você abriu o painel pelo endereço do agente (ex.: <code>http://192.168.0.10:5000</code>), deixe o endereço em branco.
      Se o painel está hospedado no Render (HTTPS), informe um endpoint HTTPS do agente (Tailscale Serve, mkcert ou túnel).</p>
      <div class="warnbox" id="cMixed" hidden></div>
      <div class="field"><label for="cEnd">Endereço do agente</label><input id="cEnd" inputmode="url" value="${esc(cfg.endpoint)}" placeholder="vazio = este mesmo endereço" autocapitalize="off" spellcheck="false"></div>
      <div class="field"><label for="cTok">Token (impresso no terminal na 1ª execução e salvo em agent/.token)</label><input id="cTok" type="password" autocomplete="off" value="${esc(cfg.token)}"></div>
      <div class="actions"><button class="btn" id="cSave">Salvar e testar</button></div>
      <p id="cMsg" class="err" style="margin-top:12px"></p>`;
    const mixed = () => {
      const v = $('#cEnd').value.trim(), w = $('#cMixed');
      const bad = location.protocol === 'https:' && /^http:\/\//i.test(v);
      w.hidden = !bad; w.textContent = bad ? 'Esta página está em HTTPS e o endereço do agente é HTTP: o Chrome bloqueia (mixed content). Use um endereço HTTPS ou abra o painel diretamente pelo agente.' : '';
    };
    $('#cEnd').oninput = mixed; mixed();
    $('#cSave').onclick = async () => {
      cfg.endpoint = $('#cEnd').value.trim(); cfg.token = $('#cTok').value.trim(); saveCfg();
      HUD.reconnect();                                     // reabre o WebSocket com o endpoint/token novos
      const m = $('#cMsg'); m.className = 'err'; m.textContent = 'Testando…';
      const r = await refresh();
      m.className = r.ok ? 'err okmsg' : 'err'; m.textContent = r.ok ? 'Conectado ao agente.' : r.error;
    };
  }

  /* ====================== JARVIS (VOZ) ====================== */
  function paneVoice() {
    const p = $('#p-voice'), J = window.Jarvis, vs = J.voices();
    const sup = J.supported, sec = window.isSecureContext;
    p.innerHTML = `
      <h3>Reconhecimento de voz</h3>
      <p>Reconhecimento: ${sup ? '<span class="pillok">disponível</span>' : '<span class="pillno">indisponível neste navegador (use o Chrome)</span>'}
         &nbsp; Microfone: ${sec ? '<span class="pillok">contexto seguro</span>' : '<span class="pillno">exige HTTPS</span>'}</p>
      ${sec ? '' : `<div class="warnbox">Esta página está em HTTP e o Chrome não libera o microfone. Soluções: (1) no Chrome do tablet abra <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>, adicione <code>${esc(location.origin)}</code>, ative e reinicie; ou (2) sirva o painel por HTTPS (Tailscale Serve / mkcert). Veja docs/JARVIS.md.</div>`}
      <label class="chk"><input type="checkbox" id="vWake" ${cfg.escuta ? 'checked' : ''} ${sup && sec ? '' : 'disabled'}> Escuta contínua: responder quando eu disser “Jarvis”</label>
      <p>Mantém o microfone aberto. No Android o Chrome pode reiniciar a escuta de tempos em tempos; o toque no núcleo sempre funciona.</p>
      <h3>Voz do Jarvis</h3>
      <label class="chk"><input type="checkbox" id="vSpeak" ${cfg.falar ? 'checked' : ''}> Responder em voz alta</label>
      <div class="field"><label for="vVoz">Voz (pt-BR)</label><select id="vVoz"><option value="">Automática</option>${vs.map(v => `<option value="${esc(v.name)}" ${v.name === cfg.voz ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`).join('')}</select>
        ${vs.length ? '' : '<small>Nenhuma voz em português instalada neste aparelho. Instale pelo ajuste de texto para fala do Android.</small>'}</div>
      <div class="rng"><span class="lab">Velocidade</span><input type="range" id="vRate" min="0.7" max="1.4" step="0.05" value="${cfg.velocidade}"><span id="vRateV">${cfg.velocidade}</span></div>
      <div class="rng"><span class="lab">Tom</span><input type="range" id="vPitch" min="0.5" max="1.4" step="0.05" value="${cfg.tom}"><span id="vPitchV">${cfg.tom}</span></div>
      <div class="field"><label for="vTrat">Como o Jarvis trata você</label><input id="vTrat" value="${esc(cfg.tratamento)}" maxlength="20" placeholder="senhor"></div>
      <div class="actions"><button class="btn ghost" id="vTest">Testar voz</button><button class="btn ghost" id="vFull">Tela cheia</button></div>`;
    const save = () => { saveCfg(); J.updateHint(); };
    $('#vWake').onchange = e => J.setContinuous(e.target.checked);
    $('#vSpeak').onchange = e => { cfg.falar = e.target.checked; save(); };
    $('#vVoz').onchange = e => { cfg.voz = e.target.value; save(); };
    $('#vRate').oninput = e => { cfg.velocidade = +e.target.value; $('#vRateV').textContent = e.target.value; save(); };
    $('#vPitch').oninput = e => { cfg.tom = +e.target.value; $('#vPitchV').textContent = e.target.value; save(); };
    $('#vTrat').oninput = e => { cfg.tratamento = e.target.value.trim() || 'senhor'; save(); };
    $('#vTest').onclick = () => J.say('Sistemas operacionais, {t}. Pronto para receber ordens.');
    $('#vFull').onclick = () => { try { document.documentElement.requestFullscreen(); } catch (e) { toast('Tela cheia indisponível', true); } };
  }

  /* ====================== INTEGRAÇÕES ====================== */
  async function paneInteg() {
    const p = $('#p-integ');
    p.innerHTML = '<p>Consultando o agente…</p>';
    const r = await api('/api/home/integracoes');
    if (!r.ok) { p.innerHTML = `<p class="err">${esc(r.error)}</p>`; return; }
    integ = r.data;
    const st = ok => ok ? '<span class="pillok">configurado</span>' : '<span class="pillno">não configurado</span>';
    p.innerHTML = `
      <p>Chaves e tokens ficam no arquivo <code>agent/.env</code> do PC (nunca no tablet). Reinicie o agente depois de editar.</p>
      <div class="srow"><div><b>Smart Life / Tuya</b><br><small class="lab">CC_TUYA_ID, CC_TUYA_SECRET, CC_TUYA_REGION (${esc(integ.tuya.regiao)})</small></div>${st(integ.tuya.configurado)}</div>
      <div class="srow"><div><b>Alexa via Voice Monkey</b><br><small class="lab">CC_VOICEMONKEY_TOKEN, depois use <code>voicemonkey:ID</code> no aparelho</small></div>${st(integ.voicemonkey)}</div>
      <div class="srow"><div><b>Alexa via IFTTT</b><br><small class="lab">CC_IFTTT_KEY, depois use <code>ifttt:evento</code> no aparelho</small></div>${st(integ.ifttt)}</div>
      <h3>Painel antigo</h3>
      <p>Sentinel, Frota, Câmeras e métricas de hardware continuam disponíveis no painel anterior (esse usa dados simulados quando o agente não responde).</p>
      <div class="actions"><a class="btn ghost" style="display:inline-grid;place-items:center;text-decoration:none" href="legado.html">Abrir painel antigo</a></div>`;
  }

  window.HUDSettings = { novo };
  /* primeiro acesso sem token/endereço: abre direto em Conexão */
  let asked = false;
  HUD.on('data', () => { if (!asked && S.erro && S.erro.kind === 'auth') { asked = true; tab = 'conn'; $('#btnCfg').click(); } });
})();
