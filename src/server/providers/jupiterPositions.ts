import { fetchWithTimeout, withRetry } from './types.js';
import { normalizeList, throwForStatus, type NormalizedPosition, type WalletProvider, type WalletRef } from './walletTypes.js';
import { resolveTokens } from './tokenMeta.js';
import { logger } from '../logger.js';
import { redactAddress } from '../services/address.js';

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
  data: { address?: string; addressId?: string; amount: RawAmount; price?: number };
  value?: number;
}
interface RawElement {
  id: string;
  platformId: string;
  serviceId?: string;
  type: string;
  label: string;
  name: string;
  refAddress?: string;
  sourceRefs?: Array<{ name: string; address: string }>;
  data?: {
    assets?: RawAsset[] | Record<string, unknown>;
    rewardAssets?: RawAsset[];
    inputAddress?: string;
    outputAddress?: string;
    filledPercentage?: number;
  };
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
    mint: assetMint(a),
    qty,
    valueUsd: typeof a.value === 'number' ? a.value : 0,
  };
}

function assetMint(a: RawAsset): string {
  return a.data.address ?? a.data.addressId?.replace(/^solana_/, '') ?? '';
}

interface PortfolioResponse {
  fetcherResults?: Array<{ id?: string; status?: string; elements?: RawElement[] }>;
}

function assertFetcherSuccess(json: PortfolioResponse, matches: (id: string) => boolean): void {
  if (!Array.isArray(json.fetcherResults))
    throw Object.assign(new Error('Respons Jupiter Portfolio tidak sesuai skema'), { statusCode: 502 });
  for (const f of json.fetcherResults ?? []) {
    if (f.id && matches(f.id) && f.status && f.status !== 'success') {
      throw Object.assign(new Error(`Jupiter ${f.id}: ${f.status} — data terakhir dipertahankan`), { statusCode: 502 });
    }
  }
}

