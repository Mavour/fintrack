import { z } from 'zod';
import { providerFetch, normalizeList, throwForStatus, type WalletProvider, type WalletRef, type NormalizedPosition } from './walletTypes.js';
import { resolveTokens } from './tokenMeta.js';
import { logger } from '../logger.js';
import { redactAddress } from '../services/address.js';

/**
 * Fallback saldo token Solana bila Jupiter Portfolio gagal / key belum ada:
 * RPC getTokenAccountsByOwner (jsonParsed) untuk KEDUA program token
 * (SPL Token + Token-2022) + SOL native via getBalance, lalu harga Jupiter
 * Price API v3. Symbol asli di-resolve via Jupiter/DexScreener/GeckoTerminal
 * sehingga menyatu dengan aset manual (dedup by mint). RPC default
 * mainnet-beta, bisa dioverride via SOLANA_RPC_URL.
 */

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

const RpcAny = z.object({ result: z.object({ value: z.unknown() }).passthrough() }).passthrough();

const PriceV3 = z.record(z.object({ usdPrice: z.number().optional() }).passthrough());

export class SolanaRpcFallbackProvider implements WalletProvider {
  readonly name = 'solana-rpc-fallback';
  constructor(private rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com') {}

  async fetchPositions(wallet: WalletRef): Promise<NormalizedPosition[]> {
    if (wallet.network_type !== 'solana') return [];

    const tokens = new Map<string, { total: number; decimals: number }>();
    for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      await this.addTokenAccounts(wallet.address, program, tokens);
    }
    // Native SOL masuk sebagai token (digabung dengan wSOL bila ada, bukan dobel).
    const lamports = await this.nativeBalance(wallet.address);
    if (lamports > 0) {
      const sol = lamports / 10 ** 9;
      const cur = tokens.get(WRAPPED_SOL);
      if (cur) cur.total += sol;
      else tokens.set(WRAPPED_SOL, { total: sol, decimals: 9 });
    }

    const mints = [...tokens.keys()];
    const prices = await this.prices(mints.slice(0, 50));
    const metaByMint = await resolveTokens(mints).catch(() => new Map<string, { symbol: string; name: string; source: string }>());

    const raw: unknown[] = [];
    for (const [mint, { total, decimals }] of tokens) {
      if (!(total > 0)) continue;
      const usd = prices.get(mint);
      const meta = metaByMint.get(mint);
      const isSol = mint === WRAPPED_SOL;
      raw.push({
        chain_id: 'solana',
        kind: 'token',
        protocol: 'solana-rpc',
        symbol: (meta?.symbol ?? (isSol ? 'SOL' : mint)).slice(0, 40),
        name: meta?.name ?? (isSol ? 'Solana' : `Token Solana (${mint.slice(0, 4)})`),
        amount: String(Number(total.toFixed(decimals))),
        price_usd: usd ?? null,
        value_usd: usd !== undefined ? total * usd : null,
        meta: {
          mint,
          decimals,
          source: isSol ? 'native' : (meta?.source ?? 'unknown'),
        },
      });
    }
    logger.info({ wallet: redactAddress(wallet.address), count: raw.length }, 'solana rpc fallback fetched');
    return normalizeList(raw, this.name);
  }

  private async addTokenAccounts(
    address: string,
    program: string,
    out: Map<string, { total: number; decimals: number }>,
  ): Promise<void> {
    const res = await providerFetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [address, { programId: program }, { encoding: 'jsonParsed' }],
      }),
    });
    throwForStatus(res, 'solana-rpc');
    const json: unknown = await res.json();
    const parsed = RpcAny.safeParse(json);
    if (!parsed.success) throw Object.assign(new Error('Respons RPC Solana tidak sesuai skema'), { statusCode: 502 });
    const val = Array.isArray(parsed.data.result.value) ? parsed.data.result.value : [];
    for (const v of val as Array<Record<string, unknown>>) {
      const info = (v?.account as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
      const p = info?.parsed as Record<string, unknown> | undefined;
      const m = p?.info as Record<string, unknown> | undefined;
      const ta = m?.tokenAmount as Record<string, unknown> | undefined;
      if (!m?.mint || !ta) continue;
      const qty = Number(ta.uiAmountString ?? ta.uiAmount ?? 0);
      if (!(qty > 0)) continue;
      const cur = out.get(String(m.mint));
      if (cur) cur.total += qty;
      else out.set(String(m.mint), { total: qty, decimals: Number(ta.decimals ?? 0) });
    }
  }

  private async nativeBalance(address: string): Promise<number> {
    try {
      const res = await providerFetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] }),
      });
      if (!res.ok) return 0;
      const json: unknown = await res.json();
      const parsed = RpcAny.safeParse(json);
      if (!parsed.success) return 0;
      const v = parsed.data.result.value;
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  }

  private async prices(mints: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (mints.length === 0) return out;
    try {
      const res = await providerFetch(`https://lite-api.jup.ag/price/v3?ids=${mints.join(',')}`, {}, 10_000);
      if (!res.ok) return out;
      const json: unknown = await res.json();
      const parsed = PriceV3.safeParse(json);
      if (!parsed.success) return out;
      for (const [mint, v] of Object.entries(parsed.data)) {
        if (typeof v.usdPrice === 'number') out.set(mint, v.usdPrice);
      }
    } catch {
      // Prices optional — amounts still sync, value stays null.
    }
    return out;
  }
}