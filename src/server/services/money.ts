import { Decimal } from 'decimal.js';

/** All IDR money is an integer (no sen). This helper guards that invariant. */
export function assertIdrInteger(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`IDR amount must be a non-negative integer, got ${value}`);
  }
}

/** qty is stored as decimal string. Parse strictly. */
export function parseQty(qty: string): Decimal {
  const d = new Decimal(qty);
  if (!d.isFinite() || d.isNegative()) throw new Error(`Invalid qty: ${qty}`);
  return d;
}

/** currentValue = qty * priceIdr, rounded to nearest integer IDR. */
export function qtyTimesPriceIdr(qty: string, priceIdr: number): number {
  const value = parseQty(qty).times(new Decimal(priceIdr));
  return value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

/** costBasis = qty * avgBuyPriceIdr */
export function costBasis(qty: string, avgBuyPriceIdr: number): number {
  return qtyTimesPriceIdr(qty, avgBuyPriceIdr);
}

export function plNominal(currentValue: number, cost: number): number {
  return currentValue - cost;
}

export function plPercent(currentValue: number, cost: number): number | null {
  if (cost === 0) return null;
  return ((currentValue - cost) / cost) * 100;
}

/** Format helpers live server-side only for tests; UI has its own copy. */
export function formatIdr(n: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(n);
}
