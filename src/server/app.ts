import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { getDatabase } from './db/database.js';
import { getConfig } from './config.js';
import { logger } from './logger.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerTransactionRoutes } from './routes/transactions.js';
import { registerPortfolioRoutes } from './routes/portfolio.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerAuthRoutes, ensurePassword, isSessionValid, getPasswordHash } from './routes/auth.js';
import { startScheduler } from './jobs/scheduler.js';

export async function buildApp() {
  const config = getConfig();
  const db = getDatabase(config.databasePath);
  await ensurePassword(db, config.appPassword);

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));

  // Auth routes are public.
  registerAuthRoutes(app, db);

  // Protect all /api/* below (except auth + health).
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.url.startsWith('/api/auth/')) return;
    if (!getPasswordHash(db)) return; // first-run setup mode
    if (!isSessionValid(db, req.cookies.session)) {
      return reply.code(401).send({ error: 'Belum masuk' });
    }
  });

  registerAccountRoutes(app, db);
  registerTransactionRoutes(app, db);
  registerPortfolioRoutes(app, db);
  registerDashboardRoutes(app, db);

  // Serve built frontend if present.
  const publicDir = path.resolve('dist/public');
  if (fs.existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  app.setErrorHandler((err: Error, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    logger.error({ err }, 'request failed');
    reply.code(status).send({ error: status === 500 ? 'Kesalahan server' : err.message });
  });

  return { app, db, config };
}
