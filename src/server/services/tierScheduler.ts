import type Database from 'better-sqlite3';
import { refreshWalletPrices } from './priceTier.js';
import { syncAllWallets, syncEvmTier, recordSyncStatus } from './walletSync.js';
import { dailyProjection, unitsUsedLast24h, EVM_THROTTLE_LADDER, nextThrottleUp, nextThrottleDown, maybeRefreshHyperCoverage } from './debankMeter.js';
import { emitSyncDone, minutesSinceLastClient, type SyncScope } from './sse.js';
import { logger } from '../logger.js';

/**
 * Scheduler bertingkat (near-real-time), satu proses tunggal:
 * - price: harga token dikenal + hitung ulang value (tanpa baca wallet).
 * - lp: posisi Meteora terbuka (fees, TVL posisi, TVL pool).
 * - solana: saldo/posisi Jupiter Portfolio.
 * - evm: token + DeFi DeBank (dengan pengaman biaya).
 * Jaminan: mutex per tier (tidak tumpang tindih), jitter ±10%,
 * hormati Retry-After/429, hash-skip (tanpa tulis/emit bila identik),
 * mode hemat (interval ×5 bila 30 mnt tanpa klien SSE).
 */

export type TierName = 'price' | 'lp' | 'solana' | 'evm';

export interface TierState {
  baseIntervalSec: number;
  activeIntervalSec: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  throttled: boolean;
  backoffUntil: number;
  running: boolean;
  evmNote: string | null;
}

interface TierRuntime extends TierState {
  timer: NodeJS.Timeout | null;
  stopped: boolean;
}

const runtimes = new Map<TierName, TierRuntime>();
let dbRef: Database.Database | null = null;
let started = false;

function getRuntime(t: TierName): TierRuntime {
  let r = runtimes.get(t);
  if (!r) {
    r = {
      baseIntervalSec: 15, activeIntervalSec: 15, lastSuccessAt: null, lastError: null,
      throttled: false, backoffUntil: 0, running: false, evmNote: null, timer: null, stopped: false,
    };
    runtimes.set(t, r);
  }
  return r;
}

/** Idle bila pernah ada klien lalu pergi ≥30 menit. */
export function isIdleMode(): boolean {
  return minutesSinceLastClient() >= 30 && minutesSinceLastClient() !== Infinity;
}

function effectiveDelayMs(r: TierRuntime): number {
  let sec = r.activeIntervalSec;
  if (isIdleMode()) sec *= 5;
  const now = Date.now();
  if (r.backoffUntil > now) {
    return Math.max(r.backoffUntil - now, 1000);
  }
  const jitter = 1 + (Math.random() * 0.2 - 0.1); // ±10%
  return Math.max(1000, Math.round(sec * 1000 * jitter));
}

function markSuccess(t: TierName, scopes: SyncScope[], changed: boolean): void {
  const r = getRuntime(t);
  r.lastSuccessAt = new Date().toISOString();
  r.lastError = null;
  if (changed) emitSyncDone(scopes);
  try {
    if (dbRef) recordSyncStatus(dbRef, `tier-${t}`, null, true);
  } catch {
    // Best-effort.
  }
}

function markFailure(t: TierName, msg: string): void {
  const r = getRuntime(t);
  r.lastError = msg.slice(0, 300);
  try {
    if (dbRef) recordSyncStatus(dbRef, `tier-${t}`, null, false, msg.slice(0, 500));
  } catch {
    // Best-effort.
  }
}

function note429(t: TierName, retryAfterMs: number | null): void {
  const r = getRuntime(t);
  // Backoff otomatis: hormati Retry-After, minimal 60 detik, interval naik sementara.
  r.backoffUntil = Date.now() + Math.max(retryAfterMs ?? 0, 60_000);
  logger.warn({ tier: t, retryAfterMs }, '429 diterima, backoff sementara');
}

async function runPriceTier(db: Database.Database): Promise<boolean> {
  const out = await refreshWalletPrices(db);
  return out.updated > 0;
}

async function runLpTier(db: Database.Database): Promise<{ changed: boolean; retryAfterMs: number | null }> {
  const results = await syncAllWallets(db, 'solana', 'lp');
  let changed = false;
  let retryAfterMs: number | null = null;
  let failures = 0;
  for (const r of results) {
    if (r.ok && !r.unchanged) changed = true;
    if (!r.ok) failures++;
    if (r.retryAfterMs) retryAfterMs = Math.max(retryAfterMs ?? 0, r.retryAfterMs);
  }
  if (results.length > 0 && failures === results.length) throw new Error(results[0].error ?? 'LP sync gagal');
  return { changed, retryAfterMs };
}

