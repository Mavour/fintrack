import { z } from 'zod';
import { providerFetch, normalizeList, throwForStatus, type WalletProvider, type WalletRef, type NormalizedPosition } from './walletTypes.js';
import { logger } from '../logger.js';
import { redactAddress } from '../services/address.js';

/**
 * Posisi LP Solana via Meteora, read-only tanpa kunci.
 *
 * - DLMM   : Data API resmi. Posisi terbuka dibaca dari GET /portfolio/open?user=
 *            (bukan /wallet/open-positions — diverifikasi live terhadap OpenAPI).
 *            Nilai posisi = `balances` dan `unclaimedFees` (string USD). PnL
 *            TIDAK dipakai (tidak ada kolom PnL). TVL pool diambil best-effort
 *            per pool via GET /pools?filter_by=pool_address=. Env override:
 *            METEORA_DLMM_BASE / METEORA_DLMM_PATH.
 * - DAMM v2 : Data API TIDAK punya endpoint posisi per-wallet (OpenAPI resmi hanya
 *            pools/stats — diverifikasi). Posisi DAMM v2 adalah NFT Token-2022
 *            yang mint-nya dibuat program cp_amm. Deteksi ON-CHAIN via RPC
 *            (getTokenAccountsByOwner + getMultipleAccounts) tanpa API baru.
 *            Nilai posisi tidak didecode (butuh IDL) → value null, UI tampil "—",
 *            tidak ada angka dikarang. RPC via SOLANA_RPC_URL.
 */

export const MeteoraPositionSchema = z.object({
  pool_address: z.string().min(1),
  pair: z.string().default(''),
  protocol: z.string().default(''),
  chain_id: z.string().default('solana'),
  position_value_usd: z.number().nonnegative().nullable().default(null),
  unclaimed_fees_usd: z.number().nonnegative().nullable().default(null),
  pool_tvl_usd: z.number().nonnegative().nullable().default(null),
  in_range: z.boolean().nullable().default(null),
  position_address: z.string().default(''),
}).passthrough();
export type MeteoraPosition = z.infer<typeof MeteoraPositionSchema>;

const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const CP_AMM_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';

/** Lapisan skema lama (normalisasi) — tetap diterima agar fixtur/test lama jalan. */
const LegacyPool = z.object({
  pool_address: z.string().optional(),
  poolAddress: z.string().optional(),
  address: z.string().optional(),
  pair: z.string().optional(),
  name: z.string().optional(),
  protocol: z.string().optional(),
  position_value_usd: z.number().optional(),
  unclaimed_fees_usd: z.number().optional(),
  pool_tvl_usd: z.number().optional(),
  in_range: z.boolean().optional(),
  position_address: z.string().optional(),
}).passthrough();

// -- DLMM /portfolio/open (bentuk asli, diverifikasi live) --------------------
// Skema sengaja minimal & longgar: banyak field (baseFee, feePerTvl24h, updatedAt,
// poolPrice, totalDeposit, dll.) berubah tipe string/number antar respons dan
// tidak dipakai — biarkan lolos via passthrough().
const DlmmPool = z.object({
  poolAddress: z.string(),
  tokenX: z.string().optional(),
  tokenY: z.string().optional(),
  balances: z.string().optional(),
  unclaimedFees: z.string().optional(),
  outOfRange: z.boolean().nullable().optional(),
  listPositions: z.array(z.unknown()).optional().default([]),
}).passthrough();
type DlmmPoolT = z.infer<typeof DlmmPool>;

const DlmmOpen = z.object({
  pools: z.array(DlmmPool).default([]),
}).passthrough();

const DlmmTvl = z.object({
  data: z.array(z.object({ tvl: z.number().optional() }).passthrough()).default([]),
}).passthrough();

function toNullableNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function firstPositionAddr(list: unknown[]): string {
  for (const p of list) {
    if (typeof p === 'string' && p) return p;
    if (p && typeof p === 'object') {
      const r = p as Record<string, unknown>;
      const a = r.positionAddress ?? r.address ?? r.publicKey ?? r.pool_address;
      if (typeof a === 'string' && a) return a;
    }
  }
  return '';
}

