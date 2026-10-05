import { timeAgo } from './format.js';

export interface CachedPrice {
  symbol: string;
  price_idr: number;
  source: string;
  fetched_at: string;
}

export interface PriceStatus {
  mode: 'live' | 'manual';
  label: string;
  detail: string;
}

/** "Sinkron Live" only when a non-manual price was truly refreshed recently. */
export function priceStatus(prices: CachedPrice[], staleMs = 15 * 60 * 1000): PriceStatus {
  if (prices.length === 0) return { mode: 'manual', label: 'Harga manual', detail: 'belum ada data' };
  const ts = (p: CachedPrice) =>
    new Date(p.fetched_at.endsWith('Z') ? p.fetched_at : p.fetched_at + 'Z').getTime();
  // Freshest non-manual quote wins (ties prefer live sources over manual ones).
  const live = prices
    .filter((p) => p.source !== 'manual')
    .sort((a, b) => ts(b) - ts(a))[0];
  if (live && Date.now() - ts(live) < staleMs) {
    return { mode: 'live', label: 'Sinkron Live', detail: timeAgo(live.fetched_at) };
  }
  const latest = [...prices].sort((a, b) => ts(b) - ts(a))[0];
  return { mode: 'manual', label: 'Harga manual', detail: timeAgo(latest.fetched_at) };
}

export function priceBadge(source: string | null, fetchedAt: string | null, stale: boolean): string {
  if (!source || !fetchedAt) return `<span class="badge"><span class="dot"></span>Harga manual</span>`;
  if (stale) return `<span class="badge"><span class="dot"></span>Harga tertunda • ${timeAgo(fetchedAt)}</span>`;
  if (source === 'manual') return `<span class="badge"><span class="dot"></span>Harga manual</span>`;
  return `<span class="badge live"><span class="dot pulse"></span>Sinkron Live • ${timeAgo(fetchedAt)}</span>`;
}
