import type { Price, PriceProvider } from './types.js';

/**
 * Mutual funds have no stable public API.
 * This provider is intentionally empty and only serves manual NAB input.
 * A future scraper can implement PriceProvider and be plugged in here.
 */
export class ManualNavProvider implements PriceProvider {
  readonly name = 'manual';
  async fetch(_symbols: string[]): Promise<Price[]> {
    return [];
  }
}
