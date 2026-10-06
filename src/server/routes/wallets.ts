import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { previewHoldings, importHoldings, PreviewQuerySchema, ImportBodySchema } from '../services/walletService.js';
import { EVM_CHAINS } from '../providers/evm.js';

export function registerWalletRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/wallets/chains', async () => ({
    chains: [{ id: 'solana', label: 'Solana (Jupiter)' }, ...EVM_CHAINS.map((c) => ({ id: c, label: c }))],
  }));

  // Read-only preview — no writes except the shared token-metadata cache.
  app.get('/api/wallets/preview', async (req, reply) => {
    try {
      const q = PreviewQuerySchema.parse((req as { query: unknown }).query);
      return { holdings: await previewHoldings(db, q.chain, q.address) };
    } catch (e: unknown) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 400).send({ error: err.message ?? 'Pratinjau gagal' });
    }
  });

  app.post('/api/wallets/import', async (req, reply) => {
    try {
      const body = ImportBodySchema.parse(req.body);
      const imported = await importHoldings(db, body.chain, body.address, body.symbols);
      return { ok: true, imported, count: imported.length };
    } catch (e: unknown) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 400).send({ error: err.message ?? 'Impor gagal' });
    }
  });
}
