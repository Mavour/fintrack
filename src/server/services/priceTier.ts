import type Database from 'better-sqlite3';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
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

/** DexScreener chain id per chain_id internal (fallback saat CoinGecko 429). */
const DEX_CHAINS: Record<string, string> = {
  eth: 'ethereum',
  arb: 'arbitrum',
  base: 'base',
  op: 'optimism',
  polygon: 'polygon',
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
    `SELECT id, chain_id, kind, amount, price_usd, meta FROM wallet_positions WHERE kind IN ('token','staking','defi')`,
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

  // Native HYPE on Elysium has no ERC-20 contract. Price by the explicit
  // canonical asset id, never by a ticker that another token can impersonate.
  const hypeIds = rows.filter((r) => {
    try { return r.chain_id === 'elysium' && JSON.parse(r.meta).coingecko_id === 'hyperliquid'; }
    catch { return false; }
  }).map((r) => r.id);
  if (hypeIds.length) {
    try {
      const res = await providerFetch('https://api.coingecko.com/api/v3/simple/price?ids=hyperliquid&vs_currencies=usd', { headers: cgHeaders() });
      throwForStatus(res, 'coingecko-hype');
      const json = await res.json() as { hyperliquid?: { usd?: number } };
      const price = json.hyperliquid?.usd;
      if (typeof price === 'number' && Number.isFinite(price) && price > 0)
        for (const id of hypeIds) prices.set(id, price);
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'harga native HYPE Elysium tertunda');
    }
  }

  // Solana: batch Jupiter Price v3, chunk 50 mint per panggilan (semua mint, bukan 50 pertama).
  const allMints = [...mintToIds.keys()];
  for (let i = 0; i < allMints.length; i += 50) {
    const mints = allMints.slice(i, i + 50);
    if (mints.length === 0) break;
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
  const cgPriced = new Set<number>();
  for (const [chain, contractsAll] of byChain) {
    const platform = CG_PLATFORMS[chain];
    for (let i = 0; i < contractsAll.length; i += 50) {
      const contracts = contractsAll.slice(i, i + 50);
      try {
        const res = await providerFetch(
          `${CG_TOKEN_PRICE}/${platform}?contract_addresses=${contracts.join(',')}&vs_currencies=usd`,
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
            for (const id of entry?.ids ?? []) {
              prices.set(id, v.usd);
              cgPriced.add(id);
            }
          }
        }
      } catch (e) {
        logger.warn({ chain, err: (e as Error).message }, 'coingecko token_price gagal, coba DexScreener');
      }
      await new Promise((r) => setTimeout(r, 1200)); // pacing free tier
    }
  }

  // EVM fallback: DexScreener keyless untuk kontrak yang belum keharga
  // (CoinGecko free sering 429 dari IP server). Satu panggilan per chain.
  const dexByChain = new Map<string, { contract: string; ids: number[] }[]>();
  for (const [key, v] of contractToIds) {
    const ids = v.ids.filter((id) => !cgPriced.has(id) && !prices.has(id));
    if (ids.length === 0 || !DEX_CHAINS[v.chain]) continue;
    const contract = key.split(':')[1];
    if (!dexByChain.has(v.chain)) dexByChain.set(v.chain, []);
    dexByChain.get(v.chain)!.push({ contract, ids });
  }
  for (const [chain, items] of dexByChain) {
    const uniq = [...new Map(items.map((i) => [i.contract.toLowerCase(), i])).values()];
    for (let i = 0; i < uniq.length; i += 30) {
      const batch = uniq.slice(i, i + 30);
      try {
        const contracts = [...new Set(batch.map((x) => x.contract))];
        const res = await providerFetch(
          `https://api.dexscreener.com/tokens/v1/${DEX_CHAINS[chain]}/${contracts.join(',')}`,
          { headers: { Accept: 'application/json' } },
          12_000,
        );
        throwForStatus(res, 'dexscreener');
        const pairs = (await res.json()) as Array<{ baseToken?: { address?: string }; priceUsd?: string }>;
        const seen = new Set<string>();
        for (const p of Array.isArray(pairs) ? pairs : []) {
          const addr = p.baseToken?.address?.toLowerCase();
          if (!addr || seen.has(addr)) continue;
          const usd = Number(p.priceUsd);
          if (!Number.isFinite(usd) || usd <= 0) continue;
          seen.add(addr);
          const item = batch.find((x) => x.contract.toLowerCase() === addr);
          for (const id of item?.ids ?? []) prices.set(id, usd);
        }
      } catch (e) {
        logger.warn({ chain, err: (e as Error).message }, 'dexscreener fallback gagal, harga lama dipertahankan');
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  if (prices.size === 0) return { updated: 0, mintsPriced: 0, contractsPriced: 0 };
  // Idempoten: hanya UPDATE bila harga benar-benar berubah (hemat WAL + cegah SSE sia-sia).
  const oldPrices = new Map<number, number | null>();
  try {
    const ids = [...prices.keys()];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const found = db.prepare(`SELECT id, price_usd FROM wallet_positions WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ id: number; price_usd: number | null }>;
      for (const f of found) oldPrices.set(f.id, f.price_usd);
    }
  } catch {
    // Bila baca gagal, lanjutkan tulis (fallback aman).
  }
  const changed = new Map<number, number>();
  for (const [id, p] of prices) {
    const old = oldPrices.get(id);
    if (old !== undefined && old !== null && Math.abs(old - p) < 1e-12) continue;
    if (old === null && p === 0) continue;
    changed.set(id, p);
  }
  if (changed.size === 0) return { updated: 0, mintsPriced: allMints.length, contractsPriced: contractToIds.size };
  const upd = db.prepare(`UPDATE wallet_positions SET price_usd = ?, value_usd = ? WHERE id = ?`);
  const amtSel = db.prepare(`SELECT amount FROM wallet_positions WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const [id, p] of changed) {
      let value: number | null = null;
      try {
        const row = amtSel.get(id) as { amount: string } | undefined;
        value = row ? new Decimal(row.amount).times(p).toNumber() : null;
      } catch {
        value = null;
      }
      upd.run(p, value, id);
    }
  });
  tx();
  return { updated: changed.size, mintsPriced: allMints.length, contractsPriced: contractToIds.size };
}