async function runSolanaTier(db: Database.Database): Promise<{ changed: boolean; retryAfterMs: number | null }> {
  const results = await syncAllWallets(db, 'solana', 'solana');
  let changed = false;
  let retryAfterMs: number | null = null;
  let failures = 0;
  for (const r of results) {
    if (r.ok && !r.unchanged) changed = true;
    if (!r.ok) failures++;
    if (r.retryAfterMs) retryAfterMs = Math.max(retryAfterMs ?? 0, r.retryAfterMs);
  }
  if (results.length > 0 && failures === results.length) throw new Error(results[0].error ?? 'Solana sync gagal');
  return { changed, retryAfterMs };
}

async function runEvmTier(db: Database.Database, budget: number): Promise<{ changed: boolean; retryAfterMs: number | null }> {
  const r = getRuntime('evm');
  const { results, meter } = await syncEvmTier(db);
  // Verifikasi cakupan Hyper DeBank (cache 24 jam, murah).
  void maybeRefreshHyperCoverage(db).catch(() => undefined);
  let changed = false;
  let retryAfterMs: number | null = null;
  let failures = 0;
  for (const res of results) {
    if (res.ok && !res.unchanged) changed = true;
    if (!res.ok) failures++;
    if (res.retryAfterMs) retryAfterMs = Math.max(retryAfterMs ?? 0, res.retryAfterMs);
  }
  // Auto-throttle dari proyeksi nyata (bukan tebakan).
  if (budget > 0) {
    const proj = dailyProjection(db, r.activeIntervalSec);
    if (proj !== null && proj > budget && r.activeIntervalSec < EVM_THROTTLE_LADDER[EVM_THROTTLE_LADDER.length - 1]) {
      r.activeIntervalSec = nextThrottleUp(r.activeIntervalSec);
      r.throttled = r.activeIntervalSec !== r.baseIntervalSec;
      r.evmNote = 'EVM melambat (hemat unit)';
      logger.warn({ proj, budget, next: r.activeIntervalSec }, 'proyeksi DeBank melebihi anggaran, interval EVM dinaikkan');
    } else if (proj !== null && proj < budget * 0.7 && r.activeIntervalSec > r.baseIntervalSec) {
      r.activeIntervalSec = Math.max(r.baseIntervalSec, nextThrottleDown(r.activeIntervalSec));
      r.throttled = r.activeIntervalSec !== r.baseIntervalSec;
      if (!r.throttled) r.evmNote = null;
      logger.info({ proj, next: r.activeIntervalSec }, 'proyeksi aman, interval EVM diturunkan');
    }
  }
  if (meter.unitsAfter !== null && meter.unitsAfter <= 0) {
    r.evmNote = 'Unit DeBank habis — sync EVM berhenti otomatis';
    throw new Error(r.evmNote);
  }
  if (results.length > 0 && failures === results.length) throw new Error(results[0].error ?? 'EVM sync gagal');
  return { changed, retryAfterMs };
}

async function tick(t: TierName, db: Database.Database, budget: number): Promise<void> {
  const r = getRuntime(t);
  if (r.stopped) return;
  if (r.running) {
    // Mutex: lewati tick bila run sebelumnya belum selesai (tidak tumpang tindih).
    logger.warn({ tier: t }, 'tier masih berjalan, tick dilewati');
    scheduleNext(t, db, budget, effectiveDelayMs(r));
    return;
  }
  r.running = true;
  try {
    if (t === 'price') {
      const changed = await runPriceTier(db);
      markSuccess(t, ['price'], changed);
    } else if (t === 'lp') {
      const out = await runLpTier(db);
      if (out.retryAfterMs) note429(t, out.retryAfterMs);
      markSuccess(t, ['lp'], out.changed);
    } else if (t === 'solana') {
      const out = await runSolanaTier(db);
      if (out.retryAfterMs) note429(t, out.retryAfterMs);
      markSuccess(t, ['solana'], out.changed);
    } else {
      const out = await runEvmTier(db, budget);
      if (out.retryAfterMs) note429(t, out.retryAfterMs);
      markSuccess(t, ['evm'], out.changed);
    }
  } catch (e) {
    const msg = (e as Error).message ?? 'gagal';
    const ra = (e as { retryAfterMs?: number | null }).retryAfterMs ?? null;
    if (ra !== null || /429/.test(msg)) note429(t, ra);
    markFailure(t, msg);
    logger.warn({ tier: t, err: msg }, 'tier sync gagal, cache lama dipakai');
  } finally {
    r.running = false;
    if (!r.stopped) scheduleNext(t, db, budget, effectiveDelayMs(r));
  }
}

