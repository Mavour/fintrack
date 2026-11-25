/* FinTrack service worker: app-shell cache + no cache untuk /api sensitif. */
const SHELL = 'fintrack-shell-v5';
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
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('fintrack-shell-') && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
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
  const navigation = req.mode === 'navigate';
  const assetType = req.destination === 'script' || /\.[cm]?js$/i.test(url.pathname) ? 'script'
    : req.destination === 'style' || /\.css$/i.test(url.pathname) ? 'style' : null;
  const matchesAsset = (response) => {
    const mime = response?.headers.get('Content-Type') ?? '';
    if (assetType === 'script') return /(?:java|ecma)script/i.test(mime);
    if (assetType === 'style') return /^text\/css(?:$|;)/i.test(mime);
    return true;
  };
  // Navigation always checks the network; HTML fallback is only for pages, never JS/CSS.
  event.respondWith(
    fetch(req, navigation ? { cache: 'no-store', signal: AbortSignal.timeout(8000) } : {})
      .then((res) => {
        if (res.ok) {
          if (!matchesAsset(res)) throw new Error('Unexpected asset content type');
          const copy = res.clone();
          event.waitUntil(caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => undefined));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached && matchesAsset(cached)) return cached;
        if (navigation && !assetType) return (await caches.match('/index.html')) ?? Response.error();
        return Response.error();
      }),
  );
});
