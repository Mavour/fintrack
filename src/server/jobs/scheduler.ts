import cron from 'node-cron';
import type Database from 'better-sqlite3';
import { refreshCrypto, refreshStocks, type OrchestratorOpts } from '../providers/priceOrchestrator.js';
import { refreshLpPositions } from '../services/lpService.js';
import { backfillThinHistories } from '../providers/historyBackfill.js';
import { verifyMetMapping } from '../providers/coingecko.js';
import { logger } from '../logger.js';

export function startScheduler(db: Database.Database, opts: OrchestratorOpts): void {
  // Crypto every 60s, single batched request per provider.
  cron.schedule('* * * * *', () => {
    refreshCrypto(db, opts).catch((e) => logger.error({ err: e }, 'crypto job failed'));
  });
  // Stocks every 5 min (provider itself checks market hours).
  cron.schedule('*/5 * * * *', () => {
    refreshStocks(db, opts).catch((e) => logger.error({ err: e }, 'stock job failed'));
  });
  // LP positions every 5 min (DeFi values move with the market).
  cron.schedule('*/5 * * * *', () => {
    refreshLpPositions(db).catch((e) => logger.error({ err: e }, 'LP job failed'));
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
