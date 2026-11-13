import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { refreshWalletPrices } from '../src/server/services/priceTier.js';
import { commitPositions } from '../src/server/services/walletSync.js';
import { createWallet } from '../src/server/services/walletRegistry.js';

afterEach(() => vi.unstubAllGlobals());

it.each([true, false])('prices Elysium by contract and Robinhood ETH even when native CoinGecko works: %s', async (nativeAvailable) => {
  const db = new Database(':memory:');
  try {
    db.exec(fs.readFileSync(new URL('../src/server/db/schema.sql', import.meta.url), 'utf8'));
    const wallet = createWallet(db, 'EVM', '0xdf00a1295b384cd641086a40569501547077d14c', 'evm');
    const contract = '0xd56786d59f898ab020f386bc21fc08bfd576a942';
    commitPositions(db, wallet.id, [
      { chain_id: 'elysium', kind: 'token', protocol: 'elysium', symbol: 'USDC', name: 'USDC', amount: '3', price_usd: null, value_usd: null, meta: { token_id: contract } },
      { chain_id: 'robinhood', kind: 'token', protocol: 'robinhood', symbol: 'ETH', name: 'ETH', amount: '0.1', price_usd: null, value_usd: null, meta: { token_id: null, coingecko_id: 'ethereum' } },
    ]);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/simple/price?')) return { ok: nativeAvailable, status: nativeAvailable ? 200 : 429, json: async () => ({ ethereum: { usd: 2000 } }) } as Response;
      if (url.includes('/simple/token_price/')) return { ok: true, json: async () => ({}) } as Response;
      if (url.includes('/tokens/v1/ethereum/')) return { ok: true, json: async () => [
        { chainId: 'ethereum', baseToken: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' }, priceUsd: '2000', liquidity: { usd: 100000 } },
      ] } as Response;
      expect(url).toContain('/tokens/v1/elysium/');
      return { ok: true, json: async () => [
        { chainId: 'ethereum', baseToken: { address: contract }, priceUsd: '1', liquidity: { usd: 99999999 } },
        { chainId: 'elysium', baseToken: { address: contract }, priceUsd: '10', liquidity: { usd: 1 } },
        { chainId: 'elysium', baseToken: { address: contract }, priceUsd: '0.001511', liquidity: { usd: 1000 } },
      ] } as Response;
    }));
    await refreshWalletPrices(db);
    const rows = db.prepare('SELECT chain_id, price_usd, value_usd FROM wallet_positions ORDER BY chain_id').all();
    expect(rows).toEqual([
      { chain_id: 'elysium', price_usd: 0.001511, value_usd: 0.004533 },
      { chain_id: 'robinhood', price_usd: 2000, value_usd: 200 },
    ]);
  } finally { db.close(); }
});
