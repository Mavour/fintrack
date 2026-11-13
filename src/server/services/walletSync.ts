import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { NormalizedPosition, WalletProvider, WalletRef } from '../providers/walletTypes.js';
import { snapshotHash } from '../providers/walletTypes.js';
import { JupiterPortfolioProvider } from '../providers/jupiterPortfolioV1.js';
import { JupiterStakingProvider, JupiterLimitOrderProvider, JupiterLiquidityProvider } from '../providers/jupiterPositions.js';
import { SolanaRpcFallbackProvider } from '../providers/solanaRpcFallback.js';
import { MeteoraDlmmProvider } from '../providers/meteora.js';
import { DebankProvider } from '../providers/debank.js';
import { EvmExplorerProvider } from '../providers/evmExplorer.js';
import { EvmNativeRpcProvider } from '../providers/evmNativeRpc.js';
import { EthplorerProvider } from '../providers/ethplorer.js';
import { ElysiumProvider } from '../providers/elysium.js';
import { HyperliquidSpotProvider } from '../providers/hyperliquid.js';
import { getWallet } from './walletRegistry.js';
import { logger } from '../logger.js';
import { redactAddress } from './address.js';
import { breakerFor } from './circuitBreaker.js';
import { measureEvmCycle } from './debankMeter.js';
import { resolveTokenIcons } from '../providers/tokenMeta.js';

export const SyncResultSchema = z.object({
  wallet_id: z.number(),
  ok: z.boolean(),
  providers_ok: z.array(z.string()),
  providers_failed: z.array(z.string()),
  positions: z.number(),
  unchanged: z.boolean().optional(),
  partial: z.boolean().optional(),
  retryAfterMs: z.number().nullable().optional(),
  error: z.string().optional(),
});
export type SyncResult = z.infer<typeof SyncResultSchema>;

export type SyncScope = 'all' | 'solana' | 'lp' | 'evm';

function providersFor(
  wallet: WalletRef,
  opts: { scope?: SyncScope; debankBlocked?: boolean; onCall?: (endpoint: string) => void } = {},
): WalletProvider[] {
  const scope = opts.scope ?? 'all';
  if (wallet.network_type === 'solana') {
    const out: WalletProvider[] = [];
    if (scope === 'all' || scope === 'solana') {
      // Tanpa JUPITER_API_KEY provider ini selalu 503 — jangan daftarkan sama
      // sekali (hemat waktu, tanpa trip circuit breaker sia-sia). Token Solana
      // tetap tersinkron via fallback RPC + staking/limit (keyless).
      if (process.env.JUPITER_API_KEY) out.push(new JupiterPortfolioProvider());
      out.push(new SolanaRpcFallbackProvider(), new JupiterStakingProvider(), new JupiterLimitOrderProvider());
    }
    if (scope === 'all' || scope === 'lp') {
      out.push(new MeteoraDlmmProvider(), new JupiterLiquidityProvider());
    }
    return out;
  }
  if (scope === 'solana' || scope === 'lp') return [];
  const list: WalletProvider[] = [];
  if (!opts.debankBlocked) {
    list.push(new DebankProvider(process.env.DEBANK_ACCESS_KEY ?? '', Number(process.env.DEBANK_DAILY_UNIT_BUDGET ?? 0), opts.onCall));
  } else {
    // DeBank tidak tersedia (tanpa key / unit habis) → jalur keyless lapis tiga:
    // Blockscout (token semua chain) + RPC native (saldo pasti) + Ethplorer
    // (token mainnet). Tumpang tindih dihapus di dedupeEvmKeyless.
    list.push(new EvmExplorerProvider(), new EvmNativeRpcProvider(), new EthplorerProvider());
  }
  // HyperCore spot (resmi, tanpa key) untuk alamat EVM — berjalan paralel.
  list.push(new HyperliquidSpotProvider(), new ElysiumProvider());
  return list;
}

