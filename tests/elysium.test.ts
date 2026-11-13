import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElysiumProvider } from '../src/server/providers/elysium.js';

const wallet = { id: 1, label: 'Robinhood', address: '0x57843c3a9d30c55ad5f971a3e42df9e507fb4ffd', network_type: 'evm' as const };
const token = '0x1111111111111111111111111111111111111111';
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
afterEach(() => vi.unstubAllGlobals());

describe('Elysium Kinetiq mainnet funds', () => {
  it('reads native HYPE and current ERC-20 balances at the same block, preserving decimals', async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api?')) return response({ status: '1', result: [
        { contractAddress: token, tokenName: 'USD', tokenSymbol: 'USD', tokenDecimal: '6' },
        { contractAddress: token, tokenName: 'USD', tokenSymbol: 'USD', tokenDecimal: '6' },
      ] });
      const call = JSON.parse(String(init?.body)); calls.push(call);
      return response({ result: ({ eth_chainId: '0x1863d', eth_blockNumber: '0x123', eth_getBalance: '0xde0b6b3a7640000', eth_call: '0x12d687' } as Record<string, string>)[call.method] });
    }));
    const positions = await new ElysiumProvider().fetchPositions(wallet);
    expect(positions.map((p) => p.amount)).toEqual(['1', '1.234567']);
    expect(positions.map((p) => p.chain_id)).toEqual(['elysium', 'elysium']);
    expect(positions[0].symbol).toBe('HYPE');
    expect(positions[1].price_usd).toBeNull();
    expect(calls.filter((c) => c.method === 'eth_call')).toHaveLength(1);
    expect(calls.filter((c) => ['eth_call', 'eth_getBalance'].includes(c.method)).every((c) => c.params[1] === '0x123')).toBe(true);
  });

  it('rejects another chain rather than showing an unrelated Elysium balance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ result: '0x53b' })));
    await expect(new ElysiumProvider().fetchPositions(wallet)).rejects.toThrow('99901');
  });

  it('accepts an explicitly empty explorer response and a zero native balance', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api?')) return response({ status: '0', message: 'No token transfers found', result: [] });
      const call = JSON.parse(String(init?.body));
      return response({ result: call.method === 'eth_chainId' ? '0x1863d' : '0x0' });
    }));
    expect(await new ElysiumProvider().fetchPositions(wallet)).toEqual([]);
  });

  it('rejects explorer errors instead of treating them as zero tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api?')) return response({ status: '0', message: 'NOTOK', result: 'Rate limit reached' });
      const call = JSON.parse(String(init?.body));
      return response({ result: call.method === 'eth_chainId' ? '0x1863d' : '0x0' });
    }));
    await expect(new ElysiumProvider().fetchPositions(wallet)).rejects.toThrow('tidak tersedia');
  });
});
