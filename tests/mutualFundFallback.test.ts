import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/server/db/database.js';
import { parseArchivedNav, refreshMutualFunds } from '../src/server/providers/mutualFunds.js';
import { storePrices } from '../src/server/providers/priceStore.js';
import { listValuations, upsertAsset } from '../src/server/services/portfolioService.js';

const databases: Database.Database[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const db of databases.splice(0)) db.close(); });
function dbWithFund() {
  const db = new Database(':memory:'); databases.push(db); runMigrations(db);
  upsertAsset(db, { type: 'reksadana', symbol: 'RD66', name: '', qty: '10', avg_buy_price_idr: 1500 });
  return db;
}
const archive = (symbol = 'RD66') => ({ symbol, currency_exchange: { currency: 'IDR' }, history: { nav: [
  { date: '2026-11-10', value: 1611.53, source: 'bibit' },
  { date: '2026-11-11', value: 1611.84, source: 'bareksa' },
] } });

describe('public NAV fallback for VPS', () => {
  it('falls back after Kontan 403 and retains the real NAV date and provenance', async () => {
    const db = dbWithFund();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(archive())));
    vi.stubGlobal('fetch', fetchMock);
    await refreshMutualFunds(db);
    expect(fetchMock.mock.calls[1]![0]).toBe('https://reksadana.risanb.com/api/funds/RD66.json');
    expect(listValuations(db)[0]).toMatchObject({ current_price_idr: 1611.84, price_date: '2026-11-11',
      daily_base_date: '2026-11-10', daily_pl_idr: 3, price_source: 'reksadana-id:bareksa' });
  });

  it('keeps the last price when both sources fail', async () => {
    const db = dbWithFund();
    storePrices(db, [{ symbol: 'RD66', priceIdr: 1600.25, source: 'kontan', asOf: '2026-11-09' }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Unavailable', { status: 403 })));
    await refreshMutualFunds(db);
    expect(listValuations(db)[0]).toMatchObject({ current_price_idr: 1600.25, price_date: '2026-11-09' });
  });

  it('rejects another fund, currency, invalid prices and malformed dates', () => {
    expect(() => parseArchivedNav(archive('RD984'), 'RD66')).toThrow();
    const usd = archive(); usd.currency_exchange.currency = 'USD';
    expect(() => parseArchivedNav(usd, 'RD66')).toThrow();
    const bad = archive(); bad.history.nav[1]!.value = 0;
    expect(() => parseArchivedNav(bad, 'RD66')).toThrow();
    const date = archive(); date.history.nav[1]!.date = '2026-02-31';
    expect(() => parseArchivedNav(date, 'RD66')).toThrow();
  });

  it('ignores future points and never downgrades a newer cached NAV', async () => {
    const future = archive(); future.history.nav.push({ date: '2099-01-01', value: 9999, source: 'bareksa' });
    expect(parseArchivedNav(future, 'RD66').history.at(-1)!.day).toBe('2026-11-11');
    const db = dbWithFund();
    storePrices(db, [{ symbol: 'RD66', priceIdr: 1620, source: 'kontan', asOf: '2026-11-12' }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(archive()))));
    await refreshMutualFunds(db);
    expect(listValuations(db)[0]).toMatchObject({ current_price_idr: 1620, price_date: '2026-11-12' });
  });
});
