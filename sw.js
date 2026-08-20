// Cache-buster service worker.
//
// The app is plain ES modules served static — no build step — so on GitHub
// Pages the browser holds every module in its HTTP cache for GitHub's ten-minute
// max-age. Push a change, reload, and you are looking at the old code until the
// cache expires or you Ctrl-F5. A query string on the entry script cannot fix
// that: each nested `import` is its own request with its own cache entry.
//
// So this sits in front of every same-origin GET and fetches it *fresh from the
// network* (`cache: 'no-store'` bypasses the HTTP cache), keeping the last good
// copy only as an offline fallback. Network-first, never stale-first — the one
// failure mode a service worker must not have is serving old code forever.
//
// It is registered from src/app/main.js with `updateViaCache: 'none'`, so the
// worker script itself is never served from cache either.

const CACHE = 'cncam-offline-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // drop any cache from an older worker, so offline never resurrects old code
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const fresh = await fetch(request, { cache: 'no-store' });
      // keep a copy for the offline fallback (Cache Storage, not the HTTP cache)
      if (fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(request, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(request);
      if (cached) return cached;
      throw err;
    }
  })());
});
