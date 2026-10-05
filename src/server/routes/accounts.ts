import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import {
  listAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  CreateAccountSchema,
  UpdateAccountSchema,
} from '../services/accountService.js';

export function registerAccountRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/accounts', async () => listAccounts(db));

  app.post('/api/accounts', async (req) => {
    return createAccount(db, CreateAccountSchema.parse(req.body));
  });

  app.patch('/api/accounts/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    return updateAccount(db, Number(req.params.id), UpdateAccountSchema.parse(req.body));
  });

  app.delete('/api/accounts/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    deleteAccount(db, Number(req.params.id));
    return { ok: true };
  });
}
