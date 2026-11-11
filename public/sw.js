/* Treasury & FP&A Synapses service worker: makes the map installable and opens it offline on the last copy.
 * The page and the graph are always fetched fresh when the network is there (network first);
 * three.js and the icons come from the cache. The review page and every other API call are never cached. */
const CACHE = 'synapse-04cd4f618a';
const SHELL = ['/', '/vendor/three.min.js', '/manifest.webmanifest', '/icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;
  if (p.startsWith('/review') || p.startsWith('/api/admin') || (p.startsWith('/api/') && p !== '/api/graph')) return;
  if (p === '/api/graph' && url.search) return;            /* incremental polls: live only */
  if (p.startsWith('/vendor/') || p.startsWith('/icons/')) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); return r; })));
    return;
  }
  if (req.mode === 'navigate' || p === '/api/graph') {
    const key = req.mode === 'navigate' ? '/' : req;
    /* the page is always asked from the server, past any HTTP cache; the copy here is only for offline */
    e.respondWith(fetch(req.mode === 'navigate' ? new Request(req.url, { cache: 'no-store', credentials: 'same-origin' }) : req).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(key, c)); } return r; })
      .catch(() => caches.match(key).then(hit => hit || Response.error())));
  }
});
