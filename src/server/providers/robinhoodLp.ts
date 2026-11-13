import { Decimal } from 'decimal.js';
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, type Address } from 'viem';
import { robinhoodCalls, robinhoodTokenInfo, robinhoodTransfers } from './robinhood.js';
import { fetchDexPrices } from '../services/priceTier.js';
import type { NormalizedPosition, WalletProvider, WalletRef } from './walletTypes.js';

// https://developers.uniswap.org/docs/protocols/v4/deployments#robinhood-chain-4663
export const RH_V4_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7';
export const RH_V3_MANAGER = '0x73991a25c818bf1f1128deaab1492d45638de0d3';
const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const ZERO = '0x0000000000000000000000000000000000000000';
export const RH_LP_ABI = parseAbi([
  'function ownerOf(uint256) view returns(address)',
  'function getPositionLiquidity(uint256) view returns(uint128)',
  'function getPoolAndPositionInfo(uint256) view returns((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),uint256)',
  'function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)',
  'function getPositionInfo(bytes32,address,int24,int24,bytes32) view returns(uint128,uint256,uint256)',
  'function getFeeGrowthInside(bytes32,int24,int24) view returns(uint256,uint256)',
  'function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
  'function factory() view returns(address)',
  'function getPool(address,address,uint24) view returns(address)',
  'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function feeGrowthGlobal0X128() view returns(uint256)',
  'function feeGrowthGlobal1X128() view returns(uint256)',
  'function ticks(int24) view returns(uint128,int128,uint256,uint256,int56,uint160,uint32,bool)',
]);
const D = Decimal.clone({ precision: 80 });
const Q96 = 1n << 96n;
const Q128 = 1n << 128n;
const lpCache = new Map<string, { at: number; positions: NormalizedPosition[] }>();
export function resetRobinhoodLpCache(): void { lpCache.clear(); }

/** Raw withdrawable principal, rounded down just like LiquidityAmounts. */
export function concentratedAmounts(liquidity: bigint, sqrtPrice: bigint, lower: number, upper: number): [bigint, bigint] {
  if (lower >= upper || lower < -887272 || upper > 887272 || sqrtPrice <= 0n) throw new Error('Range LP tidak valid');
  const a = new D('1.0001').pow(new D(lower).div(2)).mul(Q96.toString()).ceil();
  const b = new D('1.0001').pow(new D(upper).div(2)).mul(Q96.toString()).ceil();
  const current = new D(sqrtPrice.toString());
  const p = D.max(a, D.min(b, current));
  const l = new D(liquidity.toString());
  return [BigInt(l.mul(Q96.toString()).mul(b.sub(p)).div(b.mul(p)).floor().toFixed(0)),
    BigInt(l.mul(p.sub(a)).div(Q96.toString()).floor().toFixed(0))];
}

export function accruedFees(liquidity: bigint, inside: bigint, last: bigint): bigint {
  return BigInt.asUintN(256, inside - last) * liquidity / Q128;
}

type LpState = { manager: string; id: bigint; pool: string; tokens: [string, string]; lower: number; upper: number;
  tick: number; liquidity: bigint; sqrtPrice: bigint; fees: [bigint, bigint]; version: 3 | 4 };

