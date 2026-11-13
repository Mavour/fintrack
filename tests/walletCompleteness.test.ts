import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { parseLpPositions, parseStakingPositions, parseLimitOrders, fetchJupiterStaking, fetchJupiterLimitOrders, JupiterStakingProvider, JupiterLimitOrderProvider, JupiterLiquidityProvider } from '../src/server/providers/jupiterPositions.js';
import { SolanaRpcFallbackProvider } from '../src/server/providers/solanaRpcFallback.js';
import { MeteoraDlmmProvider } from '../src/server/providers/meteora.js';
import { ElysiumProvider } from '../src/server/providers/elysium.js';
import { RobinhoodNativeProvider, RobinhoodTokenProvider } from '../src/server/providers/robinhood.js';
import { RobinhoodLpProvider } from '../src/server/providers/robinhoodLp.js';
import { EvmExplorerProvider } from '../src/server/providers/evmExplorer.js';
import { EvmNativeRpcProvider } from '../src/server/providers/evmNativeRpc.js';
import { EthplorerProvider } from '../src/server/providers/ethplorer.js';
import { HyperliquidSpotProvider } from '../src/server/providers/hyperliquid.js';
import { resetBreakers } from '../src/server/services/circuitBreaker.js';
import { commitPositions, recordSyncStatus, syncWallet } from '../src/server/services/walletSync.js';
import { createWallet } from '../src/server/services/walletRegistry.js';
import { listPositions, listLp, getSyncStatus, walletSyncHealth } from '../src/server/services/walletRead.js';
import { getWalletDefi, getUnifiedPortfolio, getWalletTokens } from '../src/server/services/portfolioService.js';
import { getDashboard } from '../src/server/services/dashboardService.js';
import type { NormalizedPosition } from '../src/server/providers/walletTypes.js';

const SOL = '3keq3cRtYuoPCYBUL4s6N52ePguGivSZpNU4fzSiPXpd';
const MET = 'METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const asset = (address: string, raw: string, price: number) => ({ data: { address, amount: { raw, decimals: 6 }, price }, value: Number(raw) / 1e6 * price });
const pos = (kind: NormalizedPosition['kind'], value: number, protocol: string): NormalizedPosition => ({
  chain_id: 'solana', kind, protocol, symbol: 'MET', name: 'Meteora', amount: '200', price_usd: value / 200, value_usd: value, meta: {},
});
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(fs.readFileSync(new URL('../src/server/db/schema.sql', import.meta.url), 'utf8'));
  resetBreakers();
  vi.stubEnv('JUPITER_API_KEY', '');
  vi.spyOn(SolanaRpcFallbackProvider.prototype, 'fetchPositions').mockResolvedValue([]);
  vi.spyOn(JupiterStakingProvider.prototype, 'fetchPositions').mockResolvedValue([]);
  vi.spyOn(JupiterLimitOrderProvider.prototype, 'fetchPositions').mockResolvedValue([]);
  vi.spyOn(JupiterLiquidityProvider.prototype, 'fetchPositions').mockResolvedValue([]);
  vi.spyOn(MeteoraDlmmProvider.prototype, 'fetchPositions').mockResolvedValue([]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetBreakers(); db.close(); });

