/* FinTrack service worker: app-shell cache + no cache untuk /api sensitif. */
const SHELL = 'fintrack-shell-v4';
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then(async (c) => {
      // Jangan gagalkan install bila satu file belum ada (mis. beda hasil build).
      await Promise.allSettled(SHELL_URLS.map((u) => c.add(u)));
      await self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    // Data terautentikasi JANGAN di-cache (privasi + hindari stale sensitif).
    return;
  }
  // App shell: network-first, cache hanya respons OK; fallback ke index.html.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit ?? caches.match('/index.html'))),
  );
});
