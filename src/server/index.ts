import 'dotenv/config';
import cron from 'node-cron';
import { buildApp } from './app.js';
import { logger } from './logger.js';
import { startScheduler } from './jobs/scheduler.js';
import { startTierScheduler, stopTierScheduler } from './services/tierScheduler.js';
import { closeDatabase } from './db/database.js';
import { runBackup } from './jobs/backup.js';

// Backend tahan banting: logging terstruktur + graceful shutdown (PM2 auto-restart).
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException — shutting down');
  shutdown(1);
});

const { app, db, config } = await buildApp();

startScheduler(db, {
  binanceEnabled: config.binanceEnabled,
  yahooEnabled: config.yahooEnabled,
  fxCacheTtlMs: config.fxCacheTtlMs,
  coingeckoApiKey: config.coingeckoApiKey,
});

// Tiered wallet sync: price / lp / solana / evm (near-real-time, min 10 dtk).
startTierScheduler(db, {
  priceSec: config.priceRefreshSec,
  lpSec: config.lpRefreshSec,
  solSec: config.solRefreshSec,
  evmSec: config.evmRefreshSec,
  debankBudget: config.debankDailyUnitBudget,
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

let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    stopTierScheduler();
    cron.getTasks().forEach((t) => t.stop());
  } catch {
    // Best-effort.
  }
  void app.close().finally(() => {
    try {
      closeDatabase();
    } catch {
      // Best-effort.
    }
    process.exit(code);
  });
  // Paksa keluar bila close menggantung.
  setTimeout(() => process.exit(code), 5000).unref();
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
