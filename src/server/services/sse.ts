import type { ServerResponse } from 'node:http';

/**
 * SSE hub: endpoint GET /api/events (terautentikasi via cookie sesi).
 * Heartbeat tiap 25 detik. Event sync:done berisi cakupan yang berubah.
 * Melacak klien aktif untuk mode hemat server (idle bila 0 klien 30 menit).
 */

export type SyncScope = 'price' | 'lp' | 'solana' | 'evm';

interface Client {
  res: ServerResponse;
  connectedAt: number;
}

const clients = new Set<Client>();
let lastClientAt = 0;

export function sseClientCount(): number {
  return clients.size;
}

/** Menit sejak klien SSE terakhir terlihat (Infinity bila belum pernah). */
export function minutesSinceLastClient(): number {
  if (lastClientAt === 0) return Infinity;
  return (Date.now() - lastClientAt) / 60_000;
}

export function addSseClient(res: ServerResponse): () => void {
  const c: Client = { res, connectedAt: Date.now() };
  clients.add(c);
  lastClientAt = Date.now();
  const hb = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      // Client hilang — dibersihkan di close.
    }
  }, 25_000);
  const done = (): void => {
    clearInterval(hb);
    clients.delete(c);
  };
  res.on('close', done);
  return done;
}

export function emitSyncDone(scopes: SyncScope[]): void {
  if (clients.size === 0 || scopes.length === 0) return;
  const payload = `event: sync:done\ndata: ${JSON.stringify({ scopes, at: new Date().toISOString() })}\n\n`;
  for (const c of [...clients]) {
    try {
      c.res.write(payload);
    } catch {
      clients.delete(c);
    }
  }
}

/** Test-only: reset hub. */
export function resetSseHub(): void {
  clients.clear();
  lastClientAt = 0;
}

/** Test-only: catat koneksi sintetis (simulasi idle tanpa socket nyata). */
export function touchSseClient(at = Date.now()): void {
  lastClientAt = at;
}
