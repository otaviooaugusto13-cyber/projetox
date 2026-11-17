/* Configurações (⚙): endpoints dos agentes, token, clima, câmeras, modo simulado. Salvo no localStorage do aparelho. */
(() => {
  const dlg = $('#settings');
  const row = (cls, html) => `<div class="srow ${cls}">${html}</div>`;
  function fill() {
    const c = loadCfg();
    $('#setHosts').innerHTML = HOSTS.map((h, i) => row('', `
      <label>Nome<input type="text" data-h="name" data-i="${i}" value="${esc(h.name)}"></label>
      <label>Endpoint do agente<input type="text" inputmode="url" data-h="url" data-i="${i}" placeholder="https://pc.suarede.ts.net:5000" value="${esc(h.url)}"></label>
      <label>Token (X-CC-Token)<input type="password" autocomplete="off" data-h="token" data-i="${i}" value="${esc(h.token)}"></label>`)).join('');
    $('#setCams').innerHTML = CAMERAS.map((cm, i) => row('two', `
      <label>Câmera ${i + 1}<input type="text" data-c="name" data-i="${i}" value="${esc(cm.name)}"></label>
      <label>URL do feed<input type="text" inputmode="url" data-c="src" data-i="${i}" placeholder="https://…/stream.mjpeg" value="${esc(cm.src)}"></label>`)).join('');
    $('#setHubUrl').value = (c.hub && c.hub.url) || ''; $('#setHubTok').value = (c.hub && c.hub.token) || '';
    $('#setLat').value = c.weather.lat; $('#setLon').value = c.weather.lon;
    $('#setSim').checked = !!c.sim; $('#setAwake').checked = c.keepAwake !== false;
    mixedCheck();
  }
  function mixedCheck() {
    const bad = [...document.querySelectorAll('[data-h=url]')].some(i => location.protocol === 'https:' && /^http:\/\//i.test(i.value.trim()) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(i.value.trim()));
    const w = $('#mixedWarn'); w.hidden = !bad;
    w.innerHTML = bad ? '<b>Atenção:</b> esta página está em HTTPS e o endpoint está em HTTP. O Chrome bloqueia essa chamada (mixed content) e o painel ficará em modo simulado. Use um endpoint HTTPS (Tailscale Serve, mkcert ou Cloudflare Tunnel). Veja o README, seção “HTTPS e mixed content”.' : '';
  }
  function collect() {
    const c = loadCfg();
    document.querySelectorAll('[data-h]').forEach(el => { c.hosts[el.dataset.i][el.dataset.h] = el.value.trim(); });
    document.querySelectorAll('[data-c]').forEach(el => { c.cameras[el.dataset.i] = { ...(c.cameras[el.dataset.i] || {}), [el.dataset.c]: el.value.trim() }; });
    const lat = parseFloat($('#setLat').value.replace(',', '.')), lon = parseFloat($('#setLon').value.replace(',', '.'));
    if (isFinite(lat) && isFinite(lon)) c.weather = { lat, lon };
    c.hub = { url: $('#setHubUrl').value.trim().replace(/\/+$/, ''), token: $('#setHubTok').value.trim() };
    c.sim = $('#setSim').checked; c.keepAwake = $('#setAwake').checked;
    return c;
  }
  $('#cfgBtn').onclick = () => { fill(); dlg.showModal(); };
  $('#setClose').onclick = () => dlg.close();
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('input', e => { if (e.target.dataset.h === 'url') mixedCheck(); });
  $('#setSave').onclick = () => { if (saveCfg(collect())) location.reload(); else toast('Não foi possível salvar (armazenamento bloqueado)'); };
  $('#setReset').onclick = () => { try { localStorage.removeItem(CFG_KEY); } catch (e) {} location.reload(); };
  $('#setTest').onclick = () => { TEST_HOT = !TEST_HOT; toast(TEST_HOT ? 'Alerta crítico simulado: CPU 86°C' : 'Alerta de teste desligado'); dlg.close(); refresh(); };
})();
