import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runMigrations } from '../src/server/db/database.js';
import { getDashboard } from '../src/server/services/dashboardService.js';
import { getUnifiedPortfolio } from '../src/server/services/portfolioService.js';

it('reports partial valuation by cause and clears it after data becomes available', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.exec(`INSERT INTO assets (symbol, type, qty) VALUES ('RD66', 'reksadana', '1');
      INSERT INTO wallets (id, label, address, network_type) VALUES (1, 'Solana', 'fixture', 'solana');
      INSERT INTO wallet_positions (wallet_id, chain_id, kind, symbol, amount, value_usd) VALUES
        (1, 'solana', 'token', 'TEST', '1', NULL), (1, 'solana', 'token', 'TEST', '1', 100),
        (1, 'solana', 'defi', 'ORDER', '1', NULL);
      INSERT INTO lp_positions (wallet_id, chain_id, pool_address, position_value_usd) VALUES (1, 'solana', 'pool', 20);`);
    const partial = { complete: false, missing_prices: ['manual', 'wallet', 'defi', 'lp'], missing_fx: true };
    expect(getDashboard(db).valuation_coverage).toEqual(partial);
    expect(getUnifiedPortfolio(db).valuation_coverage).toEqual(partial);
    db.exec(`INSERT INTO price_cache (symbol, price_idr, source) VALUES ('RD66', 1000, 'manual');
      INSERT INTO fx_cache (pair, rate) VALUES ('USDIDR', 16000);
      UPDATE wallet_positions SET value_usd = 20 WHERE value_usd IS NULL;
      UPDATE lp_positions SET unclaimed_fees_usd = 0;`);
    expect(getDashboard(db).valuation_coverage).toEqual({ complete: true, missing_prices: [], missing_fx: false });
  } finally { db.close(); }
});