function legacyToPosition(r: z.infer<typeof LegacyPool>, protocol: string): MeteoraPosition {
  return {
    pool_address: r.pool_address ?? r.poolAddress ?? r.address ?? '',
    pair: r.pair ?? r.name ?? '',
    protocol: r.protocol ?? protocol,
    chain_id: 'solana',
    position_value_usd: r.position_value_usd ?? null,
    unclaimed_fees_usd: r.unclaimed_fees_usd ?? null,
    pool_tvl_usd: r.pool_tvl_usd ?? null,
    in_range: r.in_range ?? null,
    position_address: r.position_address ?? '',
  };
}

function dlmmPoolToPosition(p: DlmmPoolT): MeteoraPosition {
  return {
    pool_address: p.poolAddress,
    pair: `${p.tokenX ?? ''}/${p.tokenY ?? ''}`,
    protocol: 'Meteora DLMM',
    chain_id: 'solana',
    position_value_usd: toNullableNum(p.balances),
    unclaimed_fees_usd: toNullableNum(p.unclaimedFees),
    pool_tvl_usd: null,
    in_range: p.outOfRange === null || p.outOfRange === undefined ? null : !p.outOfRange,
    position_address: firstPositionAddr(p.listPositions ?? []),
  };
}

/** Parse respons DLMM (objek {pools:[...]} asli, atau array lapisan lama). */
export function meteoraDlmmPositions(raw: unknown): MeteoraPosition[] {
  if (Array.isArray(raw)) {
    return raw.map((r) => {
      if (r && typeof r === 'object' && 'poolAddress' in (r as Record<string, unknown>)) {
        return dlmmPoolToPosition(DlmmPool.parse(r));
      }
      return legacyToPosition(LegacyPool.parse(r), 'Meteora DLMM');
    });
  }
  const parsed = DlmmOpen.safeParse(raw);
  if (!parsed.success) {
    throw Object.assign(new Error('Respons Meteora DLMM tidak sesuai skema'), { statusCode: 502 });
  }
  return parsed.data.pools.map(dlmmPoolToPosition);
}

