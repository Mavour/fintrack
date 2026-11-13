import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/server/app.js';
import { closeDatabase } from '../src/server/db/database.js';

describe('HTTP IP and HTTPS deployments', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fintrack-http-'));
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('PORTFOLIO_SNAPSHOT_PATH', path.join(fixtureDir, 'absent.json'));
    vi.stubEnv('SESSION_SECRET', 'http-deployment-test-secret-32-characters');
    vi.stubEnv('APP_PASSWORD', 'test-password');
    vi.stubEnv('SEED_WALLETS', '[]');
    vi.stubEnv('LOG_LEVEL', 'silent');
    ({ app } = await buildApp());
  });

  afterAll(async () => {
    await app?.close();
    closeDatabase();
    vi.unstubAllEnvs();
    fs.rmdirSync(fixtureDir);
  });

  it('serves HTTP without upgrading assets or sending HTTPS-only isolation headers', async () => {
    const response = await app.inject({ url: '/health', headers: { host: '203.0.113.10:3100' } });
    expect(response.statusCode).toBe(200);
    const csp = String(response.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(response.headers['cross-origin-opener-policy']).toBeUndefined();
    expect(response.headers['origin-agent-cluster']).toBeUndefined();
    expect(response.headers['strict-transport-security']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect((await app.inject('/api/accounts')).statusCode).toBe(401);
  });

  it('preserves HTTPS protections behind the reverse proxy', async () => {
    const response = await app.inject({ url: '/health', headers: { 'x-forwarded-proto': 'https' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toContain('upgrade-insecure-requests');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['origin-agent-cluster']).toBe('?1');
    expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
  });

  it.runIf(fs.existsSync('dist/public/index.html'))('serves all built entry assets over HTTP', async () => {
    const headers = { host: '203.0.113.10:3100' };
    const page = await app.inject({ url: '/', headers });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    const urls = [...page.body.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
    expect(urls).toContain('/theme-init.js');
    expect(urls.some(url => url.endsWith('.css'))).toBe(true);
    expect(urls.some(url => url.startsWith('/assets/') && url.endsWith('.js'))).toBe(true);
    for (const url of urls) {
      expect(url.startsWith('/')).toBe(true);
      const asset = await app.inject({ url, headers });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).not.toContain('text/html');
      expect(asset.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    }
  });

  it('uses external startup scripts allowed by the production CSP', () => {
    const html = fs.readFileSync('src/web/index.html', 'utf8');
    expect(html).toContain('<script src="/theme-init.js"></script>');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script[1]).toMatch(/\bsrc=/);
      expect(script[2].trim()).toBe('');
    }
    expect(fs.existsSync('src/web/public/theme-init.js')).toBe(true);
  });
});
