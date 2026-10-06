import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { previewHoldings, importHoldings, PreviewQuerySchema, ImportBodySchema } from '../services/walletService.js';
import { EVM_CHAINS } from '../providers/evm.js';
import { getConfig } from '../config.js';

const LABELS: Record<string, string> = {
  solana: 'Solana (Jupiter)',
  eth: 'Ethereum',
  arb: 'Arbitrum',
  base: 'Base',
  op: 'Optimism',
  polygon: 'Polygon',
  hoodi: 'Hoodi Testnet',
};

export function registerWalletRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/wallets/chains', async () => {
    const keyless = new Set(['solana', ...EVM_CHAINS]);
    return {
      chains: ['solana', ...EVM_CHAINS, 'hoodi'].map((id) => ({
        id,
        label: LABELS[id] ?? id,
        needs_key: !keyless.has(id),
      })),
      etherscan_configured: getConfig().etherscanApiKey.length > 0,
    };
  });

  // Read-only preview — no writes except the shared token-metadata cache.
  app.get('/api/wallets/preview', async (req, reply) => {
    try {
      const q = PreviewQuerySchema.parse((req as { query: unknown }).query);
      return { holdings: await previewHoldings(db, q.chain, q.address, getConfig().etherscanApiKey) };
    } catch (e: unknown) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 400).send({ error: err.message ?? 'Pratinjau gagal' });
    }
  });

  app.post('/api/wallets/import', async (req, reply) => {
    try {
      const body = ImportBodySchema.parse(req.body);
      const imported = await importHoldings(db, body.chain, body.address, body.symbols, getConfig().etherscanApiKey);
      return { ok: true, imported, count: imported.length };
    } catch (e: unknown) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 400).send({ error: err.message ?? 'Impor gagal' });
    }
  });
}