/** TVL pool DLMM (best-effort; gagal → null, tidak pernah melempar). */
export async function dlmmPoolTvl(base: string, poolAddress: string): Promise<number | null> {
  try {
    const res = await providerFetch(
      `${base}/pools?filter_by=pool_address=${encodeURIComponent(poolAddress)}&page=1&page_size=5`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const json: unknown = await res.json();
    const parsed = DlmmTvl.safeParse(json);
    const tvl = parsed.success ? parsed.data.data[0]?.tvl : undefined;
    return typeof tvl === 'number' && Number.isFinite(tvl) ? tvl : null;
  } catch {
    return null;
  }
}

async function fetchDlmm(base: string, path: string, wallet: string): Promise<MeteoraPosition[]> {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${base}${path}${separator}user=${encodeURIComponent(wallet)}&page=1&page_size=50`;
  const res = await providerFetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 404) {
    throw Object.assign(
      new Error(`Endpoint Meteora ${path} tidak ditemukan (404) — verifikasi OpenAPI di ${base}, lalu set METEORA_DLMM_PATH`),
      { statusCode: 502 },
    );
  }
  throwForStatus(res, 'meteora');
  const json: unknown = await res.json();
  const list = meteoraDlmmPositions(json);
  // TVL pool per alamat (best-effort, hormati rate limit 30 rps).
  const pools = [...new Set(list.map((p) => p.pool_address).filter(Boolean))].slice(0, 20);
  for (const addr of pools) {
    const tvl = await dlmmPoolTvl(base, addr);
    if (tvl !== null) for (const p of list) if (p.pool_address === addr) p.pool_tvl_usd = tvl;
    await new Promise((r) => setTimeout(r, Math.ceil(1000 / 30)));
  }
  return list;
}

export function meteoraToNormalized(mp: MeteoraPosition): NormalizedPosition {
  return {
    chain_id: 'solana',
    kind: 'lp',
    protocol: mp.protocol,
    symbol: mp.pair ? mp.pair.toUpperCase().slice(0, 40) : `LP-${mp.pool_address.slice(0, 6).toUpperCase()}`,
    name: mp.pair || mp.pool_address,
    amount: '1',
    price_usd: mp.position_value_usd,
    value_usd: mp.position_value_usd,
    meta: {
      pool_address: mp.pool_address,
      pair: mp.pair,
      position_value_usd: mp.position_value_usd,
      unclaimed_fees_usd: mp.unclaimed_fees_usd,
      pool_tvl_usd: mp.pool_tvl_usd,
      in_range: mp.in_range,
      position_address: mp.position_address,
    },
  };
}

export class MeteoraDlmmProvider implements WalletProvider {
  readonly name = 'meteora-dlmm';
  constructor(
    private base = process.env.METEORA_DLMM_BASE ?? 'https://dlmm.datapi.meteora.ag',
    private path = process.env.METEORA_DLMM_PATH ?? '/portfolio/open',
  ) {}
  async fetchPositions(wallet: WalletRef): Promise<NormalizedPosition[]> {
    if (wallet.network_type !== 'solana') return [];
    const list = await fetchDlmm(this.base, this.path, wallet.address);
    logger.info({ wallet: redactAddress(wallet.address), count: list.length }, 'meteora DLMM fetched');
    return normalizeList(list.map(meteoraToNormalized), this.name);
  }
}

async function rpcPost<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await providerFetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  throwForStatus(res, 'solana-rpc');
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw Object.assign(new Error(`RPC ${method} gagal: ${json.error.message ?? 'unknown'}`), { statusCode: 502 });
  return json.result as T;
}

export class MeteoraDammV2Provider implements WalletProvider {
  readonly name = 'meteora-damm-v2';
  constructor(private rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com') {}

  async fetchPositions(wallet: WalletRef): Promise<NormalizedPosition[]> {
    if (wallet.network_type !== 'solana') return [];
    const acc = await rpcPost<{ value?: Array<{ account: { data: { parsed: { info: { mint: string } } } } }> } | undefined>(
      this.rpcUrl,
      'getTokenAccountsByOwner',
      [wallet.address, { programId: TOKEN_2022_PROGRAM }, { encoding: 'jsonParsed' }],
    );
    const mints = [...new Set((acc?.value ?? []).map((a) => a.account.data.parsed.info.mint))].slice(0, 50);
    const positions: NormalizedPosition[] = [];
    if (mints.length > 0) {
      const minfo = await rpcPost<{ value?: Array<{ owner?: string } | null> } | undefined>(
        this.rpcUrl,
        'getMultipleAccounts',
        [mints, { encoding: 'jsonParsed' }],
      );
      for (let i = 0; i < mints.length; i++) {
        if (minfo?.value?.[i]?.owner !== CP_AMM_PROGRAM) continue;
        const mint = mints[i];
        positions.push({
          chain_id: 'solana',
          kind: 'lp',
          protocol: 'Meteora DAMM v2',
          symbol: `LP-${mint.slice(0, 4).toUpperCase()}`,
          name: `DAMM v2 ${mint.slice(0, 6)}…${mint.slice(-4)}`,
          amount: '1',
          price_usd: null,
          value_usd: null,
          meta: {
            pool_address: mint,
            pair: 'DAMM v2',
            position_address: mint,
            nft_mint: mint,
            note: 'Posisi DAMM v2 — nilai butuh decode posisi on-chain, tidak dikarang',
          },
        });
      }
    }
    logger.info({ wallet: redactAddress(wallet.address), nft: positions.length }, 'meteora DAMM v2 on-chain checked');
    return normalizeList(positions, this.name);
  }
}