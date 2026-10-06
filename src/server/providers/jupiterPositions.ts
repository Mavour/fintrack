import { fetchWithTimeout, withRetry } from './types.js';
import { logger } from '../logger.js';

/** Jupiter's public web key (visible in their frontend; read-only data). Override via env. */
const PORTFOLIO_KEY = process.env.JUP_PORTFOLIO_KEY ?? 'jup_103f2da0530554e4eb01d8f4af2fcda75b309d2b71aa1bcdfd17e411c59056d8';

export interface LpUnderlying {
  mint: string;
  qty: string;
  valueUsd: number;
}

export interface LpPosition {
  /** Unique pool ref, e.g. solana_<poolAddress>. */
  key: string;
  pool: string;
  platform: string;
  label: string;
  assets: LpUnderlying[];
  rewards: LpUnderlying[];
  totalUsd: number;
}

interface RawAmount {
  raw: string;
  decimals: number;
}
interface RawAsset {
  data: { address: string; amount: RawAmount; price?: number };
  value?: number;
}
interface RawElement {
  id: string;
  platformId: string;
  type: string;
  label: string;
  name: string;
  sourceRefs?: Array<{ name: string; address: string }>;
  data?: { assets?: RawAsset[]; rewardAssets?: RawAsset[] };
}

function toQty(a: RawAmount): string {
  const dec = Number(a.decimals) || 0;
  if (dec === 0) return BigInt(a.raw).toString();
  const s = a.raw.padStart(dec + 1, '0');
  const int = s.slice(0, -dec) || '0';
  const frac = s.slice(-dec).replace(/0+$/, '');
  return frac ? `${BigInt(int).toString()}.${frac}` : BigInt(int).toString();
}

function toUnderlying(a: RawAsset): LpUnderlying {
  const qty = toQty(a.data.amount);
  return {
    mint: a.data.address,
    qty,
    valueUsd: typeof a.value === 'number' ? a.value : 0,
  };
}

/** Parse portfolio positions into LP positions (pure, unit-tested). */
export function parseLpPositions(json: { fetcherResults?: Array<{ elements?: RawElement[] }> }): LpPosition[] {
  const out: LpPosition[] = [];
  for (const f of json.fetcherResults ?? []) {
    for (const el of f.elements ?? []) {
      if (el.type !== 'liquidity') continue;
      const pool = el.sourceRefs?.find((r) => r.name === 'Pool')?.address ?? el.id;
      const assets = (el.data?.assets ?? []).map(toUnderlying);
      const rewards = (el.data?.rewardAssets ?? []).map(toUnderlying);
      const totalUsd = [...assets, ...rewards].reduce((s, x) => s + x.valueUsd, 0);
      if (totalUsd <= 0) continue;
      out.push({
        key: `solana_${pool}`,
        pool,
        platform: el.platformId,
        label: el.label,
        assets,
        rewards,
        totalUsd,
      });
    }
  }
  return out;
}

/** Fetch LP/liquidity positions of a Solana wallet from Jupiter Portfolio. */
export async function fetchJupiterLp(address: string): Promise<LpPosition[]> {
  const res = await withRetry(() =>
    fetchWithTimeout(`https://api.jup.ag/portfolio/v2/positions/${address}?unpriced=false`, 20_000, {
      headers: { 'x-api-key': PORTFOLIO_KEY, Accept: 'application/json', Referer: 'https://jup.ag/' },
    }),
  );
  if (res.status === 403) {
    throw Object.assign(new Error('Akses posisi Jupiter ditolak (key publik berubah) — coba lagi nanti'), {
      statusCode: 502,
    });
  }
  if (!res.ok) throw new Error(`Jupiter positions HTTP ${res.status}`);
  const json = (await res.json()) as { fetcherResults?: Array<{ elements?: RawElement[] }> };
  const positions = parseLpPositions(json);
  logger.info({ address: address.slice(0, 6), count: positions.length }, 'jupiter LP positions fetched');
  return positions;
}

/** Short display name for an LP position, e.g. LP-METEORA-GRNB. */
export function lpSymbol(platform: string, pool: string): string {
  const p = platform.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 7) || 'LP';
  return `LP-${p}-${pool.slice(0, 4).toUpperCase()}`;
}
