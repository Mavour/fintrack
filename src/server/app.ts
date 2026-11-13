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
import { registerWalletRoutes } from './routes/wallets.js';
import { registerAuthRoutes, ensurePassword, isSessionValid, getPasswordHash } from './routes/auth.js';
import { registerEventRoutes } from './routes/events.js';
import { startScheduler } from './jobs/scheduler.js';
import { seedWallets } from './services/walletRegistry.js';

export async function buildApp() {
  const config = getConfig();
  const db = getDatabase(config.databasePath);
  await ensurePassword(db, config.appPassword);
  if (config.nodeEnv === 'production' && !getPasswordHash(db)) {
    throw new Error('APP_PASSWORD wajib diisi pada first-run production (atau lakukan setup via 127.0.0.1 sebelum expose)');
  }
  try {
    seedWallets(db, config.seedWallets);
  } catch {
    // Seeding is best-effort; registry CRUD remains available.
  }

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));

  // WAJIB sebelum registrasi route: handler lookup terjadi saat route didaftar,
  // dipasang belakangan = route lama lolos ke default 500 (bocor detail Zod).
  app.setErrorHandler((err: Error, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? (err.name === 'ZodError' ? 400 : 500);
    logger.error({ err }, 'request failed');
    reply.code(status).send({ error: status === 500 ? 'Kesalahan server' : err.message });
  });

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
  registerWalletRoutes(app, db);
  registerEventRoutes(app);
  // Serve built frontend if present.
  const publicDir = path.resolve('dist/public');
  if (fs.existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir, prefix: '/' });
    // index.html = selalu segar (update langsung terlihat), aset hash = immutable.
    app.addHook('onSend', async (req, reply) => {
      const url = req.url.split('?')[0];
      if (req.method !== 'GET' || url.startsWith('/api/')) return;
      if (url === '/' || url.endsWith('/index.html')) {
        reply.header('Cache-Control', 'no-store');
      } else if (url.includes('/assets/')) {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      }
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  return { app, db, config };
}
