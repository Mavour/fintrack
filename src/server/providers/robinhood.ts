import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { decodeFunctionResult, encodeFunctionData, hexToString, parseAbi, type Address, type Hex } from 'viem';
import { providerFetch, throwForStatus, type NormalizedPosition, type WalletProvider, type WalletRef } from './walletTypes.js';

// Robinhood Chain MAINNET, not the Robinhood Wallet app or testnet.
export const ROBINHOOD_CHAIN_ID = 4663;
const RPC = 'https://robinhood.rpc.pinax.network';
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TransferLog = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  topics: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)), removed: z.boolean().optional() });
export const ROBINHOOD_TOKEN_ABI = parseAbi(['function balanceOf(address) view returns(uint256)',
  'function decimals() view returns(uint8)', 'function symbol() view returns(string)']);
export const RH_MULTICALL_ABI = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns((bool success,bytes returnData)[])']);
const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11';
const discoveryCache = new Map<string, { at: number; block: string; logs: z.infer<typeof TransferLog>[] }>();
const tokenCache = new Map<string, { at: number; positions: NormalizedPosition[] }>();
export function resetRobinhoodCache(): void { discoveryCache.clear(); tokenCache.clear(); }

async function request(body: unknown): Promise<unknown> {
  const res = await providerFetch(process.env.ROBINHOOD_RPC_URL ?? RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, 30_000);
  throwForStatus(res, 'robinhood-rpc');
  return res.json();
}

async function rpc(method: string, params: unknown[]): Promise<string> {
  const json = await request({ jsonrpc: '2.0', id: 1, method, params }) as { result?: string; error?: { message?: string } };
  if (json.error || typeof json.result !== 'string' || !/^0x[\da-f]+$/i.test(json.result))
    throw new Error(`RPC Robinhood ${method} gagal: ${json.error?.message ?? 'respons tidak valid'}`);
  return json.result;
}

/** Multicall3 reads only: one eth_call per 100 contracts. Null denotes a
 * failed subcall (e.g. burned NFT); RPC/transport failures throw. */
export async function robinhoodCalls(calls: Array<{ to: string; data: Hex }>, block: string): Promise<Array<Hex | null>> {
  const out: Array<Hex | null> = [];
  for (let start = 0; start < calls.length; start += 100) {
    const batch = calls.slice(start, start + 100);
    const data = encodeFunctionData({ abi: RH_MULTICALL_ABI, functionName: 'aggregate3', args: [
      batch.map((c) => ({ target: c.to as Address, allowFailure: true, callData: c.data })),
    ] });
    const raw = await rpc('eth_call', [{ to: MULTICALL, data }, block]);
    const results = decodeFunctionResult({ abi: RH_MULTICALL_ABI, functionName: 'aggregate3', data: raw as Hex });
    if (results.length !== batch.length) throw new Error('Batch RPC Robinhood tidak lengkap');
    out.push(...results.map((r) => r.success ? r.returnData : null));
  }
  return out;
}

/** Discover incoming ERC-20/ERC-721 transfers; balances are always read on-chain.
 * Shared by token and LP readers, at most once/minute per wallet. */
export async function robinhoodTransfers(wallet: WalletRef) {
  const key = `${process.env.ROBINHOOD_RPC_URL ?? RPC}:${wallet.address.toLowerCase()}`;
  const cached = discoveryCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached;
  const block = await blockNumber();
  const json = await request({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: block,
    topics: [TRANSFER_TOPIC, null, `0x${wallet.address.slice(2).toLowerCase().padStart(64, '0')}`] }] }) as { result?: unknown; error?: { message?: string } };
  if (json.error || !Array.isArray(json.result)) throw new Error(`Discovery Robinhood gagal: ${json.error?.message ?? 'log tidak tersedia'}`);
  // Fail closed on common result caps; never call a potentially truncated history complete.
  if (json.result.length >= 10_000) throw new Error('Riwayat Robinhood mencapai batas log — snapshot lama dipertahankan');
  const result = { at: Date.now(), block, logs: json.result.map((r) => TransferLog.parse(r)).filter((r) => !r.removed) };
  discoveryCache.set(key, result);
  return result;
}

