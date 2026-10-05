import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  listValuations,
  upsertAsset,
  deleteAsset,
  UpsertAssetSchema,
  AssetTypeSchema,
  diversificationScore,
  diversificationLabel,
} from '../services/portfolioService.js';

export function registerPortfolioRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/portfolio', async (req) => {
    const q = z.object({ type: AssetTypeSchema.optional() }).parse((req as { query: unknown }).query);
    const vals = listValuations(db, q.type);
    const totalValue = vals.reduce((s, v) => s + (v.current_value_idr ?? 0), 0);
    const totalCost = vals.reduce((s, v) => s + v.cost_idr, 0);
    const score = diversificationScore(vals);
    return {
      assets: vals,
      total_value_idr: totalValue,
      total_cost_idr: totalCost,
      floating_pl_idr: totalValue - totalCost,
      diversification_score: score,
      diversification_label: diversificationLabel(score),
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
}
