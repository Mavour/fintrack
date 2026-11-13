import cron from 'node-cron';
import type Database from 'better-sqlite3';
import { refreshCrypto, refreshStocks, type OrchestratorOpts } from '../providers/priceOrchestrator.js';
import { refreshLpPositions } from '../services/lpService.js';
import { backfillThinHistories } from '../providers/historyBackfill.js';
import { verifyMetMapping } from '../providers/coingecko.js';
import { recordWealthSnapshot } from '../services/dashboardService.js';
import { logger } from '../logger.js';
import { refreshMutualFunds } from '../providers/mutualFunds.js';

function scheduleSafe(expr: string, fallback: string): string {
  return cron.validate(expr) ? expr : fallback;
}

export function startScheduler(db: Database.Database, opts: OrchestratorOpts): void {
  // Recover the latest published NAV/close after downtime, including weekends.
  void refreshMutualFunds(db);
  void refreshStocks(db, opts);
  cron.schedule('*/15 * * * *', () => { void refreshMutualFunds(db); });
  // Crypto every 60s, single batched request per provider.
  cron.schedule('* * * * *', () => {
    refreshCrypto(db, opts).catch((e) => logger.error({ err: e }, 'crypto job failed'));
  });
  // Stocks every 5 min; the provider retains the actual trading date after close.
  cron.schedule('*/5 * * * *', () => {
    refreshStocks(db, opts).catch((e) => logger.error({ err: e }, 'stock job failed'));
  });
  // LP positions every 5 min (DeFi values move with the market).
  cron.schedule('*/5 * * * *', () => {
    refreshLpPositions(db).catch((e) => logger.error({ err: e }, 'LP job failed'));
  });
  // Wallet tracker: tier scheduler (15 dtk) adalah SATU-SATUNYA penulis wallet.
  // Cron legacy syncAllWallets dihapus agar tidak race DELETE/INSERT dengan tier
  // (interleave scope 'all' vs 'solana/evm/lp' bisa menghapus baris scope lain).
  // Snapshot kekayaan harian untuk trendline (02:05, setelah backup).
  cron.schedule('5 2 * * *', () => {
    try {
      recordWealthSnapshot(db);
    } catch (e) {
      logger.error({ err: e }, 'wealth snapshot failed');
    }
  });
  // Verify MET mapping once a day.
  cron.schedule('17 3 * * *', () => {
    verifyMetMapping(db, opts.coingeckoApiKey).then((id) => {
      if (id) logger.info({ id }, 'MET mapping verified');
    });
  });
  // All-time chart backfill daily for assets with thin history.
  cron.schedule('30 4 * * *', () => {
    backfillThinHistories(db)
      .then((r) => logger.info({ r }, 'history backfill done'))
      .catch((e) => logger.error({ err: e }, 'backfill job failed'));
  });
  logger.info('scheduler started');
}
