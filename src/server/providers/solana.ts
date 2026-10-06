import { fetchWithTimeout, withRetry } from './types.js';
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
    out.push({ symbol: 'SOL', name: 'Solana', qty: data.uiAmountString, ref: null, decimals: 9 });
  }
  for (const [mint, accounts] of Object.entries(data.tokens ?? {})) {
    let total = 0;
    let decimals = 0;
    for (const a of accounts) {
      total += Number(a.uiAmountString);
      decimals = a.decimals;
    }
    if (!(total > 0)) continue;
    const m = meta.get(mint);
    out.push({
      symbol: m?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`,
      name: m?.name ?? 'Token Solana',
      qty: String(total),
      ref: mint,
      decimals,
    });
  }
  return out.slice(0, 100);
}

export { isValidSolanaAddress };
