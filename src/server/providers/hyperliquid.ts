import { z } from 'zod';
import { providerFetch, normalizeList, throwForStatus, type WalletProvider, type WalletRef, type NormalizedPosition } from './walletTypes.js';
import { logger } from '../logger.js';
import { redactAddress } from '../services/address.js';

/**
 * HyperCore (Hyperliquid L1) spot balances for the user's EVM address.
 * Official read-only API, no key (docs: hyperliquid.gitbook.io → API → info):
 * - POST https://api.hyperliquid.xyz/info {"type":"spotClearinghouseState","user":"0x…"}
 *   → {"balances":[{"coin":"USDC","token":0,"hold":"0.0","total":"14.625485","entryNtl":"0.0"}]}
 * - POST … {"type":"spotMetaAndAssetCtxs"}
 *   → [{tokens, universe:[{name:"PURR/USDC",tokens:[1,0],index:0}]}, [{midPx,markPx,…}]]
 *   Price per coin = midPx of the "COIN/USDC" universe entry (index-aligned).
 * Coins without a USDC pair keep price/value null (never invented).
 * NOTE: entryNtl is intentionally ignored — wallet P/L comes only from the
 * user-filled cost_basis table, never from exchange notional data.
 */

const HL_INFO = 'https://api.hyperliquid.xyz/info';

const SpotBalance = z.object({
  coin: z.string(),
  token: z.number(),
  hold: z.string(),
  total: z.string(),
  entryNtl: z.string().optional(),
});

const SpotState = z.object({
  balances: z.array(SpotBalance),
});

const SpotMeta = z.object({
  tokens: z.array(z.object({ name: z.string(), index: z.number() }).passthrough()),
  universe: z.array(z.object({ name: z.string(), index: z.number() }).passthrough()),
});

const SpotCtx = z.object({
  midPx: z.string().optional(),
  markPx: z.string().optional(),
});

const MetaAndCtxs = z.tuple([SpotMeta, z.array(SpotCtx)]);

/** spotMeta cached 1h module-level (same for every wallet). */
let metaCache: { at: number; coinPrice: Map<string, number> } | null = null;

/** Test-only: clear the module-level meta cache. */
export function __resetHyperliquidCache(): void {
  metaCache = null;
}

async function coinPrices(): Promise<Map<string, number>> {
  if (metaCache && Date.now() - metaCache.at < 3600_000) return metaCache.coinPrice;
  const res = await providerFetch(
    HL_INFO,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'spotMetaAndAssetCtxs' }) },
    10_000,
  );
  throwForStatus(res, 'hyperliquid');
  const json: unknown = await res.json();
  const parsed = MetaAndCtxs.safeParse(json);
  if (!parsed.success) throw Object.assign(new Error('Respons Hyperliquid spotMeta tidak sesuai skema'), { statusCode: 502 });
  const [meta, ctxs] = parsed.data;
  const out = new Map<string, number>([['USDC', 1]]);
  meta.universe.forEach((u, i) => {
    const m = /^(.+)\/USDC$/.exec(u.name);
    const px = ctxs[i]?.midPx ?? ctxs[i]?.markPx;
    if (m && px !== undefined) {
      const v = Number(px);
      if (Number.isFinite(v) && v > 0) out.set(m[1].toUpperCase(), v);
    }
  });
  metaCache = { at: Date.now(), coinPrice: out };
  logger.info({ coins: out.size }, 'hyperliquid spot meta cached');
  return out;
}

export class HyperliquidSpotProvider implements WalletProvider {
  readonly name = 'hyperliquid-spot';

  async fetchPositions(wallet: WalletRef): Promise<NormalizedPosition[]> {
    if (wallet.network_type !== 'evm') return [];
    const res = await providerFetch(
      HL_INFO,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'spotClearinghouseState', user: wallet.address }),
      },
      10_000,
    );
    throwForStatus(res, 'hyperliquid');
    const json: unknown = await res.json();
    const parsed = SpotState.safeParse(json);
    if (!parsed.success) throw Object.assign(new Error('Respons Hyperliquid spot tidak sesuai skema'), { statusCode: 502 });
    const prices = await coinPrices().catch(() => new Map<string, number>());
    await new Promise((r) => setTimeout(r, 300)); // pacing info endpoint
    const raw = parsed.data.balances
      .filter((b) => Number(b.total) > 0)
      .map((b) => {
        const price = b.coin.toUpperCase() === 'USDC' ? 1 : (prices.get(b.coin.toUpperCase()) ?? null);
        const amount = Number(b.total);
        return {
          chain_id: 'hypercore',
          kind: 'token' as const,
          protocol: 'hyperliquid-spot',
          symbol: b.coin.toUpperCase().slice(0, 40),
          name: `Hyperliquid ${b.coin}`,
          amount: b.total,
          price_usd: price,
          value_usd: price !== null ? amount * price : null,
          meta: { coin_index: b.token, hold: b.hold },
        };
      });
    logger.info({ wallet: redactAddress(wallet.address), count: raw.length }, 'hyperliquid spot fetched');
    return normalizeList(raw, this.name);
  }
}
