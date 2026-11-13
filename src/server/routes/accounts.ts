import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  listAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  CreateAccountSchema,
  UpdateAccountSchema,
} from '../services/accountService.js';

const IdParam = z.object({ id: z.coerce.number().int().positive() });

export function registerAccountRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/accounts', async () => listAccounts(db));

  app.post('/api/accounts', async (req) => {
    return createAccount(db, CreateAccountSchema.parse(req.body));
  });

  app.patch('/api/accounts/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const params = IdParam.parse(req.params);
    return updateAccount(db, params.id, UpdateAccountSchema.parse(req.body));
  });

  app.delete('/api/accounts/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const params = IdParam.parse(req.params);
    deleteAccount(db, params.id);
    return { ok: true };
  });
}
