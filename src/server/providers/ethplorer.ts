import { Decimal } from 'decimal.js';
import type { WalletProvider, WalletRef, NormalizedPosition } from './walletTypes.js';
import { providerFetch, normalizeList, throwForStatus } from './walletTypes.js';
import { logger } from '../logger.js';
import { redactAddress } from '../services/address.js';

/**
 * Token ERC-20 Ethereum mainnet via Ethplorer (keyless, best-effort).
 * API key default "freekey" (demo publik, limit ketat) — override via
 * env ETHPLORER_API_KEY bila punya key sendiri.
 *
 * Hanya token (bukan ETH): saldo native sudah ditangani EvmNativeRpcProvider
 * agar tidak dobel. Harga ikut dari Ethplorer bila ada (rate USD); token
 * tanpa harga (spam/baru) tetap disimpan tanpa harga — jujur, tidak dikarang.
 * Cache 10 menit (freekey sangat ketat) via env ETHPLORER_INTERVAL.
 */

function apiKey(): string {
  return process.env.ETHPLORER_API_KEY?.trim() ? process.env.ETHPLORER_API_KEY.trim() : 'freekey';
}

function intervalMs(): number {
  const v = Number(process.env.ETHPLORER_INTERVAL);
  return Number.isFinite(v) && v >= 0 ? v : 600_000;
}

let cache: Map<string, { at: number; positions: NormalizedPosition[] }> = new Map();
let lastError: string | null = null;

/** Test-only: reset cache modul. */
export function __resetEthplorerCache(): void {
  cache = new Map();
  lastError = null;
}

interface EthTokenInfo {
  address: string;
  symbol?: string;
  name?: string;
  decimals?: string;
  price?: { rate?: number } | false | null;
}

interface EthplorerRes {
  tokens?: Array<{ tokenInfo: EthTokenInfo; balance: number; rawBalance: string }>;
  error?: { message?: string };
}

/** Parse respons Ethplorer (pure, unit-tested). ETH dilewati (diurus RPC). */
export function parseEthplorerTokens(json: EthplorerRes): NormalizedPosition[] {
  const out: NormalizedPosition[] = [];
  for (const t of json.tokens ?? []) {
    const info = t.tokenInfo ?? ({} as EthTokenInfo);
    const symbol = (info.symbol || '???').toUpperCase();
    if (!symbol || symbol === '???') continue;
    if (symbol === 'ETH') continue; // saldo native milik EvmNativeRpcProvider
    const dec = Number(info.decimals) || 18;
    let qty: string;
    try {
      const raw = String(t.rawBalance ?? t.balance ?? '0');
      qty = new Decimal(raw).div(new Decimal(10).pow(dec)).toString();
    } catch {
      continue;
    }
    if (qty === '0') continue;
    const rate = typeof info.price === 'object' && info.price && typeof info.price.rate === 'number' ? info.price.rate : null;
    out.push({
      chain_id: 'eth',
      kind: 'token',
      protocol: 'ethplorer',
      symbol: symbol.slice(0, 40),
      name: info.name || symbol,
      amount: qty,
      price_usd: rate,
      value_usd: rate !== null ? Number(qty) * rate : null,
      meta: { token_id: info.address?.toLowerCase() ?? null, explorer: 'ethplorer' },
    });
  }
  return out;
}

export class EthplorerProvider implements WalletProvider {
  readonly name = 'ethplorer';

  async fetchPositions(wallet: WalletRef): Promise<NormalizedPosition[]> {
    if (wallet.network_type !== 'evm') return [];
    const now = Date.now();
    const key = wallet.address.toLowerCase();
    const entry = cache.get(key);
    if (entry && now - entry.at < intervalMs()) return entry.positions;
    try {
      const res = await providerFetch(
        `https://api.ethplorer.io/getAddressInfo/${wallet.address}?apiKey=${encodeURIComponent(apiKey())}`,
        { headers: { Accept: 'application/json' } },
        20_000,
      );
      throwForStatus(res, 'ethplorer');
      const json = (await res.json()) as EthplorerRes;
      if (json.error) throw new Error(`Ethplorer: ${json.error.message ?? 'unknown'}`);
      const positions = parseEthplorerTokens(json);
      cache.set(key, { at: Date.now(), positions });
      lastError = null;
      logger.info({ wallet: redactAddress(wallet.address), count: positions.length }, 'ethplorer tokens fetched');
      return normalizeList(positions, this.name);
    } catch (e) {
      const msg = (e as Error).message ?? 'gagal';
      lastError = msg;
      logger.warn({ wallet: redactAddress(wallet.address), err: msg }, 'ethplorer gagal (pakai cache terakhir bila ada)');
      if (entry) return entry.positions;
      void lastError;
      throw e;
    }
  }
}
