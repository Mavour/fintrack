import { afterEach, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, type Hex } from 'viem';
import { RH_MULTICALL_ABI, ROBINHOOD_TOKEN_ABI, resetRobinhoodCache, TRANSFER_TOPIC } from '../src/server/providers/robinhood.js';
import { RobinhoodLpProvider, RH_LP_ABI, RH_V4_MANAGER, concentratedAmounts, accruedFees, resetRobinhoodLpCache } from '../src/server/providers/robinhoodLp.js';

afterEach(() => { vi.unstubAllGlobals(); resetRobinhoodCache(); resetRobinhoodLpCache(); });
const Q96 = 1n << 96n, Q128 = 1n << 128n;
const wallet = { id: 1, label: 'LP', address: '0xcc66dc8c9b4e597536740c04c6a0932770e3bafe', network_type: 'evm' as const };
const token0 = '0x1111111111111111111111111111111111111111';
const token1 = '0x2222222222222222222222222222222222222222';
const zero = '0x0000000000000000000000000000000000000000';
const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

it('values only currently owned, liquid NFTs, separates principal and accrued fees, and counts fees once', async () => {
  const blocks: string[] = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('dexscreener')) return response([{ chainId: 'robinhood', baseToken: { address: token1 },
      quoteToken: { address: token0 }, priceUsd: '2', priceNative: '2', liquidity: { usd: 10000 } }]);
    const call = JSON.parse(String(init?.body));
    if (call.method === 'eth_chainId') return response({ result: '0x1237' });
    if (call.method === 'eth_blockNumber') return response({ result: '0xabc' });
    if (call.method === 'eth_getLogs') return response({ result: [1, 2, 3, 4].map((id) => ({ address: RH_V4_MANAGER,
      topics: [TRANSFER_TOPIC, `0x${'0'.repeat(64)}`, `0x${wallet.address.slice(2).padStart(64, '0')}`, `0x${id.toString(16).padStart(64, '0')}`] })) });
    blocks.push(call.params[1]);
    const decoded = decodeFunctionData({ abi: RH_MULTICALL_ABI, data: call.params[0].data });
    const results = decoded.args[0].map((c) => {
      const isToken = [token0, token1].includes(c.target.toLowerCase());
      const abi = isToken ? ROBINHOOD_TOKEN_ABI : RH_LP_ABI;
      const sub = decodeFunctionData({ abi, data: c.callData });
      const id = sub.args?.[0];
      if (sub.functionName === 'ownerOf' && id === 4n) return { success: false, returnData: '0x' as Hex };
      const signed24 = (n: number) => BigInt.asUintN(24, BigInt(n));
      const result: unknown = ({
        ownerOf: id === 3n ? zero : wallet.address,
        getPositionLiquidity: id === 2n ? 0n : 10n ** 18n,
        getPoolAndPositionInfo: [{ currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks: zero },
          (signed24(-60) << 8n) | (signed24(60) << 32n)],
        getSlot0: [Q96, 0, 0, 3000], getPositionInfo: [10n ** 18n, Q128, Q128],
        getFeeGrowthInside: [2n * Q128, 3n * Q128], decimals: 18,
        symbol: c.target.toLowerCase() === token0 ? 'USDG' : 'TEST',
      } as Record<string, unknown>)[sub.functionName];
      if (result === undefined) throw new Error(sub.functionName);
      return { success: true, returnData: encodeFunctionResult({ abi, functionName: sub.functionName, result } as never) };
    });
    return response({ result: encodeFunctionResult({ abi: RH_MULTICALL_ABI, functionName: 'aggregate3', result: results }) });
  });
  vi.stubGlobal('fetch', mock);
  const provider = new RobinhoodLpProvider();
  const lp = await provider.fetchPositions(wallet);
  expect(lp).toHaveLength(1);
  expect(lp[0]).toMatchObject({ kind: 'lp', protocol: 'Uniswap v4', chain_id: 'robinhood',
    meta: { position_address: `${RH_V4_MANAGER}:1`, in_range: true, tick_lower: -60, tick_upper: 60, unclaimed_fees_usd: 5 } });
  expect(lp[0].value_usd).toBeCloseTo(Number(lp[0].meta.position_value_usd) + 5, 12);
  expect(Number(lp[0].meta.position_value_usd)).toBeGreaterThan(0);
  expect(blocks.every((b) => b === '0xabc')).toBe(true);
  const count = mock.mock.calls.length;
  await provider.fetchPositions(wallet);
  expect(mock).toHaveBeenCalledTimes(count);
});

it('keeps an out-of-range position as one-sided principal and handles fee-growth overflow', () => {
  const below = concentratedAmounts(10n ** 18n, Q96 / 2n, -60, 60);
  const above = concentratedAmounts(10n ** 18n, Q96 * 2n, -60, 60);
  expect(below[0]).toBeGreaterThan(0n); expect(below[1]).toBe(0n);
  expect(above[0]).toBe(0n); expect(above[1]).toBeGreaterThan(0n);
  expect(accruedFees(Q128, 5n, (1n << 256n) - 5n)).toBe(10n);
});
