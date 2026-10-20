// OpenBand service worker (generated at build time: the precache list and version are filled in).
// Hashed assets: cache-first. The page: network-first, falling back to the cache when offline.
// Plugins (WAM), fonts and loops (same-origin loops/*.wav are left out of the precache): cached at runtime after their first use.
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const SHELL = `openband-shell-${VERSION}`;
const RUNTIME = 'openband-runtime';
const RUNTIME_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'www.webaudiomodules.com', 'mainline.i3s.unice.fr', 'raw.githubusercontent.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('openband-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) ?? (await cache.match('./index.html')) ?? Response.error();
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // The bridge and the server's own endpoints are never cached.
    if (url.pathname.endsWith('/version.json') || url.pathname.includes('/bridge') || url.pathname.includes('/collab')) return;
    if (req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html') || url.pathname.endsWith('sw.js')) return void event.respondWith(networkFirst(req));
    return void event.respondWith(cacheFirst(req, SHELL));
  }
  if (RUNTIME_HOSTS.includes(url.hostname)) event.respondWith(cacheFirst(req, RUNTIME));
});
