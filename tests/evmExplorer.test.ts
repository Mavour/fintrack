import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EvmExplorerProvider, __resetEvmExplorerCache } from '../src/server/providers/evmExplorer.js';
import { resetBreakers } from '../src/server/services/circuitBreaker.js';

const EVM = '0x57843c3a9d30c55ad5f971a3e42df9e507fb4ffd';

/** Blockscout v1 API shapes sesuai fetchEvmHoldings (evm.ts). Mengembalikan counter panggilan. */
function stubBlockscout(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('action=balance')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: '1', result: '5000000000000000000' }), // 5 native
      };
    }
    // action=tokenlist
    const chain = u.includes('arbitrum') ? 'arb' : u.includes('base.') ? 'base' : u.includes('optimism') ? 'op' : u.includes('polygon') ? 'polygon' : 'eth';
    const token = {
      eth: { contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', name: 'USD Coin', decimals: '6', balance: '10000000' },
      arb: { contractAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', symbol: 'USDT', name: 'Tether', decimals: '6', balance: '2000000' },
      base: { contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDBC', name: 'USDC', decimals: '6', balance: '3000000' },
      op: { contractAddress: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', symbol: 'OP', name: 'Optimism', decimals: '18', balance: '4000000000000000000' },
      polygon: { contractAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', symbol: 'USDC', name: 'USD Coin', decimals: '6', balance: '5000000' },
    }[chain]!;
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: '1', result: [token] }),
    };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  resetBreakers();
  __resetEvmExplorerCache();
  process.env.EVM_EXPLORER_PACE_MS = '0';
  process.env.EVM_EXPLORER_CHAIN_INTERVAL = '0';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EVM_EXPLORER_PACE_MS;
  delete process.env.EVM_EXPLORER_CHAIN_INTERVAL;
  __resetEvmExplorerCache();
  resetBreakers();
});

describe('EVM explorer fallback keyless (Blockscout)', () => {
  it('mengambil native + token di semua chain EVM', async () => {
    stubBlockscout();
    const p = new EvmExplorerProvider();
    const out = await p.fetchPositions({ id: 1, label: 'EVM', address: EVM, network_type: 'evm' });
    const chains = [...new Set(out.map((o) => o.chain_id))];
    expect(chains.sort()).toEqual(['arb', 'base', 'eth', 'op', 'polygon']);
    const ethNative = out.find((o) => o.chain_id === 'eth' && o.symbol === 'ETH')!;
    expect(ethNative).toBeDefined();
    expect(ethNative.amount).toBe('5');
    expect(ethNative.price_usd).toBeNull();
    // Native → kontrak wrapped agar price tier CoinGecko bisa menghargai.
    expect(ethNative.meta.token_id).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
    const usdc = out.find((o) => o.chain_id === 'eth' && o.symbol === 'USDC')!;
    expect(usdc.meta.token_id).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(usdc.amount).toBe('10');
    expect(usdc.protocol).toBe('blockscout');
    expect(out.every((o) => o.kind === 'token')).toBe(true);
  });

  it('hanya untuk wallet EVM', async () => {
    stubBlockscout();
    const p = new EvmExplorerProvider();
    const out = await p.fetchPositions({ id: 2, label: 'Sol', address: 'abc', network_type: 'solana' });
    expect(out).toEqual([]);
  });

  it('chain tidak di-refetch sebelum interval habis (pakai cache)', async () => {
    process.env.EVM_EXPLORER_CHAIN_INTERVAL = '3600000';
    const fn = stubBlockscout();
    const p = new EvmExplorerProvider();
    const wallet = { id: 1, label: 'EVM', address: EVM, network_type: 'evm' as const };
    const first = await p.fetchPositions(wallet);
    expect(first.length).toBeGreaterThan(0);
    const callsAwal = fn.mock.calls.length; // 5 balance + 5 tokenlist
    const second = await p.fetchPositions(wallet);
    expect(second.length).toBe(first.length);
    expect(fn.mock.calls.length).toBe(callsAwal); // tidak ada panggilan baru
  });

  it('chain yang gagal memakai posisi terakhir (snapshot stabil)', async () => {
    process.env.EVM_EXPLORER_CHAIN_INTERVAL = '0';
    const first = stubBlockscout();
    const p = new EvmExplorerProvider();
    const wallet = { id: 1, label: 'EVM', address: EVM, network_type: 'evm' as const };
    await p.fetchPositions(wallet);
    // Siklus berikutnya: semua panggilan gagal → hasil tetap sama dari cache.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    const out = await p.fetchPositions(wallet);
    expect(out.length).toBeGreaterThan(0);
    expect(first).toBeDefined();
  });
});