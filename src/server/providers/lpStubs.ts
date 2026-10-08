import type { WalletProvider, WalletRef, NormalizedPosition } from './walletTypes.js';
import { logger } from '../logger.js';

/**
 * STUB: adapter Orca (Solana LP).
 * TODO: kerjakan hanya setelah endpoint resmi Orca terverifikasi
 * (docs/OpenAPI + satu respons contoh nyata sebagai fixture).
 * Saat ini selalu mengembalikan [] agar sync tidak mengarang data.
 */
export class OrcaStubProvider implements WalletProvider {
  readonly name = 'orca-stub';
  async fetchPositions(_wallet: WalletRef): Promise<NormalizedPosition[]> {
    logger.info('orca adapter stub — belum diimplementasikan (TODO: endpoint resmi)');
    return [];
  }
}

/**
 * STUB: adapter Raydium (Solana LP).
 * TODO: kerjakan hanya setelah endpoint resmi Raydium terverifikasi
 * (docs/OpenAPI + satu respons contoh nyata sebagai fixture).
 * Saat ini selalu mengembalikan [] agar sync tidak mengarang data.
 */
export class RaydiumStubProvider implements WalletProvider {
  readonly name = 'raydium-stub';
  async fetchPositions(_wallet: WalletRef): Promise<NormalizedPosition[]> {
    logger.info('raydium adapter stub — belum diimplementasikan (TODO: endpoint resmi)');
    return [];
  }
}
