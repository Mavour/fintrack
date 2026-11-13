import 'dotenv/config';
import cron from 'node-cron';
import { buildApp } from './app.js';
import { logger } from './logger.js';
import { startScheduler } from './jobs/scheduler.js';
import { startTierScheduler, stopTierScheduler } from './services/tierScheduler.js';
import { closeDatabase } from './db/database.js';
import { runBackup } from './jobs/backup.js';
import { recordWealthSnapshot } from './services/dashboardService.js';
import { readDormApiOptions, startDormApi } from './dormApi.js';
import { startLiveCrypto } from './services/liveCrypto.js';
import { getUnifiedPortfolio } from './services/portfolioService.js';
import { emitLivePortfolio, sseClientCount } from './services/sse.js';

// Backend tahan banting: logging terstruktur + graceful shutdown (PM2 auto-restart).
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException — shutting down');
  shutdown(1);
});

const { app, db, config } = await buildApp();
const stopLiveCrypto = startLiveCrypto(() => {
  if (sseClientCount() > 0) emitLivePortfolio(getUnifiedPortfolio(db, undefined, { readOnly: true }));
});

// Titik pertama tren kekayaan hari ini (idempoten per hari, best-effort).
try {
  recordWealthSnapshot(db);
} catch {
  // Abaikan — scheduler harian mengisi juga.
}

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

let dormApi: Awaited<ReturnType<typeof startDormApi>> | undefined;
try {
  const options = readDormApiOptions();
  if (options.enabled) {
    dormApi = await startDormApi(config.databasePath, options);
    dormApi.server.on('error', () => logger.error('Agent Dorm status API server error'));
    logger.info({ host: options.host, port: options.port }, 'Agent Dorm read-only status API listening');
  }
} catch {
  logger.error('Agent Dorm status API unavailable; check STATUS_API configuration. Fintrack continues.');
}

let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    stopTierScheduler();
    stopLiveCrypto();
    cron.getTasks().forEach((t) => t.stop());
  } catch {
    // Best-effort.
  }
  void Promise.allSettled([app.close(), dormApi?.close()]).finally(() => {
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
