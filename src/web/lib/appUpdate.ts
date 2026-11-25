async function readFresh(path: string, javascript = false): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(path, { cache: 'no-store', signal: controller.signal });
    if (!response.ok || (javascript && !/javascript|ecmascript/i.test(response.headers.get('Content-Type') ?? ''))) {
      throw new Error('Versi terbaru belum siap. Coba lagi sebentar.');
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAppEntry(): Promise<string | null> {
  const html = await readFresh('/');
  return /assets\/index-([^"']+)\.js/.exec(html)?.[0] ?? null;
}

export async function reloadAppUpdate(button: HTMLButtonElement, status: HTMLElement): Promise<void> {
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = 'Memuat…';
  status.textContent = 'Memeriksa versi terbaru…';
  try {
    const entry = await fetchAppEntry();
    if (!entry) throw new Error('Versi terbaru belum siap. Coba lagi sebentar.');
    await readFresh(`/${entry}`, true);
    // Only app-shell caches belong to this update; financial data lives on the server.
    if ('caches' in window) {
      let cacheTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            const keys = await caches.keys();
            await Promise.all(keys.filter((key) => key.startsWith('fintrack-shell-')).map((key) => caches.delete(key)));
          })(),
          new Promise<void>((resolve) => { cacheTimer = setTimeout(resolve, 2000); }),
        ]);
      } catch { /* A fresh navigation still works when browser cache storage is unavailable. */ }
      finally { if (cacheTimer) clearTimeout(cacheTimer); }
    }
    const url = new URL(location.href);
    url.searchParams.set('_ft_update', String(Date.now()));
    status.textContent = 'Membuka versi terbaru…';
    location.replace(url.href);
  } catch (e) {
    status.textContent = e instanceof Error && e.message.startsWith('Versi terbaru')
      ? e.message : 'Pembaruan gagal atau koneksi terlalu lama. Silakan coba lagi.';
    button.disabled = false;
    button.textContent = 'Coba lagi';
  }
}
