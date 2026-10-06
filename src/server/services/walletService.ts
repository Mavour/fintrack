import type Database from 'better-sqlite3';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { fetchWithTimeout, withRetry } from '../providers/types.js';
import { fetchSolanaHoldings, type ChainHolding } from '../providers/solana.js';
import { fetchJupiterPnl } from '../providers/jupiterPositions.js';
import { fetchEvmHoldings, EVM_CHAINS } from '../providers/evm.js';
import { fetchEtherscanHoldings } from '../providers/etherscan.js';
import { fetchDexTokens } from '../providers/dexscreener.js';
import { CoinGeckoProvider } from '../providers/coingecko.js';
import { createFxRateProvider } from '../providers/fxRate.js';
import { upsertAsset, getAssetBySymbol } from './portfolioService.js';

export const ChainSchema = z.enum(['solana', ...EVM_CHAINS, 'hoodi'] as [string, ...string[]]);
export type Chain = z.infer<typeof ChainSchema>;

export const PreviewQuerySchema = z.object({
  chain: ChainSchema,
  address: z.string().min(26).max(50),
});

export const ImportBodySchema = z.object({
  chain: ChainSchema,
  address: z.string().min(26).max(50),
  symbols: z.array(z.string().min(1).max(20)).max(100).optional(),
  min_usd: z.number().min(0).max(1000000).default(1),
});

export interface HoldingPreview extends ChainHolding {
  /** Pre-collision base symbol (for stable import matching). */
  base_symbol: string;
  /** Current cached IDR price when already known, else null. */
  price_idr: number | null;
  /** Fresh USD value (qty x market). Null when unpriced — kept, not auto-dropped. */
  usd_value: number | null;
  already_tracked: boolean;
}

/** Fresh USD per Solana mint: Jupiter batch first, DexScreener for the rest. */
async function solanaUsd(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (mints.length === 0) return out;
  try {
    const res = await withRetry(() =>
      fetchWithTimeout(`https://lite-api.jup.ag/price/v3?ids=${mints.slice(0, 50).join(',')}`, 12_000),
    );
    if (res.ok) {
      const json = (await res.json()) as Record<string, { usdPrice?: number }>;
      for (const [mint, v] of Object.entries(json)) {
        if (typeof v?.usdPrice === 'number') out.set(mint, v.usdPrice);
      }
    }
  } catch {
    // Fall through to DexScreener.
  }
  const rest = mints.filter((m) => !out.has(m));
  if (rest.length > 0) {
    const dex = await fetchDexTokens(rest).catch(() => new Map());
    for (const [mint, t] of dex) {
      if (t.priceUsd) out.set(mint, t.priceUsd);
    }
  }
  return out;
}

/** Ensure the display symbol is unique per mint (SI vs SI from another mint). */
function resolveFinalSymbol(db: Database.Database, base: string, mint: string | null): string {
  if (!mint) return base;
  let candidate = base;
  for (let len = 4; len <= 8; len += 2) {
    const row = db.prepare(`SELECT provider_id FROM asset_map WHERE symbol = ?`).get(candidate) as
      | { provider_id: string }
      | undefined;
    if (!row || row.provider_id === mint) return candidate;
    candidate = `${base}_${mint.slice(0, len).toUpperCase()}`;
  }
  return candidate;
}

