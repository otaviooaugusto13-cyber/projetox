/* Command Center · Service Worker
 * - Pré-cacheia o "shell" (HTML/CSS/JS) para abrir offline e liberar a instalação PWA.
 * - Só mexe em GET do próprio site e NUNCA em /api/ (dados reais do agente não podem vir de cache).
 * - Para publicar uma nova versão: aumente VERSION.
 */
const VERSION = 'cc-v4.2.0';
const SHELL = [
  './', 'index.html', 'legado.html', 'manifest.json',
  'css/hud.css', 'css/style.css',
  'js/hud-core.js', 'js/jarvis-nlu.js', 'js/jarvis.js', 'js/hud-home.js', 'js/hud-fleet.js', 'js/hud-settings.js',
  'js/config.js', 'js/app.js', 'js/sentinel.js', 'js/fleet.js', 'js/settings.js', 'js/pwa.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-64.png',
];

self.addEventListener('install', e => {
  // allSettled: um arquivo ausente não impede a instalação do restante
  e.waitUntil(caches.open(VERSION).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;   // API/LAN/clima: sempre rede

  // Navegação: rede primeiro (pega deploy novo), cache como fallback offline
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => { const c = res.clone(); caches.open(VERSION).then(ch => ch.put(req, c)); return res; })
        .catch(() => caches.match(req).then(h => h || caches.match('index.html')))
    );
    return;
  }
  // Assets: stale-while-revalidate
  e.respondWith(
    caches.open(VERSION).then(cache =>
      cache.match(req).then(hit => {
        const net = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      })
    )
  );
});
