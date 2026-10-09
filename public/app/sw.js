/* Service worker for the TB decision support dashboard (served at /app/).
 *
 * Caches the dashboard page and its icon so the snapshot opens offline and the app can be installed.
 * API responses are never cached: they contain patient data and must always come from the server.
 */
const CACHE = 'tbds-app-v1';
const SHELL = ['./', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith('/app/')) return;   // API: straight to network
  if (req.mode === 'navigate' || url.pathname === '/app/') {
    // network first, so a rebuilt page is picked up; fall back to the cached copy offline
    event.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put('./', copy));
      return res;
    }).catch(() => caches.match('./')));
    return;
  }
  event.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
