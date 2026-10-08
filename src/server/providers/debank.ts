import { z } from 'zod';
import { providerFetch, normalizeList, throwForStatus, type WalletProvider, type WalletRef, type NormalizedPosition } from './walletTypes.js';
import { logger } from '../logger.js';
import { redactAddress } from '../services/address.js';

/**
 * EVM adapter: DeBank Cloud OpenAPI (official, keyed, EVM-only, bukan Solana).
 * Base https://pro-openapi.debank.com, header AccessKey: $DEBANK_ACCESS_KEY.
 * Docs: https://docs.cloud.debank.com/en/readme/open-api
 * Endpoints: /v1/user/all_token_list, /v1/user/all_complex_protocol_list,
 * /v1/user/total_balance, /v1/user/used_chain_list, /v1/chain/list,
 * /v1/account/units. Satu alamat EVM berlaku untuk semua chain EVM.
 */

const DEBANK_BASE = 'https://pro-openapi.debank.com';

const TokenItem = z.object({
  id: z.string().optional(),
  chain: z.string().optional(),
  symbol: z.string().optional(),
  name: z.string().optional(),
  amount: z.union([z.string(), z.number()]).optional(),
  price: z.number().optional(),
  price_24h_change: z.number().optional(),
}).passthrough();

const ProtocolItem = z.object({
  chain: z.string().optional(),
  protocol_id: z.string().optional(),
  name: z.string().optional(),
  portfolio_item_list: z.array(z.object({
    name: z.string().optional(),
    stats: z.object({ net_usd_value: z.number().optional() }).passthrough().optional(),
  }).passthrough()).optional(),
  net_usd_value: z.number().optional(),
}).passthrough();

export interface DebankBudget {
  unitsRemaining: number | null;
  budget: number;
  blocked: boolean;
}

export class DebankProvider implements WalletProvider {
  readonly name = 'debank';
  constructor(
    private accessKey = process.env.DEBANK_ACCESS_KEY ?? '',
    private budget = Number(process.env.DEBANK_DAILY_UNIT_BUDGET ?? 0),
    private onCall?: (endpoint: string) => void,
  ) {}

  private headers(): Record<string, string> {
    return { AccessKey: this.accessKey, Accept: 'application/json' };
  }

  private called(endpoint: string): void {
    try {
      this.onCall?.(endpoint);
    } catch {
      // Metering tidak boleh menggagalkan sync.
    }
  }

  private requireKey(): void {
    if (!this.accessKey) {
      throw Object.assign(new Error('DEBANK_ACCESS_KEY belum diisi — posisi EVM belum bisa disinkron'), {
        statusCode: 503,
      });
    }
  }

  async unitsRemaining(): Promise<number | null> {
    this.requireKey();
    try {
      this.called('/v1/account/units');
      const res = await providerFetch(`${DEBANK_BASE}/v1/account/units`, { headers: this.headers() });
      if (!res.ok) return null;
      const json = (await res.json()) as { units?: number; remaining?: number };
      return typeof json.units === 'number' ? json.units : typeof json.remaining === 'number' ? json.remaining : null;
    } catch {
      return null;
    }
  }

  async checkBudget(): Promise<DebankBudget> {
    if (!this.accessKey) return { unitsRemaining: null, budget: this.budget, blocked: true };
    if (!this.budget || this.budget <= 0) {
      const unitsRemaining = await this.unitsRemaining();
      return { unitsRemaining, budget: this.budget, blocked: false };
    }
    const unitsRemaining = await this.unitsRemaining();
    const blocked = unitsRemaining !== null && unitsRemaining <= 0;
    return { unitsRemaining, budget: this.budget, blocked };
  }

  async chainList(): Promise<Array<{ id: string; name: string }>> {
    this.requireKey();
    this.called('/v1/chain/list');
    const res = await providerFetch(`${DEBANK_BASE}/v1/chain/list`, { headers: this.headers() });
    throwForStatus(res, 'debank');
    const json = (await res.json()) as Array<{ id?: string; community_id?: number; name?: string }>;
    if (!Array.isArray(json)) throw Object.assign(new Error('Respons DeBank chain/list tidak sesuai skema'), { statusCode: 502 });
    return json.map((c) => ({ id: String(c.id ?? c.community_id ?? ''), name: String(c.name ?? '') }));
  }

  async fetchPositions(wallet: WalletRef): Promise<NormalizedPosition[]> {
    if (wallet.network_type !== 'evm') return [];
    this.requireKey();
    const addr = wallet.address;
    const raw: NormalizedPosition[] = [];

    // Token semua chain.
    {
      this.called('/v1/user/all_token_list');
      const res = await providerFetch(
        `${DEBANK_BASE}/v1/user/all_token_list?id=${addr}&is_all=false&has_balance=true`,
        { headers: this.headers() },
      );
      throwForStatus(res, 'debank');
      const json: unknown = await res.json();
      const list = Array.isArray(json) ? json : [];
      for (const t of list) {
        const p = TokenItem.safeParse(t);
        if (!p.success) {
          logger.warn('Respons DeBank: 1 token dilewati (skema)');
          continue;
        }
        const amount = Number(p.data.amount ?? 0);
        if (!(amount > 0)) continue;
        const price = typeof p.data.price === 'number' ? p.data.price : null;
        raw.push({
          chain_id: String(p.data.chain ?? 'eth'),
          kind: 'token',
          protocol: 'debank',
          symbol: String(p.data.symbol ?? p.data.id ?? '???').toUpperCase().slice(0, 40),
          name: String(p.data.name ?? ''),
          amount: String(p.data.amount ?? '0'),
          price_usd: price,
          value_usd: price !== null ? amount * price : null,
          meta: { token_id: p.data.id ?? null },
        });
      }
    }

    // LP / DeFi (complex protocol list). Tanpa PnL — hanya value + fees bila ada.
    {
      this.called('/v1/user/all_complex_protocol_list');
      const res = await providerFetch(`${DEBANK_BASE}/v1/user/all_complex_protocol_list?id=${addr}`, {
        headers: this.headers(),
      });
      if (res.status === 429) throwForStatus(res, 'debank');
      if (res.ok) {
        const json: unknown = await res.json();
        const list = Array.isArray(json) ? json : [];
        for (const t of list) {
          const p = ProtocolItem.safeParse(t);
          if (!p.success) {
            logger.warn('Respons DeBank: 1 protokol dilewati (skema)');
            continue;
          }
          const d = p.data;
          const items = d.portfolio_item_list ?? [];
          for (const item of items) {
            const v = item.stats?.net_usd_value ?? d.net_usd_value ?? null;
            raw.push({
              chain_id: String(d.chain ?? 'eth'),
              kind: 'lp',
              protocol: String(d.protocol_id ?? d.name ?? 'debank-defi'),
              symbol: String(item.name ?? d.name ?? 'LP').toUpperCase().slice(0, 40),
              name: String(item.name ?? d.name ?? ''),
              amount: '1',
              price_usd: v,
              value_usd: v,
              meta: { protocol_id: d.protocol_id ?? null, position_value_usd: v, unclaimed_fees_usd: null, pool_tvl_usd: null, in_range: null, position_address: '' },
            });
          }
        }
      }
    }

    logger.info({ wallet: redactAddress(addr), count: raw.length }, 'debank positions fetched');
    return normalizeList(raw, this.name);
  }
}
