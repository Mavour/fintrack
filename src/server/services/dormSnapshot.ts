import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { getUnifiedPortfolio } from './portfolioService.js';

export interface DormSnapshotOptions {
  dayTimeZone: string;
  monthlyBudgetIdr: number | null;
  fxMaxAgeSec: number;
  now?: number;
}

function utc(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : value.replace(' ', 'T') + 'Z';
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function shifted(day: string, days: number): string {
  const date = new Date(day + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

type TxRow = { id: number; kind: 'income' | 'expense'; amount_idr: number; category: string; note: string; occurred_at: string };
type Kind = 'cash' | 'stable' | 'lp' | 'spot';

/** SELECT-only snapshot. No migrations, sync, FX fetch, seeding, or bookkeeping. */
export function readDormSnapshot(db: Database.Database, options: DormSnapshotOptions) {
  return db.transaction(() => {
    const now = options.now ?? Date.now();
    const ts = new Date(now).toISOString();
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: options.dayTimeZone });
    const today = formatter.format(new Date(now));
    const weekStart = shifted(today, -6);
    const monthStart = today.slice(0, 7) + '-01';
    const thirtyStart = shifted(today, -29);
    const since = shifted(monthStart < thirtyStart ? monthStart : thirtyStart, -2) + 'T00:00:00.000Z';
    const alerts: Array<{ id: string; level: 'info' | 'warn'; message: string; ts: string }> = [];
    const warn = (id: string, message: string) => alerts.push({ id, level: 'warn', message, ts });
    const fxRow = db.prepare("SELECT rate, fetched_at FROM fx_cache WHERE pair = 'USDIDR'").get() as
      { rate: number; fetched_at: string } | undefined;
    const fxAt = utc(fxRow?.fetched_at);
    const fx = fxRow && Number.isFinite(fxRow.rate) && fxRow.rate > 0 && fxAt &&
      now >= Date.parse(fxAt) && now - Date.parse(fxAt) <= options.fxMaxAgeSec * 1000 ? fxRow.rate : null;
    if (!fx) warn('fx-unavailable', 'Kurs USD/IDR belum tersedia atau basi; nilai USD tidak ditebak');
    const toUsd = (idr: number | null): number | null => idr === null ? null : idr === 0 ? 0 : fx ? new Decimal(idr).div(fx).toDecimalPlaces(2).toNumber() : null;
    const sum = (values: Array<number | null>) => values.some(v => v === null) ? null : values.reduce<number>((s, v) => s + (v ?? 0), 0);
    const round = (n: number | null) => n === null ? null : new Decimal(n).toDecimalPlaces(2).toNumber();
    const cash = db.prepare('SELECT COALESCE(SUM(balance_idr), 0) AS value FROM accounts WHERE is_active = 1').get() as { value: number };
    const portfolio = getUnifiedPortfolio(db, undefined, { readOnly: true });
    const buckets: Record<Kind, Array<number | null>> = { cash: [toUsd(cash.value)], stable: [], lp: [], spot: [] };
    const stable = new Set(['USDC', 'USDT', 'DAI', 'USDS', 'USD1', 'PYUSD', 'FDUSD']);
    for (const asset of portfolio.assets) {
      const kind = asset.symbol.startsWith('LP-') ? 'lp' : asset.type === 'crypto' && stable.has(asset.symbol.toUpperCase()) ? 'stable' : 'spot';
      buckets[kind].push(toUsd(asset.current_value_idr));
    }
    for (const token of portfolio.wallet_tokens) buckets[stable.has(token.symbol.toUpperCase()) ? 'stable' : 'spot'].push(token.value_usd);
    for (const defi of portfolio.wallet_defi) buckets.spot.push(defi.value_usd);
    const lp = db.prepare(`SELECT COUNT(*) AS count, SUM(COALESCE(position_value_usd,0) + COALESCE(unclaimed_fees_usd,0)) AS value,
      SUM(CASE WHEN position_value_usd IS NULL OR unclaimed_fees_usd IS NULL THEN 1 ELSE 0 END) AS unknown_count FROM lp_positions`).get() as { count: number; value: number | null; unknown_count: number | null };
    buckets.lp.push(lp.value ?? 0);
    const unknownWallet = db.prepare("SELECT COUNT(*) AS count FROM wallet_positions WHERE kind IN ('token','staking','defi') AND value_usd IS NULL AND CAST(amount AS REAL) > 0").get() as { count: number };
    const unknownCount = portfolio.unpriced_manual_assets + unknownWallet.count + (lp.unknown_count ?? 0);
    if (unknownCount) warn('valuation-incomplete', 'Sebagian aset belum mempunyai valuasi lengkap; total yang diketahui hanya subtotal');
    if (portfolio.assets.some(a => !utc(a.price_fetched_at) || now - Date.parse(utc(a.price_fetched_at)!) > 15 * 60_000)) warn('manual-prices-stale', 'Sebagian harga aset manual sudah basi');
    const sync = db.prepare('SELECT last_success_at, last_error FROM sync_status').all() as Array<{ last_success_at: string | null; last_error: string | null }>;
    if (sync.some(s => s.last_error)) warn('sync-errors', 'Sebagian sinkronisasi fintrack bermasalah; memakai cache tersimpan');
    const oldestWallet = db.prepare('SELECT MIN(datetime(synced_at)) AS at FROM wallet_positions').get() as { at: string | null };
    const oldestLp = db.prepare('SELECT MIN(datetime(synced_at)) AS at FROM lp_positions').get() as { at: string | null };
    if ([oldestWallet.at, oldestLp.at].some(v => v && (!utc(v) || now - Date.parse(utc(v)!) > 15 * 60_000))) {
      warn('wallet-data-stale', 'Sebagian valuasi wallet/LP lebih tua dari 15 menit');
    }
    const labels: Record<Kind, string> = { cash: 'Kas dan rekening', stable: 'Stablecoin', lp: 'Likuiditas LP', spot: 'Aset investasi' };
    const accounts = (Object.keys(buckets) as Kind[]).map(type => ({ id: `fintrack-${type}`, label: labels[type], type, valueUsd: round(sum(buckets[type])) }));
    const knownUsd = round(sum(accounts.map(a => a.valueUsd)));
    const knownIdr = cash.value + portfolio.total_value_idr;
    const rows = db.prepare(`SELECT id, kind, amount_idr, category, note, occurred_at FROM transactions
      WHERE kind IN ('income','expense') AND julianday(occurred_at) >= julianday(?) AND julianday(occurred_at) <= julianday(?)
      ORDER BY julianday(occurred_at) DESC, id DESC`).all(since, ts) as TxRow[];
    const cashflowIdr = { todayIncomeIdr: 0, todayExpenseIdr: 0, last7dIncomeIdr: 0, last7dExpenseIdr: 0, last30dIncomeIdr: 0, last30dExpenseIdr: 0 };
    let monthSpentIdr = 0;
    for (const tx of rows) {
      const at = utc(tx.occurred_at);
      if (!at || Date.parse(at) > now) continue;
      const day = formatter.format(new Date(at));
      const income = tx.kind === 'income';
      if (day === today) cashflowIdr[income ? 'todayIncomeIdr' : 'todayExpenseIdr'] += tx.amount_idr;
      if (day >= weekStart && day <= today) cashflowIdr[income ? 'last7dIncomeIdr' : 'last7dExpenseIdr'] += tx.amount_idr;
      if (day >= thirtyStart && day <= today) cashflowIdr[income ? 'last30dIncomeIdr' : 'last30dExpenseIdr'] += tx.amount_idr;
      if (!income && day >= monthStart && day <= today) monthSpentIdr += tx.amount_idr;
    }
    const cashflow = Object.fromEntries(Object.entries(cashflowIdr).map(([key, value]) => [key.replace(/Idr$/, 'Usd'), toUsd(value)]));
    const recent = db.prepare(`SELECT id, kind, amount_idr, category, note, occurred_at FROM transactions
      WHERE kind IN ('income','expense') AND julianday(occurred_at) <= julianday(?)
      ORDER BY julianday(occurred_at) DESC, id DESC LIMIT 60`).all(ts) as TxRow[];
    const transactions = recent.map(tx => ({ id: `tx-${tx.id}`, ts: utc(tx.occurred_at)!, kind: tx.kind, category: tx.category, amountUsd: toUsd(tx.amount_idr), amountIdr: tx.amount_idr, note: tx.note }));
    const monthly = options.monthlyBudgetIdr;
    const daysInMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
    if (monthly === null) warn('budget-unconfigured', 'Fintrack belum memiliki budget bulanan untuk Karō');
    const nativeCashflow = { ...cashflowIdr };
    return {
      agentId: 'portfolio' as const,
      status: alerts.some(a => a.level === 'warn') ? 'warn' as const : 'ok' as const,
      updatedAt: ts,
      headline: 'Ringkasan fintrack dari data tersimpan',
      metrics: {
        currency: 'USD',
        netWorthUsd: unknownCount ? null : knownUsd,
        knownNetWorthUsd: knownUsd,
        valuationComplete: unknownCount === 0 && accounts.every(a => a.valueUsd !== null),
        unvaluedPositions: unknownCount,
        accounts,
        cashflow,
        budget: { dailyUsd: monthly === null ? null : toUsd(Math.round(monthly / daysInMonth)), monthlyUsd: toUsd(monthly), monthSpentUsd: toUsd(monthSpentIdr) },
        budgetConfigured: monthly !== null,
        transactions,
        fx: { pair: 'USDIDR', rate: fx, fetchedAt: fxAt, basis: 'cached_current_fx_estimate' },
        dayTimeZone: options.dayTimeZone,
        native: { currency: 'IDR', knownNetWorthIdr: knownIdr, cashflow: nativeCashflow, monthlyBudgetIdr: monthly, monthSpentIdr },
      },
      alerts,
      events: [],
    };
  })();
}

export type DormSnapshot = Omit<ReturnType<typeof readDormSnapshot>, 'status'> & { status: 'ok' | 'warn' | 'error' | 'offline' };