/**
 * Totuple (dedupe) Hyperliquid: docs DeBank menunjukkan complex protocol
 * "hyperliquid / Main-Account Spot" ikut terbaca dari DeBank, sehingga koin
 * yang sama bisa muncul dua kali. Baris DeBank berprotokol hyperliquid yang
 * simbolnya juga dikembalikan HyperCore resmi dibuang (sumber resmi menang).
 * Mengembalikan {kept, dropped} untuk logging.
 */
export function dedupeHyperliquid(all: NormalizedPosition[]): { kept: NormalizedPosition[]; dropped: number } {
  const hlCoins = new Set(
    all.filter((p) => p.chain_id === 'hypercore').map((p) => p.symbol.toUpperCase()),
  );
  if (hlCoins.size === 0) return { kept: all, dropped: 0 };
  const kept = all.filter((p) => {
    if (p.chain_id === 'hypercore') return true;
    const proto = p.protocol.toLowerCase();
    if (proto.includes('hyperliquid') && hlCoins.has(p.symbol.toUpperCase())) return false;
    return true;
  });
  const dropped = all.length - kept.length;
  if (dropped > 0) logger.info({ dropped }, 'hyperliquid double-count dibuang (DeBank sudah mencakup)');
  return { kept, dropped };
}

/** Prioritas sumber keyless EVM bila simbol yang sama muncul ganda. */
const EVM_KEYLESS_RANK: Record<string, number> = { blockscout: 0, 'evm-rpc': 1, ethplorer: 2 };

/**
 * Totuple keyless EVM: Blockscout (token semua chain) vs RPC native vs
 * Ethplorer (token mainnet) bisa melaporkan simbol yang sama. Satu baris
 * per (chain, simbol) dipertahankan sesuai prioritas — baris DeBank /
 * HyperCore / LP tidak disentuh.
 */
export function dedupeEvmKeyless(all: NormalizedPosition[]): { kept: NormalizedPosition[]; dropped: number } {
  const passthrough: NormalizedPosition[] = [];
  const best = new Map<string, NormalizedPosition>();
  let dropped = 0;
  for (const p of all) {
    const rank = EVM_KEYLESS_RANK[p.protocol.toLowerCase()];
    if (p.kind !== 'token' || rank === undefined) {
      passthrough.push(p);
      continue;
    }
    const contract = typeof p.meta.token_id === 'string' ? p.meta.token_id.toLowerCase() : p.symbol.toUpperCase();
    const key = `${p.chain_id}::${contract}`;
    const cur = best.get(key);
    if (!cur) {
      best.set(key, p);
      continue;
    }
    dropped++;
    if (rank < (EVM_KEYLESS_RANK[cur.protocol.toLowerCase()] ?? 99)) best.set(key, p);
  }
  if (dropped > 0) logger.info({ dropped }, 'evm keyless double-count dibuang (satu baris per chain+simbol)');
  return { kept: [...passthrough, ...best.values()], dropped };
}

/** Catat status sync per provider (kegagalan satu provider tidak memengaruhi lain). */
export function recordSyncStatus(
  db: Database.Database,
  provider: string,
  walletId: number | null,
  ok: boolean,
  error?: string,
  unitsRemaining?: number | null,
): void {
  // SQLite treats NULL values as distinct in a composite primary key.
  // Reuse one row per global tier instead of appending a row on every tick.
  if (walletId === null) {
    db.transaction(() => {
      db.prepare('DELETE FROM sync_status WHERE provider = ? AND wallet_id IS NULL AND rowid != (SELECT MAX(rowid) FROM sync_status WHERE provider = ? AND wallet_id IS NULL)').run(provider, provider);
      const result = db.prepare(`UPDATE sync_status SET
        last_success_at = CASE WHEN ? THEN datetime('now') ELSE last_success_at END,
        last_error = ?, units_remaining = COALESCE(?, units_remaining), updated_at = datetime('now')
        WHERE provider = ? AND wallet_id IS NULL`).run(ok ? 1 : 0, error ?? null, unitsRemaining ?? null, provider);
      if (!result.changes) db.prepare(`INSERT INTO sync_status (provider, wallet_id, last_success_at, last_error, units_remaining)
        VALUES (?, NULL, ?, ?, ?)`).run(provider, ok ? new Date().toISOString() : null, error ?? null, unitsRemaining ?? null);
    })();
    return;
  }
  db.prepare(
    `INSERT INTO sync_status (provider, wallet_id, last_success_at, last_error, units_remaining, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(provider, wallet_id) DO UPDATE SET
       last_success_at = CASE WHEN ? THEN datetime('now') ELSE last_success_at END,
       last_error = ?, units_remaining = COALESCE(?, units_remaining), updated_at = datetime('now')`,
  ).run(provider, walletId, ok ? new Date().toISOString() : null, error ?? null, unitsRemaining ?? null, ok ? 1 : 0, error ?? null, unitsRemaining ?? null);
}

