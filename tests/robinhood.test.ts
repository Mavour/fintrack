import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { RobinhoodNativeProvider, RobinhoodTokenProvider, resetRobinhoodCache, RH_MULTICALL_ABI, ROBINHOOD_TOKEN_ABI, TRANSFER_TOPIC } from '../src/server/providers/robinhood.js';
const wallet = { id: 1, label: 'RH', address: '0xdf00a1295b384cd641086a40569501547077d14c', network_type: 'evm' as const };
const token = '0x1111111111111111111111111111111111111111';
const topic = `0x${wallet.address.slice(2).padStart(64, '0')}`;
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetRobinhoodCache(); });
describe('Robinhood Chain mainnet', () => {
  it('keeps native ETH readable independently of failed token discovery', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body));
      if (call.method === 'eth_getLogs') return response({ error: { message: 'rate limit' } });
      return response({ result: ({ eth_chainId: '0x1237', eth_blockNumber: '0xabc', eth_getBalance: '0x7cd7ac039636a' } as Record<string, string>)[call.method] });
    }));
    expect((await new RobinhoodNativeProvider().fetchPositions(wallet))[0]).toMatchObject({ chain_id: 'robinhood', symbol: 'ETH', amount: '0.002196251931665258' });
    await expect(new RobinhoodTokenProvider().fetchPositions(wallet)).rejects.toThrow('rate limit');
  });
  it('rejects testnet or other EVM networks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ result: '0x1' })));
    await expect(new RobinhoodNativeProvider().fetchPositions(wallet)).rejects.toThrow('4663');
    await expect(new RobinhoodTokenProvider().fetchPositions(wallet)).rejects.toThrow('4663');
  });
  it('discovers contracts from logs, ignores NFTs, and reads current balances at one block without explorer', async () => {
    const blocks: string[] = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body));
      if (call.method === 'eth_chainId') return response({ result: '0x1237' });
      if (call.method === 'eth_blockNumber') return response({ result: '0xabc' });
      if (call.method === 'eth_getLogs') {
        expect(call.params[0]).toMatchObject({ fromBlock: '0x0', toBlock: '0xabc', topics: [TRANSFER_TOPIC, null, topic] });
        return response({ result: [
          { address: token, topics: [TRANSFER_TOPIC, topic, topic] },
          { address: token, topics: [TRANSFER_TOPIC, topic, topic] },
          { address: '0x2222222222222222222222222222222222222222', topics: [TRANSFER_TOPIC, topic, topic, topic] },
        ] });
      }
      blocks.push(call.params[1]);
      const decoded = decodeFunctionData({ abi: RH_MULTICALL_ABI, data: call.params[0].data });
      const results = decoded.args[0].map((c) => {
        expect(c.target.toLowerCase()).toBe(token);
        const sub = decodeFunctionData({ abi: ROBINHOOD_TOKEN_ABI, data: c.callData });
        const result = sub.functionName === 'balanceOf' ? 1234567n : sub.functionName === 'decimals' ? 6 : 'USD';
        return { success: true, returnData: encodeFunctionResult({ abi: ROBINHOOD_TOKEN_ABI, functionName: sub.functionName, result } as never) };
      });
      return response({ result: encodeFunctionResult({ abi: RH_MULTICALL_ABI, functionName: 'aggregate3', result: results }) });
    });
    vi.stubGlobal('fetch', fetch);
    const provider = new RobinhoodTokenProvider();
    const positions = await provider.fetchPositions(wallet);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ amount: '1.234567', symbol: 'USD', price_usd: null, meta: { token_id: token } });
    expect(blocks).toEqual(['0xabc', '0xabc']);
    const count = fetch.mock.calls.length;
    await provider.fetchPositions(wallet);
    expect(fetch).toHaveBeenCalledTimes(count);
  });
  it('rejects potentially truncated logs instead of clearing balances', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body));
      return response({ result: call.method === 'eth_chainId' ? '0x1237' : call.method === 'eth_blockNumber' ? '0xabc' : Array(10000).fill({}) });
    }));
    await expect(new RobinhoodTokenProvider().fetchPositions(wallet)).rejects.toThrow('batas log');
  });
});
