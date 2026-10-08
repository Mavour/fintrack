import type Database from 'better-sqlite3';
import { z } from 'zod';
import { providerFetch, throwForStatus } from '../providers/walletTypes.js';
import { logger } from '../logger.js';

/**
 * Tingkat HARGA: perbarui harga token yang sudah dikenal lalu hitung ulang
 * value_usd = amount × price — tanpa membaca ulang wallet (hemat kuota).
 * - Solana: Jupiter Price API v3 per mint (sumber harga resmi murah).
 * - EVM: CoinGecko simple/token_price per contract address per platform
 *   (di luar DeBank agar unit tidak terpakai). Token tanpa harga memakai
 *   harga terakhir DeBank yang tersimpan.
 * CATATAN: peta platform CoinGecko di bawah mengikuti dokumentasi publik
 * CoinGecko (asset_platforms). Bila platform tak dikenal, token dilewati
 * dengan peringatan — tidak ada harga yang dikarang.
 */

const JUP_PRICE = 'https://lite-api.jup.ag/price/v3';
const CG_TOKEN_PRICE = 'https://api.coingecko.com/api/v3/simple/token_price';

/** CoinGecko asset_platform_id per chain_id DeBank (terverifikasi dari /asset_platforms). */
export const CG_PLATFORMS: Record<string, string> = {
  eth: 'ethereum',
  arb: 'arbitrum-one',
  base: 'base',
  op: 'optimistic-ethereum',
  polygon: 'polygon-pos',
  bsc: 'binance-smart-chain',
  avax: 'avalanche',
};

const JupPriceRes = z.record(z.object({ usdPrice: z.number().optional() }).passthrough());
const CgPriceRes = z.record(z.object({ usd: z.number().optional() }).passthrough());

function cgHeaders(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY ?? '';
  return key ? { 'x-cg-demo-api-key': key } : {};
}

export interface PriceTierResult {
  updated: number;
  mintsPriced: number;
  contractsPriced: number;
}

/** Refresh harga posisi wallet yang dikenal. Mengembalikan jumlah baris ter-update. */
export async function refreshWalletPrices(db: Database.Database): Promise<PriceTierResult> {
  const rows = db.prepare(
    `SELECT id, chain_id, kind, amount, price_usd, meta FROM wallet_positions WHERE kind IN ('token','staking')`,
  ).all() as Array<{ id: number; chain_id: string; kind: string; amount: string; price_usd: number | null; meta: string }>;

  const mintToIds = new Map<string, number[]>();
  const contractToIds = new Map<string, { ids: number[]; chain: string }>();
  for (const r of rows) {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(r.meta) as Record<string, unknown>;
    } catch {
      continue;
    }
    const mint = typeof meta.mint === 'string' ? meta.mint : null;
    const tokenId = typeof meta.token_id === 'string' ? meta.token_id : null;
    if (r.chain_id === 'solana' && mint) {
      if (!mintToIds.has(mint)) mintToIds.set(mint, []);
      mintToIds.get(mint)!.push(r.id);
    } else if (tokenId && tokenId.startsWith('0x') && CG_PLATFORMS[r.chain_id]) {
      const key = `${r.chain_id}:${tokenId.toLowerCase()}`;
      if (!contractToIds.has(key)) contractToIds.set(key, { ids: [], chain: r.chain_id });
      contractToIds.get(key)!.ids.push(r.id);
    }
  }

  const prices = new Map<number, number>();

  // Solana: satu batch Jupiter Price v3 (maks 50 mint).
  const mints = [...mintToIds.keys()].slice(0, 50);
  if (mints.length > 0) {
    try {
      const res = await providerFetch(`${JUP_PRICE}?ids=${mints.join(',')}`, {}, 10_000);
      throwForStatus(res, 'jupiter-price');
      const parsed = JupPriceRes.safeParse(await res.json());
      if (parsed.success) {
        for (const [mint, v] of Object.entries(parsed.data)) {
          if (typeof v.usdPrice === 'number') {
            for (const id of mintToIds.get(mint) ?? []) prices.set(id, v.usdPrice);
          }
        }
      } else {
        logger.warn('jupiter price: respons tidak sesuai skema, harga lama dipertahankan');
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'jupiter price gagal, harga lama dipertahankan');
    }
  }

  // EVM: satu panggilan CoinGecko per chain (hemat rate limit free ~5–15/mnt).
  const byChain = new Map<string, string[]>();
  for (const [key, v] of contractToIds) {
    const contract = key.split(':')[1];
    if (!byChain.has(v.chain)) byChain.set(v.chain, []);
    byChain.get(v.chain)!.push(contract);
  }
  for (const [chain, contracts] of byChain) {
    const platform = CG_PLATFORMS[chain];
    try {
      const res = await providerFetch(
        `${CG_TOKEN_PRICE}/${platform}?contract_addresses=${contracts.slice(0, 50).join(',')}&vs_currencies=usd`,
        { headers: cgHeaders() },
        10_000,
      );
      throwForStatus(res, 'coingecko');
      const parsed = CgPriceRes.safeParse(await res.json());
      if (!parsed.success) {
        logger.warn({ chain }, 'coingecko token_price: skema tak sesuai, harga lama dipertahankan');
        continue;
      }
      for (const [contract, v] of Object.entries(parsed.data)) {
        if (typeof v.usd === 'number') {
          const entry = contractToIds.get(`${chain}:${contract.toLowerCase()}`);
          for (const id of entry?.ids ?? []) prices.set(id, v.usd);
        }
      }
    } catch (e) {
      logger.warn({ chain, err: (e as Error).message }, 'coingecko token_price gagal, harga DeBank terakhir dipakai');
    }
    await new Promise((r) => setTimeout(r, 1200)); // pacing free tier
  }

  if (prices.size === 0) return { updated: 0, mintsPriced: 0, contractsPriced: 0 };
  const upd = db.prepare(`UPDATE wallet_positions SET price_usd = ?, value_usd = CAST(amount AS REAL) * ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const [id, p] of prices) upd.run(p, p, id);
  });
  tx();
  return { updated: prices.size, mintsPriced: mints.length, contractsPriced: contractToIds.size };
}
