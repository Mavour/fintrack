import type Database from 'better-sqlite3';
import { getUnifiedPortfolio } from './portfolioService.js';

export interface DashboardSummary {
  total_cash_idr: number;
  total_invested_value_idr: number;
  total_wealth_idr: number;
  income_this_month_idr: number;
  expense_this_month_idr: number;
  total_pl_idr: number;
  allocation: Array<{ label: string; value_idr: number }>;
  expense_by_category: Array<{ category: string; total_idr: number }>;
  portfolio_by_asset: Array<{ symbol: string; value_idr: number }>;
}

export function getDashboard(db: Database.Database, month?: string): DashboardSummary {
  const m = month ?? new Date().toISOString().slice(0, 7);
  const cashRow = db
    .prepare('SELECT COALESCE(SUM(balance_idr),0) AS t FROM accounts WHERE is_active = 1')
    .get() as { t: number };
  const flowRows = db
    .prepare(
      `SELECT kind, COALESCE(SUM(amount_idr),0) AS t FROM transactions
       WHERE strftime('%Y-%m', occurred_at) = ? GROUP BY kind`,
    )
    .all(m) as Array<{ kind: string; t: number }>;
  const income = flowRows.find((r) => r.kind === 'income')?.t ?? 0;
  const expense = flowRows.find((r) => r.kind === 'expense')?.t ?? 0;

  const uni = getUnifiedPortfolio(db);
  const invested = uni.total_value_idr;
  const pl = uni.floating_pl_idr;
  const byType = new Map<string, number>(Object.entries(uni.by_type));
  const byAsset: Array<{ symbol: string; value_idr: number }> = [];
  for (const v of uni.assets) {
    const val = v.current_value_idr ?? 0;
    if (val > 0) byAsset.push({ symbol: v.symbol, value_idr: val });
  }
  for (const w of uni.wallet_tokens) {
    if ((w.value_idr ?? 0) > 0) byAsset.push({ symbol: w.symbol, value_idr: w.value_idr ?? 0 });
  }

  const allocation = [
    { label: 'Kas', value_idr: cashRow.t },
    { label: 'Crypto', value_idr: byType.get('crypto') ?? 0 },
    { label: 'Saham', value_idr: byType.get('saham') ?? 0 },
    { label: 'Reksadana', value_idr: byType.get('reksadana') ?? 0 },
  ];

  const expenseRows = db
    .prepare(
      `SELECT category, SUM(amount_idr) AS total_idr FROM transactions
       WHERE kind = 'expense' AND strftime('%Y-%m', occurred_at) = ?
       GROUP BY category ORDER BY total_idr DESC`,
    )
    .all(m) as Array<{ category: string; total_idr: number }>;

  return {
    total_cash_idr: cashRow.t,
    total_invested_value_idr: invested,
    total_wealth_idr: cashRow.t + invested,
    income_this_month_idr: income,
    expense_this_month_idr: expense,
    total_pl_idr: pl,
    allocation,
    expense_by_category: expenseRows,
    portfolio_by_asset: byAsset,
  };
}
