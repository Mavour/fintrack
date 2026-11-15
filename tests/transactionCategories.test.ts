import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../src/server/db/database.js';
import { registerTransactionRoutes } from '../src/server/routes/transactions.js';
import { createAccount } from '../src/server/services/accountService.js';
import { createTransaction } from '../src/server/services/transactionService.js';
import { catOptions, txForm } from '../src/web/components/modal.js';

describe('saved transaction categories', () => {
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fintrack-categories-'));
    db = new Database(path.join(dir, 'test.db'));
    runMigrations(db);
    app = Fastify();
    registerTransactionRoutes(app, db);
  });
  afterEach(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = '/api/transactions/categories';

  it('keeps expense and income categories separate without creating a transaction', async () => {
    for (const payload of [{ kind: 'expense', name: 'Servis Motor' }, { kind: 'income', name: 'Freelance' }]) {
      const response = await app.inject({ method: 'POST', url, payload });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual(payload);
    }
    expect((await app.inject(url)).json()).toEqual({ expense: ['Servis Motor'], income: ['Freelance'] });
    expect(db.prepare('SELECT * FROM transactions').all()).toEqual([]);
  });

  it('trims names and reuses duplicates, while allowing the same name for both kinds', async () => {
    for (const name of ['  Usaha  ', 'usaha']) {
      const response = await app.inject({ method: 'POST', url, payload: { kind: 'income', name } });
      expect(response.json()).toEqual({ kind: 'income', name: 'Usaha' });
    }
    await app.inject({ method: 'POST', url, payload: { kind: 'expense', name: 'Usaha' } });
    expect((await app.inject(url)).json()).toEqual({ expense: ['Usaha'], income: ['Usaha'] });
  });

  it.each([
    { kind: 'expense', name: '   ' },
    { kind: 'income', name: 'a'.repeat(61) },
    { kind: 'transfer', name: 'Tidak didukung' },
  ])('rejects invalid category %j', async (payload) => {
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(400);
    expect((await app.inject(url)).json()).toEqual({ expense: [], income: [] });
  });

  it('includes categories already used by older transactions', async () => {
    const account = createAccount(db, { name: 'Bank', type: 'bank', balance_idr: 100_000 });
    createTransaction(db, { kind: 'expense', category: 'Kategori Lama', amount_idr: 1000, account_id: account.id, note: '' });
    expect((await app.inject(url)).json()).toEqual({ expense: ['Kategori Lama'], income: [] });
  });

  it('persists independently of transactions and survives repeated startup migrations', async () => {
    await app.inject({ method: 'POST', url, payload: { kind: 'income', name: 'Komisi' } });
    await app.close();
    db.close();
    db = new Database(path.join(dir, 'test.db'));
    runMigrations(db);
    runMigrations(db);
    app = Fastify();
    registerTransactionRoutes(app, db);
    expect((await app.inject(url)).json()).toEqual({ expense: [], income: ['Komisi'] });
  });
});

describe('category form options', () => {
  it('keeps presets, escapes names, and selects a custom category when editing', () => {
    const html = catOptions('expense', ['makan', '<Servis & Motor>'], '<Servis & Motor>');
    expect(html).toContain('<option selected>&lt;Servis &amp; Motor&gt;</option>');
    expect(html.match(/<option>makan<\/option>/g)).toHaveLength(1);
    expect(html).toContain('<option>Transport</option>');
    expect(html).not.toContain('<option>Gaji</option>');
    const form = txForm([], 'income', { category: 'Komisi', lockKind: true });
    expect(form).toContain('<option selected>Komisi</option>');
    expect(form).toContain('id="f-cat-add"');
    expect(txForm([], 'transfer')).toContain('id="f-cat-controls" hidden');
  });
});
