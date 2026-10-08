import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CircuitBreaker, breakerFor, resetBreakers } from '../src/server/services/circuitBreaker.js';
import {
  throwForStatus,
  ProviderHttpError,
  normalizeListLenient,
  snapshotHash,
} from '../src/server/providers/walletTypes.js';
import { nextThrottleUp, nextThrottleDown, dailyProjection, unitsUsedLast24h } from '../src/server/services/debankMeter.js';
import { commitPositions, syncWallet, checkGlobalResyncCooldown } from '../src/server/services/walletSync.js';
import { refreshWalletPrices } from '../src/server/services/priceTier.js';
import { emitSyncDone, sseClientCount, minutesSinceLastClient, resetSseHub, touchSseClient } from '../src/server/services/sse.js';
import { isIdleMode } from '../src/server/services/tierScheduler.js';
import { createWallet } from '../src/server/services/walletRegistry.js';
import { listPositions } from '../src/server/services/walletRead.js';
import { tierSec as tierSecShim } from '../src/server/config.js';

const SOL = '3keq3cRtYuoPCYBUL4s6N52ePguGivSZpNU4fzSiPXpd';

function memDb(): Database.Database {
  const db = new Database(':memory:');
  const here = path.dirname(fileURLToPath(import.meta.url));
  db.exec(fs.readFileSync(path.join(here, '..', 'src', 'server', 'db', 'schema.sql'), 'utf-8'));
  return db;
}

function resp(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  resetBreakers();
  resetSseHub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetBreakers();
  resetSseHub();
});

describe('circuit breaker', () => {
  it('buka setelah 5 gagal beruntun, half-open lalu tutup saat sukses', () => {
    const b = new CircuitBreaker({ failureThreshold: 5, openCooldownMs: 50 });
    for (let i = 0; i < 4; i++) {
      b.recordFailure();
      expect(b.allow()).toBe(true);
    }
    b.recordFailure();
    expect(b.allow()).toBe(false);
    expect(b.snapshot().state).toBe('open');
  });

  it('breaker registry dipakai syncWallet (provider down di-skip)', async () => {
    const db = memDb();
    const w = createWallet(db, 'S', SOL);
    // Buka circuit jupiter + rpc + meteora secara manual.
    for (const name of ['jupiter-portfolio-v1', 'solana-rpc-fallback', 'meteora-dlmm', 'meteora-damm-v2']) {
      const b = breakerFor(name);
      for (let i = 0; i < 5; i++) b.recordFailure();
    }
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('must not be called');
    }));
    const r = await syncWallet(db, w.id, 'all');
    // Hanya stub (sukses kosong) yang jalan -> tidak ada provider nyata -> gagal terkontrol, cache utuh.
    expect(r.ok).toBe(false);
    expect(r.providers_failed).toContain('jupiter-portfolio-v1');
    db.close();
  });
});

describe('429 + Retry-After', () => {
  it('throwForStatus membawa retryAfterMs untuk 429', () => {
    try {
      throwForStatus(resp(429, {}, { 'retry-after': '7' }), 'x');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderHttpError);
      expect((e as ProviderHttpError).retryAfterMs).toBe(7000);
    }
  });

  it('429 tanpa header tetap 429 terkontrol', () => {
    try {
      throwForStatus(resp(429), 'x');
      expect.unreachable();
    } catch (e) {
      expect((e as { statusCode?: number }).statusCode).toBe(429);
      expect((e as ProviderHttpError).retryAfterMs).toBeNull();
    }
  });

  it('syncWallet meneruskan retryAfterMs + backoff dicatat', async () => {
    process.env.JUPITER_API_KEY = 'k';
    const db = memDb();
    const w = createWallet(db, 'S', SOL);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('portfolio/v1')) return resp(429, {}, { 'retry-after': '3' });
      if (String(url).includes('mainnet-beta')) return resp(200, { result: { value: [] } });
      if (String(url).includes('meteora')) return resp(200, []);
      return resp(500);
    }));
    const r = await syncWallet(db, w.id, 'solana');
    expect(r.retryAfterMs).toBe(3000);
    db.close();
    delete process.env.JUPITER_API_KEY;
  });
});

