import type Database from 'better-sqlite3';
import { fetchDexTokens } from './dexscreener.js';
import { fetchGeckoSymbols } from './geckoterminal.js';
import { fetchWithTimeout, withRetry } from './types.js';
import { logger } from '../logger.js';

/**
 * Resolver symbol/nama token bersama (solana-rpc-fallback dkk).
 * Prioritas: Jupiter verified list (cache 24 jam) → DexScreener → GeckoTerminal
 * (tahu token "mati" pun, harga sering null). Semua best-effort; kegagalan
 * sumber tidak pernah melempar — mint dipakai sebagai fallback symbol.
 */

interface JupToken {
  id: string;
  symbol: string;
  name: string;
  icon?: string;
}

let jupCache: { at: number; byMint: Map<string, JupToken> } | null = null;

/** Test-only: clear the module-level Jupiter cache. */
export function __resetTokenMetaCache(): void {
  jupCache = null;
}

export interface TokenMeta {
  symbol: string;
  name: string;
  source: 'verified' | 'dex' | 'gecko' | 'unknown';
  icon: string | null;
}

export async function resolveTokens(mints: string[]): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>();
  if (mints.length === 0) return out;

  // 1) Jupiter verified (3873 token, satu fetch per hari).
  try {
    if (!jupCache || Date.now() - jupCache.at > 24 * 3600 * 1000) {
      const res = await withRetry(() => fetchWithTimeout('https://api.jup.ag/tokens/v2/tag?query=verified', 15_000));
      if (res.ok) {
        const list = (await res.json()) as JupToken[];
        jupCache = { at: Date.now(), byMint: new Map(list.map((t) => [t.id, t])) };
      }
    }
    if (jupCache) {
      for (const m of mints) {
        const t = jupCache.byMint.get(m);
        if (t) out.set(m, { symbol: t.symbol, name: t.name, source: 'verified', icon: iconUrl(t.icon) });
      }
    }
  } catch {
    // Non-fatal.
  }

  const unknown = mints.filter((m) => !out.has(m));
  if (unknown.length === 0) return out;

  // 2) DexScreener (pairs aktif pertama menang).
  try {
    const dex = await fetchDexTokens(unknown);
    for (const [m, t] of dex) {
      if (!out.has(m)) out.set(m, { symbol: t.symbol, name: t.name, source: 'dex', icon: iconUrl(t.imageUrl) });
    }
  } catch {
    // Non-fatal.
  }

  const still = unknown.filter((m) => !out.has(m));
  if (still.length === 0) return out;

  // 3) GeckoTerminal — mengenal token tanpa pair (dead tokens).
  try {
    const gecko = await fetchGeckoSymbols(still);
    for (const [m, t] of gecko) {
      if (!out.has(m)) out.set(m, { symbol: t.symbol, name: t.name, source: 'gecko', icon: null });
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

/** Samarkan URL ikon: hanya https, selain itu null. */
function iconUrl(v: unknown): string | null {
  return typeof v === 'string' && v.startsWith('https://') ? v : null;
}

/** TTL cache ikon: ketemu 30 hari, tak ketemu 1 hari (listing baru dicoba lagi). */
const HIT_TTL_MS = 30 * 24 * 3600_000;
const MISS_TTL_MS = 24 * 3600_000;

function ensureIconTable(db: Database.Database): void {
  try {
    db.prepare(
      `CREATE TABLE IF NOT EXISTS token_icons (
         mint TEXT PRIMARY KEY, icon TEXT NOT NULL DEFAULT '',
         updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    ).run();
  } catch {
    // Best-effort.
  }
}

/**
 * Resolve logo per mint dengan cache disk (token_icons).
 * Sumber: Jupiter verified `icon` → DexScreener `info.imageUrl`.
 * Best-effort: gagal total → peta kosong (frontend pakai fallback).
 * Mengembalikan mint -> URL ikon (hanya yang ketemu).
 */
export async function resolveTokenIcons(db: Database.Database, mints: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(mints.filter((m) => typeof m === 'string' && m.trim() !== ''))];
  if (wanted.length === 0) return out;
  ensureIconTable(db);
  const now = Date.now();
  const missing: string[] = [];
  try {
    const rows = db.prepare(
      `SELECT mint, icon, updated_at FROM token_icons WHERE mint IN (${wanted.map(() => '?').join(',')})`,
    ).all(...wanted) as Array<{ mint: string; icon: string; updated_at: string }>;
    const seen = new Map(rows.map((r) => [r.mint, r]));
    for (const m of wanted) {
      const r = seen.get(m);
      if (!r) {
        missing.push(m);
        continue;
      }
      const age = now - new Date(r.updated_at.endsWith('Z') ? r.updated_at : r.updated_at + 'Z').getTime();
      if (r.icon) {
        if (Number.isFinite(age) && age < HIT_TTL_MS) {
          out.set(m, r.icon);
          continue;
        }
        missing.push(m);
      } else if (!Number.isFinite(age) || age >= MISS_TTL_MS) {
        missing.push(m);
      }
    }
  } catch {
    missing.push(...wanted.filter((m) => !out.has(m)));
  }
  if (missing.length === 0) return out;
  let meta: Map<string, TokenMeta>;
  try {
    meta = await resolveTokens(missing);
  } catch {
    return out;
  }
  try {
    const upsert = db.prepare(
      `INSERT INTO token_icons (mint, icon, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(mint) DO UPDATE SET icon = excluded.icon, updated_at = datetime('now')`,
    );
    const tx = db.transaction(() => {
      for (const m of missing) {
        const icon = meta.get(m)?.icon ?? '';
        upsert.run(m, icon);
        if (icon) out.set(m, icon);
      }
    });
    tx();
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'token icon cache tulis gagal');
  }
  return out;
}

/** Baca ikon dari cache disk saja (sinkron, untuk jalur baca/API). */
export function readCachedIcons(db: Database.Database, mints: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const wanted = [...new Set(mints.filter((m) => typeof m === 'string' && m.trim() !== ''))];
  if (wanted.length === 0) return out;
  try {
    const rows = db.prepare(
      `SELECT mint, icon FROM token_icons WHERE icon != '' AND mint IN (${wanted.map(() => '?').join(',')})`,
    ).all(...wanted) as Array<{ mint: string; icon: string }>;
    for (const r of rows) out.set(r.mint, r.icon);
  } catch {
    // Tabel belum ada — kembalikan kosong.
  }
  return out;
}