export async function previewHoldings(
  db: Database.Database,
  chain: string,
  address: string,
  etherscanKey = '',
): Promise<HoldingPreview[]> {
  const { chain: c, address: a } = PreviewQuerySchema.parse({ chain, address });
  const holdings: ChainHolding[] =
    c === 'solana'
      ? await fetchSolanaHoldings(a)
      : c === 'hoodi'
        ? await fetchEtherscanHoldings(a, c, etherscanKey)
        : await fetchEvmHoldings(a, c);
  const priceRows = db.prepare('SELECT symbol, price_idr FROM price_cache').all() as Array<{
    symbol: string;
    price_idr: number;
  }>;
  const prices = new Map(priceRows.map((r) => [r.symbol, r.price_idr]));
  const tracked = new Set(
    (db.prepare('SELECT symbol FROM assets').all() as Array<{ symbol: string }>).map((r) => r.symbol),
  );
  // Fresh USD values: Solana mints via Jupiter+Dex batch; EVM via cached IDR/FX.
  const fx = createFxRateProvider(db, 3_600_000);
  let solUsd = new Map<string, number>();
  if (c === 'solana') {
    const mints = [...new Set(holdings.map((h) => h.ref).filter((m): m is string => !!m))];
    solUsd = await solanaUsd(mints);
  }
  const cgMap = new Map<string, string>(
    (db.prepare(`SELECT symbol, provider_id FROM asset_map WHERE provider = 'coingecko'`).all() as Array<{
      symbol: string;
      provider_id: string;
    }>).map((r) => [r.symbol, r.provider_id]),
  );
  const cgNeeded = [...new Set(holdings.map((h) => h.symbol.toUpperCase()).filter((s) => cgMap.has(s) && !prices.has(s)))];
  let cgUsd = new Map<string, number>();
  if (cgNeeded.length > 0) {
    try {
      const cg = new CoinGeckoProvider(db, fx, process.env.COINGECKO_API_KEY ?? '');
      const rate = await fx();
      const fetched = await cg.fetch(cgNeeded);
      cgUsd = new Map(fetched.map((p) => [p.symbol, p.priceIdr / rate]));
    } catch {
      // Leave unknown.
    }
  }
  const usdOf = (h: ChainHolding): number | null => {
    if (h.ref && solUsd.has(h.ref)) {
      const v = new Decimal(solUsd.get(h.ref)!).times(h.qty).toNumber();
      return Number.isFinite(v) ? v : null;
    }
    const idr = prices.get(h.symbol.toUpperCase());
    if (idr !== undefined) {
      return null; // resolved below with FX to avoid an extra fetch; see caller
    }
    if (cgUsd.has(h.symbol.toUpperCase())) {
      const v = new Decimal(cgUsd.get(h.symbol.toUpperCase())!).times(h.qty).toNumber();
      return Number.isFinite(v) ? v : null;
    }
    return null;
  };
  const fxRate = await fx().catch(() => null);
  return holdings.map((h) => {
    const base = h.symbol.toUpperCase();
    const symbol = resolveFinalSymbol(db, base, h.ref);
    let usd = usdOf(h);
    if (usd === null) {
      const idr = prices.get(symbol) ?? prices.get(base);
      if (idr !== undefined && fxRate) {
        const v = new Decimal(idr).times(h.qty).div(fxRate).toNumber();
        usd = Number.isFinite(v) ? v : null;
      }
    }
    return {
      ...h,
      base_symbol: base,
      symbol,
      price_idr: prices.get(symbol) ?? null,
      usd_value: usd,
      already_tracked: tracked.has(symbol),
    };
  });
}

/**
 * Import holdings as crypto assets. Qty follows the chain (source of truth).
 * Buy price: kept when already known; otherwise auto-filled with the current
 * market price at first sync (so P/L tracks from that moment, no typing needed).
 * Unknown price -> avg stays 0 and P/L is hidden.
 */