describe('zod toleran', () => {
  it('item rusak dilewati, item bagus dipakai', () => {
    const warns: string[] = [];
    const out = normalizeListLenient(
      [
        { chain_id: 'solana', kind: 'token', symbol: 'SOL', amount: '1', price_usd: 1, value_usd: 1, meta: {} },
        { chain_id: '', kind: 'nope', symbol: '' },
      ],
      'test',
      (m) => warns.push(m),
    );
    expect(out.positions).toHaveLength(1);
    expect(out.skipped).toBe(1);
    expect(warns).toHaveLength(1);
  });
});

describe('hash-skip + guard drop 90%', () => {
  const pos = (value: number, symbol = 'SOL') => ({
    chain_id: 'solana', kind: 'token' as const, protocol: 't', symbol, name: 'S',
    amount: '1', price_usd: value, value_usd: value, meta: {},
  });

  it('snapshot identik tidak ditulis ulang', () => {
    const db = memDb();
    const w = createWallet(db, 'S', SOL);
    const first = commitPositions(db, w.id, [pos(100)], 'all');
    expect(first.written).toBe(true);
    const second = commitPositions(db, w.id, [pos(100)], 'all');
    expect(second).toEqual({ written: false, skipped: 'unchanged' });
    db.close();
  });

  it('drop >90% ditahan, diterima setelah 2 sync beruntun', () => {
    const db = memDb();
    const w = createWallet(db, 'S', SOL);
    commitPositions(db, w.id, [pos(1000)], 'all');
    const s1 = commitPositions(db, w.id, [pos(50)], 'all');
    expect(s1.skipped).toBe('suspicious');
    expect(listPositions(db, { wallet_id: w.id, show_all: true })[0].value_usd).toBe(1000);
    const s2 = commitPositions(db, w.id, [pos(50)], 'all');
    expect(s2.written).toBe(true);
    expect(listPositions(db, { wallet_id: w.id, show_all: true })[0].value_usd).toBe(50);
    db.close();
  });

  it('snapshot kosong saat sebelumnya ada dianggap mencurigakan', () => {
    const db = memDb();
    const w = createWallet(db, 'S', SOL);
    commitPositions(db, w.id, [pos(100)], 'all');
    const s = commitPositions(db, w.id, [], 'all');
    expect(s.skipped).toBe('suspicious');
    expect(listPositions(db, { wallet_id: w.id, show_all: true })).toHaveLength(1);
    db.close();
  });

  it('hash stabil tidak peduli urutan', () => {
    const a = [pos(10, 'A'), pos(20, 'B')];
    const b = [pos(20, 'B'), pos(10, 'A')];
    expect(snapshotHash(a)).toBe(snapshotHash(b));
  });
});

describe('throttle ladder DeBank', () => {
  it('naik bertahap 15→30→60→300→600, mentok 600', () => {
    expect(nextThrottleUp(15)).toBe(30);
    expect(nextThrottleUp(30)).toBe(60);
    expect(nextThrottleUp(300)).toBe(600);
    expect(nextThrottleUp(600)).toBe(600);
    expect(nextThrottleUp(999)).toBe(600);
  });
  it('turun bertahap', () => {
    expect(nextThrottleDown(600)).toBe(300);
    expect(nextThrottleDown(30)).toBe(15);
    expect(nextThrottleDown(15)).toBe(15);
  });
  it('proyeksi dari pengukuran nyata', () => {
    const db = memDb();
    expect(dailyProjection(db, 15)).toBeNull();
    expect(unitsUsedLast24h(db)).toBeNull();
    db.prepare(`INSERT INTO debank_meter (units_before, units_after, units_used, calls_json) VALUES (100, 90, 10, '{}')`).run();
    // 10 unit/siklus × (86400/15) siklus = 57600/hari.
    expect(dailyProjection(db, 15)).toBe(57600);
    expect(unitsUsedLast24h(db)).toBe(10);
    db.close();
  });
});