function scheduleNext(t: TierName, db: Database.Database, budget: number, delayMs: number): void {
  const r = getRuntime(t);
  if (r.timer) clearTimeout(r.timer);
  r.timer = setTimeout(() => {
    void tick(t, db, budget);
  }, delayMs);
  if (r.timer.unref) r.timer.unref();
}

export interface TierSchedulerOpts {
  priceSec: number;
  lpSec: number;
  solSec: number;
  evmSec: number;
  debankBudget: number;
}

export function startTierScheduler(db: Database.Database, opts: TierSchedulerOpts): void {
  if (started) return;
  started = true;
  dbRef = db;
  const map: Record<TierName, number> = { price: opts.priceSec, lp: opts.lpSec, solana: opts.solSec, evm: opts.evmSec };
  for (const t of Object.keys(map) as TierName[]) {
    const r = getRuntime(t);
    r.stopped = false;
    r.baseIntervalSec = map[t];
    r.activeIntervalSec = map[t];
    scheduleNext(t, db, opts.debankBudget, effectiveDelayMs(r));
  }
  logger.info({ opts }, 'tier scheduler started');
}

export function stopTierScheduler(): void {
  started = false;
  for (const r of runtimes.values()) {
    r.stopped = true;
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    r.running = false;
  }
}

/** Status per tier untuk popover badge + menu Wallet. */
export function getTierStatus(): Record<TierName, { intervalSec: number; activeIntervalSec: number; lastSuccessAt: string | null; lastError: string | null; throttled: boolean; note: string | null; idle: boolean }> {
  const idle = isIdleMode();
  const out = {} as ReturnType<typeof getTierStatus>;
  for (const t of ['price', 'lp', 'solana', 'evm'] as TierName[]) {
    const r = getRuntime(t);
    out[t] = {
      intervalSec: r.baseIntervalSec,
      activeIntervalSec: idle ? r.activeIntervalSec * 5 : r.activeIntervalSec,
      lastSuccessAt: r.lastSuccessAt,
      lastError: r.lastError,
      throttled: r.throttled,
      note: r.evmNote,
      idle,
    };
  }
  return out;
}

/** Test-only: reset penuh. */
export function resetTierScheduler(): void {
  stopTierScheduler();
  runtimes.clear();
  dbRef = null;
}

/**
 * Pemicu manual semua tingkat sekaligus (tombol Sinkron Ulang).
 * Tunduk pada cooldown global di route. Mengirim sync:done per cakupan berubah.
 */
export async function triggerAllTiersNow(db: Database.Database): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    const changed = await runPriceTier(db);
    markSuccess('price', ['price'], changed);
    out.price = { ok: true, changed };
  } catch (e) {
    markFailure('price', (e as Error).message);
    out.price = { ok: false };
  }
  try {
    const r = await runLpTier(db);
    markSuccess('lp', ['lp'], r.changed);
    out.lp = { ok: true, changed: r.changed };
  } catch (e) {
    markFailure('lp', (e as Error).message);
    out.lp = { ok: false };
  }
  try {
    const r = await runSolanaTier(db);
    markSuccess('solana', ['solana'], r.changed);
    out.solana = { ok: true, changed: r.changed };
  } catch (e) {
    markFailure('solana', (e as Error).message);
    out.solana = { ok: false };
  }
  try {
    const budget = Number(process.env.DEBANK_DAILY_UNIT_BUDGET ?? 0);
    const r = await runEvmTier(db, budget);
    markSuccess('evm', ['evm'], r.changed);
    out.evm = { ok: true, changed: r.changed };
  } catch (e) {
    markFailure('evm', (e as Error).message);
    out.evm = { ok: false };
  }
  return out;
}

export { unitsUsedLast24h, dailyProjection };
