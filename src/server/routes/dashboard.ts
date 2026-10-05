import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getDashboard } from '../services/dashboardService.js';
import { getPrices, getHistory } from '../providers/priceStore.js';
import { refreshCrypto, refreshStocks } from '../providers/priceOrchestrator.js';
import type { OrchestratorOpts } from '../providers/priceOrchestrator.js';

export function registerDashboardRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/dashboard', async (req) => {
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(
      (req as { query: unknown }).query,
    );
    return getDashboard(db, q.month);
  });

  app.get('/api/prices', async (req) => {
    const q = z.object({ symbols: z.string().optional() }).parse((req as { query: unknown }).query);
    const symbols = q.symbols ? q.symbols.split(',').map((s) => s.trim().toUpperCase()) : undefined;
    return getPrices(db, symbols);
  });

  app.get('/api/prices/history', async (req, reply) => {
    const q = z.object({ symbol: z.string().min(1) }).parse((req as { query: unknown }).query);
    return getHistory(db, q.symbol.toUpperCase());
  });

  app.post('/api/prices/refresh', async (_req, _reply, opts?: { orchestrator?: OrchestratorOpts }) => {
    // Manual "Sinkron Ulang" button.
    const o = (opts?.orchestrator ?? {
      binanceEnabled: true,
      yahooEnabled: true,
      fxCacheTtlMs: 3_600_000,
      coingeckoApiKey: '',
    }) as OrchestratorOpts;
    await refreshCrypto(db, o);
    await refreshStocks(db, o);
    return { ok: true, prices: getPrices(db) };
  });
}
