import { Connection, PublicKey } from '@solana/web3.js';
import { createRequire } from 'node:module';
import { Decimal } from 'decimal.js';
import type { DlmmPosition } from '../../shared/meteoraDlmm.js';
import type { PositionInfo } from '@meteora-ag/dlmm';

const require = createRequire(import.meta.url);

export async function fetchDlmmPositionDetails(walletAddress: string): Promise<DlmmPosition[]> {
  const owner = new PublicKey(walletAddress);
  // The SDK's ESM build uses an extensionless Anchor directory import in Node.
  const DLMM = require('@meteora-ag/dlmm') as {
    getAllLbPairPositionsByUser(connection: Connection, owner: PublicKey): Promise<Map<string, PositionInfo>>;
  };
  const signal = AbortSignal.timeout(10_000);
  const connection = new Connection(process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com', {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: (url, init) => fetch(url, { ...init, signal }),
  });
  const pools = await DLMM.getAllLbPairPositionsByUser(connection, owner);
  const positions: DlmmPosition[] = [];
  for (const pool of pools.values()) {
    const activeBin = pool.lbPair.activeId;
    for (const { publicKey, positionData: data } of pool.lbPairPositionsData) {
      if (!data.owner.equals(owner)) continue;
      positions.push({
        pool_address: pool.publicKey.toBase58(),
        position_address: publicKey.toBase58(),
        lower_bin: data.lowerBinId,
        upper_bin: data.upperBinId,
        active_bin: activeBin,
        in_range: data.lowerBinId <= activeBin && activeBin <= data.upperBinId,
        token_x_mint: pool.tokenX.mint.address.toBase58(),
        token_y_mint: pool.tokenY.mint.address.toBase58(),
        fee_x: new Decimal(data.feeX.toString()).div(new Decimal(10).pow(pool.tokenX.mint.decimals)).toFixed(),
        fee_y: new Decimal(data.feeY.toString()).div(new Decimal(10).pow(pool.tokenY.mint.decimals)).toFixed(),
      });
    }
  }
  return positions.sort((left, right) => left.position_address.localeCompare(right.position_address));
}
