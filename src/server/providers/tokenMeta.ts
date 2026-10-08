import { fetchDexTokens } from './dexscreener.js';
import { fetchGeckoSymbols } from './geckoterminal.js';
import { fetchWithTimeout, withRetry } from './types.js';

/**
 * Resolver symbol/nama token bersama (solana-rpc-fallback dkk).
 * Prioritas: Jupiter verified list (cache 24 jam) → DexScreener → GeckoTerminal
 * (tahu token "mati" pun, harga sering null). Semua best-effort; kegagalan
 * sumber tidak pernah melempar — mint dipakai sebagai fallback symbol.
 */

interface JupToken {
  id: string;
  symbol: string;
  name: string;
}

let jupCache: { at: number; byMint: Map<string, JupToken> } | null = null;

/** Test-only: clear the module-level Jupiter cache. */
export function __resetTokenMetaCache(): void {
  jupCache = null;
}

export interface TokenMeta {
  symbol: string;
  name: string;
  source: 'verified' | 'dex' | 'gecko' | 'unknown';
}

export async function resolveTokens(mints: string[]): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>();
  if (mints.length === 0) return out;

  // 1) Jupiter verified (3873 token, satu fetch per hari).
  try {
    if (!jupCache || Date.now() - jupCache.at > 24 * 3600 * 1000) {
      const res = await withRetry(() => fetchWithTimeout('https://api.jup.ag/tokens/v2/tag?query=verified', 15_000));
      if (res.ok) {
        const list = (await res.json()) as JupToken[];
        jupCache = { at: Date.now(), byMint: new Map(list.map((t) => [t.id, t])) };
      }
    }
    if (jupCache) {
      for (const m of mints) {
        const t = jupCache.byMint.get(m);
        if (t) out.set(m, { symbol: t.symbol, name: t.name, source: 'verified' });
      }
    }
  } catch {
    // Non-fatal.
  }

  const unknown = mints.filter((m) => !out.has(m));
  if (unknown.length === 0) return out;

  // 2) DexScreener (pairs aktif pertama menang).
  try {
    const dex = await fetchDexTokens(unknown);
    for (const [m, t] of dex) {
      if (!out.has(m)) out.set(m, { symbol: t.symbol, name: t.name, source: 'dex' });
    }
  } catch {
    // Non-fatal.
  }

  const still = unknown.filter((m) => !out.has(m));
  if (still.length === 0) return out;

  // 3) GeckoTerminal — mengenal token tanpa pair (dead tokens).
  try {
    const gecko = await fetchGeckoSymbols(still);
    for (const [m, t] of gecko) {
      if (!out.has(m)) out.set(m, { symbol: t.symbol, name: t.name, source: 'gecko' });
    }
  } catch {
    // Non-fatal.
  }
  return out;
}