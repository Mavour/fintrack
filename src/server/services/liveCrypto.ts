import { emitSyncDone } from './sse.js';
import { logger } from '../logger.js';
import WebSocketClient from 'ws';

const PAIRS: Record<string, string> = { SOLUSDT: 'solana', ETHUSDT: 'ethereum', HYPEUSDT: 'hyperliquid', METUSDT: 'meteora' };
const MINTS: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'solana',
  METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL: 'meteora',
};
const TTL_MS = 20_000;
export interface LiveQuote { price: number; at: number; source: 'binance-stream-usdt' }
const quotes = new Map<string, LiveQuote>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let notifyPrices = () => emitSyncDone(['price']);

/** Resolve by chain + mint/contract, never by a wallet token's ticker. */
export function liveAssetId(chain: string, meta: Record<string, unknown>): string | null {
  if (chain === 'solana' && typeof meta.mint === 'string') return MINTS[meta.mint] ?? null;
  const contract = typeof meta.token_id === 'string' ? meta.token_id.toLowerCase() : null;
  if (chain === 'eth' && contract === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2') return 'ethereum';
  if (!contract && chain === 'robinhood' && meta.coingecko_id === 'ethereum') return 'ethereum';
  if (!contract && chain === 'elysium' && meta.coingecko_id === 'hyperliquid') return 'hyperliquid';
  return null;
}

export function getLiveQuote(assetId: string | null, now = Date.now()): LiveQuote | null {
  const quote = assetId ? quotes.get(assetId) : undefined;
  return quote && now - quote.at <= TTL_MS && quote.at <= now + 5000 ? quote : null;
}

export function acceptLiveTrade(payload: unknown, now = Date.now()): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (p.e !== 'aggTrade' || typeof p.s !== 'string' || !PAIRS[p.s] || typeof p.T !== 'number') return false;
  const price = typeof p.p === 'string' ? Number(p.p) : NaN;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(p.T) || p.T < now - TTL_MS || p.T > now + 5000) return false;
  const id = PAIRS[p.s]!;
  const previous = quotes.get(id);
  if (previous && p.T < previous.at) return false;
  quotes.set(id, { price, at: p.T, source: 'binance-stream-usdt' });
  // Coalesce rapid trades into one UI notification per second.
  if (!notifyTimer) notifyTimer = setTimeout(() => { notifyTimer = null; notifyPrices(); }, 1000);
  return true;
}

interface Socket {
  close(): void;
  addEventListener(name: string, handler: (event: { data?: unknown }) => void): void;
}

/** One public market-data connection; no wallet addresses or credentials are sent. */
export function startLiveCrypto(onPrices?: () => void): () => void {
  notifyPrices = onPrices ?? (() => emitSyncDone(['price']));
  const NativeSocket = (globalThis as unknown as { WebSocket?: new (url: string) => Socket }).WebSocket;
  const SocketClient = NativeSocket ?? (WebSocketClient as unknown as new (url: string) => Socket);
  if (!NativeSocket) logger.info('crypto streaming using ws client (native WebSocket unavailable)');
  let socket: Socket | null = null;
  let reconnect: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let failures = 0;
  const connect = () => {
    if (stopped) return;
    let lastMessage = Date.now();
    let failed = false;
    const retry = () => {
      if (failed || stopped) return;
      failed = true;
      if (watchdog) clearInterval(watchdog);
      socket?.close();
      quotes.clear();
      notifyPrices();
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
      reconnect = setTimeout(connect, delay);
      logger.warn({ delay }, 'crypto stream disconnected; REST fallback active');
    };
    try {
      const streams = Object.keys(PAIRS).map((pair) => `${pair.toLowerCase()}@aggTrade`).join('/');
      socket = new SocketClient(`wss://data-stream.binance.vision/stream?streams=${streams}`);
      socket.addEventListener('open', () => { logger.info('crypto spot stream connected'); });
      socket.addEventListener('message', (event) => {
        if (failed || stopped || typeof event.data !== 'string') return;
        try {
          const json = JSON.parse(event.data) as { data?: unknown };
          if (acceptLiveTrade(json.data)) { lastMessage = Date.now(); failures = 0; }
        } catch { /* Malformed ticks never replace a valid quote. */ }
      });
      socket.addEventListener('error', retry);
      socket.addEventListener('close', retry);
      watchdog = setInterval(() => { if (Date.now() - lastMessage > 30_000) retry(); }, 5000);
    } catch { retry(); }
  };
  connect();
  return () => {
    stopped = true;
    if (reconnect) clearTimeout(reconnect);
    if (watchdog) clearInterval(watchdog);
    if (notifyTimer) clearTimeout(notifyTimer);
    notifyTimer = null;
    socket?.close();
    quotes.clear();
  };
}

export function resetLiveQuotes(): void {
  notifyPrices = () => emitSyncDone(['price']);
  quotes.clear();
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = null;
}
