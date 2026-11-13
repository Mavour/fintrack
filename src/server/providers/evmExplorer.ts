import type { WalletProvider, WalletRef, NormalizedPosition } from './walletTypes.js';
import { fetchEvmHoldings, EVM_CHAINS } from './evm.js';
import { normalizeList } from './walletTypes.js';
import { logger } from '../logger.js';
import { redactAddress } from '../services/address.js';

/**
 * EVM fallback keyless: explorer Blockscout publik (v1 API) untuk semua chain
 * EVM (eth/arb/base/op/polygon). Dipakai bila DeBank tidak tersedia (tanpa
 * DEBANK_ACCESS_KEY atau unit DeBank habis) agar saldo EVM tetap tersinkron
 * gratis. Tidak pernah menebak — token tanpa harga tetap tanpa harga sampai
 * price tier CoinGecko menghargainya via contract (meta.token_id).
 *
 * Penghemat permintaan: tiap chain di-refresh paling cepat sekali per
 * EVM_EXPLORER_CHAIN_INTERVAL (default 120 dtk), bergilir antar cycle — jadi
 * tiap chain ≈ 1 panggilan/2 mnt per wallet (muat bagi explorer publik).
 * Bila satu chain gagal / belum waktunya, posisi terakhir chain itu dipakai
 * (snapshot stabil, tanpa drop).
 *
 * Harga koin native: price tier CoinGecko menghargai berdasarkan contract,
 * jadi untuk koin native dipakai kontrak wrapped kanonikal per chain (WETH
 * dst) — harganya identik dengan koin native (dokumentasi publik CoinGecko).
 */

const CHAIN_PACE_MS = 600;
const CHAIN_INTERVAL_MS = 120_000;

/** Pace antar chain bisa dikurangi via env (mis. tes). */
function chainPaceMs(): number {
  const v = Number(process.env.EVM_EXPLORER_PACE_MS);
  return Number.isFinite(v) && v >= 0 ? v : CHAIN_PACE_MS;
}

/** Interval refresh per chain (0 = selalu muat ulang). */
function chainIntervalMs(): number {
  const v = Number(process.env.EVM_EXPLORER_CHAIN_INTERVAL);
  return Number.isFinite(v) && v >= 0 ? v : CHAIN_INTERVAL_MS;
}

/** Override host explorer per chain via env EVM_EXPLORER_<CHAIN>_URL (tanpa /api). */
function hostOverride(chain: string): string | undefined {
  const v = process.env[`EVM_EXPLORER_${chain.toUpperCase()}_URL`]?.trim();
  if (!v) return undefined;
  // SSRF guard: hanya https publik, tolak private/loopback/link-local.
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:') return undefined;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return undefined;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|0\.0\.0\.0|::1|fc00:|fe80:)/i.test(host)) return undefined;
  return v.replace(/\/+$/, '');
}

/** Kontrak wrapped kanonikal per chain (untuk harga native di CoinGecko). */
export const NATIVE_WRAPPED: Record<string, string> = {
  eth: '0xC02aaa39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
  arb: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH Arbitrum
  base: '0x4200000000000000000000000000000000000006', // WETH Base
  op: '0x4200000000000000000000000000000000000006', // WETH Optimism
  polygon: '0x0000000000000000000000000000000000001010', // POL native
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ChainCache {
  at: number;
  positions: NormalizedPosition[];
}

/** Cache per (chain, alamat): kebal terhadap gagal/429 — posisi terakhir selalu dipakai. */
const chainCache = new Map<string, ChainCache>();
const chainLastError = new Map<string, string>();

const cacheKey = (chain: string, address: string): string => `${chain}::${address.toLowerCase()}`;

/** Test-only: reset cache modul. */
export function __resetEvmExplorerCache(): void {
  chainCache.clear();
  chainLastError.clear();
}

function toPositions(wallet: WalletRef, chain: string, holdings: Array<{ symbol: string; name: string; qty: string; ref: string | null }>): NormalizedPosition[] {
  const out: NormalizedPosition[] = [];
  for (const h of holdings) {
    const symbol = h.symbol.toUpperCase();
    if (!symbol || symbol === '???') continue;
    const tokenId = h.ref ?? NATIVE_WRAPPED[chain] ?? null;
    out.push({
      chain_id: chain,
      kind: 'token',
      protocol: 'blockscout',
      symbol: symbol.slice(0, 40),
      name: h.name || symbol,
      amount: h.qty,
      price_usd: null,
      value_usd: null,
      meta: { token_id: tokenId ? tokenId.toLowerCase() : null, explorer: 'blockscout' },
    });
  }
  return out;
}

export class EvmExplorerProvider implements WalletProvider {
  readonly name = 'evm-explorer';
  failedChains: string[] = [];

  async fetchPositions(wallet: WalletRef): Promise<NormalizedPosition[]> {
    if (wallet.network_type !== 'evm') return [];
    this.failedChains = [];
    const now = Date.now();
    const interval = chainIntervalMs();
    const out: NormalizedPosition[] = [];
    let nothingCached = true;
    let failures = 0;

    for (const chain of EVM_CHAINS) {
      const key = cacheKey(chain, wallet.address);
      const cached = chainCache.get(key);
      if (cached) nothingCached = false;
      const due = !cached || now - cached.at >= interval;
      if (!due) {
        // Belum waktunya muat ulang — pakai data terakhir chain+alamat ini.
        out.push(...cached!.positions);
        continue;
      }
      try {
        const holdings = await fetchEvmHoldings(wallet.address, chain, hostOverride(chain));
        const positions = toPositions(wallet, chain, holdings);
        chainCache.set(key, { at: Date.now(), positions });
        chainLastError.delete(key);
        out.push(...positions);
      } catch (e) {
        const msg = (e as Error).message ?? 'gagal';
        chainLastError.set(key, msg);
        failures++;
        this.failedChains.push(chain);
        logger.warn({ chain, wallet: redactAddress(wallet.address), err: msg }, 'blockscout explorer gagal (chain dilewati, pakai data terakhir)');
        // Gagal transien → pertahankan posisi terakhir chain agar snapshot stabil.
        if (cached) out.push(...cached.positions.map((p) => ({ ...p, meta: { ...p.meta, cached_at: new Date(cached.at).toISOString() } })));
      }
      // Pacing publik: jeda kecil antar chain.
      await sleep(chainPaceMs());
    }

    // Semua chain gagal tanpa pernah punya cache → provider dianggap gagal
    // (status jujur), bukan "sukses kosong" yang berisiko menghapus snapshot.
    if (out.length === 0 && nothingCached && failures === EVM_CHAINS.length) {
      throw Object.assign(new Error('Semua chain explorer Blockscout gagal tanpa data cache'), { statusCode: 502 });
    }
    logger.info({ wallet: redactAddress(wallet.address), count: out.length, chains: EVM_CHAINS.filter((c) => chainCache.has(cacheKey(c, wallet.address))) }, 'evm explorer positions fetched (cache-backed)');
    return normalizeList(out, this.name);
  }
}
