/* Wallet source verification: seed wallets+positions, dump tables (redacted),
 * screenshot Portofolio at 1440px, 1000px, and 390px + assert no horizontal
 * scroll + table shape (4 kolom, tanpa chip wallet/type/source di Daftar Aset).
 * Demo data goes to a TEMP db only. Refuses to run unless DEMO_MODE=true.
 * Run: DEMO_MODE=true npm run build && DEMO_MODE=true node scripts/shot-wallet.mjs */
if (process.env.DEMO_MODE !== 'true') {
  console.error('REFUSED: set DEMO_MODE=true to run screenshot seeding (default false, protects real DBs).');
  process.exit(2);
}
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const PORT = 3111;
const DB = 'C:\\Users\\ASUS\\AppData\\Local\\Temp\\opencode\\shot-wallet.db';
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = new URL('../screenshots/', import.meta.url).pathname.replace(/^\//, '');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const short = (a) => (a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`);

fs.rmSync(DB, { force: true });
fs.rmSync(DB + '-wal', { force: true });
fs.rmSync(DB + '-shm', { force: true });
fs.mkdirSync(OUT, { recursive: true });

const server = spawn('node', ['dist/server/index.js'], {
  cwd: new URL('../', import.meta.url).pathname.replace(/^\//, ''),
  env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB, APP_PASSWORD: '', NODE_ENV: 'production', LOG_LEVEL: 'warn' },
  stdio: 'pipe',
});
server.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));

async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

const api = (p, init) =>
  fetch(`${BASE}${p}`, { ...init, headers: { 'Content-Type': 'application/json' } }).then(async (r) => {
    if (!r.ok) throw new Error(`${p} -> ${r.status}: ${await r.text()}`);
    return r.json();
  });

await waitHealth();

// ---- seed wallets (registry API: validation via PublicKey/isAddress) ----
// NOTE: .env SEED_WALLETS may already seed these at startup → reuse if present.
const existing = await api('/api/wallets/registry');
const findAddr = (suffix) => existing.wallets.find((w) => w.address.endsWith(suffix));
const sol = findAddr('PXpd') ?? await api('/api/wallets/registry', { method: 'POST', body: JSON.stringify({ label: 'Solana Utama', address: '3keq3cRtYuoPCYBUL4s6N52ePguGivSZpNU4fzSiPXpd' }) });
const evm = findAddr('4ffd') ?? await api('/api/wallets/registry', { method: 'POST', body: JSON.stringify({ label: 'EVM Utama', address: '0x57843c3a9d30c55ad5f971a3e42df9e507fb4ffd' }) });