async function read(to: string, functionName: (typeof RH_LP_ABI)[number]['name'], args: readonly unknown[], block: string): Promise<unknown> {
  const data = encodeFunctionData({ abi: RH_LP_ABI, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  const [raw] = await robinhoodCalls([{ to, data }], block);
  if (!raw || raw === '0x') throw new Error(`Pembacaan LP Robinhood ${functionName} gagal`);
  return decodeFunctionResult({ abi: RH_LP_ABI, functionName, data: raw });
}

async function readV4(manager: string, id: bigint, liquidity: bigint, block: string): Promise<LpState> {
  const [key, info] = await read(manager, 'getPoolAndPositionInfo', [id], block) as [
    { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }, bigint];
  const pool = keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'),
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  const lower = Number(BigInt.asIntN(24, info >> 8n));
  const upper = Number(BigInt.asIntN(24, info >> 32n));
  const [sqrtPrice, tick] = await read(STATE_VIEW, 'getSlot0', [pool], block) as [bigint, number];
  const salt = `0x${id.toString(16).padStart(64, '0')}`;
  const [storedL, last0, last1] = await read(STATE_VIEW, 'getPositionInfo', [pool, manager, lower, upper, salt], block) as [bigint, bigint, bigint];
  if (storedL !== liquidity) throw new Error('Likuiditas LP Robinhood tidak konsisten');
  const [inside0, inside1] = await read(STATE_VIEW, 'getFeeGrowthInside', [pool, lower, upper], block) as [bigint, bigint];
  return { manager, id, pool, tokens: [key.currency0.toLowerCase(), key.currency1.toLowerCase()], lower, upper,
    sqrtPrice, tick, liquidity, fees: [accruedFees(liquidity, inside0, last0), accruedFees(liquidity, inside1, last1)], version: 4 };
}

async function readV3(manager: string, id: bigint, p: readonly unknown[], block: string): Promise<LpState> {
  const [, , token0, token1, fee, lower, upper, liquidity, last0, last1, owed0, owed1] = p as
    [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];
  const factory = await read(manager, 'factory', [], block) as Address;
  const pool = await read(factory, 'getPool', [token0, token1, fee], block) as Address;
  const [sqrtPrice, tick] = await read(pool, 'slot0', [], block) as [bigint, number];
  const global0 = await read(pool, 'feeGrowthGlobal0X128', [], block) as bigint;
  const global1 = await read(pool, 'feeGrowthGlobal1X128', [], block) as bigint;
  const lo = await read(pool, 'ticks', [lower], block) as [bigint, bigint, bigint, bigint];
  const hi = await read(pool, 'ticks', [upper], block) as [bigint, bigint, bigint, bigint];
  const inside = (global: bigint, low: bigint, high: bigint) => BigInt.asUintN(256,
    global - (tick >= lower ? low : BigInt.asUintN(256, global - low)) - (tick < upper ? high : BigInt.asUintN(256, global - high)));
  return { manager, id, pool, tokens: [token0.toLowerCase(), token1.toLowerCase()], lower, upper, liquidity, sqrtPrice, tick,
    fees: [owed0 + accruedFees(liquidity, inside(global0, lo[2], hi[2]), last0),
      owed1 + accruedFees(liquidity, inside(global1, lo[3], hi[3]), last1)], version: 3 };
}

/** Directly owned official Uniswap v3/v4 NFTs. Custodial staking/other DEXes
 * require their own ownership adapters and are not inferred from past transfers. */
export class RobinhoodLpProvider implements WalletProvider {
  readonly name = 'robinhood-lp';
  async fetchPositions(wallet: WalletRef): Promise<NormalizedPosition[]> {
    if (wallet.network_type !== 'evm') return [];
    const cacheKey = `${process.env.ROBINHOOD_RPC_URL ?? ''}:${wallet.address.toLowerCase()}`;
    const cached = lpCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 60_000) return cached.positions;
    const { block, logs } = await robinhoodTransfers(wallet);
    const candidates = [...new Map(logs.filter((l) => l.topics.length === 4 &&
      [RH_V3_MANAGER, RH_V4_MANAGER].includes(l.address.toLowerCase()))
      .map((l) => [`${l.address.toLowerCase()}:${l.topics[3]}`, { manager: l.address.toLowerCase(), id: BigInt(l.topics[3]) }])).values()];
    const owners = await robinhoodCalls(candidates.map((p) => ({ to: p.manager,
      data: encodeFunctionData({ abi: RH_LP_ABI, functionName: 'ownerOf', args: [p.id] }) })), block);
    const owned = candidates.filter((_, i) => owners[i] && owners[i] !== '0x' &&
      decodeFunctionResult({ abi: RH_LP_ABI, functionName: 'ownerOf', data: owners[i]! }).toLowerCase() === wallet.address.toLowerCase());
    const details = await robinhoodCalls(owned.map((p) => ({ to: p.manager,
      data: encodeFunctionData({ abi: RH_LP_ABI, functionName: p.manager === RH_V4_MANAGER ? 'getPositionLiquidity' : 'positions', args: [p.id] }) })), block);
    const states: LpState[] = [];
    for (let i = 0; i < owned.length; i++) {
      const p = owned[i]; const raw = details[i];
      if (!raw || raw === '0x') throw new Error('Detail NFT LP Robinhood tidak tersedia');
      if (p.manager === RH_V4_MANAGER) {
        const liquidity = decodeFunctionResult({ abi: RH_LP_ABI, functionName: 'getPositionLiquidity', data: raw });
        if (liquidity > 0n) states.push(await readV4(p.manager, p.id, liquidity, block));
      } else {
        const data = decodeFunctionResult({ abi: RH_LP_ABI, functionName: 'positions', data: raw });
        if (data[7] > 0n) states.push(await readV3(p.manager, p.id, data, block));
      }
    }
    if (!states.length) { lpCache.set(cacheKey, { at: Date.now(), positions: [] }); return []; }
    const contracts = [...new Set(states.flatMap((p) => p.tokens))];
    const info = await robinhoodTokenInfo(contracts.filter((c) => c !== ZERO), block);
    info.set(ZERO, { decimals: 18, symbol: 'ETH' });
    const prices = await fetchDexPrices('robinhood', contracts.map((c) => c === ZERO ? WETH : c));
    if (prices.has(WETH)) prices.set(ZERO, prices.get(WETH)!);
    const positions: NormalizedPosition[] = states.map((p) => {
      const amounts = concentratedAmounts(p.liquidity, p.sqrtPrice, p.lower, p.upper);
      const value = (raw: [bigint, bigint]): number | null => {
        let total = new D(0);
        for (let i = 0; i < 2; i++) {
          if (!raw[i]) continue;
          const price = prices.get(p.tokens[i]);
          if (price === undefined) return null;
          total = total.add(new D(raw[i].toString()).div(new D(10).pow(info.get(p.tokens[i])!.decimals)).mul(price));
        }
        return total.toNumber();
      };
      const principal = value(amounts), fees = value(p.fees);
      const pair = p.tokens.map((t) => info.get(t)!.symbol).join('/');
      return { chain_id: 'robinhood', kind: 'lp', protocol: `Uniswap v${p.version}`, symbol: pair.slice(0, 40), name: pair.slice(0, 120),
        amount: '1', price_usd: null, value_usd: principal !== null && fees !== null ? principal + fees : null,
        meta: { pool_address: p.pool, pair, position_address: `${p.manager}:${p.id}`, token_id: p.id.toString(),
          position_manager: p.manager, position_value_usd: principal, unclaimed_fees_usd: fees, pool_tvl_usd: null,
          in_range: p.liquidity > 0n && p.tick >= p.lower && p.tick < p.upper, liquidity: p.liquidity.toString(),
          tick_lower: p.lower, tick_upper: p.upper, block_number: block,
          underlying: p.tokens.map((address, i) => ({ address, symbol: info.get(address)!.symbol,
            amount_raw: amounts[i].toString(), fees_raw: p.fees[i].toString(), decimals: info.get(address)!.decimals })) } };
    });
    lpCache.set(cacheKey, { at: Date.now(), positions });
    return positions;
  }
}
