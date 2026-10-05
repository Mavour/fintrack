import 'dotenv/config';
import cron from 'node-cron';
import { buildApp } from './app.js';
import { logger } from './logger.js';
import { startScheduler } from './jobs/scheduler.js';
import { runBackup } from './jobs/backup.js';

const { app, db, config } = await buildApp();

startScheduler(db, {
  binanceEnabled: config.binanceEnabled,
  yahooEnabled: config.yahooEnabled,
  fxCacheTtlMs: config.fxCacheTtlMs,
  coingeckoApiKey: config.coingeckoApiKey,
});

// Daily backup at 02:00.
cron.schedule('0 2 * * *', () => {
  try {
    runBackup(db, config.backupDir, config.backupRetentionDays);
  } catch (e) {
    logger.error({ err: e }, 'backup failed');
  }
});

await app.listen({ port: config.port, host: config.host });
logger.info(`Dompet Saya listening on ${config.host}:${config.port}`);
