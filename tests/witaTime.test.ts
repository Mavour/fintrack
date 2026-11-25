import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { toWitaInput, fromWitaInput, witaMonth } from '../src/shared/time.js';
import { fmtDate, fmtTransactionDate, todayLong } from '../src/web/lib/format.js';
import { occurredAtField, readOccurredAt, txForm } from '../src/web/components/modal.js';
import { createAccount } from '../src/server/services/accountService.js';
import { createTransaction, listTransactions, updateTransaction } from '../src/server/services/transactionService.js';
import { getDashboard } from '../src/server/services/dashboardService.js';
import { runMigrations } from '../src/server/db/database.js';
import { logger } from '../src/server/logger.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('WITA transaction times', () => {
  it.each(['UTC', 'Asia/Jakarta', 'America/Los_Angeles'])('uses WITA even when the device timezone is %s', (tz) => {
    vi.stubEnv('TZ', tz);
    expect(toWitaInput('2026-11-15T02:44:00.000Z')).toBe('2026-11-15T10:44');
    expect(fmtTransactionDate('2026-11-15T02:44:00.000Z')).toBe('15 Nov 2026 • 10:44 WITA');
    expect(fromWitaInput('2026-11-15T10:44')).toBe('2026-11-15T02:44:00.000Z');
    expect(toWitaInput('2026-11-15 02:44:00')).toBe('2026-11-15T10:44');
    expect(toWitaInput('2026-11-15T10:44:00+08:00')).toBe('2026-11-15T10:44');
  });

  it('converts the date at midnight and preserves date-only values', () => {
    expect(fmtTransactionDate('2026-10-31T16:00:00Z')).toBe('1 Nov 2026 • 00:00 WITA');
    expect(witaMonth('2026-10-31T16:00:00Z')).toBe('2026-11');
    expect(witaMonth('2026-10-31T15:59:00Z')).toBe('2026-10');
    expect(fmtDate('2026-10-31')).toBe('31 Okt 2026');
    expect(toWitaInput('2026-10-31')).toBe('2026-10-31T00:00');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-31T16:00:00Z'));
    expect(todayLong()).toBe('Minggu, 1 November 2026');
    expect(witaMonth()).toBe('2026-11');
  });

  it('prefills editing in WITA and saves the same instant back to UTC', () => {
    const form = txForm([], 'expense', { occurred_at: '2026-11-15T02:44:00Z' });
    expect(form).toContain('Tanggal &amp; waktu (WITA)');
    expect(form).toContain('value="2026-11-15T10:44"');
    const body = { querySelector: () => ({ value: '2026-11-15T10:44' }) } as unknown as HTMLElement;
    expect(readOccurredAt(body)).toBe('2026-11-15T02:44:00.000Z');
  });

  it('uses the current WITA day and time when the shared date field is left blank', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-31T16:05:00Z'));
    expect(occurredAtField()).toContain('type="datetime-local" value=""');
    const body = { querySelector: () => ({ value: '' }) } as unknown as HTMLElement;
    const saved = readOccurredAt(body);
    expect(saved).toBe('2026-10-31T16:05:00.000Z');
    expect(fmtTransactionDate(saved)).toBe('1 Nov 2026 • 00:05 WITA');
  });

  it('uses the WITA month for transaction filters and dashboard totals at month boundaries', () => {
    const db = new Database(':memory:');
    try {
      db.exec(fs.readFileSync('src/server/db/schema.sql', 'utf8'));
      const a = createAccount(db, { name: 'Bank', type: 'bank', balance_idr: 1000 });
      const insert = (kind: 'income' | 'expense', amount: number, at: string) => createTransaction(db, {
        kind, amount_idr: amount, account_id: a.id, category: 'Test', note: '', occurred_at: at,
      });
      const october = insert('expense', 10, '2026-10-31T15:59:00Z');
      const november = insert('expense', 20, '2026-11-01T00:00:00+08:00');
      expect(november.occurred_at).toBe('2026-10-31T16:00:00.000Z');
      const income = insert('income', 30, '2026-10-31 17:00:00');
      expect(listTransactions(db, { month: '2026-10' }).map((t) => t.id)).toEqual([october.id]);
      expect(listTransactions(db, { month: '2026-11' }).map((t) => t.id).sort()).toEqual([november.id, income.id].sort());
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-31T17:00:00Z'));
      expect(getDashboard(db)).toMatchObject({
        expense_this_month_idr: 20, income_this_month_idr: 30,
        expense_by_category: [{ category: 'Test', total_idr: 20 }],
      });
    } finally { db.close(); }
  });

  it('rejects invalid creates and edits and reports invalid legacy dates without changing balances', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const account = createAccount(db, { name: 'Bank', type: 'bank', balance_idr: 1000 });
      const expense = { kind: 'expense' as const, amount_idr: 100, account_id: account.id, category: 'Test', note: '' };
      expect(() => createTransaction(db, { ...expense, occurred_at: 'bukan-tanggal' })).toThrow();
      const valid = createTransaction(db, { ...expense, occurred_at: '2026-11-01' });
      expect(() => updateTransaction(db, valid.id, { amount_idr: 300, occurred_at: '2026-02-30' })).toThrow();
      db.prepare('UPDATE transactions SET occurred_at = ? WHERE id = ?').run('2026-10-31 16:00:00', valid.id);
      const legacy = db.prepare("INSERT INTO transactions (kind, amount_idr, account_id, occurred_at) VALUES ('expense', 10, ?, 'rusak')").run(account.id);
      runMigrations(db);
      expect(warn).toHaveBeenCalledWith({ transactionIds: [Number(legacy.lastInsertRowid)] }, expect.any(String));
      expect(listTransactions(db, { month: '2026-11' })).toMatchObject([{ id: valid.id, occurred_at: '2026-10-31T16:00:00.000Z' }]);
      expect(db.prepare('SELECT balance_idr FROM accounts').pluck().get()).toBe(900);
    } finally { db.close(); }
  });
});