function lpMeta(p: NormalizedPosition): {
  pool_address: string; pair: string; position_value_usd: number | null;
  unclaimed_fees_usd: number | null; pool_tvl_usd: number | null;
  in_range: number | null; position_address: string;
} {
  const m = (p.meta ?? {}) as Record<string, unknown>;
  const b = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    pool_address: String(m.pool_address ?? ''),
    pair: String(m.pair ?? p.symbol ?? ''),
    position_value_usd: b(m.position_value_usd ?? p.value_usd),
    unclaimed_fees_usd: b(m.unclaimed_fees_usd),
    pool_tvl_usd: b(m.pool_tvl_usd),
    in_range: typeof m.in_range === 'boolean' ? (m.in_range ? 1 : 0) : null,
    position_address: String(m.position_address ?? ''),
  };
}

/**
 * Idempotent sync satu wallet: upsert snapshot dalam satu transaksi,
 * posisi yang hilang dari semua provider dihapus dari snapshot terbaru.
 * Gagal total (semua provider gagal) -> cache lama dipertahankan.
 */
/** Catat mode keyless sekali (tanpa tulis tiap tick): ganti status basi
 *  "Circuit terbuka" dengan penjelasan jujur agar UI tidak menyesatkan. */
function noteKeylessOnce(db: Database.Database, provider: string, walletId: number, msg: string): void {
  try {
    const row = db.prepare(
      'SELECT last_success_at, last_error FROM sync_status WHERE provider = ? AND wallet_id = ?',
    ).get(provider, walletId) as { last_success_at: string | null; last_error: string | null } | undefined;
    if (row && row.last_success_at === null && row.last_error === msg) return;
    recordSyncStatus(db, provider, walletId, false, msg);
  } catch {
    // Best-effort.
  }
}

let budgetCache: { at: number; blocked: boolean } | null = null;
const walletLocks = new WeakMap<Database.Database, Map<number, Promise<SyncResult>>>();

export async function syncWallet(
  db: Database.Database,
  walletId: number,
  scope: SyncScope = 'all',
  onCall?: (endpoint: string) => void,
): Promise<SyncResult> {
  let locks = walletLocks.get(db);
  if (!locks) { locks = new Map(); walletLocks.set(db, locks); }
  const previous = locks.get(walletId);
  const pending = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(() => syncWalletUnlocked(db, walletId, scope, onCall));
  locks.set(walletId, pending);
  try { return await pending; }
  finally { if (locks.get(walletId) === pending) locks.delete(walletId); }
}

