import type Database from 'better-sqlite3';
import { DebankProvider } from '../providers/debank.js';

/**
 * Pengukur biaya nyata DeBank: baca /v1/account/units sebelum & sesudah
 * tiap siklus EVM, catat pemakaian per siklus + hitung proyeksi harian.
 * Tidak menebak biaya per panggilan — semua angka dari pengukuran.
 */

export interface MeterReading {
  unitsBefore: number | null;
  unitsAfter: number | null;
  used: number | null;
  calls: Record<string, number>;
}

export async function measureEvmCycle(
  db: Database.Database,
  fn: (onCall: (endpoint: string) => void) => Promise<unknown>,
): Promise<MeterReading> {
  const calls: Record<string, number> = {};
  const onCall = (endpoint: string): void => {
    calls[endpoint] = (calls[endpoint] ?? 0) + 1;
  };
  const probe = new DebankProvider();
  let unitsBefore: number | null = null;
  let unitsAfter: number | null = null;
  try {
    unitsBefore = await probe.unitsRemaining();
  } catch {
    unitsBefore = null;
  }
  await fn(onCall);
  try {
    unitsAfter = await probe.unitsRemaining();
  } catch {
    unitsAfter = null;
  }
  const used = unitsBefore !== null && unitsAfter !== null ? Math.max(0, unitsBefore - unitsAfter) : null;
  try {
    db.prepare(
      `INSERT INTO debank_meter (units_before, units_after, units_used, calls_json) VALUES (?, ?, ?, ?)`,
    ).run(unitsBefore, unitsAfter, used, JSON.stringify(calls));
    // Simpan 7 hari saja.
    db.prepare(`DELETE FROM debank_meter WHERE measured_at < datetime('now', '-7 days')`).run();
  } catch {
    // Metering tidak boleh menggagalkan sync.
  }
  return { unitsBefore, unitsAfter, used, calls };
}

/** Total unit terpakai 24 jam terakhir (pengukuran nyata). */
export function unitsUsedLast24h(db: Database.Database): number | null {
  try {
    const row = db.prepare(
      `SELECT COALESCE(SUM(COALESCE(units_used,0)),0) AS t, COUNT(*) AS c FROM debank_meter
       WHERE measured_at >= datetime('now', '-1 day') AND units_used IS NOT NULL`,
    ).get() as { t: number; c: number };
    if (row.c === 0) return null;
    return row.t;
  } catch {
    return null;
  }
}

/**
 * Proyeksi harian = rata-rata per siklus × siklus per hari pada interval aktif.
 * Interval aktif bisa melambat saat throttle — proyeksi mengikuti interval itu.
 */
export function dailyProjection(db: Database.Database, activeIntervalSec: number): number | null {
  try {
    const row = db.prepare(
      `SELECT AVG(COALESCE(units_used,0)) AS avg_used, COUNT(*) AS c FROM debank_meter
       WHERE measured_at >= datetime('now', '-1 day') AND units_used IS NOT NULL`,
    ).get() as { avg_used: number | null; c: number };
    if (!row.c || row.avg_used === null) return null;
    const cyclesPerDay = 86_400 / Math.max(1, activeIntervalSec);
    return Math.round(row.avg_used * cyclesPerDay);
  } catch {
    return null;
  }
}

/** Rincian pemakaian per endpoint 24 jam (dari hitungan panggilan tercatat). */
export function callsPerEndpoint24h(db: Database.Database): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const rows = db.prepare(
      `SELECT calls_json FROM debank_meter WHERE measured_at >= datetime('now', '-1 day')`,
    ).all() as Array<{ calls_json: string }>;
    for (const r of rows) {
      try {
        const obj = JSON.parse(r.calls_json) as Record<string, number>;
        for (const [k, v] of Object.entries(obj)) out[k] = (out[k] ?? 0) + v;
      } catch {
        // Baris rusak dilewati.
      }
    }
  } catch {
    // Tabel belum ada (migrasi lama) — kembalikan kosong.
  }
  return out;
}

/** Tangga throttle EVM: 15s → 30s → 1m → 5m → maks 10m. */
export const EVM_THROTTLE_LADDER = [15, 30, 60, 300, 600];
export function nextThrottleUp(currentSec: number): number {
  for (const s of EVM_THROTTLE_LADDER) {
    if (s > currentSec) return s;
  }
  return EVM_THROTTLE_LADDER[EVM_THROTTLE_LADDER.length - 1];
}

export function nextThrottleDown(currentSec: number): number {
  for (let i = EVM_THROTTLE_LADDER.length - 1; i >= 0; i--) {
    if (EVM_THROTTLE_LADDER[i] < currentSec) return EVM_THROTTLE_LADDER[i];
  }
  return EVM_THROTTLE_LADDER[0];
}

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

export interface HyperCoverage {
  chains: Array<{ id: string; name: string }>;
  checked_at: string | null;
  /** DeBank mencakup Hyperliquid (chain HyperEVM dan/atau protokol spot). */
  covers_hyper: boolean;
}

/**
 * Cakupan Hyper DeBank dari /v1/chain/list resmi (bukan hardcode).
 * Di-cache 24 jam di tabel meta agar tidak membakar unit tiap polling.
 * Dipakai UI untuk label + memverifikasi tidak ada dobel dengan HyperCore.
 */
export function getCachedHyperCoverage(db: Database.Database): HyperCoverage {
  try {
    const raw = metaGet(db, 'debank_hyper_chains');
    if (raw) {
      const parsed = JSON.parse(raw) as HyperCoverage;
      if (Array.isArray(parsed.chains)) return parsed;
    }
  } catch {
    // Cache rusak → anggap belum ada.
  }
  return { chains: [], checked_at: null, covers_hyper: false };
}

/** Refresh cache cakupan (maks 1×/24 jam, 1 panggilan chain/list). */
export async function maybeRefreshHyperCoverage(db: Database.Database): Promise<HyperCoverage> {
  const cached = getCachedHyperCoverage(db);
  if (cached.checked_at && Date.now() - new Date(cached.checked_at).getTime() < 24 * 3600_000) {
    return cached;
  }
  const key = process.env.DEBANK_ACCESS_KEY ?? '';
  if (!key) return cached;
  try {
    const p = new DebankProvider();
    const chains = await p.chainList();
    const hyper = chains.filter(
      (c) => /hype|hyper/i.test(c.id) || /hyper/i.test(c.name),
    );
    const out: HyperCoverage = { chains: hyper, checked_at: new Date().toISOString(), covers_hyper: hyper.length > 0 };
    metaSet(db, 'debank_hyper_chains', JSON.stringify(out));
    return out;
  } catch {
    return cached;
  }
}
