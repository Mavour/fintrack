import { z } from 'zod';
import { providerFetch, normalizeList, throwForStatus, type WalletProvider, type WalletRef, type NormalizedPosition } from './walletTypes.js';
import { logger } from '../logger.js';
import { redactAddress } from '../services/address.js';

/**
 * Solana adapter: Jupiter Portfolio API v1 (official, keyed).
 * GET {base}/positions/{address} with header x-api-key: $JUPITER_API_KEY.
 * Docs: https://dev.jup.ag/docs/portfolio (beta, Jupiter platforms only).
 * Do NOT use v2 (not public). Never scrape jup.ag/portfolio web pages.
 *
 * Response shape is validated tolerantly: v1 beta may evolve, so unknown
 * fields pass through and only the normalized subset is enforced.
 */

const JUP_BASE = 'https://api.jup.ag/portfolio/v1';

const JupTokenPosition = z.object({
  mint: z.string().optional(),
  address: z.string().optional(),
  symbol: z.string().optional(),
  name: z.string().optional(),
  amount: z.union([z.string(), z.number()]).optional(),
  uiAmount: z.union([z.string(), z.number()]).optional(),
  priceUsd: z.number().optional(),
  valueUsd: z.number().optional(),
}).passthrough();

const JupResponse = z.object({
  positions: z.array(JupTokenPosition).optional(),
  tokens: z.array(JupTokenPosition).optional(),
  staking: z.array(JupTokenPosition).optional(),
  data: z.array(JupTokenPosition).optional(),
}).passthrough();

function num(v: string | number | undefined): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return '0';
}

export class JupiterPortfolioProvider implements WalletProvider {
  readonly name = 'jupiter-portfolio-v1';
  constructor(private apiKey = process.env.JUPITER_API_KEY ?? '') {}

  async platforms(): Promise<unknown> {
    const res = await providerFetch(`${JUP_BASE}/platforms`, {
      headers: { 'x-api-key': this.apiKey, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Jupiter platforms HTTP ${res.status}`);
    return res.json();
  }

  async fetchPositions(wallet: WalletRef): Promise<NormalizedPosition[]> {
    if (wallet.network_type !== 'solana') return [];
    if (!this.apiKey) {
      throw Object.assign(new Error('JUPITER_API_KEY belum diisi — token Solana memakai fallback RPC'), {
        statusCode: 503,
      });
    }
    const res = await providerFetch(`${JUP_BASE}/positions/${wallet.address}`, {
      headers: { 'x-api-key': this.apiKey, Accept: 'application/json' },
    });
    throwForStatus(res, 'jupiter');
    const json: unknown = await res.json();
    const parsed = JupResponse.safeParse(json);
    if (!parsed.success) {
      throw Object.assign(new Error('Respons Jupiter Portfolio v1 tidak sesuai skema'), { statusCode: 502 });
    }
    const d = parsed.data;
    const tokens = d.positions ?? d.tokens ?? d.data ?? [];
    const staking = d.staking ?? [];
    const raw = [
      ...tokens.map((t) => ({
        chain_id: 'solana',
        kind: 'token' as const,
        protocol: 'jupiter',
        symbol: String(t.symbol ?? t.mint ?? '???').toUpperCase().slice(0, 40),
        name: String(t.name ?? ''),
        amount: num(typeof t.uiAmount !== 'undefined' ? t.uiAmount : t.amount),
        price_usd: typeof t.priceUsd === 'number' ? t.priceUsd : null,
        value_usd: typeof t.valueUsd === 'number' ? t.valueUsd : null,
        meta: { mint: t.mint ?? t.address ?? null },
      })),
      ...staking.map((t) => ({
        chain_id: 'solana',
        kind: 'staking' as const,
        protocol: 'jupiter-staking',
        symbol: String(t.symbol ?? 'STAKED').toUpperCase().slice(0, 40),
        name: String(t.name ?? ''),
        amount: num(typeof t.uiAmount !== 'undefined' ? t.uiAmount : t.amount),
        price_usd: typeof t.priceUsd === 'number' ? t.priceUsd : null,
        value_usd: typeof t.valueUsd === 'number' ? t.valueUsd : null,
        meta: { mint: t.mint ?? t.address ?? null },
      })),
    ];
    logger.info({ wallet: redactAddress(wallet.address), count: raw.length }, 'jupiter v1 positions fetched');
    return normalizeList(raw, this.name);
  }
}
