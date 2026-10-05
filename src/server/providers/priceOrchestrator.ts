import type Database from 'better-sqlite3';
import { CoinGeckoProvider } from './coingecko.js';
import { BinanceProvider } from './binance.js';
import { YahooFinanceProvider, isMarketOpen } from './yahooFinance.js';
import { createFxRateProvider } from './fxRate.js';
import { storePrices } from './priceStore.js';
import { logger } from '../logger.js';

export interface OrchestratorOpts {
  binanceEnabled: boolean;
  yahooEnabled: boolean;
  fxCacheTtlMs: number;
  coingeckoApiKey: string;
}

export async function refreshCrypto(db: Database.Database, opts: OrchestratorOpts): Promise<void> {
  const symbols = (db.prepare(`SELECT symbol FROM assets WHERE type = 'crypto'`).all() as Array<{ symbol: string }>).map(
    (r) => r.symbol,
  );
  if (symbols.length === 0) return;
  const fx = createFxRateProvider(db, opts.fxCacheTtlMs);
  try {
    const primary = new CoinGeckoProvider(db, fx, opts.coingeckoApiKey);
    const prices = await primary.fetch(symbols);
    const got = new Set(prices.map((p) => p.symbol));
    storePrices(db, prices);
    const missing = symbols.filter((s) => !got.has(s));
    if (missing.length > 0 && opts.binanceEnabled) {
      const fallback = new BinanceProvider(fx);
      const fb = await fallback.fetch(missing);
      storePrices(db, fb);
    }
  } catch (e) {
    logger.warn({ err: e }, 'crypto refresh failed, keeping cache');
  }
}

export async function refreshStocks(db: Database.Database, opts: OrchestratorOpts): Promise<void> {
  if (!opts.yahooEnabled) return;
  if (!isMarketOpen()) {
    logger.info('market closed, skipping stock refresh');
    return;
  }
  const symbols = (db.prepare(`SELECT symbol FROM assets WHERE type = 'saham'`).all() as Array<{ symbol: string }>).map(
    (r) => r.symbol,
  );
  if (symbols.length === 0) return;
  try {
    const provider = new YahooFinanceProvider();
    const prices = await provider.fetch(symbols);
    storePrices(db, prices);
  } catch (e) {
    logger.warn({ err: e }, 'stock refresh failed, keeping cache');
  }
}
