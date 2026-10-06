import type Database from 'better-sqlite3';
import { CoinGeckoProvider } from './coingecko.js';
import { BinanceProvider } from './binance.js';
import { JupiterPriceProvider } from './jupiterPrice.js';
import { DexScreenerPriceProvider } from './dexscreener.js';
import { GeckoTerminalPriceProvider } from './geckoterminal.js';
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
      for (const p of fb) got.add(p.symbol);
    }
    // Solana tokens by mint (Jupiter): covers memecoins CoinGecko doesn't list.
    const stillMissing = symbols.filter((s) => !got.has(s));
    if (stillMissing.length > 0) {
      const jup = new JupiterPriceProvider(db, fx);
      const jp = await jup.fetch(stillMissing);
      storePrices(db, jp);
      for (const p of jp) got.add(p.symbol);
    }
    // Long-tail Solana tokens (DexScreener pairs): last resort before cache.
    const restMissing = symbols.filter((s) => !got.has(s));
    if (restMissing.length > 0) {
      const dex = new DexScreenerPriceProvider(db, fx);
      const dp = await dex.fetch(restMissing);
      storePrices(db, dp);
      for (const p of dp) got.add(p.symbol);
    }
    // Dead/illiquid tokens that regain liquidity later (GeckoTerminal).
    const finalMissing = symbols.filter((s) => !got.has(s));
    if (finalMissing.length > 0) {
      const gt = new GeckoTerminalPriceProvider(db, fx);
      storePrices(db, await gt.fetch(finalMissing));
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
