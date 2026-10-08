import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { isAddress } from 'viem';

/**
 * Address validation (read-only, no keys/signatures anywhere).
 * - Solana: PublicKey dari @solana/web3.js (menolak base58 invalid / panjang salah).
 * - EVM: isAddress dari viem (0x + 40 hex, checksum-aware).
 */

export const NetworkTypeSchema = z.enum(['solana', 'evm']);
export type NetworkType = z.infer<typeof NetworkTypeSchema>;

export function isSolanaAddress(addr: string): boolean {
  try {
    const k = new PublicKey(addr);
    // PublicKey accepts base58 curve points; require canonical 32-byte form.
    return k.toBase58() === addr;
  } catch {
    return false;
  }
}

export function isEvmAddress(addr: string): boolean {
  try {
    return isAddress(addr);
  } catch {
    return false;
  }
}

/** Auto-detect network from address format. Throws 400 when unknown. */
export function detectNetworkType(address: string): NetworkType {
  if (isEvmAddress(address)) return 'evm';
  if (isSolanaAddress(address)) return 'solana';
  throw Object.assign(new Error('Format alamat tidak dikenal (bukan Solana/EVM)'), { statusCode: 400 });
}

/** Validate address matches the claimed network. Throws 400 otherwise. */
export function assertValidAddress(address: string, network?: NetworkType): NetworkType {
  const detected = detectNetworkType(address);
  if (network && network !== detected) {
    throw Object.assign(new Error(`Alamat tidak cocok untuk jaringan ${network}`), { statusCode: 400 });
  }
  return detected;
}

/** Short display form: 3keq…iXpd. Never hides via privat mode (spec). */
export function shortAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** Redact for logs: keep first 4 + last 2 only. */
export function redactAddress(address: string): string {
  if (address.length <= 8) return '***';
  return `${address.slice(0, 4)}***${address.slice(-2)}`;
}

export const WalletInputSchema = z.object({
  label: z.string().max(60).default(''),
  address: z.string().min(26).max(50),
  network_type: NetworkTypeSchema.optional(),
});

export const WalletPatchSchema = z.object({
  label: z.string().max(60).optional(),
  address: z.string().min(26).max(50).optional(),
});
