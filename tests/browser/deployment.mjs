import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { buildApp } from '../../dist/server/app.js';
import { closeDatabase } from '../../dist/server/db/database.js';
import { emitLivePortfolio, sseClientCount } from '../../dist/server/services/sse.js';
import { getUnifiedPortfolio } from '../../dist/server/services/portfolioService.js';

Object.assign(process.env, {
  NODE_ENV: 'production', APP_PASSWORD: 'browser-fixture-password',
  SESSION_SECRET: 'browser-fixture-session-secret-for-ci', DATABASE_PATH: ':memory:',
  PORTFOLIO_SNAPSHOT_PATH: '', SEED_WALLETS: '[]', LOG_LEVEL: 'silent', DEBANK_ACCESS_KEY: '',
});

const html = fs.readFileSync('dist/public/index.html', 'utf8');
const entry = html.match(/\/assets\/index-[^"']+\.js/)?.[0];
assert.ok(entry, 'production index must have a hashed entry script');
const bundle = fs.readFileSync(`dist/public${entry}`, 'utf8');
const oldWorker = fs.readFileSync('dist/public/sw.js', 'utf8').replace('fintrack-shell-v5', 'fintrack-shell-browser-previous');
const oldEntry = '/assets/index-previous-release.js';
const { app, db } = await buildApp();
let browser;
let proxy;
try {
  db.exec(`INSERT INTO assets (symbol, type, qty) VALUES ('RD66', 'reksadana', '1');
    INSERT INTO wallets (id, label, address, network_type) VALUES (1, 'Wallet uji', 'fixture', 'solana');
    INSERT INTO lp_positions (wallet_id, pool_address, chain_id, protocol, pair, position_value_usd, unclaimed_fees_usd)
      VALUES (1, 'fixture-pool', 'solana', 'Meteora DLMM', 'TEST/USDC', 100, 2);
    INSERT INTO fx_cache (pair, rate) VALUES ('USDIDR', 16000);`);
  const now = Date.now();
  const positions = [{ pool_address: 'fixture-pool', position_address: 'fixture-position', lower_bin: -10,
    upper_bin: 10, active_bin: 11, in_range: false, token_x_mint: 'fixture-x', token_y_mint: 'fixture-y', fee_x: '0.12345', fee_y: '0' }];
  db.prepare('INSERT INTO meteora_dlmm_snapshots (wallet_id, wallet_address, attempted_at, synced_at, positions_json) VALUES (1, ?, ?, ?, ?)')
    .run('fixture', now, now, JSON.stringify(positions));

  const upstreamBase = await app.listen({ port: 0, host: '127.0.0.1' });
  let previousRelease = true;
  proxy = http.createServer((req, res) => {
    const pathname = new URL(req.url, upstreamBase).pathname;
    if (previousRelease && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(html.replace(entry, oldEntry));
      return;
    }
    if (previousRelease && pathname === oldEntry) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(`${bundle}\ndocument.body.dataset.previousRelease = 'loaded';`);
      return;
    }
    if (previousRelease && pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      res.end(oldWorker);
      return;
    }
    const upstream = http.request(new URL(req.url, upstreamBase), { method: req.method, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    res.on('close', () => upstream.destroy());
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const baseURL = `http://127.0.0.1:${proxy.address().port}`;
  const executablePath = process.env.FINTRACK_CHROMIUM_EXECUTABLE;
  browser = await chromium.launch({ executablePath });
  const context = await browser.newContext({ baseURL });
  const login = await context.request.post('/api/auth/login', { data: { password: process.env.APP_PASSWORD } });
  assert.equal(login.status(), 200);
  const page = await context.newPage();
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  assert.equal(await page.locator('script[type=module]').getAttribute('src'), oldEntry);
  assert.equal(await page.locator('body').getAttribute('data-previous-release'), 'loaded');
  await page.locator('[data-valuation-coverage]').filter({ hasText: 'Valuasi sebagian' }).waitFor();

  previousRelease = false;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.locator('#btn-update').click();
  await page.waitForURL((url) => url.searchParams.has('_ft_update'));
  assert.equal(await page.locator('script[type=module]').getAttribute('src'), entry);
  assert.equal(await page.locator('body').getAttribute('data-previous-release'), null);
  assert.equal(await page.evaluate(async (path) => (await fetch(path, { cache: 'no-store' })).status, oldEntry), 404);
  assert.equal(await page.evaluate(async () => {
    const response = await fetch('/api/accounts');
    if (!response.ok) throw new Error(`API responded ${response.status}`);
    return Boolean(await caches.match('/api/accounts'));
  }), false);

  await page.locator('[data-valuation-coverage]').filter({ hasText: 'Valuasi sebagian' }).waitFor();
  assert.ok(sseClientCount() > 0, 'home should have a live update connection');
  db.exec("INSERT INTO price_cache (symbol, price_idr, source) VALUES ('RD66', 1000, 'manual')");
  emitLivePortfolio(getUnifiedPortfolio(db, undefined, { readOnly: true }));
  await page.locator('[data-valuation-coverage]').waitFor({ state: 'hidden' });

  await page.goto('/#/portofolio');
  await page.locator('[data-position-tab=lp]').click();
  const monitor = page.getByRole('region', { name: 'Pemantauan Meteora DLMM' });
  await monitor.getByText('Di luar rentang').waitFor();
  assert.match(await monitor.innerText(), /TEST\/USDC.*-10 hingga 10.*11.*0\.12345/s);
  await page.locator('#btn-privat').click();
  await monitor.getByText('•••', { exact: true }).waitFor();
  assert.doesNotMatch(await monitor.innerText(), /0\.12345/);
  console.log('Chromium passed: PWA release switch, API cache, live valuation and private DLMM fees');
} finally {
  await browser?.close();
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  await app.close();
  closeDatabase();
}
