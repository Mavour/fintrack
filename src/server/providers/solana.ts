import { fetchWithTimeout, withRetry } from './types.js';
import { fetchDexTokens } from './dexscreener.js';
import { fetchGeckoSymbols } from './geckoterminal.js';
import { logger } from '../logger.js';

export interface ChainHolding {
  /** Human symbol (SOL) or shortened mint when unknown. */
  symbol: string;
  name: string;
  /** Exact decimal qty as string. */
  qty: string;
  /** Token mint address (solana) or contract (evm). Null for native coin. */
  ref: string | null;
  decimals: number;
  /** Where the symbol came from (for price-map registration). */
  mintSource: 'native' | 'verified' | 'dex' | 'gecko' | 'unknown';
}

interface UltraHoldings {
  amount: string;
  uiAmount: number;
  uiAmountString: string;
  tokens: Record<string, Array<{ amount: string; uiAmountString: string; decimals: number }>>;
}

interface JupToken {
  id: string;
  symbol: string;
  name: string;
}

/** Verified-token list cached 24h (3873 tokens, one fetch per day). */
let tokenCache: { at: number; byMint: Map<string, JupToken> } | null = null;

/** Test-only: clear the module-level token cache. */
export function __resetTokenCache(): void {
  tokenCache = null;
}

async function tokenMap(): Promise<Map<string, JupToken>> {
  if (tokenCache && Date.now() - tokenCache.at < 24 * 3600 * 1000) return tokenCache.byMint;
  const res = await withRetry(() => fetchWithTimeout('https://api.jup.ag/tokens/v2/tag?query=verified', 15_000));
  if (!res.ok) throw new Error(`Jupiter tokens HTTP ${res.status}`);
  const list = (await res.json()) as JupToken[];
  const byMint = new Map(list.map((t) => [t.id, t]));
  tokenCache = { at: Date.now(), byMint };
  logger.info({ count: byMint.size }, 'jupiter token list cached');
  return byMint;
}

function isValidSolanaAddress(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

/**
 * Fetch all holdings of a Solana wallet (native SOL + SPL tokens).
 * Fully keyless: free Lite endpoint (60 req/min), fallback to main endpoint.
 */
export async function fetchSolanaHoldings(address: string): Promise<ChainHolding[]> {
  if (!isValidSolanaAddress(address)) throw Object.assign(new Error('Alamat Solana tidak valid'), { statusCode: 400 });
  let res: Response;
  try {
    res = await withRetry(() =>
      fetchWithTimeout(`https://lite-api.jup.ag/ultra/v1/holdings/${address}`, 15_000),
    );
  } catch {
    res = await withRetry(() =>
      fetchWithTimeout(`https://api.jup.ag/ultra/v1/holdings/${address}`, 15_000),
    );
  }
  if (!res.ok) throw new Error(`Jupiter holdings HTTP ${res.status}`);
  const data = (await res.json()) as UltraHoldings;
  const meta = await tokenMap().catch(() => new Map<string, JupToken>());

  const out: ChainHolding[] = [];
  if (data.uiAmount > 0) {
    out.push({ symbol: 'SOL', name: 'Solana', qty: data.uiAmountString, ref: null, decimals: 9, mintSource: 'native' });
  }
  const unknownMints: string[] = [];
  const byMint = new Map<string, { total: number; decimals: number }>();
  for (const [mint, accounts] of Object.entries(data.tokens ?? {})) {
    let total = 0;
    let decimals = 0;
    for (const a of accounts) {
      total += Number(a.uiAmountString);
      decimals = a.decimals;
    }
    if (!(total > 0)) continue;
    byMint.set(mint, { total, decimals });
    if (!meta.get(mint)) unknownMints.push(mint);
  }
  // Resolve long-tail mints to real symbols via DexScreener (one batched call).
  const dex = unknownMints.length > 0 ? await fetchDexTokens(unknownMints).catch(() => new Map()) : new Map();
  const stillUnknown = unknownMints.filter((m) => !dex.has(m));
  // Last resort for symbols: GeckoTerminal knows even dead tokens (price often null).
  const gecko = stillUnknown.length > 0 ? await fetchGeckoSymbols(stillUnknown).catch(() => new Map()) : new Map();
  for (const [mint, { total, decimals }] of byMint) {
    const m = meta.get(mint);
    if (m) {
      out.push({ symbol: m.symbol, name: m.name, qty: String(total), ref: mint, decimals, mintSource: 'verified' });
    } else {
      const d = (dex as Map<string, { symbol: string; name: string }>).get(mint);
      const g = (gecko as Map<string, { symbol: string; name: string }>).get(mint);
      const sym = d?.symbol ?? g?.symbol;
      out.push({
        symbol: sym ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`,
        name: d?.name ?? g?.name ?? 'Token Solana',
        qty: String(total),
        ref: mint,
        decimals,
        mintSource: d ? 'dex' : g ? 'gecko' : 'unknown',
      });
    }
  }
  return out.slice(0, 100);
}

export { isValidSolanaAddress };
