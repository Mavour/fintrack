import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { PublicKey } from '@solana/web3.js';
import { afterEach, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/server/db/database.js';
import { fetchDlmmPositionDetails } from '../src/server/providers/meteoraDlmm.js';
import { listDlmmMonitor, refreshDlmmMonitor } from '../src/server/services/meteoraDlmmMonitor.js';
import { createWallet, deleteWallet, updateWallet } from '../src/server/services/walletRegistry.js';
import { listLp, lpSummary } from '../src/server/services/walletRead.js';

const pubkey = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('loads the published SDK and reads a verified empty result through the configured Solana RPC', async () => {
  const endpoint = 'https://solana.example.test';
  vi.stubEnv('SOLANA_RPC_URL', endpoint);
  const clock = { executable: false, owner: '11111111111111111111111111111111', lamports: 1,
    data: [Buffer.alloc(40).toString('base64'), 'base64'], rentEpoch: 0 };
  const rpc = vi.fn(async (url: string, init: RequestInit) => {
    expect(new URL(url).origin).toBe(endpoint);
    const { id, method } = JSON.parse(String(init.body));
    const result = method === 'getProgramAccounts' ? [] : { context: { slot: 1 }, value: [clock] };
    return Response.json({ jsonrpc: '2.0', id, result });
  });
  vi.stubGlobal('fetch', rpc);
  await expect(fetchDlmmPositionDetails(pubkey(1).toBase58())).resolves.toEqual([]);
  expect(rpc.mock.calls.map(([, options]) => JSON.parse(String(options.body)).method)).toEqual(['getProgramAccounts', 'getMultipleAccounts']);
});

it('tracks individual positions, fees and snapshot recovery without changing aggregated LP', async () => {
  vi.useFakeTimers();
  const sdk = createRequire(import.meta.url)('@meteora-ag/dlmm');
  const owner = pubkey(1);
  const pool = pubkey(2);
  const range = (address: number, lowerBinId: number, upperBinId: number) => ({
    publicKey: pubkey(address),
    positionData: { owner, lowerBinId, upperBinId, feeX: 1250n, feeY: 0n },
  });
  const read = vi.spyOn(sdk, 'getAllLbPairPositionsByUser').mockResolvedValue(new Map([[pool.toBase58(), {
    publicKey: pool,
    lbPair: { activeId: 0 },
    tokenX: { mint: { address: pubkey(3), decimals: 3 } },
    tokenY: { mint: { address: pubkey(4), decimals: 6 } },
    lbPairPositionsData: [range(5, -5, 0), range(6, 0, 8), range(7, 1, 8)],
  }]]));
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    const wallet = createWallet(db, 'Uji', owner.toBase58(), 'solana');
    db.prepare(`INSERT INTO lp_positions (wallet_id, pool_address, pair, protocol, chain_id, position_value_usd, unclaimed_fees_usd)
      VALUES (?, ?, 'X/Y', 'Meteora DLMM', 'solana', 100, 2)`).run(wallet.id, pool.toBase58());
    const snapshots = () => listDlmmMonitor(db, listLp(db));
    expect(snapshots()[0].state).toBe('pending');
    const total = lpSummary(db);
    await Promise.all([refreshDlmmMonitor(db, wallet), refreshDlmmMonitor(db, wallet)]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(snapshots()[0]).toMatchObject({ state: 'ready', positions: [5, 6, 7].map((address) => ({
      position_address: pubkey(address).toBase58(), pair: 'X/Y', active_bin: 0,
      in_range: address !== 7, fee_x: '1.25', fee_y: '0',
    })) });
    expect(lpSummary(db)).toEqual(total);

    vi.advanceTimersByTime(60_000);
    read.mockRejectedValueOnce(new Error('RPC offline'));
    await refreshDlmmMonitor(db, wallet);
    expect(snapshots()[0].state).toBe('stale');
    expect(snapshots()[0].positions).toHaveLength(3);

    vi.advanceTimersByTime(60_000);
    read.mockResolvedValueOnce(new Map());
    await refreshDlmmMonitor(db, wallet);
    expect(snapshots()[0]).toMatchObject({ state: 'ready', positions: [] });

    const changed = updateWallet(db, wallet.id, { address: pubkey(8).toBase58() });
    await refreshDlmmMonitor(db, wallet, fetchDlmmPositionDetails);
    expect(snapshots()[0].state).toBe('pending');
    await refreshDlmmMonitor(db, changed, async () => { throw new Error('Unavailable'); });
    expect(snapshots()[0].state).toBe('unavailable');
    deleteWallet(db, wallet.id);
    expect(snapshots()).toEqual([]);
  } finally { db.close(); }
});
