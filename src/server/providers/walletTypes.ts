import { z } from 'zod';
import { fetchWithTimeout, withRetry } from './types.js';

/**
 * Uniform provider interface. Every wallet data source implements this so
 * sync/aggregation never depends on vendor shapes.
 */

export const NormalizedPositionSchema = z.object({
  chain_id: z.string().min(1).max(40),
  kind: z.enum(['token', 'lp', 'staking', 'defi']),
  protocol: z.string().max(60).default(''),
  symbol: z.string().min(1).max(40),
  name: z.string().max(120).default(''),
  amount: z.string().min(1).max(60),
  price_usd: z.number().nonnegative().nullable().default(null),
  value_usd: z.number().nonnegative().nullable().default(null),
  meta: z.record(z.unknown()).default({}),
});
export type NormalizedPosition = z.infer<typeof NormalizedPositionSchema>;

export interface WalletRef {
  id: number;
  label: string;
  address: string;
  network_type: 'solana' | 'evm';
}

export interface WalletProvider {
  readonly name: string;
  fetchPositions(wallet: WalletRef): Promise<NormalizedPosition[]>;
}

/** Provider fetch wrapper: 10s timeout, retry x3 exponential backoff. */
export async function providerFetch(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  return withRetry(() => fetchWithTimeout(url, timeoutMs, init), 3, 500);
}

/** HTTP error terkontrol dengan info rate-limit (status + Retry-After). */
export class ProviderHttpError extends Error {
  readonly httpStatus: number;
  readonly retryAfterMs: number | null;
  constructor(message: string, httpStatus: number, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'ProviderHttpError';
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfter(res: Response): number | null {
  const h = res.headers?.get?.('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}

/**
 * Lempar error terkontrol untuk respons non-OK. HTTP 429 membawa info
 * Retry-After agar scheduler bisa backoff otomatis. Tidak pernah crash.
 */
export function throwForStatus(res: Response, provider: string): void {
  if (res.ok) return;
  const retryAfterMs = res.status === 429 ? parseRetryAfter(res) : null;
  const err = new ProviderHttpError(`${provider} HTTP ${res.status}`, res.status, retryAfterMs);
  (err as { statusCode?: number }).statusCode = res.status === 429 ? 429 : 502;
  throw err;
}

/** Validate every item; a non-conforming response is a controlled error, never a crash. */
export function normalizeList(raw: unknown, provider: string): NormalizedPosition[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: NormalizedPosition[] = [];
  for (const item of arr) {
    const parsed = NormalizedPositionSchema.safeParse(item);
    if (!parsed.success) {
      throw Object.assign(
        new Error(`Respons ${provider} tidak sesuai skema: ${parsed.error.issues[0]?.message ?? 'invalid'}`),
        { statusCode: 502 },
      );
    }
    out.push(parsed.data);
  }
  return out;
}

/** Dust filter: hide positions worth < $1 by default (toggle shows all). */
export function filterDust(positions: NormalizedPosition[], showAll = false, minUsd = 1): NormalizedPosition[] {
  if (showAll) return positions;
  return positions.filter((p) => (p.value_usd ?? Infinity) >= minUsd);
}

/** Merge same symbol across wallets (sums value, keeps per-wallet detail separately). */
export interface MergedToken {
  symbol: string;
  name: string;
  chain_ids: string[];
  total_value_usd: number;
  wallets: Array<{ wallet_id: number; wallet_label: string; amount: string; value_usd: number | null }>;
}

export function mergeTokensAcrossWallets(
  rows: Array<{ symbol: string; name: string; chain_id: string; value_usd: number | null; wallet_id: number; wallet_label: string; amount: string }>,
): MergedToken[] {
  const by = new Map<string, MergedToken>();
  for (const r of rows) {
    const key = r.symbol.toUpperCase();
    const cur = by.get(key) ?? { symbol: key, name: r.name, chain_ids: [], total_value_usd: 0, wallets: [] };
    if (!cur.chain_ids.includes(r.chain_id)) cur.chain_ids.push(r.chain_id);
    cur.total_value_usd += r.value_usd ?? 0;
    cur.wallets.push({ wallet_id: r.wallet_id, wallet_label: r.wallet_label, amount: r.amount, value_usd: r.value_usd });
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => b.total_value_usd - a.total_value_usd);
}

/** USD -> IDR at display layer. Amounts are stored in USD; conversion never persists. */
export function usdToIdr(usd: number | null, rate: number): number | null {
  if (usd === null || !Number.isFinite(usd) || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.round(usd * rate);
}

export interface LenientResult {
  positions: NormalizedPosition[];
  skipped: number;
}

/**
 * Validasi zod toleran: item rusak dilewati + dihitung, respons lain tetap
 * dipakai. Dipakai jalur sync agar satu item buruk tidak membuang semuanya.
 * (Contract test tetap memakai normalizeList yang ketat.)
 */
export function normalizeListLenient(
  raw: unknown,
  provider: string,
  onWarn?: (msg: string) => void,
): LenientResult {
  const arr = Array.isArray(raw) ? raw : [];
  const positions: NormalizedPosition[] = [];
  let skipped = 0;
  for (const item of arr) {
    const parsed = NormalizedPositionSchema.safeParse(item);
    if (!parsed.success) {
      skipped += 1;
      onWarn?.(`Respons ${provider}: 1 item dilewati (${parsed.error.issues[0]?.message ?? 'invalid'})`);
      continue;
    }
    positions.push(parsed.data);
  }
  return { positions, skipped };
}

/** Hash stabil snapshot untuk deteksi "identik → jangan tulis / jangan emit". */
export function snapshotHash(positions: NormalizedPosition[]): string {
  const rows = positions
    .map((p) => [p.chain_id, p.kind, p.protocol, p.symbol, p.amount, p.price_usd ?? '', p.value_usd ?? ''].join('|'))
    .sort();
  let h = 2166136261;
  const s = rows.join('\n');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
