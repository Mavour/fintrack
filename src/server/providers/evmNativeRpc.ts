import { Decimal } from 'decimal.js';
import type { WalletProvider, WalletRef, NormalizedPosition } from './walletTypes.js';
import { providerFetch, normalizeList, throwForStatus } from './walletTypes.js';
import { EVM_CHAINS } from './evm.js';
import { NATIVE_WRAPPED } from './evmExplorer.js';
import { logger } from '../logger.js';
import { redactAddress } from '../services/address.js';

/**
 * Saldo native EVM via JSON-RPC publik (keyless, tanpa indexer).
 * Satu panggilan eth_getBalance per chain — jauh lebih ringan dan andal
 * dibanding explorer saat Blockscout di-rate-limit.
 *
 * URL default memakai publicnode (terverifikasi live). Override per chain
 * via env EVM_RPC_<CHAIN>_URL (cth. EVM_RPC_ETH_URL). Harga diisi price tier
 * CoinGecko via meta.token_id (kontrak wrapped kanonikal — sama dengan
 * EvmExplorerProvider agar konsisten).
 */

const DEFAULT_RPC: Record<string, string> = {
  eth: 'https://ethereum.publicnode.com',
  arb: 'https://arbitrum-one.publicnode.com',
  base: 'https://base.publicnode.com',
  op: 'https://optimism.publicnode.com',
  polygon: 'https://polygon-bor.publicnode.com',
};

const NATIVE_SYMBOL: Record<string, string> = {
  eth: 'ETH',
  arb: 'ETH',
  base: 'ETH',
  op: 'ETH',
  polygon: 'POL',
};

const NATIVE_NAME: Record<string, string> = {
  eth: 'Ethereum Native',
  arb: 'Arbitrum Native',
  base: 'Base Native',
  op: 'Optimism Native',
  polygon: 'Polygon Native',
};

function rpcUrl(chain: string): string {
  const v = process.env[`EVM_RPC_${chain.toUpperCase()}_URL`];
  return v?.trim() ? v.trim() : (DEFAULT_RPC[chain] ?? '');
}

function paceMs(): number {
  const v = Number(process.env.EVM_RPC_PACE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 600;
}

function intervalMs(): number {
  const v = Number(process.env.EVM_RPC_CHAIN_INTERVAL);
  return Number.isFinite(v) && v >= 0 ? v : 120_000;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RpcRes {
  result?: string;
  error?: { message?: string };
}

/** Cache per (chain, alamat): tahan terhadap gagal/429 — saldo terakhir selalu dipakai. */
const chainCache = new Map<string, { at: number; positions: NormalizedPosition[] }>();
const chainLastError = new Map<string, string>();

const cacheKey = (chain: string, address: string): string => `${chain}::${address.toLowerCase()}`;

/** Test-only: reset cache modul. */
export function __resetEvmNativeRpcCache(): void {
  chainCache.clear();
  chainLastError.clear();
}

async function nativeBalance(chain: string, address: string): Promise<string | null> {
  const url = rpcUrl(chain);
  if (!url) return null;
  const res = await providerFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
    },
    15_000,
  );
  throwForStatus(res, 'evm-rpc');
  const json = (await res.json()) as RpcRes;
  if (json.error) throw new Error(`RPC ${chain} gagal: ${json.error.message ?? 'unknown'}`);
  if (typeof json.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(json.result)) throw new Error(`RPC ${chain}: saldo tidak valid`);
  const wei = BigInt(json.result);
  if (wei <= 0n) return null;
  return new Decimal(wei.toString()).div(new Decimal(10).pow(18)).toString();
}

export class EvmNativeRpcProvider implements WalletProvider {
  readonly name = 'evm-rpc';
  failedChains: string[] = [];

  async fetchPositions(wallet: WalletRef): Promise<NormalizedPosition[]> {
    if (wallet.network_type !== 'evm') return [];
    this.failedChains = [];
    const now = Date.now();
    const interval = intervalMs();
    const out: NormalizedPosition[] = [];
    let nothingCached = true;
    let failures = 0;

    for (const chain of EVM_CHAINS) {
      const key = cacheKey(chain, wallet.address);
      const cached = chainCache.get(key);
      if (cached) nothingCached = false;
      if (cached && now - cached.at < interval) {
        out.push(...cached.positions);
        continue;
      }
      try {
        const qty = await nativeBalance(chain, wallet.address);
        const symbol = NATIVE_SYMBOL[chain] ?? '???';
        const positions: NormalizedPosition[] =
          qty && symbol !== '???'
            ? [
                {
                  chain_id: chain,
                  kind: 'token',
                  protocol: 'evm-rpc',
                  symbol,
                  name: NATIVE_NAME[chain] ?? symbol,
                  amount: qty,
                  price_usd: null,
                  value_usd: null,
                  meta: {
                    token_id: (NATIVE_WRAPPED[chain] ?? null)?.toLowerCase() ?? null,
                    explorer: 'evm-rpc',
                  },
                },
              ]
            : [];
        chainCache.set(key, { at: Date.now(), positions });
        chainLastError.delete(key);
        out.push(...positions);
      } catch (e) {
        const msg = (e as Error).message ?? 'gagal';
        chainLastError.set(key, msg);
        failures++;
        this.failedChains.push(chain);
        logger.warn({ chain, wallet: redactAddress(wallet.address), err: msg }, 'evm rpc native gagal (chain dilewati, pakai data terakhir)');
        if (cached) out.push(...cached.positions.map((p) => ({ ...p, meta: { ...p.meta, cached_at: new Date(cached.at).toISOString() } })));
      }
      await sleep(paceMs());
    }

    if (out.length === 0 && nothingCached && failures === EVM_CHAINS.length) {
      throw Object.assign(new Error('Semua RPC EVM gagal tanpa data cache'), { statusCode: 502 });
    }
    logger.info({ wallet: redactAddress(wallet.address), count: out.length }, 'evm native rpc fetched (cache-backed)');
    return normalizeList(out, this.name);
  }
}