/** Parse portfolio positions into LP positions (pure, unit-tested). */
export function parseLpPositions(json: { fetcherResults?: Array<{ elements?: RawElement[] }> }): LpPosition[] {
  const out: LpPosition[] = [];
  for (const f of json.fetcherResults ?? []) {
    for (const el of f.elements ?? []) {
      if (el.type !== 'liquidity') continue;
      const pool = el.sourceRefs?.find((r) => r.name === 'Pool')?.address ?? el.id;
      const assetsRaw = Array.isArray(el.data?.assets) ? (el.data?.assets as RawAsset[]) : [];
      const assets = assetsRaw.map(toUnderlying);
      const rewards = (el.data?.rewardAssets ?? []).map(toUnderlying);
      const totalUsd = [...assets, ...rewards].reduce((s, x) => s + x.valueUsd, 0);
      if (totalUsd <= 0) continue;
      out.push({
        key: el.refAddress ?? `solana_${el.id}`,
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

/** Jupiter supplies valued DAMM v2/Orca/Raydium positions as well as DLMM.
 * DLMM overlaps are removed against the direct Meteora snapshot during sync. */
export class JupiterLiquidityProvider implements WalletProvider {
  readonly name = 'jupiter-liquidity-v2';
  async fetchPositions(wallet: WalletRef): Promise<NormalizedPosition[]> {
    if (wallet.network_type !== 'solana') return [];
    const res = await withRetry(() => fetchWithTimeout(
      `https://api.jup.ag/portfolio/v2/positions/${wallet.address}?unpriced=false`, 20_000,
      { headers: { 'x-api-key': PORTFOLIO_KEY, Accept: 'application/json' } },
    ));
    throwForStatus(res, this.name);
    const json = await res.json() as PortfolioResponse;
    assertFetcherSuccess(json, (id) => /positions|whirlpool|clmm|cpmm/.test(id));
    const positions = parseLpPositions(json);
    const mints = [...new Set(positions.flatMap((p) => p.assets.map((a) => a.mint)).filter(Boolean))];
    const metadata = await resolveTokens(mints).catch(() => new Map());
    return normalizeList(positions.map((p) => ({
      chain_id: 'solana', kind: 'lp', protocol: `jupiter-${p.platform}`,
      symbol: lpSymbol(p.platform, p.pool), name: p.label || p.platform, amount: '1',
      price_usd: p.totalUsd, value_usd: p.totalUsd,
      meta: {
        pool_address: p.pool, position_address: p.key,
        pair: p.assets.map((a) => metadata.get(a.mint)?.symbol ?? a.mint.slice(0, 6)).join('/'),
        position_value_usd: p.assets.reduce((s, a) => s + a.valueUsd, 0),
        unclaimed_fees_usd: p.rewards.reduce((s, a) => s + a.valueUsd, 0),
      },
    })), this.name);
  }
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
  throwForStatus(res, 'jupiter-portfolio');
  const json = (await res.json()) as { fetcherResults?: Array<{ elements?: RawElement[] }> };
  const positions = parseLpPositions(json);
  logger.info({ address: address.slice(0, 6), count: positions.length }, 'jupiter LP positions fetched');
  return positions;
}

export interface StakingUnderlying {
  mint: string;
  qty: string;
  priceUsd: number | null;
  valueUsd: number | null;
}

export interface StakingPosition {
  /** Unique ref, e.g. solana_<elementId>_<mint>. */
  key: string;
  protocol: string;
  label: string;
  pool: string;
  mint: string;
  qty: string;
  priceUsd: number | null;
  valueUsd: number | null;
}

function isStakingElement(el: RawElement): boolean {
  if (el.type === 'liquidity' || el.type === 'trade') return false;
  const hay = `${el.serviceId ?? ''} ${el.id} ${el.label} ${el.type}`;
  return /stak/i.test(hay);
}

/** Parse elemen staking Jupiter Portfolio v2 (pure, unit-tested).
 *  Bentuk nyata (meteora-met-staking): type "multiple", label "Staked",
 *  data.assets array berisi {data:{address, amount:{raw,decimals}, price}, value}.
 *  Elemen "Wallet" (token biasa) dan "trade" (limit order) TIDAK diambil —
 *  sudah ditangani RPC fallback agar tidak dobel. */
export function parseStakingPositions(json: { fetcherResults?: Array<{ elements?: RawElement[] }> }): StakingPosition[] {
  const out: StakingPosition[] = [];
  for (const f of json.fetcherResults ?? []) {
    for (const el of f.elements ?? []) {
      if (!isStakingElement(el)) continue;
      const assetsRaw = Array.isArray(el.data?.assets) ? (el.data?.assets as RawAsset[]) : [];
      const rewardsRaw = Array.isArray(el.data?.rewardAssets) ? (el.data?.rewardAssets as RawAsset[]) : [];
      const pool = el.sourceRefs?.find((r) => r.name === 'Pool')?.address ?? '';
      for (const a of [...assetsRaw, ...rewardsRaw]) {
      const mint = a?.data ? assetMint(a) : '';
        if (!mint || !a?.data?.amount) continue;
        let qty: string;
        try {
          qty = toQty(a.data.amount);
        } catch {
          continue;
        }
        if (!qty || qty === '0') continue;
        const priceUsd = typeof a.data.price === 'number' ? a.data.price : null;
        const valueUsd = typeof a.value === 'number'
          ? a.value
          : priceUsd !== null
            ? Number(qty) * priceUsd
            : null;
        out.push({
          key: `solana_${el.id}_${mint}`,
          protocol: el.platformId || 'staking',
          label: el.label || 'Staked',
          pool,
          mint,
          qty,
          priceUsd,
          valueUsd,
        });
      }
    }
  }
  return out;
}

/** Fetch posisi staking Solana dari Jupiter Portfolio v2 (key publik sama dengan LP).
 *  Symbol di-resolve via Jupiter verified → Dex → Gecko; mint jadi fallback. */
export async function fetchJupiterStaking(address: string): Promise<NormalizedPosition[]> {
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
  throwForStatus(res, 'jupiter-staking');
  const json = (await res.json()) as { fetcherResults?: Array<{ elements?: RawElement[] }> };
  assertFetcherSuccess(json, (id) => /stak/.test(id));
  const staked = parseStakingPositions(json);
  const metaByMint = await resolveTokens([...new Set(staked.map((s) => s.mint))]).catch(() => new Map());
  const raw: unknown[] = staked.map((s) => {
    const meta = metaByMint.get(s.mint);
    return {
      chain_id: 'solana',
      kind: 'staking',
      protocol: `jupiter-${s.protocol}`,
      symbol: (meta?.symbol ?? s.mint.slice(0, 8)).toUpperCase().slice(0, 40),
      name: meta?.name ?? `${s.label} (${s.mint.slice(0, 4)}…)`,
      amount: s.qty,
      price_usd: s.priceUsd,
      value_usd: s.valueUsd,
      meta: { mint: s.mint, pool_address: s.pool || null, label: s.label, position_id: s.key,
        ...(s.mint === 'METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL' && s.protocol === 'meteora'
          ? { referral_rewards_status: 'requires_wallet_verification' } : {}) },
    };
  });
  const out = normalizeList(raw, 'jupiter-staking');
  logger.info({ address: address.slice(0, 6), count: out.length }, 'jupiter staking positions fetched');
  return out;
}

/** Provider staking Jupiter v2 untuk scope sync Solana (tanpa key tambahan). */
export class JupiterStakingProvider implements WalletProvider {
  readonly name = 'jupiter-staking-v2';
  async fetchPositions(wallet: WalletRef): Promise<NormalizedPosition[]> {
    if (wallet.network_type !== 'solana') return [];
    const out = await fetchJupiterStaking(wallet.address);
    logger.info({ wallet: redactAddress(wallet.address), count: out.length }, 'jupiter staking fetched');
    return out;
  }
}

export interface LimitOrderPosition {
  /** Unique ref, e.g. solana_<elementId>_<inputMint>. */
  key: string;
  protocol: string;
  label: string;
  inputMint: string;
  inputQty: string;
  priceUsd: number | null;
  valueUsd: number | null;
  outputMint: string | null;
  outputSymbol?: string;
  filledPct: number | null;
  side: 'input' | 'output';
}

function isLimitOrderElement(el: RawElement): boolean {
  if (el.type !== 'trade') return false;
  const hay = `${el.serviceId ?? ''} ${el.id} ${el.label}`;
  return /limit/i.test(hay);
}

/** Parse limit order Jupiter Portfolio v2 (pure, unit-tested).
 *  Bentuk nyata (meteora-dlmm-limit-orders): type "trade", label "LimitOrder",
 *  data.assets OBJEK {input: {data:{address, amount, price}, value}} (bukan
 *  array), plus data.inputAddress/outputAddress/filledPercentage. Hanya sisi
 *  input tersisa DAN output hasil fill yang belum ditarik dihitung sebagai dana. */
export function parseLimitOrders(json: { fetcherResults?: Array<{ elements?: RawElement[] }> }): LimitOrderPosition[] {
  const out: LimitOrderPosition[] = [];
  for (const f of json.fetcherResults ?? []) {
    for (const el of f.elements ?? []) {
      if (!isLimitOrderElement(el)) continue;
      const assets = el.data?.assets as Record<string, RawAsset> | RawAsset[] | undefined;
      const list: Array<[string, RawAsset]> = Array.isArray(assets)
        ? assets.map((a) => ['input', a])
        : Object.entries(assets ?? {}).filter(([side]) => side === 'input' || side === 'output');
      const data = (el.data ?? {}) as Record<string, unknown>;
      const outputMint = typeof data.outputAddress === 'string' ? (data.outputAddress as string) : null;
      const filledPct = typeof data.filledPercentage === 'number' ? data.filledPercentage : null;
      for (const [side, a] of list) {
        const mint = a?.data ? assetMint(a) : '';
        if (!mint || !a?.data?.amount) continue;
        let qty: string;
        try {
          qty = toQty(a.data.amount);
        } catch {
          continue;
        }
        if (!qty || qty === '0') continue;
        const priceUsd = typeof a.data.price === 'number' ? a.data.price : null;
        const valueUsd = typeof a.value === 'number' ? a.value : priceUsd !== null ? Number(qty) * priceUsd : null;
        out.push({
          key: `solana_${el.id}_${side}_${mint}`,
          protocol: el.platformId || 'limit-order',
          label: el.label || 'LimitOrder',
          inputMint: mint,
          inputQty: qty,
          priceUsd,
          valueUsd,
          outputMint,
          filledPct,
          side: side === 'output' ? 'output' : 'input',
        });
      }
    }
  }
  return out;
}

/** Fetch limit order Solana dari Jupiter Portfolio v2 (key publik sama dengan LP). */
export async function fetchJupiterLimitOrders(address: string): Promise<NormalizedPosition[]> {
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
  throwForStatus(res, 'jupiter-limit');
  const json = (await res.json()) as { fetcherResults?: Array<{ elements?: RawElement[] }> };
  assertFetcherSuccess(json, (id) => /limit/.test(id));
  const orders = parseLimitOrders(json);
  const mints = [...new Set(orders.flatMap((o) => [o.inputMint, o.outputMint]).filter((m): m is string => !!m))];
  const metaByMint = await resolveTokens(mints).catch(() => new Map());
  const raw: unknown[] = orders.map((o) => {
    const meta = metaByMint.get(o.inputMint);
    const outMeta = o.outputMint ? metaByMint.get(o.outputMint) : undefined;
    return {
      chain_id: 'solana',
      kind: 'defi',
      protocol: `jupiter-${o.protocol}`,
      symbol: (meta?.symbol ?? o.inputMint.slice(0, 8)).toUpperCase().slice(0, 40),
      name: o.side === 'output' ? `Hasil fill belum ditarik (${meta?.symbol ?? o.inputMint.slice(0, 6)})` : meta?.name ?? `${o.label} (${o.inputMint.slice(0, 4)}…)`,
      amount: o.inputQty,
      price_usd: o.priceUsd,
      value_usd: o.valueUsd,
      meta: {
        mint: o.inputMint,
        order: 'limit',
        label: o.label,
        output_mint: o.outputMint,
        output_symbol: outMeta?.symbol ?? o.outputMint?.slice(0, 8) ?? null,
        filled_pct: o.filledPct,
        order_id: o.key,
        order_side: o.side,
      },
    };
  });
  const out = normalizeList(raw, 'jupiter-limit');
  logger.info({ address: address.slice(0, 6), count: out.length }, 'jupiter limit orders fetched');
  return out;
}

/** Provider limit order Jupiter v2 untuk scope sync Solana (tanpa key tambahan). */
export class JupiterLimitOrderProvider implements WalletProvider {
  readonly name = 'jupiter-limit-v2';
  async fetchPositions(wallet: WalletRef): Promise<NormalizedPosition[]> {
    if (wallet.network_type !== 'solana') return [];
    const out = await fetchJupiterLimitOrders(wallet.address);
    logger.info({ wallet: redactAddress(wallet.address), count: out.length }, 'jupiter limit orders fetched (provider)');
    return out;
  }
}

/** Short display name for an LP position, e.g. LP-METEORA-GRNB. */
export function lpSymbol(platform: string, pool: string): string {
  const p = platform.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 7) || 'LP';
  return `LP-${p}-${pool.slice(0, 4).toUpperCase()}`;
}

export interface PnlEntry {
  avgCostUsd: number;
  unrealizedUsd: number;
  unrealizedPct: number;
}

/**
 * Per-token trade history (average cost + unrealized P/L) from Jupiter.
 * This is the true cost basis — better than any manual estimate.
 */
export async function fetchJupiterPnl(address: string): Promise<Map<string, PnlEntry>> {
  const out = new Map<string, PnlEntry>();
  try {
    const res = await withRetry(() =>
      fetchWithTimeout(`https://datapi.jup.ag/v1/pnl-positions?address=${address}&filter=activePosition`, 15_000, {
        headers: { 'x-api-key': PORTFOLIO_KEY, Accept: 'application/json', Referer: 'https://jup.ag/' },
      }),
    );
    if (!res.ok) return out;
    const json = (await res.json()) as Record<string, { tokenPositions?: Array<Record<string, number | string>> }>;
    const positions = json[address]?.tokenPositions ?? [];
    for (const t of positions) {
      const mint = String(t.assetId ?? '');
      const avg = Number(t.averageCost ?? 0);
      if (mint && avg > 0) {
        out.set(mint, {
          avgCostUsd: avg,
          unrealizedUsd: Number(t.unrealizedPnl ?? 0),
          unrealizedPct: Number(t.unrealizedPnlPercentage ?? 0),
        });
      }
    }
  } catch {
    // PnL unavailable — caller falls back to market/unknown.
  }
  return out;
}