describe('complete Solana balances', () => {
  it('separates same-ticker Robinhood contracts so unpriced fake USDG cannot inflate the real balance', () => {
    const w = createWallet(db, 'RH', '0xcc66dc8c9b4e597536740c04c6a0932770e3bafe', 'evm');
    const token = { ...pos('token', 17, 'robinhood'), chain_id: 'robinhood', symbol: 'USDG', amount: '17', price_usd: 1 };
    commitPositions(db, w.id, [
      { ...token, meta: { token_id: '0x1111111111111111111111111111111111111111' } },
      { ...token, amount: '9999', price_usd: null, value_usd: null, meta: { token_id: '0x2222222222222222222222222222222222222222' } },
      { ...token, amount: '20', price_usd: 0.1, value_usd: 2, meta: { token_id: '0x3333333333333333333333333333333333333333' } },
    ]);
    const { tokens, hiddenCount } = getWalletTokens(db);
    expect(tokens.map((t) => [t.amount, t.value_usd])).toEqual([['17', 17], ['20', 2]]);
    expect(new Set(tokens.map((t) => t.asset_key)).size).toBe(2);
    expect(hiddenCount).toBe(1);
  });

  it('accepts newly discovered Robinhood ETH alongside priced Elysium tokens when RPC omits prices', async () => {
    vi.stubEnv('DEBANK_ACCESS_KEY', '');
    for (const provider of [EvmExplorerProvider, EvmNativeRpcProvider, EthplorerProvider, HyperliquidSpotProvider, RobinhoodLpProvider])
      vi.spyOn(provider.prototype, 'fetchPositions').mockResolvedValue([]);
    const w = createWallet(db, 'RH & Elysium', '0xdf00a1295b384cd641086a40569501547077d14c', 'evm');
    const token = { ...pos('token', 100, 'elysium'), chain_id: 'elysium', amount: '10', price_usd: 10,
      meta: { token_id: '0x1111111111111111111111111111111111111111', sync_provider: 'elysium' } };
    commitPositions(db, w.id, [token]);
    vi.spyOn(ElysiumProvider.prototype, 'fetchPositions').mockResolvedValue([{ ...token, amount: '11', price_usd: null, value_usd: null }]);
    vi.spyOn(RobinhoodNativeProvider.prototype, 'fetchPositions').mockResolvedValue([
      { ...pos('token', 0, 'robinhood'), chain_id: 'robinhood', symbol: 'ETH', amount: '0.002', price_usd: null, value_usd: null },
    ]);
    vi.spyOn(RobinhoodTokenProvider.prototype, 'fetchPositions').mockRejectedValue(new Error('HTTP 403'));
    const result = await syncWallet(db, w.id, 'evm');
    expect(result.ok).toBe(true);
    expect(result.partial).toBe(true);
    const rows = listPositions(db, { wallet_id: w.id, show_all: true });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.chain_id === 'elysium')).toMatchObject({ amount: '11', price_usd: 10, value_usd: 110 });
    expect(rows.find((r) => r.chain_id === 'robinhood')).toMatchObject({ symbol: 'ETH', amount: '0.002' });
  });

  it('counts LP fees once and includes both order sides, staking and spot in crypto totals', () => {
    const w = createWallet(db, 'S', SOL);
    db.prepare("INSERT INTO fx_cache (pair, rate) VALUES ('USDIDR',1000)").run();
    db.prepare("INSERT INTO assets (type,symbol,qty,avg_buy_price_idr) VALUES ('crypto','MAN','1',0)").run();
    db.prepare("INSERT INTO price_cache (symbol,price_idr) VALUES ('MAN',15000)").run();
    commitPositions(db, w.id, [
      pos('token', 10, 'solana-rpc'), pos('staking', 20, 'jupiter-meteora'),
      { ...pos('defi', 30, 'jupiter-meteora'), symbol: 'USDC', meta: { output_symbol: 'SOL', order_side: 'input' } },
      { ...pos('defi', 10, 'jupiter-meteora'), symbol: 'SOL', meta: { output_symbol: 'SOL', order_side: 'output' } },
      { ...pos('lp', 105, 'Meteora DLMM'), meta: { pool_address: 'pool', position_address: 'position', position_value_usd: 100, unclaimed_fees_usd: 5 } },
    ]);
    const portfolio = getUnifiedPortfolio(db);
    expect(portfolio.lp_value_idr).toBe(105000);
    expect(portfolio.lp_fees_idr).toBe(5000);
    expect(portfolio.by_type.crypto).toBe(190000);
    expect(portfolio.total_value_idr).toBe(190000);
    const dashboard = getDashboard(db);
    expect(dashboard.allocation.find((a) => a.label === 'Crypto')?.value_idr).toBe(190000);
    expect(dashboard.total_invested_value_idr).toBe(190000);
  });

  it.each([
    ['meteora-met-staking', fetchJupiterStaking],
    ['meteora-dlmm-limit-orders', fetchJupiterLimitOrders],
  ] as const)('rejects an embedded %s fetcher failure even when HTTP is successful', async (id, fetchPositions) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({
      fetcherResults: [{ id, status: 'error', elements: [] }],
    }) })));
    await expect(fetchPositions(SOL)).rejects.toThrow('data terakhir dipertahankan');
  });

  it('counts both remaining input and unwithdrawn output of partially filled orders', () => {
    const orders = parseLimitOrders({ fetcherResults: [{ elements: [{
      id: 'order-1', platformId: 'meteora', serviceId: 'meteora-dlmm-limit-orders', type: 'trade', label: 'LimitOrder', name: '',
      data: { assets: { input: asset(USDC, '40000000', 1), output: asset(MET, '50000000', 0.2) }, outputAddress: MET, filledPercentage: 0.25 },
    }] }] });
    expect(orders.map((o) => o.side)).toEqual(['input', 'output']);
    expect(orders.reduce((sum, o) => sum + (o.valueUsd ?? 0), 0)).toBe(50);
    expect(orders[0].filledPct).toBe(0.25);
  });

  it('parses MET staking using addressId when the legacy address field is absent', () => {
    const rows = parseStakingPositions({ fetcherResults: [{ elements: [{
      id: 'stake-1', platformId: 'meteora', serviceId: 'meteora-met-staking', type: 'multiple', label: 'Staked', name: '',
      data: { assets: [{ data: { addressId: `solana_${MET}`, amount: { raw: '200000000', decimals: 6 }, price: 0.2 } }] },
    }] }] });
    expect(rows[0]).toMatchObject({ mint: MET, qty: '200', valueUsd: 40 });
  });

  it('keeps distinct LP positions in the same pool', () => {
    const rows = parseLpPositions({ fetcherResults: [{ elements: ['one', 'two'].map((id) => ({
      id, refAddress: `solana_${id}`, platformId: 'meteora', type: 'liquidity', label: 'LP', name: '',
      sourceRefs: [{ name: 'Pool', address: 'pool' }], data: { assets: [asset(MET, '1000000', 1)] },
    })) }] });
    expect(new Set(rows.map((p) => p.key)).size).toBe(2);
  });

  it('preserves staking and its original timestamp when its provider fails while balances succeed', async () => {
    const w = createWallet(db, 'S', SOL);
    commitPositions(db, w.id, [pos('staking', 40, 'jupiter-meteora')]);
    db.prepare("UPDATE wallet_positions SET synced_at = '2026-01-01 00:00:00'").run();
    vi.mocked(JupiterStakingProvider.prototype.fetchPositions).mockRejectedValue(new Error('upstream unavailable'));
    vi.mocked(SolanaRpcFallbackProvider.prototype.fetchPositions).mockResolvedValue([pos('token', 50, 'solana-rpc')]);
    const result = await syncWallet(db, w.id, 'solana');
    expect(result.partial).toBe(true);
    const rows = listPositions(db, { show_all: true });
    expect(rows).toHaveLength(2);
    expect(rows.find((p) => p.kind === 'staking')?.synced_at).toBe('2026-01-01 00:00:00');
    expect(walletSyncHealth(db).mode).toBe('stale');
  });

  it('removes a closed order after an authoritative successful empty response', async () => {
    const w = createWallet(db, 'S', SOL);
    commitPositions(db, w.id, [pos('defi', 40, 'jupiter-meteora'), pos('token', 50, 'solana-rpc')]);
    vi.mocked(SolanaRpcFallbackProvider.prototype.fetchPositions).mockResolvedValue([pos('token', 50, 'solana-rpc')]);
    await syncWallet(db, w.id, 'solana');
    expect(listPositions(db, { kind: 'defi', show_all: true })).toEqual([]);
  });

  it('does not double count direct DLMM and Jupiter LP data', async () => {
    const w = createWallet(db, 'S', SOL);
    const lp = { ...pos('lp', 100, 'Meteora DLMM'), meta: { pool_address: 'pool', position_address: 'position' } };
    vi.mocked(MeteoraDlmmProvider.prototype.fetchPositions).mockResolvedValue([lp]);
    vi.mocked(JupiterLiquidityProvider.prototype.fetchPositions).mockResolvedValue([{ ...lp, protocol: 'jupiter-meteora' }]);
    await syncWallet(db, w.id, 'lp');
    expect(listLp(db)).toHaveLength(1);
  });

  it('uses valued Jupiter LP data when the direct provider fails', async () => {
    const w = createWallet(db, 'S', SOL);
    const lp = { ...pos('lp', 100, 'Meteora DLMM'), meta: { pool_address: 'pool', position_address: 'position' } };
    commitPositions(db, w.id, [lp]);
    vi.mocked(MeteoraDlmmProvider.prototype.fetchPositions).mockRejectedValue(new Error('unavailable'));
    vi.mocked(JupiterLiquidityProvider.prototype.fetchPositions).mockResolvedValue([{ ...lp, protocol: 'jupiter-meteora', value_usd: 110, meta: { ...lp.meta, position_value_usd: 110 } }]);
    await syncWallet(db, w.id, 'lp');
    expect(listLp(db)).toHaveLength(1);
    expect(listLp(db)[0].position_value_usd).toBe(110);
  });

  it('does not append EVM LP rows each time the EVM tier runs', () => {
    const w = createWallet(db, 'EVM', '0x57843c3a9d30c55ad5f971a3e42df9e507fb4ffd');
    const lp = { ...pos('lp', 100, 'debank-uniswap'), chain_id: 'eth', meta: { pool_address: 'pool', position_address: 'position' } };
    commitPositions(db, w.id, [lp], 'evm');
    commitPositions(db, w.id, [{ ...lp, value_usd: 101 }], 'evm');
    expect(listLp(db)).toHaveLength(1);
    expect(listPositions(db, { show_all: true })).toHaveLength(1);
  });

  it('invalidates overlapping hashes after a different scope replaces the snapshot', () => {
    const w = createWallet(db, 'S', SOL);
    commitPositions(db, w.id, [pos('token', 100, 'solana-rpc')], 'all');
    commitPositions(db, w.id, [pos('token', 110, 'solana-rpc')], 'solana');
    expect(commitPositions(db, w.id, [pos('token', 100, 'solana-rpc')], 'all').written).toBe(true);
    expect(listPositions(db, { show_all: true })[0].value_usd).toBe(100);
  });

  it('serializes manual and automatic scopes for the same wallet', async () => {
    const w = createWallet(db, 'S', SOL);
    let release!: (value: NormalizedPosition[]) => void;
    vi.mocked(SolanaRpcFallbackProvider.prototype.fetchPositions).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const first = syncWallet(db, w.id, 'solana');
    const second = syncWallet(db, w.id, 'lp');
    await vi.waitFor(() => expect(SolanaRpcFallbackProvider.prototype.fetchPositions).toHaveBeenCalledOnce());
    expect(MeteoraDlmmProvider.prototype.fetchPositions).not.toHaveBeenCalled();
    release([pos('token', 100, 'solana-rpc')]);
    await Promise.all([first, second]);
    expect(MeteoraDlmmProvider.prototype.fetchPositions).toHaveBeenCalledOnce();
    expect(listPositions(db, { show_all: true })).toHaveLength(1);
  });

  it('writes one global status row and deduplicates historical NULL primary keys', () => {
    db.prepare("INSERT INTO sync_status (provider) VALUES ('tier-lp'), ('tier-lp')").run();
    recordSyncStatus(db, 'tier-lp', null, true);
    recordSyncStatus(db, 'tier-lp', null, false, 'partial');
    expect(getSyncStatus(db)).toHaveLength(1);
    expect(getSyncStatus(db)[0].last_error).toBe('partial');
    expect(db.prepare('SELECT * FROM sync_status').all()).toHaveLength(1);
  });

  it('keeps unwithdrawn output separate from remaining input in the portfolio', () => {
    const w = createWallet(db, 'S', SOL);
    db.prepare("INSERT INTO fx_cache (pair, rate) VALUES ('USDIDR',16000)").run();
    commitPositions(db, w.id, [
      { ...pos('defi', 40, 'jupiter-meteora'), symbol: 'USDC', amount: '40', meta: { output_symbol: 'MET', order_side: 'input' } },
      { ...pos('defi', 10, 'jupiter-meteora'), symbol: 'MET', amount: '50', meta: { output_symbol: 'MET', order_side: 'output' } },
    ]);
    const { tokens } = getWalletDefi(db);
    expect(tokens).toHaveLength(2);
    expect(tokens.reduce((s, p) => s + (p.value_usd ?? 0), 0)).toBe(50);
    expect(tokens.find((p) => p.order_side === 'output')?.amount).toBe('50');
  });
});
