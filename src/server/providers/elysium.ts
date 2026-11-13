import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { providerFetch, throwForStatus, type NormalizedPosition, type WalletProvider, type WalletRef } from './walletTypes.js';

// Kinetiq Elysium mainnet; verified with eth_chainId on its public RPC.
export const ELYSIUM_CHAIN_ID = 99901;
const RPC = 'https://rpc.elysium.kinetiq.xyz';
const EXPLORER = 'https://elysium.kinetiq.xyz/api';
const Transfer = z.object({
  contractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  tokenSymbol: z.string().min(1), tokenName: z.string(),
  tokenDecimal: z.coerce.number().int().min(0).max(255),
});

async function rpc(method: string, params: unknown[]): Promise<string> {
  const res = await providerFetch(process.env.ELYSIUM_RPC_URL ?? RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  throwForStatus(res, 'elysium-rpc');
  const json = await res.json() as { result?: string; error?: { message?: string } };
  if (json.error || typeof json.result !== 'string' || !/^0x[\da-f]+$/i.test(json.result))
    throw new Error(`RPC Elysium ${method} gagal: ${json.error?.message ?? 'respons tidak valid'}`);
  return json.result;
}

/** Discover token contracts from transfers, then read CURRENT balanceOf at a
 * common block. Transfer sums are never used as balances. */
export class ElysiumProvider implements WalletProvider {
  readonly name = 'elysium';
  async fetchPositions(wallet: WalletRef): Promise<NormalizedPosition[]> {
    if (wallet.network_type !== 'evm') return [];
    if (BigInt(await rpc('eth_chainId', [])) !== BigInt(ELYSIUM_CHAIN_ID))
      throw new Error('RPC Elysium bukan mainnet Kinetiq chain 99901');
    const block = await rpc('eth_blockNumber', []);
    const native = await rpc('eth_getBalance', [wallet.address, block]);
    const tokens = new Map<string, z.infer<typeof Transfer>>();
    for (let page = 1; ; page++) {
      if (page > 100) throw new Error('Riwayat token Elysium terlalu panjang — snapshot lama dipertahankan');
      const url = new URL(EXPLORER);
      url.search = new URLSearchParams({ module: 'account', action: 'tokentx', address: wallet.address,
        page: String(page), offset: '1000', sort: 'desc' }).toString();
      const res = await providerFetch(url.toString());
      throwForStatus(res, 'elysium-explorer');
      const json = await res.json() as { status?: string; message?: string; result?: unknown };
      if (json.status === '0' && json.message === 'No token transfers found' && Array.isArray(json.result) && !json.result.length) break;
      if (json.status !== '1' || !Array.isArray(json.result)) throw new Error('Riwayat token Elysium tidak tersedia');
      for (const item of json.result) {
        const t = Transfer.parse(item);
        tokens.set(t.contractAddress.toLowerCase(), t);
      }
      if (json.result.length < 1000) break;
    }
    const out: NormalizedPosition[] = [];
    const add = (raw: string, decimals: number, symbol: string, name: string, token: string | null): void => {
      if (BigInt(raw) === 0n) return;
      out.push({ chain_id: 'elysium', kind: 'token', protocol: 'elysium', symbol: symbol.slice(0, 40),
        name: name.slice(0, 120), amount: new Decimal(BigInt(raw).toString()).div(new Decimal(10).pow(decimals)).toString(),
        price_usd: null, value_usd: null,
        meta: { token_id: token, chain_id: ELYSIUM_CHAIN_ID, ...(token ? {} : { coingecko_id: 'hyperliquid' }) } });
    };
    add(native, 18, 'HYPE', 'Elysium HYPE', null);
    for (const [contract, t] of tokens) {
      const data = `0x70a08231${wallet.address.slice(2).toLowerCase().padStart(64, '0')}`;
      const balance = await rpc('eth_call', [{ to: contract, data }, block]);
      add(balance, t.tokenDecimal, t.tokenSymbol, t.tokenName, contract);
    }
    return out;
  }
}
