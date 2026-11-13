import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/server/db/database.js';
import { storePrices } from '../src/server/providers/priceStore.js';
import { addSseClient, minutesSinceLastClient, resetSseHub } from '../src/server/services/sse.js';
import { connectSse } from '../src/web/lib/sse.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetSseHub();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client() {
  const res = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn> };
  res.write = vi.fn();
  cleanups.push(addSseClient(res as unknown as ServerResponse));
  return res;
}

describe('live price delivery', () => {
  it('publishes committed NAV/stock changes, without broadcasts for identical prices', () => {
    const db = new Database(':memory:');
    cleanups.push(() => db.close());
    runMigrations(db);
    const res = client();
    const fund = { symbol: 'RD66', source: 'kontan', priceIdr: 1611.84, asOf: '2026-11-11' };
    storePrices(db, [fund]);
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(res.write.mock.calls[0]![0]).toContain('"scopes":["price"]');
    res.write.mockClear();
    storePrices(db, [fund]);
    expect(res.write).not.toHaveBeenCalled();
    storePrices(db, [{ ...fund, priceIdr: 1612.10, asOf: '2026-11-12' }]);
    expect(res.write).toHaveBeenCalledTimes(1);
    res.write.mockClear();
    storePrices(db, [fund]);
    expect(res.write).not.toHaveBeenCalled();
    storePrices(db, [{ symbol: 'BACH.JK', source: 'yahoo', priceIdr: 216, asOf: '2026-11-13' }]);
    expect(res.write).toHaveBeenCalledTimes(1);
  });

  it('does not enter idle mode while a dashboard stays connected for over 30 minutes', () => {
    vi.useFakeTimers();
    const res = client();
    vi.advanceTimersByTime(35 * 60_000);
    expect(minutesSinceLastClient()).toBe(0);
    res.emit('close');
    expect(minutesSinceLastClient()).toBe(0);
    vi.advanceTimersByTime(31 * 60_000);
    expect(minutesSinceLastClient()).toBe(31);
  });

  it('refreshes cached values after reconnect even if no further price changes arrive', () => {
    vi.useFakeTimers();
    const doc = Object.assign(new EventTarget(), { hidden: false });
    const sources: FakeSource[] = [];
    class FakeSource extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(_url: string) { super(); sources.push(this); }
      close() {}
    }
    vi.stubGlobal('document', doc);
    vi.stubGlobal('EventSource', FakeSource);
    const sync = vi.fn();
    const portfolio = vi.fn();
    cleanups.push(connectSse({ onSync: sync, onPortfolio: portfolio }));
    sources[0]!.onopen!();
    expect(sync).toHaveBeenCalledTimes(1);
    sources[0]!.onerror!();
    vi.advanceTimersByTime(2000);
    expect(sources).toHaveLength(2);
    sources[1]!.onopen!();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith(['price', 'lp', 'solana', 'evm']);
    sources[1]!.dispatchEvent(new MessageEvent('portfolio:live', { data: JSON.stringify({ total_value_idr: 123 }) }));
    expect(portfolio).toHaveBeenCalledWith({ total_value_idr: 123 });
    expect(sync).toHaveBeenCalledTimes(2); // A streaming frame must not trigger HTTP refetches.
  });
});
