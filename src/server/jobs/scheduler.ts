import cron from 'node-cron';
import type Database from 'better-sqlite3';
import { refreshCrypto, refreshStocks, type OrchestratorOpts } from '../providers/priceOrchestrator.js';
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
  // Verify MET mapping once a day.
  cron.schedule('17 3 * * *', () => {
    verifyMetMapping(db, opts.coingeckoApiKey).then((id) => {
      if (id) logger.info({ id }, 'MET mapping verified');
    });
  });
  logger.info('scheduler started');
}
