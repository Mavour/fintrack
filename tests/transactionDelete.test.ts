import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { registerTransactionRoutes } from '../src/server/routes/transactions.js';
import { createAccount } from '../src/server/services/accountService.js';
import { createTransaction, getTransaction } from '../src/server/services/transactionService.js';
import { api, clearApiSnapshots } from '../src/web/lib/api.js';

describe('transaction deletion through the web API client', () => {
  let app: ReturnType<typeof Fastify>;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(fs.readFileSync('src/server/db/schema.sql', 'utf8'));
    app = Fastify();
    registerTransactionRoutes(app, db);
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const response = await app.inject({
        method: init.method as 'DELETE', url,
        headers: init.headers as Record<string, string>, payload: init.body as string | undefined,
      });
      return new Response(response.body, { status: response.statusCode });
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    clearApiSnapshots();
    vi.unstubAllGlobals();
  });

  it.each(['expense', 'income', 'transfer'] as const)('deletes %s and restores account balances', async (kind) => {
    const from = createAccount(db, { name: 'Bank', type: 'bank', balance_idr: 100_000 });
    const to = createAccount(db, { name: 'Tunai', type: 'cash', balance_idr: 0 });
    const tx = createTransaction(db, {
      kind, amount_idr: 50_000, account_id: from.id,
      to_account_id: kind === 'transfer' ? to.id : null, category: 'Test', note: '',
    });

    await expect(api.del(`/api/transactions/${tx.id}`)).resolves.toEqual({ ok: true });
    expect(getTransaction(db, tx.id)).toBeUndefined();
    expect(db.prepare('SELECT balance_idr FROM accounts ORDER BY id').all()).toEqual([
      { balance_idr: 100_000 }, { balance_idr: 0 },
    ]);
  });
});
