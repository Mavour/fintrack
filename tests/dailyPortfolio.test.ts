import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/server/db/database.js';
import { listValuations, upsertAsset } from '../src/server/services/portfolioService.js';
import { storePrices } from '../src/server/providers/priceStore.js';
import { parseFundHistory, refreshMutualFunds } from '../src/server/providers/mutualFunds.js';
import { YahooFinanceProvider } from '../src/server/providers/yahooFinance.js';

const databases: Database.Database[] = [];
function memDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  databases.push(db);
  return db;
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.close();
});

describe('daily fund and stock P/L without dividends', () => {
  it('preserves fractional NAV and exact total modal for merged pockets', () => {
    const db = memDb();
    upsertAsset(db, { type: 'reksadana', symbol: 'RD13', name: 'ABF', qty: '12.3456', avg_buy_price_idr: 56700, total_cost_idr: 700000 });
    storePrices(db, [{ symbol: 'RD13', source: 'kontan', priceIdr: 58032.25, asOf: '2026-11-11', history: [
      { day: '2026-11-10', priceIdr: 57987.45 }, { day: '2026-11-11', priceIdr: 58032.25 },
    ] }]);
    const [a] = listValuations(db);
    expect(a).toMatchObject({ cost_idr: 700000, current_price_idr: 58032.25, current_value_idr: 716443,
      pl_idr: 16443, daily_pl_idr: 553, price_date: '2026-11-11', daily_base_date: '2026-11-10' });
    expect(a!.daily_pl_percent).toBeCloseTo(0.077258);
    // Legacy callers that omit total modal must not wipe the user's exact modal.
    upsertAsset(db, { type: 'reksadana', symbol: 'RD13', name: 'ABF', qty: '12.3456', avg_buy_price_idr: 56700 });
    expect(listValuations(db)[0]!.cost_idr).toBe(700000);
  });

  it('compares previous trading date across weekends, without using cost as daily baseline', () => {
    const db = memDb();
    upsertAsset(db, { type: 'saham', symbol: 'BACH.JK', name: 'BACH', qty: '100', avg_buy_price_idr: 300 });
    const quote = { symbol: 'BACH.JK', source: 'yahoo', priceIdr: 214, asOf: '2026-11-09', history: [
      { day: '2026-11-06', priceIdr: 204 }, { day: '2026-11-09', priceIdr: 214 },
    ] };
    storePrices(db, [quote, { ...quote, priceIdr: 216 }]);
    expect(listValuations(db)[0]).toMatchObject({ cost_idr: 30000, pl_idr: -8400, daily_pl_idr: 1200,
      daily_base_date: '2026-11-06', price_date: '2026-11-09' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM price_history').get()).toEqual({ n: 2 });
  });

  it('shows unknown daily P/L when no previous NAV exists and rejects an older replacement', () => {
    const db = memDb();
    upsertAsset(db, { type: 'reksadana', symbol: 'RD66', name: '', qty: '1', avg_buy_price_idr: 0 });
    storePrices(db, [{ symbol: 'RD66', source: 'kontan', priceIdr: 1611.84, asOf: '2026-11-11' }]);
    expect(listValuations(db)[0]).toMatchObject({ pl_idr: null, daily_pl_idr: null });
    storePrices(db, [{ symbol: 'RD66', source: 'kontan', priceIdr: 1611.53, asOf: '2026-11-10' }]);
    expect(listValuations(db)[0]).toMatchObject({ current_price_idr: 1611.84, price_date: '2026-11-11' });
  });

  it('parses paired NAV dates and rejects broken, zero, or future data', () => {
    expect(parseFundHistory("pausecontent.push('2026-11-10');data1.push('1611.53');")).toEqual([{ day: '2026-11-10', priceIdr: 1611.53 }]);
    for (const html of ['', "pausecontent.push('2026-11-10');", "pausecontent.push('2026-11-10');data1.push('0');",
      "pausecontent.push('2099-11-10');data1.push('100');"]) expect(() => parseFundHistory(html)).toThrow();
  });

  it('keeps the old NAV and original market date when the public source fails', async () => {
    const db = memDb();
    upsertAsset(db, { type: 'reksadana', symbol: 'RD66', name: '', qty: '1', avg_buy_price_idr: 0 });
    storePrices(db, [{ symbol: 'RD66', source: 'kontan', priceIdr: 1611.84, asOf: '2026-11-11' }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })));
    await refreshMutualFunds(db);
    expect(listValuations(db)[0]).toMatchObject({ current_price_idr: 1611.84, price_date: '2026-11-11' });
  });

  it('fetches the explicitly mapped fund and stores dated NAV history', async () => {
    const db = memDb();
    upsertAsset(db, { type: 'reksadana', symbol: 'RD984', name: '', qty: '10.1234', avg_buy_price_idr: 0, total_cost_idr: 12000 });
    const fetchMock = vi.fn().mockResolvedValue(new Response("pausecontent.push('2026-11-10');pausecontent.push('2026-11-11');data1.push('1380.94');data1.push('1381.16');"));
    vi.stubGlobal('fetch', fetchMock);
    await refreshMutualFunds(db);
    expect(fetchMock.mock.calls[0]![0]).toContain('produk_id=15371');
    expect(listValuations(db)[0]).toMatchObject({ current_price_idr: 1381.16, daily_pl_idr: 2, cost_idr: 12000 });
  });

  it('uses raw IDR closes and trading dates for daily stock P/L', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ chart: { result: [{
      meta: { currency: 'IDR' }, timestamp: [Date.parse('2026-11-12T02:00:00Z') / 1000, Date.parse('2026-11-13T02:00:00Z') / 1000],
      indicators: { quote: [{ close: [214, 216] }], adjclose: [{ adjclose: [999, 999] }] },
    }] } }))));
    const [quote] = await new YahooFinanceProvider().fetch(['BACH.JK']);
    expect(quote).toMatchObject({ symbol: 'BACH.JK', priceIdr: 216, asOf: '2026-11-13', history: [
      { day: '2026-11-12', priceIdr: 214 }, { day: '2026-11-13', priceIdr: 216 },
    ] });
  });

  it('adds columns to existing databases idempotently', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(`CREATE TABLE assets (id INTEGER PRIMARY KEY, type TEXT, symbol TEXT UNIQUE, name TEXT, qty TEXT,
      avg_buy_price_idr INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE price_cache (symbol TEXT PRIMARY KEY, price_idr INTEGER, source TEXT, fetched_at TEXT);`);
    runMigrations(db);
    runMigrations(db);
    upsertAsset(db, { type: 'saham', symbol: 'PRDL.JK', name: '', qty: '300', avg_buy_price_idr: 120, total_cost_idr: 36000 });
    storePrices(db, [{ symbol: 'PRDL.JK', source: 'yahoo', priceIdr: 104, asOf: '2026-11-12' }]);
    expect(listValuations(db)[0]).toMatchObject({ cost_idr: 36000, pl_idr: -4800 });
  });
});
