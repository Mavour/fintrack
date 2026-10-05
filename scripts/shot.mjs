/* Verification screenshots: 390 / 768 / 1440 x 4 pages + layout assertions. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const PORT = 3110;
const DB = 'C:\\Users\\ASUS\\AppData\\Local\\Temp\\opencode\\shot.db';
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = new URL('../screenshots/', import.meta.url).pathname.replace(/^\//, '');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

fs.rmSync(DB, { force: true });
fs.rmSync(DB + '-wal', { force: true });
fs.rmSync(DB + '-shm', { force: true });
fs.mkdirSync(OUT, { recursive: true });

const server = spawn('node', ['dist/server/index.js'], {
  cwd: new URL('../', import.meta.url).pathname.replace(/^\//, ''),
  env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB, APP_PASSWORD: '' },
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

// ---- seed ----
const bca = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ name: 'BCA', type: 'bank', balance_idr: 8500000 }) });
const gopay = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ name: 'GoPay', type: 'e_wallet', balance_idr: 1200000 }) });
await api('/api/accounts', { method: 'POST', body: JSON.stringify({ name: 'Tunai', type: 'cash', balance_idr: 500000 }) });
const txs = [
  { kind: 'expense', amount_idr: 45000, account_id: bca.id, category: 'Makan', note: 'Warung' },
  { kind: 'expense', amount_idr: 120000, account_id: bca.id, category: 'Transport', note: 'Bensin' },
  { kind: 'expense', amount_idr: 85000, account_id: gopay.id, category: 'Hiburan', note: 'Bioskop' },
  { kind: 'income', amount_idr: 8000000, account_id: bca.id, category: 'Gaji', note: 'Gaji Okt' },
];
for (const t of txs) await api('/api/transactions', { method: 'POST', body: JSON.stringify(t) });
await api('/api/portfolio', { method: 'PUT', body: JSON.stringify({ type: 'crypto', symbol: 'SOL', name: 'Solana', qty: '12.5', avg_buy_price_idr: 1500000, price_idr: 2400000 }) });
await api('/api/portfolio', { method: 'PUT', body: JSON.stringify({ type: 'saham', symbol: 'BBCA.JK', name: 'BCA', qty: '100', avg_buy_price_idr: 9800, price_idr: 10250 }) });
await api('/api/portfolio', { method: 'PUT', body: JSON.stringify({ type: 'reksadana', symbol: 'RDNPU', name: 'RDN Pasar Uang', qty: '5000', avg_buy_price_idr: 1200, price_idr: 1280 }) });

// 7-day history for sparklines + one live source for the badge
const { default: Database } = await import('better-sqlite3');
const db = new Database(DB);
const hist = db.prepare(`INSERT OR IGNORE INTO price_history (symbol, price_idr, fetched_at) VALUES (?, ?, ?)`);
for (const [sym, base, step] of [['SOL', 2100000, 60000], ['BBCA.JK', 9900, 60], ['RDNPU', 1240, 8]]) {
  for (let d = 7; d >= 1; d--) {
    const ts = new Date(Date.now() - d * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    hist.run(sym, Math.round(base + (7 - d) * step), ts);
  }
}
db.prepare(`UPDATE price_cache SET source = 'coingecko', fetched_at = datetime('now') WHERE symbol = 'SOL'`).run();
db.close();

// ---- shots ----
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const pages = [
  ['beranda', '#/'],
  ['portofolio', '#/portofolio'],
  ['transaksi', '#/transaksi'],
  ['akun', '#/akun'],
];
const widths = [390, 768, 1440];
let failures = 0;
for (const w of widths) {
  for (const [name, hash] of pages) {
    const pg = await browser.newPage({ viewport: { width: w, height: 900 } });
    await pg.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(2500);
    await pg.screenshot({ path: path.join(OUT, `${name}-${w}.png`), fullPage: true });
    const check = await pg.evaluate(() => {
      const bn = document.getElementById('bottomnav');
      const sb = document.getElementById('sidebar');
      const bnItems = bn ? bn.querySelectorAll('a').length : 0;
      const sbItems = sb ? sb.querySelectorAll('nav a').length : 0;
      return {
        w: window.innerWidth,
        bottomNavItems: bnItems,
        sidebarItems: sbItems,
        scrollW: document.documentElement.scrollWidth,
      };
    });
    const desktop = w >= 900;
    const okNav = desktop ? check.bottomNavItems === 0 && check.sidebarItems === 4 : check.bottomNavItems === 4 && check.sidebarItems === 0;
    const okScroll = check.scrollW <= w + 1;
    console.log(`${name}@${w}: bottomNav=${check.bottomNavItems} sidebar=${check.sidebarItems} scrollW=${check.scrollW} -> ${okNav && okScroll ? 'OK' : 'FAIL'}`);
    if (!okNav || !okScroll) failures++;
    await pg.close();
  }
}
// 360px no-horizontal-scroll probe
{
  const pg = await browser.newPage({ viewport: { width: 360, height: 800 } });
  for (const [, hash] of pages) {
    await pg.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(800);
    const sw = await pg.evaluate(() => document.documentElement.scrollWidth);
    console.log(`scroll@360 ${hash}: ${sw} -> ${sw <= 361 ? 'OK' : 'FAIL'}`);
    if (sw > 361) failures++;
  }
  await pg.close();
}
await browser.close();
server.kill();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
