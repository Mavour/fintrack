import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  upsertAsset,
  deleteAsset,
  UpsertAssetSchema,
  AssetTypeSchema,
  getUnifiedPortfolio,
  setCostBasis,
  deleteCostBasis,
} from '../services/portfolioService.js';

export function registerPortfolioRoutes(app: FastifyInstance, db: Database.Database): void {
  // Terpadu: aset manual (duplikat wallet disembunyikan total, token tanpa
  // harga atau < $1 tidak dikirim) + token wallet read-only (P/L hanya bila
  // cost_basis diisi). Token tersembunyi dihitung di hidden_tokens.
  app.get('/api/portfolio', async (req) => {
    const q = z.object({ type: AssetTypeSchema.optional(), show_all: z.coerce.boolean().optional() }).parse((req as { query: unknown }).query);
    const u = getUnifiedPortfolio(db, q.type);
    return {
      assets: u.assets,
      wallet_tokens: u.wallet_tokens,
      hidden_tokens: u.hidden_tokens,
      total_value_idr: u.total_value_idr,
      total_cost_idr: u.total_cost_idr,
      floating_pl_idr: u.floating_pl_idr,
      by_type: u.by_type,
      cost_basis: u.cost_basis,
      diversification_score: u.diversification_score,
      diversification_label: u.diversification_label,
    };
  });

  app.put('/api/portfolio', async (req, reply) => {
    try {
      return reply.code(201).send(upsertAsset(db, UpsertAssetSchema.parse(req.body)));
    } catch (e: unknown) {
      const err = e as { message?: string };
      return reply.code(400).send({ error: err.message ?? 'Invalid asset' });
    }
  });

  app.delete('/api/portfolio/:symbol', async (req: FastifyRequest<{ Params: { symbol: string } }>, reply) => {
    try {
      deleteAsset(db, req.params.symbol.toUpperCase());
      return { ok: true };
    } catch (e: unknown) {
      return reply.code(404).send({ error: 'Asset not found' });
    }
  });

  // Harga beli token wallet (diisi user; penggerak satu-satunya P/L wallet).
  app.put('/api/cost-basis', async (req, reply) => {
    try {
      const body = z.object({ symbol: z.string().min(1).max(40), buy_price_idr: z.number().int().min(0) }).parse(req.body);
      return reply.code(201).send(setCostBasis(db, body.symbol, body.buy_price_idr));
    } catch (e: unknown) {
      const err = e as { message?: string };
      return reply.code(400).send({ error: err.message ?? 'Invalid cost basis' });
    }
  });

  app.delete('/api/cost-basis/:symbol', async (req: FastifyRequest<{ Params: { symbol: string } }>, reply) => {
    try {
      deleteCostBasis(db, req.params.symbol);
      return { ok: true };
    } catch (e: unknown) {
      return reply.code(404).send({ error: 'Cost basis not found' });
    }
  });
}
