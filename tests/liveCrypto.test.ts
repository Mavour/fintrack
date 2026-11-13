import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/server/db/database.js';
import { acceptLiveTrade, getLiveQuote, liveAssetId, resetLiveQuotes, startLiveCrypto } from '../src/server/services/liveCrypto.js';
import { getWalletTokens, listValuations, upsertAsset } from '../src/server/services/portfolioService.js';
const fallbackSocket = vi.hoisted(() => ({ created: vi.fn() }));
vi.mock('ws', () => ({ default: class {
  constructor(url: string) { fallbackSocket.created(url); }
  close() {}
  addEventListener() {}
} }));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  resetLiveQuotes();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const solMint = 'So11111111111111111111111111111111111111112';
const tick = (symbol: string, price: string, at = Date.now()) => ({ e: 'aggTrade', s: symbol, p: price, T: at });

describe('spot crypto streaming', () => {
  it('uses the ws client when the Node runtime has no native WebSocket', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', undefined);
    const stop = startLiveCrypto(); cleanups.push(stop);
    expect(fallbackSocket.created).toHaveBeenCalledWith(expect.stringContaining('wss://data-stream.binance.vision/stream?streams='));
    stop();
  });
  it('only maps explicit mint/contract identities, not impersonating tickers', () => {
    expect(liveAssetId('solana', { mint: solMint })).toBe('solana');
    expect(liveAssetId('solana', { mint: 'fake-sol', symbol: 'SOL' })).toBeNull();
    expect(liveAssetId('robinhood', { coingecko_id: 'ethereum', token_id: null })).toBe('ethereum');
    expect(liveAssetId('robinhood', { coingecko_id: 'ethereum', token_id: '0xfake' })).toBeNull();
    expect(liveAssetId('elysium', { coingecko_id: 'hyperliquid', token_id: null })).toBe('hyperliquid');
    expect(liveAssetId('solana', { mint: '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g', symbol: 'HYPE' })).toBeNull();
  });

  it('rejects invalid, stale, future, out-of-order and unsupported ticks', () => {
    const now = Date.now();
    expect(acceptLiveTrade(tick('SOLUSDT', '100', now), now)).toBe(true);
    for (const t of [tick('SOLUSDT', '0', now), tick('SOLUSDT', 'NaN', now), tick('FAKEUSDT', '100', now),
      tick('SOLUSDT', '200', now - 21000), tick('SOLUSDT', '200', now + 6000), tick('SOLUSDT', '200', now - 1)])
      expect(acceptLiveTrade(t, now)).toBe(false);
    expect(getLiveQuote('solana', now)?.price).toBe(100);
    expect(getLiveQuote('solana', now + 20001)).toBeNull();
  });

  it('updates wallet valuation and totals without altering balances or snapshot prices', () => {
    vi.useFakeTimers();
    const db = new Database(':memory:'); cleanups.push(() => db.close()); runMigrations(db);
    db.prepare("INSERT INTO wallets(id,address,network_type) VALUES (1,'test','solana')").run();
    db.prepare("INSERT INTO fx_cache(pair,rate) VALUES ('USDIDR',16000)").run();
    const insert = db.prepare("INSERT INTO wallet_positions(wallet_id,chain_id,kind,symbol,amount,price_usd,value_usd,meta) VALUES (1,'solana','token','SOL','2',50,100,?)");
    insert.run(JSON.stringify({ mint: solMint }));
    acceptLiveTrade(tick('SOLUSDT', '100'));
    expect(getWalletTokens(db).tokens[0]).toMatchObject({ amount: '2', value_usd: 200, value_idr: 3200000, price_mode: 'stream' });
    expect(db.prepare('SELECT amount,price_usd,value_usd FROM wallet_positions').get()).toEqual({ amount: '2', price_usd: 50, value_usd: 100 });
    // A later balance sync still values the latest amount at the streaming price.
    db.prepare("UPDATE wallet_positions SET amount='3',value_usd=150").run();
    expect(getWalletTokens(db).tokens[0]).toMatchObject({ amount: '3', value_usd: 300, price_mode: 'stream' });
    vi.advanceTimersByTime(21000);
    expect(getWalletTokens(db).tokens[0]).toMatchObject({ value_usd: 150, price_mode: 'periodic' });
  });

  it('streams manual crypto through verified mappings while retaining cost basis', () => {
    const db = new Database(':memory:'); cleanups.push(() => db.close()); runMigrations(db);
    db.prepare("INSERT INTO fx_cache(pair,rate) VALUES ('USDIDR',16000)").run();
    upsertAsset(db, { type: 'crypto', symbol: 'SOL', name: 'Solana', qty: '2', avg_buy_price_idr: 1000000 });
    acceptLiveTrade(tick('SOLUSDT', '100'));
    expect(listValuations(db)[0]).toMatchObject({ current_value_idr: 3200000, pl_idr: 1200000, price_mode: 'stream', price_source: 'binance-stream-usdt' });
    upsertAsset(db, { type: 'crypto', symbol: 'SOL', name: 'Different token', qty: '2', avg_buy_price_idr: 1000000, chain: 'solana', mint: 'fake-sol' });
    expect(listValuations(db)[0]!.price_mode).toBe('periodic');
  });

  it('reconnects with bounded backoff and clears streaming prices after disconnect', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      handlers = new Map<string, (event: {data?: unknown}) => void>();
      close = vi.fn();
      constructor(public url: string) { sockets.push(this); }
      addEventListener(name: string, fn: (event: {data?: unknown}) => void) { this.handlers.set(name, fn); }
      fire(name: string, data?: unknown) { this.handlers.get(name)?.({ data }); }
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    const publish = vi.fn();
    const stop = startLiveCrypto(publish); cleanups.push(stop);
    expect(sockets[0]!.url).toContain('wss://data-stream.binance.vision/stream?streams=');
    sockets[0]!.fire('message', JSON.stringify({ data: tick('SOLUSDT', '100') }));
    expect(getLiveQuote('solana')?.price).toBe(100);
    sockets[0]!.fire('message', JSON.stringify({ data: tick('SOLUSDT', '101') }));
    vi.advanceTimersByTime(1000);
    expect(publish).toHaveBeenCalledTimes(1);
    sockets[0]!.fire('error');
    expect(getLiveQuote('solana')).toBeNull();
    sockets[0]!.fire('close');
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    stop();
    vi.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(2);
  });
});