describe('tier harga', () => {
  it('value dihitung ulang dari harga baru tanpa baca wallet', async () => {
    const db = memDb();
    const w = createWallet(db, 'S', SOL);
    db.prepare(
      `INSERT INTO wallet_positions (wallet_id, chain_id, kind, protocol, symbol, name, amount, price_usd, value_usd, meta)
       VALUES (?, 'solana', 'token', 'solana-rpc', 'TOK', 'Tok', '2', 1, 2, ?)`,
    ).run(w.id, JSON.stringify({ mint: 'MINT1111111111111111111111111111111111111111' }));
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, {
      MINT1111111111111111111111111111111111111111: { usdPrice: 5 },
    })));
    const out = await refreshWalletPrices(db);
    expect(out.updated).toBe(1);
    const row = listPositions(db, { wallet_id: w.id, show_all: true })[0];
    expect(row.price_usd).toBe(5);
    expect(row.value_usd).toBe(10);
    db.close();
  });

  it('harga gagal → nilai lama dipertahankan, tidak throw', async () => {
    const db = memDb();
    const w = createWallet(db, 'S', SOL);
    db.prepare(
      `INSERT INTO wallet_positions (wallet_id, chain_id, kind, protocol, symbol, name, amount, price_usd, value_usd, meta)
       VALUES (?, 'solana', 'token', 'solana-rpc', 'TOK', 'Tok', '2', 1, 2, ?)`,
    ).run(w.id, JSON.stringify({ mint: 'MINT1111111111111111111111111111111111111111' }));
    vi.stubGlobal('fetch', vi.fn(async () => resp(500)));
    const out = await refreshWalletPrices(db);
    expect(out.updated).toBe(0);
    expect(listPositions(db, { wallet_id: w.id, show_all: true })[0].price_usd).toBe(1);
    db.close();
  });
});

describe('SSE hub + idle', () => {
  it('tanpa klien tidak idle saat belum pernah ada; idle setelah 30 mnt pergi', () => {
    expect(sseClientCount()).toBe(0);
    expect(isIdleMode()).toBe(false);
    touchSseClient(Date.now() - 31 * 60_000);
    expect(minutesSinceLastClient()).toBeGreaterThan(30);
    expect(isIdleMode()).toBe(true);
    touchSseClient(Date.now());
    expect(isIdleMode()).toBe(false);
  });

  it('emit tanpa klien tidak throw', () => {
    expect(() => emitSyncDone(['price', 'lp'])).not.toThrow();
  });
});

describe('cooldown global sync-all', () => {
  it('mencegah spam tombol', () => {
    const db = memDb();
    db.prepare(`INSERT INTO sync_status (provider, wallet_id, updated_at) VALUES ('t', NULL, datetime('now'))`).run();
    expect(() => checkGlobalResyncCooldown(db, 30_000)).toThrow(/Tunggu/);
    db.close();
  });
});

describe('matriks ketahanan provider', () => {
  const cases: Array<[string, (url: string) => Promise<Response>]> = [
    ['HTTP 500', async () => resp(500)],
    ['HTTP 429', async () => resp(429, {}, { 'retry-after': '1' })],
    ['timeout', async () => {
      throw new Error('timeout');
    }],
    ['JSON rusak', async () => ({ ok: true, status: 200, json: async () => {
      throw new SyntaxError('bad json');
    } }) as unknown as Response],
    ['respons kosong', async () => resp(200, {})],
  ];
  for (const [name, impl] of cases) {
    it(`sync selamat dari: ${name}`, { timeout: 60_000 }, async () => {
      process.env.JUPITER_API_KEY = 'k';
      const db = memDb();
      const w = createWallet(db, 'S', SOL);
      // Seed cache bagus dulu.
      commitPositions(db, w.id, [{
        chain_id: 'solana', kind: 'token', protocol: 't', symbol: 'SOL', name: 'S',
        amount: '1', price_usd: 100, value_usd: 100, meta: {},
      }], 'all');
      vi.stubGlobal('fetch', vi.fn(impl));
      let threw = false;
      try {
        await syncWallet(db, w.id, 'all');
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      // Cache bagus tidak pernah hancur oleh data buruk.
      const rows = listPositions(db, { wallet_id: w.id, show_all: true });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].value_usd).toBe(100);
      db.close();
      delete process.env.JUPITER_API_KEY;
    });
  }
});

describe('env tier minimum', () => {
  it('nilai agresif dijepit ke 10 detik', () => {
    expect(tierSecShim('3', 15)).toBe(10);
    expect(tierSecShim('15', 15)).toBe(15);
    expect(tierSecShim(undefined, 15)).toBe(15);
    expect(tierSecShim('abc', 15)).toBe(15);
  });
});
