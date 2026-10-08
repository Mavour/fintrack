/**
 * Klien SSE live-update dengan reconnect exponential backoff + fallback
 * polling 30 detik. Hemat: tutup koneksi saat tab tersembunyi >60 detik,
 * sambung ulang + segarkan saat tab terlihat lagi.
 */

export type SseScope = 'price' | 'lp' | 'solana' | 'evm';

interface SseOpts {
  onSync: (scopes: SseScope[]) => void;
  onState?: (connected: boolean) => void;
}

export function connectSse(opts: SseOpts): () => void {
  let es: EventSource | null = null;
  let disposed = false;
  let attempts = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let lastDataAt = Date.now();

  const clearPoll = (): void => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  const startPollFallback = (): void => {
    if (pollTimer || disposed) return;
    opts.onState?.(false);
    pollTimer = setInterval(() => {
      if (document.hidden || disposed) return;
      lastDataAt = Date.now();
      opts.onSync(['price', 'lp', 'solana', 'evm']);
    }, 30_000);
  };

  const open = (): void => {
    if (disposed || document.hidden) return;
    closeEs();
    try {
      es = new EventSource('/api/events');
    } catch {
      startPollFallback();
      return;
    }
    es.addEventListener('sync:done', (ev) => {
      attempts = 0;
      clearPoll();
      opts.onState?.(true);
      lastDataAt = Date.now();
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { scopes?: SseScope[] };
        if (Array.isArray(data.scopes)) opts.onSync(data.scopes);
      } catch {
        // Payload rusak diabaikan — data terakhir tetap tampil.
      }
    });
    es.onerror = () => {
      closeEs();
      opts.onState?.(false);
      if (disposed) return;
      attempts += 1;
      const backoff = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5));
      setTimeout(() => {
        if (!disposed && !document.hidden) open();
        else if (!disposed) startPollFallback();
      }, backoff);
      startPollFallback();
    };
  };

  const closeEs = (): void => {
    if (es) {
      try {
        es.close();
      } catch {
        // Abaikan.
      }
      es = null;
    }
  };

  const onVis = (): void => {
    if (document.hidden) {
      // Tutup SSE setelah 60 detik tersembunyi agar mode hemat server aktif.
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        closeEs();
      }, 60_000);
    } else {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = null;
      clearPoll();
      // Segarkan seketika bila data lebih tua dari 60 detik.
      if (Date.now() - lastDataAt > 60_000) {
        lastDataAt = Date.now();
        opts.onSync(['price', 'lp', 'solana', 'evm']);
      }
      open();
    }
  };

  document.addEventListener('visibilitychange', onVis);
  open();

  return () => {
    disposed = true;
    closeEs();
    clearPoll();
    if (hideTimer) clearTimeout(hideTimer);
    document.removeEventListener('visibilitychange', onVis);
  };
}
