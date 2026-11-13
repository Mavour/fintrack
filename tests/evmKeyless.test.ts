import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EvmNativeRpcProvider, __resetEvmNativeRpcCache } from '../src/server/providers/evmNativeRpc.js';
import { EthplorerProvider, parseEthplorerTokens, __resetEthplorerCache } from '../src/server/providers/ethplorer.js';
import { dedupeEvmKeyless } from '../src/server/services/walletSync.js';
import { resetBreakers } from '../src/server/services/circuitBreaker.js';
import type { NormalizedPosition } from '../src/server/providers/walletTypes.js';

const EVM = '0x57843c3a9d30c55ad5f971a3e42df9e507fb4ffd';

/** eth_getBalance per chain: eth 0.0128, base 1.3e-7, sisanya nol. */
function stubRpc(): ReturnType<typeof vi.fn> {
  const byHost: Record<string, string> = {
    'ethereum.publicnode.com': '0x2da6a7f3ad2ad1', // 0.012849614229940945 ETH
    'arbitrum-one.publicnode.com': '0x0',
    'base.publicnode.com': '0xbee893923ce', // debu
    'optimism.publicnode.com': '0x0',
    'polygon-bor.publicnode.com': '0x0',
  };
  const fn = vi.fn(async (url: string) => {
    const host = Object.keys(byHost).find((h) => String(url).includes(h)) ?? '';
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: byHost[host] ?? '0x0' }),
    };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function stubEthplorer(tokens: unknown[] = []): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ address: EVM, tokens }),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  resetBreakers();
  __resetEvmNativeRpcCache();
  __resetEthplorerCache();
  process.env.EVM_RPC_PACE_MS = '0';
  process.env.EVM_RPC_CHAIN_INTERVAL = '0';
  process.env.ETHPLORER_INTERVAL = '0';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EVM_RPC_PACE_MS;
  delete process.env.EVM_RPC_CHAIN_INTERVAL;
  delete process.env.ETHPLORER_INTERVAL;
  __resetEvmNativeRpcCache();
  __resetEthplorerCache();
  resetBreakers();
});

const pos = (over: Partial<NormalizedPosition>): NormalizedPosition => ({
  chain_id: 'eth',
  kind: 'token',
  protocol: 'blockscout',
  symbol: 'ETH',
  name: 'Ethereum Native',
  amount: '1',
  price_usd: null,
  value_usd: null,
  meta: {},
  ...over,
});

describe('EVM keyless lapis dua (RPC native + Ethplorer)', () => {
  it('saldo native dibaca per chain, nol dilewati', async () => {
    stubRpc();
    const p = new EvmNativeRpcProvider();
    const out = await p.fetchPositions({ id: 2, label: 'EVM', address: EVM, network_type: 'evm' });
    const eth = out.find((o) => o.chain_id === 'eth')!;
    expect(eth.symbol).toBe('ETH');
    expect(Number(eth.amount)).toBeCloseTo(0.012849614229940945, 10);
    expect(eth.meta.token_id).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
    expect(out.find((o) => o.chain_id === 'arb')).toBeUndefined();
    expect(out.find((o) => o.chain_id === 'polygon')).toBeUndefined();
    const base = out.find((o) => o.chain_id === 'base')!;
    expect(Number(base.amount)).toBeGreaterThan(0);
    expect(Number(base.amount)).toBeLessThan(0.001);
  });

  it('hanya untuk wallet EVM', async () => {
    stubRpc();
    const p = new EvmNativeRpcProvider();
    expect(await p.fetchPositions({ id: 1, label: 'S', address: 'x', network_type: 'solana' })).toEqual([]);
  });

  it('parse Ethplorer: ETH dilewati, token tanpa harga tetap disimpan', () => {
    const out = parseEthplorerTokens({
      tokens: [
        { tokenInfo: { address: '0xabc', symbol: 'ETH', name: 'Ether', decimals: '18', price: { rate: 2500 } }, balance: 1, rawBalance: '1000000000000000000' },
        { tokenInfo: { address: '0x514b9e5467b9eb811519e316263c9099eae546ca', symbol: 'PVC', name: 'Privacy Coin', decimals: '8', price: false }, balance: 1000000, rawBalance: '100000000000000' },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe('PVC');
    expect(out[0].amount).toBe('1000000');
    expect(out[0].price_usd).toBeNull();
    expect(out[0].meta.token_id).toBe('0x514b9e5467b9eb811519e316263c9099eae546ca');
  });

  it('Ethplorer memakai cache 10 menit (hemat freekey)', async () => {
    process.env.ETHPLORER_INTERVAL = '600000';
    const fn = stubEthplorer([]);
    const p = new EthplorerProvider();
    const wallet = { id: 2, label: 'EVM', address: EVM, network_type: 'evm' as const };
    await p.fetchPositions(wallet);
    await p.fetchPositions(wallet);
    expect(fn.mock.calls.length).toBe(1);
  });

  it('dedupe keyless: satu baris per chain+simbol sesuai prioritas', () => {
    const { kept, dropped } = dedupeEvmKeyless([
      pos({ protocol: 'ethplorer', symbol: 'ETH', amount: '9' }),
      pos({ protocol: 'evm-rpc', symbol: 'ETH', amount: '0.0128' }),
      pos({ protocol: 'blockscout', symbol: 'ETH', amount: '0.0128' }),
      pos({ protocol: 'ethplorer', symbol: 'PVC', amount: '1000000' }),
      pos({ protocol: 'debank', symbol: 'ETH', amount: '5' }),
      pos({ chain_id: 'hypercore', protocol: 'hyperliquid-spot', symbol: 'HYPE', amount: '2' }),
    ]);
    // ETH eth: blockscout menang; PVC eth: ethplorer; debank & hypercore utuh.
    expect(dropped).toBe(2);
    const eth = kept.filter((k) => k.chain_id === 'eth' && k.symbol === 'ETH');
    expect(eth).toHaveLength(2); // blockscout + debank (debank bukan keyless)
    expect(eth.find((e) => e.protocol === 'blockscout')).toBeDefined();
    expect(kept.find((k) => k.symbol === 'PVC')?.protocol).toBe('ethplorer');
    expect(kept).toHaveLength(4);
  });
});
