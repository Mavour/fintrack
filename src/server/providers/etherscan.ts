import { Decimal } from 'decimal.js';
import { fetchWithTimeout, withRetry } from './types.js';
import type { ChainHolding } from './solana.js';

/** Etherscan V2 (one API for all EVM chains). Needs a free read-only key. */
const CHAINS: Record<string, { chainId: number; native: string; label: string }> = {
  eth: { chainId: 1, native: 'ETH', label: 'Ethereum' },
  hoodi: { chainId: 560006, native: 'ETH', label: 'Hoodi Testnet' },
  arb: { chainId: 42161, native: 'ETH', label: 'Arbitrum' },
  base: { chainId: 8453, native: 'ETH', label: 'Base' },
  op: { chainId: 10, native: 'ETH', label: 'Optimism' },
  polygon: { chainId: 137, native: 'POL', label: 'Polygon' },
};

export const ETHERSCAN_CHAINS = Object.keys(CHAINS);

interface TokTx {
  contractAddress: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimal: string;
}

/**
 * Fetch native + ERC-20 holdings via Etherscan V2.
 * The key is read-only (no trading permission possible). Throws 400 without key.
 */
export async function fetchEtherscanHoldings(
  address: string,
  chain: string,
  apiKey: string,
): Promise<ChainHolding[]> {
  const c = CHAINS[chain];
  if (!c) throw Object.assign(new Error(`Chain tidak didukung: ${chain}`), { statusCode: 400 });
  if (!apiKey) {
    throw Object.assign(
      new Error('Butuh API key Etherscan gratis — daftar di etherscan.io, lalu isi ETHERSCAN_API_KEY di .env'),
      { statusCode: 400 },
    );
  }
  const q = (module: string, action: string, extra = '') =>
    `https://api.etherscan.io/v2/api?chainid=${c.chainId}&module=${module}&action=${action}&address=${address}${extra}&apikey=${apiKey}`;
  const out: ChainHolding[] = [];

  try {
    const r = await withRetry(() => fetchWithTimeout(q('account', 'balance', '&tag=latest'), 15_000));
    const j = (await r.json()) as { status?: string; result?: string };
    if (j.status === '1' && j.result && j.result !== '0') {
      out.push({
        symbol: chain === 'hoodi' ? 'ETH_HOODI' : c.native,
        name: `${c.label} Native`,
        qty: new Decimal(j.result).div(new Decimal(10).pow(18)).toString(),
        ref: null,
        decimals: 18,
      });
    }
  } catch {
    // Continue with tokens.
  }

  // Discover ERC-20 contracts from transfer history, then read each balance.
  const txRes = await withRetry(() =>
    fetchWithTimeout(q('account', 'tokentx', '&startblock=0&endblock=99999999&sort=asc'), 20_000),
  );
  const txJson = (await txRes.json()) as { status?: string; result?: TokTx[] | string; message?: string };
  if (txJson.status !== '1' || !Array.isArray(txJson.result)) return out;
  const seen = new Map<string, TokTx>();
  for (const t of txJson.result) {
    if (t.contractAddress && !seen.has(t.contractAddress.toLowerCase())) {
      seen.set(t.contractAddress.toLowerCase(), t);
    }
  }
  for (const t of [...seen.values()].slice(0, 30)) {
    await new Promise((r) => setTimeout(r, 220)); // free-tier pacing
    try {
      const bRes = await withRetry(() =>
        fetchWithTimeout(q('account', 'tokenbalance', `&contractaddress=${t.contractAddress}&tag=latest`), 15_000),
      );
      const bJson = (await bRes.json()) as { status?: string; result?: string };
      if (bJson.status !== '1' || !bJson.result || bJson.result === '0') continue;
      const dec = Number(t.tokenDecimal) || 18;
      const qty = new Decimal(bJson.result).div(new Decimal(10).pow(dec)).toString();
      if (qty === '0') continue;
      out.push({
        symbol: (t.tokenSymbol || '???').toUpperCase(),
        name: t.tokenName || 'Token EVM',
        qty,
        ref: t.contractAddress,
        decimals: dec,
      });
    } catch {
      // Skip unreadable contracts.
    }
  }
  return out;
}