export async function robinhoodTokenInfo(contracts: string[], block: string): Promise<Map<string, { symbol: string; decimals: number }>> {
  const raw = await robinhoodCalls(contracts.flatMap((to) => [
    { to, data: encodeFunctionData({ abi: ROBINHOOD_TOKEN_ABI, functionName: 'decimals' }) },
    { to, data: encodeFunctionData({ abi: ROBINHOOD_TOKEN_ABI, functionName: 'symbol' }) },
  ]), block);
  const out = new Map<string, { symbol: string; decimals: number }>();
  for (let i = 0; i < contracts.length; i++) {
    const decimalsRaw = raw[i * 2];
    if (!decimalsRaw || decimalsRaw === '0x') throw new Error(`Decimals token Robinhood tidak tersedia: ${contracts[i]}`);
    const decimals = Number(decodeFunctionResult({ abi: ROBINHOOD_TOKEN_ABI, functionName: 'decimals', data: decimalsRaw }));
    let symbol = contracts[i].slice(0, 10);
    const symbolRaw = raw[i * 2 + 1];
    if (symbolRaw && symbolRaw !== '0x') {
      try { symbol = decodeFunctionResult({ abi: ROBINHOOD_TOKEN_ABI, functionName: 'symbol', data: symbolRaw }); }
      catch { if (symbolRaw.length === 66) symbol = hexToString(symbolRaw).replace(/\0+$/, ''); }
    }
    out.set(contracts[i].toLowerCase(), { decimals, symbol: symbol.slice(0, 40) || contracts[i].slice(0, 10) });
  }
  return out;
}

async function blockNumber(): Promise<string> {
  if (BigInt(await rpc('eth_chainId', [])) !== BigInt(ROBINHOOD_CHAIN_ID))
    throw new Error('RPC Robinhood bukan mainnet chain 4663');
  return rpc('eth_blockNumber', []);
}

function position(raw: string, decimals: number, symbol: string, name: string, token: string | null): NormalizedPosition {
  return { chain_id: 'robinhood', kind: 'token', protocol: 'robinhood', symbol: symbol.slice(0, 40),
    name: name.slice(0, 120), amount: new Decimal(BigInt(raw).toString()).div(new Decimal(10).pow(decimals)).toString(),
    price_usd: null, value_usd: null,
    meta: { token_id: token, chain_id: ROBINHOOD_CHAIN_ID, ...(token ? {} : { coingecko_id: 'ethereum' }) } };
}

// Independent snapshots: an unavailable token indexer must not hide native ETH
// or replace previously discovered ERC-20 balances with an empty result.
export class RobinhoodNativeProvider implements WalletProvider {
  readonly name = 'robinhood-native';
  async fetchPositions(wallet: WalletRef): Promise<NormalizedPosition[]> {
    if (wallet.network_type !== 'evm') return [];
    const block = await blockNumber();
    const balance = await rpc('eth_getBalance', [wallet.address, block]);
    return BigInt(balance) === 0n ? [] : [position(balance, 18, 'ETH', 'Robinhood ETH', null)];
  }
}

export class RobinhoodTokenProvider implements WalletProvider {
  readonly name = 'robinhood-tokens';
  async fetchPositions(wallet: WalletRef): Promise<NormalizedPosition[]> {
    if (wallet.network_type !== 'evm') return [];
    const key = `${process.env.ROBINHOOD_RPC_URL ?? RPC}:${wallet.address.toLowerCase()}`;
    const cached = tokenCache.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.positions;
    const { block, logs } = await robinhoodTransfers(wallet);
    const contracts = [...new Set(logs.filter((l) => l.topics.length === 3).map((l) => l.address.toLowerCase()))];
    const balances = await robinhoodCalls(contracts.map((to) => ({ to, data: encodeFunctionData({
      abi: ROBINHOOD_TOKEN_ABI, functionName: 'balanceOf', args: [wallet.address as Address],
    }) })), block);
    const nonzero = contracts.filter((_, i) => balances[i] && balances[i] !== '0x' && BigInt(balances[i]!) > 0n);
    const info = await robinhoodTokenInfo(nonzero, block);
    const out: NormalizedPosition[] = [];
    for (const contract of nonzero) {
      const t = info.get(contract)!;
      out.push(position(balances[contracts.indexOf(contract)]!, t.decimals, t.symbol, t.symbol, contract));
    }
    tokenCache.set(key, { at: Date.now(), positions: out });
    return out;
  }
}