async function syncWalletUnlocked(
  db: Database.Database, walletId: number, scope: SyncScope,
  onCall?: (endpoint: string) => void,
): Promise<SyncResult> {
  const row = getWallet(db, walletId);
  if (!row) throw Object.assign(new Error('Wallet tidak ditemukan'), { statusCode: 404 });
  const wallet: WalletRef = { id: row.id, label: row.label, address: row.address, network_type: row.network_type };

  // Tanpa key: nyatakan keyless-mode sekali, bukan "Circuit terbuka" abadi.
  if (wallet.network_type === 'solana' && !process.env.JUPITER_API_KEY) {
    noteKeylessOnce(db, 'jupiter-portfolio-v1', wallet.id, 'Tanpa JUPITER_API_KEY — token Solana via fallback RPC');
  }

  // DeBank budget gate (EVM): hentikan sync otomatis bila unit habis (cache 60 dtk).
  let debankBlocked = false;
  if (wallet.network_type === 'evm') {
    try {
      if (!budgetCache || Date.now() - budgetCache.at > 60_000) {
        const b = await new DebankProvider().checkBudget();
        budgetCache = { at: Date.now(), blocked: b.blocked };
        recordSyncStatus(db, 'debank-budget', wallet.id, true, undefined, b.unitsRemaining);
        debankBlocked = b.blocked;
      } else {
        debankBlocked = budgetCache.blocked;
      }
      if (debankBlocked) logger.warn({ wallet: redactAddress(wallet.address) }, 'debank budget exhausted, sync skipped');
    } catch {
      // Budget check gagal -> lanjutkan sync, provider akan error terkontrol bila key hilang.
    }
  }
  if (wallet.network_type === 'evm' && debankBlocked)
    noteKeylessOnce(db, 'debank', wallet.id, 'LP/DeFi EVM belum diperbarui — DeBank tidak tersedia; saldo memakai RPC/explorer');

  const providers = providersFor(wallet, { scope, debankBlocked, onCall });
  const ok: string[] = [];
  const failed: string[] = [];
  const all: NormalizedPosition[] = [];
  const partialChains = new Map<string, Set<string>>();
  let retryAfterMs: number | null = null;

  for (const p of providers) {
    const breaker = breakerFor(p.name);
    if (!breaker.allow()) {
      failed.push(p.name);
      recordSyncStatus(db, p.name, wallet.id, false, 'Circuit terbuka — provider diistirahatkan sementara');
      logger.warn({ provider: p.name }, 'circuit open, provider skipped');
      continue;
    }
    try {
      const list = await p.fetchPositions(wallet);
      breaker.recordSuccess();
      ok.push(p.name);
      all.push(...list.map((position) => ({ ...position, meta: { ...position.meta, sync_provider: p.name } })));
      if (p.failedChains?.length) {
        failed.push(p.name);
        partialChains.set(p.name, new Set(p.failedChains));
        recordSyncStatus(db, p.name, wallet.id, false, `Chain tertunda: ${p.failedChains.join(', ')} — memakai data terakhir`);
      } else recordSyncStatus(db, p.name, wallet.id, true);
    } catch (e) {
      const msg = (e as Error).message ?? 'gagal';
      const ra = (e as { retryAfterMs?: number | null }).retryAfterMs ?? null;
      const status = (e as { httpStatus?: number; statusCode?: number }).httpStatus ?? (e as { statusCode?: number }).statusCode;
      breaker.recordFailure(typeof status === 'number' ? status : undefined);
      if (ra !== null) retryAfterMs = Math.max(retryAfterMs ?? 0, ra);
      failed.push(p.name);
      recordSyncStatus(db, p.name, wallet.id, false, msg.slice(0, 500));
      logger.warn({ provider: p.name, wallet: redactAddress(wallet.address), err: msg }, 'wallet provider failed, others continue');
    }
    // DeBank ~100 req/s pro; jeda kecil antar provider EVM.
    if (wallet.network_type === 'evm') await new Promise((r) => setTimeout(r, 200));
  }

  if (ok.length === 0) {
    return { wallet_id: wallet.id, ok: false, providers_ok: ok, providers_failed: failed, positions: 0, retryAfterMs, error: 'Semua provider gagal — memakai data terakhir' };
  }
  // Keep the last snapshot of failed providers, including old snapshots that
  // predate explicit provenance. A partial API outage must not erase funds.
  const previous = db.prepare('SELECT * FROM wallet_positions WHERE wallet_id = ?').all(wallet.id) as Array<Omit<NormalizedPosition, 'meta'> & { meta: string; synced_at: string }>;
  const carried: NormalizedPosition[] = [];
  for (const row of previous) {
    let meta: Record<string, unknown>;
    try { meta = JSON.parse(row.meta) as Record<string, unknown>; } catch { meta = {}; }
    const source = typeof meta.sync_provider === 'string' ? meta.sync_provider : legacyProvider(row);
    const unavailableDefi = debankBlocked && source === 'debank' && row.kind !== 'token';
    if ((unavailableDefi || failed.includes(source)) && (!partialChains.has(source) || partialChains.get(source)!.has(row.chain_id)) &&
      !all.some((p) => p.meta.sync_provider === source && p.chain_id === row.chain_id))
      carried.push({ ...row, meta: { ...meta, sync_provider: source, cached_at: meta.cached_at ?? row.synced_at } });
  }
  let finalPositions = [...all, ...carried];
  if (wallet.network_type === 'solana') {
    const freshJupiterPools = new Set(all.filter((p) => p.meta.sync_provider === 'jupiter-liquidity-v2').map((p) => p.meta.pool_address));
    finalPositions = finalPositions.filter((p) => !(p.meta.cached_at && p.kind === 'lp' && freshJupiterPools.has(p.meta.pool_address)));
    const directPools = new Set(finalPositions.filter((p) => p.protocol === 'Meteora DLMM' && !p.meta.cached_at).map((p) => p.meta.pool_address));
    finalPositions = finalPositions.filter((p) => !(p.kind === 'lp' && p.meta.sync_provider === 'jupiter-liquidity-v2' && directPools.has(p.meta.pool_address)));
    // Keyed Portfolio and RPC describe the same wallet holdings, not two balances.
    const authoritative = new Set(finalPositions.filter((p) => p.meta.sync_provider !== 'jupiter-portfolio-v1')
      .map((p) => `${p.kind}:${p.meta.mint ?? p.symbol}`));
    finalPositions = finalPositions.filter((p) => p.meta.sync_provider !== 'jupiter-portfolio-v1' || !authoritative.has(`${p.kind}:${p.meta.mint ?? p.symbol}`));
  }
  if (wallet.network_type === 'evm') {
    finalPositions = dedupeHyperliquid(finalPositions).kept;
    finalPositions = dedupeEvmKeyless(finalPositions).kept;
  }

  const commit = commitPositions(db, wallet.id, finalPositions, scope);
  // Isi cache logo di background (tak memblokir respons): mint dari snapshot ini.
  if (commit.written) {
    const mints = finalPositions
      .map((p) => (p.meta as Record<string, unknown> | undefined)?.mint)
      .filter((m): m is string => typeof m === 'string' && m.length > 0);
    if (mints.length > 0) {
      void resolveTokenIcons(db, mints).catch(() => undefined);
    }
  }
  if (commit.skipped === 'unchanged') {
    return { wallet_id: wallet.id, ok: true, partial: failed.length > 0, providers_ok: ok, providers_failed: failed, positions: finalPositions.length, unchanged: true, retryAfterMs };
  }
  if (commit.skipped === 'suspicious') {
    return { wallet_id: wallet.id, ok: false, providers_ok: ok, providers_failed: failed, positions: finalPositions.length, retryAfterMs, error: 'Perubahan drastis terdeteksi — data lama dipertahankan menunggu konfirmasi' };
  }
  return { wallet_id: wallet.id, ok: true, partial: failed.length > 0, providers_ok: ok, providers_failed: failed, positions: finalPositions.length, retryAfterMs };
}

