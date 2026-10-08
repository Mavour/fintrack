import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedWallets, listWallets } from '../src/server/services/walletRegistry.js';
import { commitPositions } from '../src/server/services/walletSync.js';
import { getUnifiedPortfolio, upsertAsset, setCostBasis } from '../src/server/services/portfolioService.js';
import { createWallet } from '../src/server/services/walletRegistry.js';
import { resetBreakers } from '../src/server/services/circuitBreaker.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function memDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'src', 'server', 'db', 'schema.sql'), 'utf-8'));
  db.prepare(`INSERT INTO fx_cache (pair, rate, fetched_at) VALUES ('USDIDR', 16000, datetime('now'))`).run();
  return db;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('demo guard: tidak ada data mock di jalur runtime', () => {
  it('seed-dummy menolak berjalan tanpa DEMO_MODE=true', () => {
    const env = { ...process.env };
    delete env.DEMO_MODE;
    const r = spawnSync('node', ['scripts/seed-dummy.mjs'], { cwd: ROOT, encoding: 'utf-8', env });
    expect(r.status).toBe(2);
    expect(String(r.stderr)).toMatch(/DEMO_MODE/);
  });

  it('shot scripts menolak berjalan tanpa DEMO_MODE=true', () => {
    const env = { ...process.env };
    delete env.DEMO_MODE;
    for (const s of ['scripts/shot.mjs', 'scripts/shot-wallet.mjs']) {
      const r = spawnSync('node', [s], { cwd: ROOT, encoding: 'utf-8', env });
      expect(r.status).toBe(2);
    }
  });

  it('src/ tidak mengandung literal data demo', () => {
    const forbidden = ['Met Dummy', 'dummyAssets', 'seed-dummy', 'Warung', 'Gaji Okt'];
    const hits: string[] = [];
    for (const f of walkTs(path.join(ROOT, 'src'))) {
      const content = fs.readFileSync(f, 'utf-8');
      for (const lit of forbidden) {
        if (content.includes(lit)) hits.push(`${path.relative(ROOT, f)}: ${lit}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('migrasi tidak meng-INSERT aset/posisi contoh', () => {
    const schema = fs.readFileSync(path.join(ROOT, 'src', 'server', 'db', 'schema.sql'), 'utf-8');
    expect(schema).not.toMatch(/INSERT INTO (assets|wallet_positions|price_cache)/);
  });
});

describe('e2e: seed -> sync -> portfolio terpadu', () => {
  it('wallet seed tampil, duplikat manual disembunyikan, token tanpa harga disembunyikan', () => {
    resetBreakers();
    const db = memDb();
    // 1. SEED_WALLETS -> wallets (validasi format address).
    const added = seedWallets(db, [
      { label: 'Solana Utama', address: '3keq3cRtYuoPCYBUL4s6N52ePguGivSZpNU4fzSiPXpd' },
      { label: 'EVM Utama', address: '0x57843c3a9d30c55ad5f971a3e42df9e507fb4ffd' },
    ]);
    expect(added).toBe(2);
    expect(listWallets(db).map((w) => w.network_type).sort()).toEqual(['evm', 'solana']);

    // 2. provider -> wallet_positions (output sync, tanpa network).
    const sol = listWallets(db).find((w) => w.network_type === 'solana')!;
    const evm = listWallets(db).find((w) => w.network_type === 'evm')!;
    // NB: user TIDAK punya HYPE — hanya SOL + token tanpa harga (XYZ).
    commitPositions(db, sol.id, [{
      chain_id: 'solana', kind: 'token', protocol: 'solana-rpc', symbol: 'SOL', name: 'Solana',
      amount: '1.5', price_usd: 150, value_usd: 225, meta: {},
    }], 'all');
    commitPositions(db, evm.id, [{
      chain_id: 'hypercore', kind: 'token', protocol: 'hyperliquid-spot', symbol: 'XYZ', name: 'Token XYZ',
      amount: '10', price_usd: null, value_usd: null, meta: {},
    }], 'all');

    // 3. aset manual user (bukan seed) + duplikat manual atas SOL wallet.
    upsertAsset(db, { type: 'crypto', symbol: 'SOL', name: 'Solana', qty: '1', avg_buy_price_idr: 2000000 });
    db.prepare(`INSERT INTO price_cache (symbol, price_idr, source) VALUES ('SOL', 2400000, 'manual')`).run();

    // 4. endpoint API -> payload UI.
    const u = getUnifiedPortfolio(db);
    // Token wallet dengan harga tampil; tanpa harga disembunyikan dari Daftar Aset.
    const symbols = u.wallet_tokens.map((t) => t.symbol);
    expect(symbols).toContain('SOL');
    expect(symbols).not.toContain('XYZ');
    expect(symbols).not.toContain('HYPE');
    const solW = u.wallet_tokens.find((t) => t.symbol === 'SOL')!;
    expect(solW.chains).toContain('solana');
    expect(solW.wallets).toContain('Solana Utama');
    // Manual duplikat (SOL) disembunyikan total; XYZ dihitung sebagai hidden.
    expect(u.assets.find((a) => a.symbol === 'SOL')).toBeUndefined();
    expect(u.hidden_tokens).toBe(1);
    expect(u.total_value_idr).toBe(Math.round(225 * 16000));
    // P/L wallet "-" tanpa cost basis...
    expect(solW.has_cost).toBe(false);
    expect(solW.pl_idr).toBeNull();
    // ...muncul setelah user mengisi.
    setCostBasis(db, 'SOL', 2000000);
    const u2 = getUnifiedPortfolio(db);
    const solW2 = u2.wallet_tokens.find((t) => t.symbol === 'SOL')!;
    expect(solW2.has_cost).toBe(true);
    expect(solW2.pl_idr).toBe(Math.round(225 * 16000) - Math.round(2000000 * 1.5));
    db.close();
    expect(createWallet).toBeDefined();
  });
});
