import type Database from 'better-sqlite3';
import { fetchWithTimeout, type Price } from './types.js';
import { storePrices } from './priceStore.js';
import { logger } from '../logger.js';

// Explicit product IDs: never resolve funds by a similar name or another share class.
export const MUTUAL_FUNDS = [
  { symbol: 'RD66', name: 'Avrist Ada Kas Mutiara', kontanId: 14736 },
  { symbol: 'RD838', name: 'Majoris Sukuk Negara Indonesia', kontanId: 15205 },
  { symbol: 'RD984', name: 'Manulife Dana Kas Syariah', kontanId: 15371 },
  { symbol: 'RD13', name: 'ABF Indonesia Bond Index Fund', kontanId: 46 },
  { symbol: 'RD1544', name: 'Schroder Dana Mantap Plus II', kontanId: 476 },
] as const;

export function parseFundHistory(html: string): Array<{ day: string; priceIdr: number }> {
  const dates = [...html.matchAll(/pausecontent\.push\('([^']+)'\)/g)].map((m) => m[1]!);
  const values = [...html.matchAll(/data1\.push\('([^']+)'\)/g)].map((m) => Number(m[1]));
  if (!dates.length || dates.length !== values.length) throw new Error('Grafik NAB tidak valid');
  const today = new Date().toISOString().slice(0, 10);
  return dates.map((day, i) => {
    const priceIdr = values[i]!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today || !Number.isFinite(priceIdr) || priceIdr <= 0
      || (i > 0 && day <= dates[i - 1]!)) throw new Error('Tanggal atau NAB tidak valid');
    return { day, priceIdr };
  });
}

export async function refreshMutualFunds(db: Database.Database): Promise<void> {
  const assets = db.prepare("SELECT symbol FROM assets WHERE type = 'reksadana'").all() as Array<{ symbol: string }>;
  await Promise.all(assets.map(async ({ symbol }) => {
    const fund = MUTUAL_FUNDS.find((f) => f.symbol === symbol);
    if (!fund) return;
    try {
      const url = `https://pusatdata.kontan.co.id/reksadana/get_chart_product/?produk_id=${fund.kontanId}&select=nab&periode=1&start_date=&end_date=`;
      const res = await fetchWithTimeout(url, 15_000);
      if (!res.ok) throw new Error(`Kontan HTTP ${res.status}`);
      const history = parseFundHistory(await res.text());
      const last = history[history.length - 1]!;
      const price: Price = { symbol, priceIdr: last.priceIdr, asOf: last.day, source: 'kontan', history };
      storePrices(db, [price]);
    } catch (err) {
      logger.warn({ err, symbol }, 'fund NAV refresh failed, keeping dated cache');
    }
  }));
}
