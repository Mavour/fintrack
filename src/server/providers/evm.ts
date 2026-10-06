import { Decimal } from 'decimal.js';
import { fetchWithTimeout, withRetry } from './types.js';
import type { ChainHolding } from './solana.js';

/** Keyless EVM explorers (Blockscout v1 API). */
const EXPLORERS: Record<string, { base: string; native: string; label: string }> = {
  eth: { base: 'https://eth.blockscout.com/api', native: 'ETH', label: 'Ethereum' },
  arb: { base: 'https://arbitrum.blockscout.com/api', native: 'ETH', label: 'Arbitrum' },
  base: { base: 'https://base.blockscout.com/api', native: 'ETH', label: 'Base' },
  op: { base: 'https://optimism.blockscout.com/api', native: 'ETH', label: 'Optimism' },
  polygon: { base: 'https://polygon.blockscout.com/api', native: 'POL', label: 'Polygon' },
};

export const EVM_CHAINS = Object.keys(EXPLORERS);

export function isValidEvmAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

interface BsToken {
  balance: string;
  contractAddress: string;
  decimals: string;
  name: string;
  symbol: string;
}

/**
 * Fetch ERC-20 + native holdings of an EVM address. Fully keyless.
 * Only public address data is ever requested — never keys or signatures.
 */
export async function fetchEvmHoldings(address: string, chain: string): Promise<ChainHolding[]> {
  if (!isValidEvmAddress(address)) throw Object.assign(new Error('Alamat EVM tidak valid'), { statusCode: 400 });
  const ex = EXPLORERS[chain];
  if (!ex) throw Object.assign(new Error(`Chain tidak didukung: ${chain}`), { statusCode: 400 });

  const out: ChainHolding[] = [];
  // Native coin balance (wei -> units).
  try {
    const r = await withRetry(() =>
      fetchWithTimeout(`${ex.base}?module=account&action=balance&address=${address}`, 20_000),
    );
    const j = (await r.json()) as { status?: string; result?: string };
    if (j.result && j.result !== '0') {
      const units = new Decimal(j.result).div(new Decimal(10).pow(18)).toString();
      out.push({ symbol: ex.native, name: ex.label + ' Native', qty: units, ref: null, decimals: 18 });
    }
  } catch {
    // Native lookup failed — continue with tokens.
  }

  const res = await withRetry(() =>
    fetchWithTimeout(`${ex.base}?module=account&action=tokenlist&address=${address}`, 25_000),
  );
  if (!res.ok) throw new Error(`Explorer HTTP ${res.status}`);
  const json = (await res.json()) as { status?: string; result?: BsToken[] | string };
  const list = Array.isArray(json.result) ? json.result : [];
  for (const t of list) {
    if (!t.balance || t.balance === '0') continue;
    const dec = Number(t.decimals) || 18;
    const qty = new Decimal(t.balance).div(new Decimal(10).pow(dec)).toString();
    if (qty === '0') continue;
    out.push({ symbol: t.symbol || '???', name: t.name || 'Token EVM', qty, ref: t.contractAddress, decimals: dec });
    if (out.length >= 100) break;
  }
  return out;
}