export async function importHoldings(
  db: Database.Database,
  chain: string,
  address: string,
  symbols?: string[],
  etherscanKey = '',
): Promise<{ imported: Array<{ symbol: string; qty: string }>; skipped_dust: Array<{ symbol: string; usd_value: number }> }> {
  const parsed = ImportBodySchema.parse({ chain, address, symbols });
  const preview = await previewHoldings(db, parsed.chain, parsed.address, etherscanKey);
  const wanted = parsed.symbols?.map((s) => s.toUpperCase());
  const minUsd = parsed.min_usd ?? 1;
  // True cost basis from Jupiter trade history (Solana). Takes precedence
  // over estimates: it comes from actual swaps, not typing or snapshots.
  let pnl = new Map<string, { avgCostUsd: number }>();
  let fxRate: number | null = null;
  if (parsed.chain === 'solana') {
    pnl = await fetchJupiterPnl(parsed.address);
    if ([...pnl.values()].some((p) => p.avgCostUsd > 0)) {
      fxRate = await createFxRateProvider(db, 3_600_000)().catch(() => null);
    }
  }
  const skipped: Array<{ symbol: string; usd_value: number }> = [];
  const out: Array<{ symbol: string; qty: string }> = [];
  for (const h of preview) {
    if (wanted && !wanted.includes(h.symbol) && !wanted.includes(h.base_symbol)) continue;
    if (h.symbol === '???') continue;
    // Dust filter: drop holdings provably worth less than the threshold.
    // Unpriced holdings are kept so nothing vanishes silently.
    if (h.usd_value !== null && h.usd_value < minUsd) {
      skipped.push({ symbol: h.symbol, usd_value: h.usd_value });
      continue;
    }
    // Re-resolve every iteration: earlier loop writes change collision state.
    const symbol = resolveFinalSymbol(db, h.base_symbol, h.ref);
    const existing = getAssetBySymbol(db, symbol);
    // Retire placeholders for the same mint: previously shortened asset with
    // no buy price. Match by mapping first, then by exact qty (avg 0, unmapped).
    if (!existing && h.ref && !symbol.includes('…')) {
      const kill = (sym: string): void => {
        const oldAsset = getAssetBySymbol(db, sym);
        if (oldAsset && oldAsset.avg_buy_price_idr === 0) {
          db.prepare(`DELETE FROM assets WHERE symbol = ?`).run(sym);
          db.prepare(`DELETE FROM asset_map WHERE symbol = ?`).run(sym);
        }
      };
      const byMap = db.prepare(
        `SELECT symbol FROM asset_map WHERE provider_id = ? AND symbol != ?`,
      ).get(h.ref, symbol) as { symbol: string } | undefined;
      if (byMap) {
        kill(byMap.symbol);
      } else {
        const dups = db.prepare(
          `SELECT symbol FROM assets WHERE type = 'crypto' AND qty = ? AND avg_buy_price_idr = 0
           AND symbol LIKE '%…%' AND symbol NOT IN (SELECT symbol FROM asset_map)`,
        ).all(h.qty) as Array<{ symbol: string }>;
        if (dups.length === 1) kill(dups[0].symbol);
      }
    }
    const live = getAssetBySymbol(db, symbol);
    let avg = live && live.avg_buy_price_idr > 0 ? live.avg_buy_price_idr : (h.price_idr ?? 0);
    // Jupiter trade-history cost wins over any estimate when available.
    // Native SOL carries no mint ref, so use the wSOL mint for lookup.
    const mint = h.ref ?? (h.symbol === 'SOL' ? 'So11111111111111111111111111111111111111112' : null);
    const jup = mint ? pnl.get(mint) : undefined;
    if (jup && jup.avgCostUsd > 0 && fxRate) {
      avg = Math.max(1, Math.round(jup.avgCostUsd * fxRate));
    }
    upsertAsset(db, {
      type: 'crypto',
      symbol,
      name: live?.name || h.name,
      qty: h.qty,
      avg_buy_price_idr: avg,
    });
    // Register Solana mint for price-by-mint (never overrides CoinGecko).
    if (parsed.chain === 'solana' && h.ref && h.mintSource !== 'native' && h.mintSource !== 'unknown') {
      const provider = h.mintSource === 'dex' ? 'dexscreener' : h.mintSource === 'gecko' ? 'geckoterminal' : 'jupiter';
      db.prepare(
        `INSERT INTO asset_map (symbol, provider, provider_id, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(symbol) DO NOTHING`,
      ).run(symbol, provider, h.ref);
    }
    out.push({ symbol, qty: h.qty });
  }
  return { imported: out, skipped_dust: skipped };
}
