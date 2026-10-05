import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  listTransactions,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  CreateTxSchema,
  UpdateTxSchema,
  TxKindSchema,
} from '../services/transactionService.js';

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  kind: TxKindSchema.optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

export function registerTransactionRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/transactions', async (req) => {
    const q = ListQuery.parse((req as { query: unknown }).query);
    return listTransactions(db, q);
  });

  app.post('/api/transactions', async (req, reply) => {
    try {
      return reply.code(201).send(createTransaction(db, CreateTxSchema.parse(req.body)));
    } catch (e: unknown) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 400).send({ error: err.message ?? 'Invalid transaction' });
    }
  });

  app.patch('/api/transactions/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      return updateTransaction(db, Number(req.params.id), UpdateTxSchema.parse(req.body));
    } catch (e: unknown) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 400).send({ error: err.message ?? 'Update failed' });
    }
  });

  app.delete('/api/transactions/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      deleteTransaction(db, Number(req.params.id));
      return { ok: true };
    } catch (e: unknown) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 400).send({ error: err.message ?? 'Delete failed' });
    }
  });
}