// ---- seed positions + manual assets directly (deterministic, no network) ----
const { default: Database } = await import('better-sqlite3');
const db = new Database(DB);
const pos = db.prepare(`INSERT INTO wallet_positions (wallet_id, chain_id, kind, protocol, symbol, name, amount, price_usd, value_usd, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
pos.run(sol.id, 'solana', 'token', 'jupiter', 'SOL', 'Solana', '12.5', 150, 1875, JSON.stringify({ mint: 'So11111111111111111111111111111111111111112' }));
pos.run(evm.id, 'hypercore', 'token', 'hyperliquid-spot', 'HYPE', 'Hyperliquid HYPE', '25.5', 20.12, 513.06, JSON.stringify({ coin_index: 150, hold: '0.0' }));
pos.run(evm.id, 'base', 'token', 'debank', 'USDC', 'USD Coin', '140.25', 1, 140.25, JSON.stringify({ token_id: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }));
const lp = db.prepare(`INSERT INTO lp_positions (wallet_id, pool_address, pair, protocol, chain_id, position_value_usd, unclaimed_fees_usd, pool_tvl_usd, in_range, position_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
lp.run(sol.id, 'POOL1', 'SOL-USDC', 'Meteora DLMM', 'solana', 1250.5, 12.34, 2500000, 1, 'POS1');
db.prepare(`INSERT INTO wallet_positions (wallet_id, chain_id, kind, protocol, symbol, name, amount, price_usd, value_usd, meta) VALUES (?, 'solana', 'lp', 'Meteora DLMM', 'SOL-USDC', 'SOL-USDC', '1', 1250.5, 1250.5, ?)`)
  .run(sol.id, JSON.stringify({ pool_address: 'POOL1', pair: 'SOL-USDC', position_value_usd: 1250.5, unclaimed_fees_usd: 12.34, pool_tvl_usd: 2500000, in_range: true, position_address: 'POS1' }));
// manual duplicates (round qty, own cost) + stocks
// HYPE manual = duplikat wallet (chain kosong) → superseded, tidak dirender.
await api('/api/portfolio', { method: 'PUT', body: JSON.stringify({ type: 'crypto', symbol: 'HYPE', name: 'Hyperliquid', qty: '25', avg_buy_price_idr: 400000, price_idr: 321920 }) });
// MET: manual crypto biasa, tampil (LP- tidak, tapi ini bukan LP).
await api('/api/portfolio', { method: 'PUT', body: JSON.stringify({ type: 'crypto', symbol: 'MET', name: 'Met Dummy', qty: '100', avg_buy_price_idr: 15000, price_idr: 18500 }) });
await api('/api/portfolio', { method: 'PUT', body: JSON.stringify({ type: 'saham', symbol: 'BBCA.JK', name: 'Bank BCA', qty: '100', avg_buy_price_idr: 9800, price_idr: 10250 }) });
// cost basis: SOL only (HYPE wallet must show "-")
await api('/api/cost-basis', { method: 'PUT', body: JSON.stringify({ symbol: 'SOL', buy_price_idr: 1500000 }) });
db.prepare(`INSERT OR REPLACE INTO fx_cache (pair, rate, fetched_at) VALUES ('USDIDR', 16000, datetime('now'))`).run();
const hist = db.prepare(`INSERT OR IGNORE INTO price_history (symbol, price_idr, fetched_at) VALUES (?, ?, ?)`);
for (const [sym, base, step] of [['HYPE', 300000, 3000], ['SOL', 2100000, 60000], ['BBCA.JK', 9900, 60], ['MET', 17000, 300]]) {
  for (let d = 7; d >= 1; d--) {
    const ts = new Date(Date.now() - d * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    hist.run(sym, Math.round(base + (7 - d) * step), ts);
  }
}
db.prepare(`INSERT INTO sync_status (provider, wallet_id, last_success_at, updated_at) VALUES ('hyperliquid-spot', ?, datetime('now', '-2 minutes'), datetime('now', '-2 minutes'))`).run(evm.id);
db.prepare(`INSERT INTO sync_status (provider, wallet_id, last_success_at, updated_at) VALUES ('jupiter-portfolio-v1', ?, datetime('now', '-1 minute'), datetime('now', '-1 minute'))`).run(sol.id);
db.prepare(`INSERT INTO sync_status (provider, wallet_id, last_success_at, last_error, updated_at) VALUES ('debank', ?, datetime('now', '-20 minutes'), 'DeBank all_token_list HTTP 401', datetime('now', '-1 minute'))`).run(evm.id);

// ---- dump tables (addresses redacted) ----
console.log('=== wallets ===');
for (const w of db.prepare('SELECT id, label, address, network_type, created_at FROM wallets ORDER BY id').all()) {
  console.log(`${w.id} | ${w.label} | ${short(w.address)} | ${w.network_type} | ${w.created_at}`);
}
console.log('=== wallet_positions ===');
const wlabel = Object.fromEntries(db.prepare('SELECT id, label FROM wallets').all().map((r) => [r.id, r.label]));
for (const p of db.prepare('SELECT wallet_id, symbol, chain_id, kind, protocol, amount, value_usd FROM wallet_positions ORDER BY wallet_id, symbol').all()) {
  console.log(`${wlabel[p.wallet_id]} | ${p.symbol} | ${p.chain_id} | ${p.kind} | ${p.protocol} | amt=${p.amount} | $${p.value_usd}`);
}
console.log('=== lp_positions ===');
for (const r of db.prepare('SELECT wallet_id, pair, protocol, chain_id, position_value_usd, unclaimed_fees_usd, pool_tvl_usd, in_range FROM lp_positions').all()) {
  console.log(`${wlabel[r.wallet_id]} | ${r.pair} | ${r.protocol} | ${r.chain_id} | tvl=${r.position_value_usd} | fees=${r.unclaimed_fees_usd} | pool=${r.pool_tvl_usd} | in_range=${r.in_range}`);
}
console.log('=== sync_status ===');
for (const s of db.prepare('SELECT provider, wallet_id, last_success_at, last_error FROM sync_status ORDER BY provider, wallet_id').all()) {
  console.log(`${s.provider} | wallet=${s.wallet_id === null ? '-' : wlabel[s.wallet_id]} | ok_at=${s.last_success_at} | err=${s.last_error ?? '-'}`);
}
console.log('=== cost_basis ===');
for (const c of db.prepare('SELECT symbol, buy_price_idr FROM cost_basis').all()) {
  console.log(`${c.symbol} | ${c.buy_price_idr}`);
}
console.log('=== portfolio totals ===');
const pf = await api('/api/portfolio');
console.log(`total=${pf.total_value_idr} cost=${pf.total_cost_idr} pl=${pf.floating_pl_idr} hidden=${pf.hidden_tokens}`);
console.log('=== assets (manual, setelah filter) ===');
for (const a of pf.assets) console.log(`manual ${a.symbol} chain=${a.chain ?? '-'} type=${a.type} pl=${a.pl_idr}`);
console.log('=== assets superseded flags (DB) ===');
for (const r of db.prepare('SELECT symbol, superseded_by_wallet FROM assets ORDER BY symbol').all()) console.log(`${r.symbol} sup=${r.superseded_by_wallet}`);
console.log('=== wallet_tokens (setelah filter $1/harga) ===');
for (const w of pf.wallet_tokens) console.log(`wallet ${w.symbol} chains=[${w.chains}] has_cost=${w.has_cost} pl=${w.pl_idr}`);
db.close();

// ---- shots ----
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
let failures = 0;
for (const w of [1440, 1000, 390]) {
  const pg = await browser.newPage({ viewport: { width: w, height: 900 } });
  pg.on('console', (m) => { if (m.type() === 'error') console.log(`[console@${w}]`, m.text().slice(0, 200)); });
  pg.on('pageerror', (e) => console.log(`[pageerror@${w}]`, String(e).slice(0, 200)));
  await pg.goto(`${BASE}/#/portofolio`, { waitUntil: 'networkidle' });
  const marker = w === 390 ? 'Komposisi Portofolio' : 'Daftar Aset';
  try {
    await pg.waitForFunction((m) => document.body.textContent.includes(m), marker, { timeout: 25000 });
  } catch {
    console.log(`WARN@${w}: '${marker}' tidak muncul setelah 25 dtk`);
  }
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path: path.join(OUT, `wallet-portofolio-${w}.png`), fullPage: true });
  const sw = await pg.evaluate(() => document.documentElement.scrollWidth);
  console.log(`portofolio@${w}: scrollW=${sw} -> ${sw <= w + 1 ? 'OK' : 'FAIL (scroll horizontal)'}`);
  if (sw > w + 1) failures++;
  if (w !== 390) {
    // Desktop: tabel Daftar Aset 5 kolom (dengan Jenis) + sortable, baris wallet ber-pill "wallet",
    // tanpa baris duplikat/tombol "Tampilkan debu"/"Tampilkan n token tanpa harga".
    const heads = await pg.evaluate(() => [...document.querySelectorAll('table.data.assets thead th')].map((t) => t.textContent.trim().replace(/[↑↓]/g, '').trim()));
    const expected = ['Aset', 'Jenis', 'Qty', 'Harga', 'Nilai'];
    console.log(`portofolio@${w}: headers=${JSON.stringify(heads)} -> ${JSON.stringify(heads) === JSON.stringify(expected) ? 'OK' : 'FAIL'}`);
    if (JSON.stringify(heads) !== JSON.stringify(expected)) failures++;
const checks = await pg.evaluate((expectHint) => {
      const typeChips = document.querySelectorAll('table.data.assets .type-chip').length;
      const walletChip = document.querySelectorAll('table.data.assets .wallet-chip').length;
      const dupRow = document.querySelectorAll('table.data.assets tr.is-dup').length;
      const toggles = document.querySelectorAll('#btn-dust, #btn-unpriced').length;
      // Donut "Komposisi Portofolio" pakai warna baku per jenis (bukan PALETTE acak).
      const card = [...document.querySelectorAll('.card')].find((c) => (c.querySelector('strong')?.textContent ?? '').includes('Komposisi Portofolio'));
      const strokes = card?.querySelectorAll('svg circle[stroke]') ?? [];
      const donutColors = [...strokes].map((s) => s.getAttribute('stroke')).filter(Boolean);
      const typeColors = ['#e5484d', '#f59e0b', '#0e9f6e'];
      const donutOk = donutColors.length > 0 && donutColors.every((c) => typeColors.includes(c));
      const hintShown = [...document.querySelectorAll('.card')].some((c) => c.textContent.includes('disembunyikan'));
      return { typeChips, walletChip, dupRow, toggles, donutOk, donutColors, hintShown: expectHint === false ? true : hintShown };
    }, pf.hidden_tokens > 0);
    const ok = checks.typeChips >= 1 && checks.walletChip >= 1 && checks.dupRow === 0 && checks.toggles === 0 && checks.donutOk && checks.hintShown;
    console.log(`portofolio@${w}: table/donut ${JSON.stringify({ ...checks, donutOk: checks.donutOk })} -> ${ok ? 'OK' : 'FAIL'}`);
    if (!ok) failures++;
  } else {
    // Mobile: kartu Daftar Aset (#assets) berisi chip jenis + pill "wallet",
    // tanpa P/L/sparkline, dan tak ada pesan "Belum ada aset".
    const leaks = await pg.evaluate(() => ({
      typeChips: document.querySelectorAll('#assets .asset-card .type-chip').length,
      walletChip: document.querySelectorAll('#assets .asset-card .wallet-chip').length,
      spark: document.querySelectorAll('#assets .asset-card svg').length,
      noAsset: !document.body.textContent.includes('Belum ada aset'),
    }));
    const ok = leaks.typeChips >= 1 && leaks.walletChip >= 1 && leaks.spark === 0 && leaks.noAsset;
    console.log(`portofolio@${w}: mobile badges ${JSON.stringify(leaks)} -> ${ok ? 'OK' : 'FAIL'}`);
    if (!ok) failures++;
  }
  await pg.close();
}
await browser.close();
server.kill();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