function legacyProvider(p: Omit<NormalizedPosition, 'meta'>): string {
  if (p.chain_id === 'elysium') return 'elysium';
  if (p.protocol === 'solana-rpc') return 'solana-rpc-fallback';
  if (p.protocol === 'Meteora DLMM') return 'meteora-dlmm';
  if (p.protocol === 'Meteora DAMM v2') return 'jupiter-liquidity-v2';
  if (p.protocol === 'blockscout') return 'evm-explorer';
  if (p.protocol === 'evm-rpc') return 'evm-rpc';
  if (p.protocol === 'ethplorer') return 'ethplorer';
  if (p.chain_id === 'hypercore') return 'hyperliquid-spot';
  if (p.chain_id !== 'solana') return 'debank';
  if (p.protocol.startsWith('jupiter-') && p.kind === 'staking') return 'jupiter-staking-v2';
  if (p.protocol.startsWith('jupiter-') && p.kind === 'defi') return 'jupiter-limit-v2';
  if (p.kind === 'lp') return 'jupiter-liquidity-v2';
  return 'jupiter-portfolio-v1';
}

/** Kunci meta untuk counter konfirmasi drop dan hash snapshot. */
function metaGet(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function metaSet(db: Database.Database, key: string, value: string): void {
  try {
    db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  } catch {
    // Best-effort.
  }
}

function walletTotal(db: Database.Database, walletId: number): number {
  try {
    const row = db.prepare(
      `SELECT COALESCE(SUM(COALESCE(value_usd,0)),0) AS t FROM wallet_positions WHERE wallet_id = ?`,
    ).get(walletId) as { t: number };
    return row.t;
  } catch {
    return 0;
  }
}

/**
 * Tulis snapshot dengan perlindungan:
 * - Hash identik → lewati tulis (hemat DB + cegah event SSE sia-sia).
 * - Total turun >90% tiba-tiba (atau kosong padahal sebelumnya ada) →
 *   anggap mencurigakan, pertahankan data lama; terima hanya setelah
 *   2 sync beruntun mengonfirmasi nilai yang sama.
 * Scope 'lp' hanya menyentuh baris kind=lp (+ tabel lp_positions);
 * scope lain menulis snapshot penuh wallet.
 */
export function commitPositions(
  db: Database.Database,
  walletId: number,
  all: NormalizedPosition[],
  scope: SyncScope = 'all',
): { written: boolean; skipped?: 'unchanged' | 'suspicious' } {
  const hash = snapshotHash(all);
  const hashKey = `wallet_hash_${scope}_${walletId}`;
  if (metaGet(db, hashKey) === hash) {
    return { written: false, skipped: 'unchanged' };
  }
  const newTotal = all.reduce((s, p) => s + (p.value_usd ?? 0), 0);
  const oldTotal = scope === 'lp'
    ? lpTotal(db, walletId)
    : scope === 'all' || scope === 'evm'
      ? walletTotal(db, walletId)
      : walletNonLpTotal(db, walletId);
  if (oldTotal > 0 && newTotal < oldTotal * 0.1) {
    const cKey = `wallet_drop_confirm_${scope}_${walletId}`;
    const count = Number(metaGet(db, cKey) ?? 0) + 1;
    const prevHash = metaGet(db, `${cKey}_hash`);
    metaSet(db, cKey, String(count));
    metaSet(db, `${cKey}_hash`, hash);
    metaSet(db, `${cKey}_total`, String(newTotal));
    if (count < 2 || prevHash !== null && prevHash !== hash) {
      // Butuh 2 sync beruntun dengan hash SAMA; nilai berbeda → reset hitungan.
      if (prevHash !== null && prevHash !== hash) metaSet(db, cKey, '1');
      logger.warn({ walletId, oldTotal, newTotal }, 'suspicious drop, keeping old snapshot');
      return { written: false, skipped: 'suspicious' };
    }
    // Dua sync beruntun mengonfirmasi nilai yang sama → terima nilai baru.
    metaSet(db, cKey, '0');
  } else {
    metaSet(db, `wallet_drop_confirm_${scope}_${walletId}`, '0');
  }

  const tx = db.transaction(() => {
    // A full refresh overlaps both LP and token scopes. Invalidate only
    // overlapping hashes so an earlier snapshot cannot skip a required write.
    const overlaps: SyncScope[] = scope === 'all' || scope === 'evm'
      ? ['all', 'evm', 'lp', 'solana'] : scope === 'lp' ? ['all', 'evm', 'lp'] : ['all', 'evm', 'solana'];
    for (const overlapping of overlaps)
      db.prepare('DELETE FROM meta WHERE key = ?').run(`wallet_hash_${overlapping}_${walletId}`);
    if (scope === 'lp') {
      db.prepare(`DELETE FROM wallet_positions WHERE wallet_id = ? AND kind = 'lp'`).run(walletId);
      db.prepare('DELETE FROM lp_positions WHERE wallet_id = ?').run(walletId);
    } else if (scope === 'all' || scope === 'evm') {
      db.prepare('DELETE FROM wallet_positions WHERE wallet_id = ?').run(walletId);
      db.prepare('DELETE FROM lp_positions WHERE wallet_id = ?').run(walletId);
    } else {
      // Scope solana/evm: hanya baris non-LP (LP ditangani tingkat LP).
      db.prepare(`DELETE FROM wallet_positions WHERE wallet_id = ? AND kind != 'lp'`).run(walletId);
    }
    const insPos = db.prepare(
      `INSERT INTO wallet_positions (wallet_id, chain_id, kind, protocol, symbol, name, amount, price_usd, value_usd, meta, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    );
    const insLp = db.prepare(
      `INSERT INTO lp_positions (wallet_id, pool_address, pair, protocol, chain_id, position_value_usd, unclaimed_fees_usd, pool_tvl_usd, in_range, position_address, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    );
    for (const p of all) {
      const syncedAt = typeof p.meta.cached_at === 'string' ? p.meta.cached_at : null;
      insPos.run(walletId, p.chain_id, p.kind, p.protocol, p.symbol, p.name, p.amount, p.price_usd, p.value_usd, JSON.stringify(p.meta ?? {}), syncedAt);
      if (p.kind === 'lp') {
        const m = lpMeta(p);
        insLp.run(walletId, m.pool_address, m.pair, p.protocol, p.chain_id, m.position_value_usd, m.unclaimed_fees_usd, m.pool_tvl_usd, m.in_range, m.position_address, syncedAt);
      }
    }
  });
  tx();
  metaSet(db, hashKey, hash);
  return { written: true };
}

function lpTotal(db: Database.Database, walletId: number): number {
  try {
    const row = db.prepare(
      `SELECT COALESCE(SUM(COALESCE(position_value_usd,0)),0) AS t FROM lp_positions WHERE wallet_id = ?`,
    ).get(walletId) as { t: number };
    return row.t;
  } catch {
    return 0;
  }
}

function walletNonLpTotal(db: Database.Database, walletId: number): number {
  try {
    const row = db.prepare(
      `SELECT COALESCE(SUM(COALESCE(value_usd,0)),0) AS t FROM wallet_positions WHERE wallet_id = ? AND kind != 'lp'`,
    ).get(walletId) as { t: number };
    return row.t;
  } catch {
    return 0;
  }
}

export async function syncAllWallets(
  db: Database.Database,
  network?: 'solana' | 'evm',
  scope: SyncScope = 'all',
): Promise<SyncResult[]> {
  const rows = db.prepare(
    network ? 'SELECT * FROM wallets WHERE network_type = ? ORDER BY id' : 'SELECT * FROM wallets ORDER BY id',
  ).all(...(network ? [network] : [])) as Array<{ id: number }>;
  const out: SyncResult[] = [];
  for (const r of rows) {
    try {
      out.push(await syncWallet(db, r.id, scope));
    } catch (e) {
      out.push({ wallet_id: r.id, ok: false, providers_ok: [], providers_failed: [], positions: 0, error: (e as Error).message });
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return out;
}

/**
 * Sinkronisasi scope EVM dengan pengukuran unit nyata (sebelum & sesudah).
 * onCall diteruskan ke DebankProvider agar panggilan per endpoint tercatat.
 */
export async function syncEvmTier(
  db: Database.Database,
  onCall?: (endpoint: string) => void,
): Promise<{ results: SyncResult[]; meter: { unitsBefore: number | null; unitsAfter: number | null; used: number | null } }> {
  const rows = db.prepare('SELECT * FROM wallets WHERE network_type = ? ORDER BY id').all('evm') as Array<{ id: number }>;
  const results: SyncResult[] = [];
  const reading = await measureEvmCycle(db, async (inner) => {
    const combined = (endpoint: string): void => {
      inner(endpoint);
      onCall?.(endpoint);
    };
    for (const r of rows) {
      try {
        results.push(await syncWallet(db, r.id, 'evm', combined));
      } catch (e) {
        results.push({ wallet_id: r.id, ok: false, providers_ok: [], providers_failed: [], positions: 0, error: (e as Error).message });
      }
      await new Promise((res) => setTimeout(res, 500));
    }
  });
  return { results, meter: { unitsBefore: reading.unitsBefore, unitsAfter: reading.unitsAfter, used: reading.used } };
}

/** Cooldown tombol "Sinkron Ulang": 30 detik per wallet (default via env). */
export function checkResyncCooldown(db: Database.Database, walletId: number, cooldownMs: number): void {
  const row = db.prepare(
    `SELECT MAX(updated_at) AS last_at FROM sync_status WHERE wallet_id = ?`,
  ).get(walletId) as { last_at: string | null } | undefined;
  if (!row?.last_at) return;
  const age = Date.now() - new Date(row.last_at.endsWith('Z') ? row.last_at : row.last_at + 'Z').getTime();
  if (age < cooldownMs) {
    const wait = Math.ceil((cooldownMs - age) / 1000);
    throw Object.assign(new Error(`Tunggu ${wait} detik sebelum sinkron ulang`), { statusCode: 429 });
  }
}

/** Cooldown global tombol "Sinkron Ulang" semua tingkat (30 detik). */
export function checkGlobalResyncCooldown(db: Database.Database, cooldownMs: number): void {
  let row: { v: string | null } | undefined;
  try {
    row = db.prepare(`SELECT MAX(updated_at) AS v FROM sync_status`).get() as { v: string | null };
  } catch {
    return;
  }
  if (!row?.v) return;
  const age = Date.now() - new Date(row.v.endsWith('Z') ? row.v : row.v + 'Z').getTime();
  if (age < cooldownMs) {
    const wait = Math.ceil((cooldownMs - age) / 1000);
    throw Object.assign(new Error(`Tunggu ${wait} detik sebelum sinkron ulang`), { statusCode: 429 });
  }
}

/**
 * Cooldown KHUSUS klik manual (ganti checkResyncCooldown/checkGlobalResyncCooldown
 * di route). Alasan: sync_status ditulis ulang scheduler tiap ±15 detik, jadi
 * cooldown berbasis sync_status membuat tombol manual selalu 429. Kunci manual
 * ini hanya ditulis saat tombol manual diklik — sync otomatis tidak memengaruhi.
 */
export const manualSyncKeyWallet = (id: number): string => `manual_sync_wallet_${id}`;
export const manualSyncKeyAll = 'manual_sync_all';

export function checkManualSyncCooldown(db: Database.Database, key: string, cooldownMs: number): void {
  const last = Number(metaGet(db, key) ?? 0);
  if (last > 0) {
    const age = Date.now() - last;
    if (age < cooldownMs) {
      const wait = Math.ceil((cooldownMs - age) / 1000);
      throw Object.assign(new Error(`Tunggu ${wait} detik sebelum sinkron ulang`), { statusCode: 429 });
    }
  }
}

export function markManualSync(db: Database.Database, key: string): void {
  metaSet(db, key, String(Date.now()));
}
