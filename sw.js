// Cache-buster service worker.
//
// The app is plain ES modules served static — no build step — so on GitHub
// Pages the browser holds every module in its HTTP cache for GitHub's ten-minute
// max-age. Push a change, reload, and you are looking at the old code until the
// cache expires or you Ctrl-F5. A query string on the entry script cannot fix
// that: each nested `import` is its own request with its own cache entry.
//
// So this sits in front of every same-origin GET and asks the network about it
// every time, keeping the last good copy only as an offline fallback.
// Network-first, never stale-first — the one failure mode a service worker must
// not have is serving old code forever.
//
// *Asks*, not downloads. `no-cache` sends the copy the browser already holds
// back with its ETag, and an unchanged file comes back as an empty 304 — the
// same freshness guarantee as `no-store`, which is what this used to use, but
// `no-store` threw the browser's copy away and fetched every body again: about
// 3.5MB for the page and the engine once more for each of the six workers, on
// every load, whether anything had changed or not. It also kept the compiled
// code cache from ever being used, since that lives beside the HTTP cache.
//
// It is registered from src/app/main.js with `updateViaCache: 'none'`, so the
// worker script itself is never served from cache either.

const CACHE = 'cncam-offline-v1';

// Which version of each file the offline copy already holds, so an unchanged
// file is not written to it again on every load. Lost when the worker is
// stopped, which only costs one rewrite per file.
const kept = new Map();

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
      const fresh = await fetch(request, { cache: 'no-cache' });
      // keep a copy for the offline fallback (Cache Storage, not the HTTP cache)
      if (fresh.ok) {
        const version = fresh.headers.get('etag')
          ?? `${fresh.headers.get('last-modified')}|${fresh.headers.get('content-length')}`;
        if (kept.get(request.url) !== version) {
          kept.set(request.url, version);
          const copy = fresh.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
        }
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(request);
      if (cached) return cached;
      throw err;
    }
  })());
});
