import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import Database from 'better-sqlite3';
import { readDormSnapshot, type DormSnapshot } from './services/dormSnapshot.js';

export interface DormApiOptions {
  enabled: boolean;
  host: string;
  port: number;
  apiKey: string;
  dayTimeZone: string;
  monthlyBudgetIdr: number | null;
  fxMaxAgeSec: number;
}

export function readDormApiOptions(env: NodeJS.ProcessEnv = process.env): DormApiOptions {
  const apiKey = env.STATUS_API_KEY || '';
  const enabled = env.STATUS_API_ENABLED ?? (apiKey ? 'true' : 'false');
  if (!['true', 'false', '1', '0'].includes(enabled)) throw new Error('Invalid STATUS_API_ENABLED');
  const active = enabled === 'true' || enabled === '1';
  if (active && !apiKey.trim()) throw new Error('STATUS_API_KEY is required for financial data');
  const host = env.STATUS_API_HOST || '127.0.0.1';
  const port = Number(env.STATUS_API_PORT || 9002);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid STATUS_API_PORT');
  const dayTimeZone = env.STATUS_API_DAY_TIMEZONE || 'Asia/Makassar';
  new Intl.DateTimeFormat('en-CA', { timeZone: dayTimeZone }).format();
  const rawBudget = env.STATUS_API_MONTHLY_BUDGET_IDR;
  const monthlyBudgetIdr = rawBudget === undefined || !rawBudget.trim() ? null : Number(rawBudget);
  if (monthlyBudgetIdr !== null && (!Number.isSafeInteger(monthlyBudgetIdr) || monthlyBudgetIdr < 0)) throw new Error('Invalid STATUS_API_MONTHLY_BUDGET_IDR');
  const fxMaxAgeSec = Number(env.STATUS_API_FX_MAX_AGE_SEC || 86400);
  if (!Number.isFinite(fxMaxAgeSec) || fxMaxAgeSec < 60) throw new Error('Invalid STATUS_API_FX_MAX_AGE_SEC');
  return { enabled: active, host, port, apiKey, dayTimeZone, monthlyBudgetIdr, fxMaxAgeSec };
}

export async function startDormStatusServer(options: DormApiOptions, snapshot: () => DormSnapshot): Promise<Server> {
  if (!options.apiKey.trim()) throw new Error('STATUS_API_KEY is required for financial data');
  const expected = createHash('sha256').update(`Bearer ${options.apiKey}`).digest();
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, body: unknown) => { res.writeHead(status); res.end(JSON.stringify(body)); };
    const actual = createHash('sha256').update(req.headers.authorization || '').digest();
    if (!timingSafeEqual(actual, expected)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      send(401, { error: 'Unauthorized' });
      return;
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      send(405, { error: 'Read-only API; use GET' });
      return;
    }
    const route = (req.url || '').split('?')[0];
    if (route !== '/status' && route !== '/health') { send(404, { error: 'Not found' }); return; }
    try {
      const data = snapshot();
      if (route === '/status') send(200, data);
      else send(data.status === 'ok' ? 200 : 503, { ok: data.status === 'ok', agentId: 'portfolio', status: data.status, updatedAt: data.updatedAt });
    } catch {
      send(503, { error: 'Status unavailable' });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => { server.removeListener('error', reject); resolve(); });
  });
  return server;
}

/** A separate SQLite connection enforces readonly, even if a helper attempts a write. */
export function openDormDatabase(databasePath: string): Database.Database {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 1000');
  return db;
}

export async function startDormApi(databasePath: string, options: DormApiOptions) {
  const db = openDormDatabase(databasePath);
  try {
    let cached = readDormSnapshot(db, options);
    let readFailed = false;
    const server = await startDormStatusServer(options, () => {
      if (readFailed || Date.now() - Date.parse(cached.updatedAt) > 90_000) {
        return { ...cached, status: 'error', alerts: [...cached.alerts, { id: 'snapshot-unavailable', level: 'warn', message: 'Snapshot fintrack belum dapat diperbarui', ts: cached.updatedAt }] };
      }
      return cached;
    });
    const timer = setInterval(() => {
      try { cached = readDormSnapshot(db, options); readFailed = false; }
      catch { readFailed = true; }
    }, 30000);
    timer.unref();
    return {
      server,
      close: () => new Promise<void>((resolve) => {
        clearInterval(timer);
        server.closeAllConnections();
        server.close(() => { db.close(); resolve(); });
      }),
    };
  } catch (err) {
    db.close();
    throw err;
  }
}
