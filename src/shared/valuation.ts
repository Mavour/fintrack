export interface ValuationCoverage {
  complete: boolean;
  missing_prices: Array<'manual' | 'wallet' | 'defi' | 'lp'>;
  missing_fx: boolean;
}
