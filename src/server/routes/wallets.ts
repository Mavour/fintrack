import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { previewHoldings, PreviewQuerySchema } from '../services/walletService.js';
import { previewLp, LpPreviewQuery } from '../services/lpService.js';
import { EVM_CHAINS } from '../providers/evm.js';
import { getConfig } from '../config.js';
import { z } from 'zod';
import { WalletInputSchema, WalletPatchSchema } from '../services/address.js';
import { listWallets, createWallet, updateWallet, deleteWallet } from '../services/walletRegistry.js';
import { syncWallet, checkResyncCooldown, checkGlobalResyncCooldown } from '../services/walletSync.js';
import { listPositions, listLp, lpSummary, getSyncStatus, walletSyncHealth } from '../services/walletRead.js';
import { DebankProvider } from '../providers/debank.js';
import { getTierStatus, isIdleMode, triggerAllTiersNow } from '../services/tierScheduler.js';
import { unitsUsedLast24h, callsPerEndpoint24h, getCachedHyperCoverage } from '../services/debankMeter.js';

const LABELS: Record<string, string> = {
  solana: 'Solana (Jupiter)',
  eth: 'Ethereum',
  arb: 'Arbitrum',
  base: 'Base',
  op: 'Optimism',
  polygon: 'Polygon',
  hoodi: 'Hoodi Testnet',
};

export function registerWalletRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/wallets/chains', async () => {
    const keyless = new Set(['solana', ...EVM_CHAINS]);
    return {
      chains: ['solana', ...EVM_CHAINS, 'hoodi'].map((id) => ({
        id,
        label: LABELS[id] ?? id,
        needs_key: !keyless.has(id),
      })),
      etherscan_configured: getConfig().etherscanApiKey.length > 0,
    };
  });

  // Read-only preview — no writes except the shared token-metadata cache.
  app.get('/api/wallets/preview', async (req, reply) => {
    try {
      const q = PreviewQuerySchema.parse((req as { query: unknown }).query);
      return { holdings: await previewHoldings(db, q.chain, q.address, getConfig().etherscanApiKey) };
    } catch (e: unknown) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 400).send({ error: err.message ?? 'Pratinjau gagal' });
    }
  });

  // LP positions (Solana DeFi via Jupiter Portfolio).
  app.get('/api/wallets/lp-preview', async (req, reply) => {
    try {
      const q = LpPreviewQuery.parse((req as { query: unknown }).query);
      return { positions: await previewLp(db, q.address) };
    } catch (e: unknown) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 502).send({ error: err.message ?? 'Gagal memuat posisi LP' });
    }
  });

  // --- Wallet registry (CRUD, Akun & Bank > Wallet) ---
  app.get('/api/wallets/registry', async () => {
    const wallets = listWallets(db);
    const status = getSyncStatus(db);
    return { wallets, sync_status: status, health: walletSyncHealth(db) };
  });

  app.post('/api/wallets/registry', async (req, reply) => {
    try {
      const body = WalletInputSchema.parse(req.body);
      const row = createWallet(db, body.label, body.address, body.network_type);
      return reply.code(201).send(row);
    } catch (e: unknown) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 400).send({ error: err.message ?? 'Gagal menambah wallet' });
    }
  });

  app.patch('/api/wallets/registry/:id', async (req, reply) => {
    try {
      const params = z.object({ id: z.coerce.number().int() }).parse((req as { params: unknown }).params);
      const body = WalletPatchSchema.parse(req.body);
      return updateWallet(db, params.id, body);
    } catch (e: unknown) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 400).send({ error: err.message ?? 'Gagal mengubah wallet' });
    }
  });

  app.delete('/api/wallets/registry/:id', async (req, reply) => {
    try {
      const params = z.object({ id: z.coerce.number().int() }).parse((req as { params: unknown }).params);
      deleteWallet(db, params.id);
      return { ok: true };
    } catch (e: unknown) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 404).send({ error: err.message ?? 'Gagal menghapus wallet' });
    }
  });

  app.post('/api/wallets/registry/:id/sync', async (req, reply) => {
    try {
      const params = z.object({ id: z.coerce.number().int() }).parse((req as { params: unknown }).params);
      checkResyncCooldown(db, params.id, getConfig().walletSyncCooldownMs);
      return await syncWallet(db, params.id);
    } catch (e: unknown) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 502).send({ error: err.message ?? 'Sinkron gagal' });
    }
  });

  // --- Normalized positions (Token + LP & DeFi), dust < $1 hidden by default ---
  app.get('/api/wallets/positions', async (req) => {
    const q = z
      .object({
        wallet_id: z.coerce.number().int().optional(),
        kind: z.enum(['token', 'lp', 'staking', 'defi']).optional(),
        chain_id: z.string().max(40).optional(),
        show_all: z.coerce.boolean().optional().default(false),
        min_usd: z.coerce.number().min(0).max(1000000).optional().default(1),
      })
      .parse((req as { query: unknown }).query);
    return { positions: listPositions(db, q) };
  });

  // --- LP summary + rows: fees belum diklaim, TVL posisi, TVL pool. No PnL. ---
  app.get('/api/wallets/lp', async (req) => {
    const q = z
      .object({ wallet_id: z.coerce.number().int().optional(), chain_id: z.string().max(40).optional() })
      .parse((req as { query: unknown }).query);
    return { summary: lpSummary(db), positions: listLp(db, q) };
  });

  // --- Sync health + DeBank units (for topbar badge + quota warning) ---
  app.get('/api/wallets/status', async () => {
    let units_remaining: number | null = null;
    let debank_configured = getConfig().debankAccessKey.length > 0;
    if (debank_configured) {
      try {
        units_remaining = await new DebankProvider().unitsRemaining();
      } catch {
        units_remaining = null;
      }
    }
    const fx = db.prepare(`SELECT rate FROM fx_cache WHERE pair = 'USDIDR'`).get() as { rate: number } | undefined;
    return {
      health: walletSyncHealth(db),
      sync_status: getSyncStatus(db),
      tiers: getTierStatus(),
      usd_idr: fx?.rate ?? 16000,
      debank: {
        configured: debank_configured,
        units_remaining,
        budget: getConfig().debankDailyUnitBudget,
        used_24h: unitsUsedLast24h(db),
        calls_24h: callsPerEndpoint24h(db),
        hyper_coverage: getCachedHyperCoverage(db),
      },
    };
  });

  // --- Per-tier status (popover badge): last update + active interval ---
  app.get('/api/wallets/tiers', async () => {
    return { tiers: getTierStatus(), idle: isIdleMode() };
  });

  // --- Manual "Sinkron Ulang": picu semua tingkat sekaligus, cooldown 30 detik ---
  app.post('/api/wallets/sync-all', async (_req, reply) => {
    try {
      checkGlobalResyncCooldown(db, getConfig().walletSyncCooldownMs);
      const results = await triggerAllTiersNow(db);
      return { ok: true, results };
    } catch (e: unknown) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 502).send({ error: err.message ?? 'Sinkron gagal' });
    }
  });
}
