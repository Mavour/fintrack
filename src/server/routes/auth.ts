import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import type Database from 'better-sqlite3';

const LoginSchema = z.object({ password: z.string().min(1).max(72) });
const SetupSchema = z.object({ password: z.string().min(6).max(72) });

export const SESSION_MAX_AGE_SEC = 7 * 24 * 3600;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function getPasswordHash(db: Database.Database): string | undefined {
  return (db.prepare(`SELECT value FROM meta WHERE key = 'pw_hash'`).get() as { value: string } | undefined)?.value;
}

export function setPasswordHash(db: Database.Database, hash: string): void {
  db.prepare(`INSERT INTO meta (key, value) VALUES ('pw_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(hash);
}

export async function ensurePassword(db: Database.Database, plain: string): Promise<void> {
  if (!plain) return;
  if (getPasswordHash(db)) return;
  setPasswordHash(db, await bcrypt.hash(plain, 10));
}

export async function verifyPassword(db: Database.Database, plain: string): Promise<boolean> {
  const hash = getPasswordHash(db);
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

export function createSession(db: Database.Database): string {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_MAX_AGE_SEC * 1000).toISOString();
  db.prepare(`INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)`).run(hashToken(token), expires);
  // Opportunistic cleanup: hapus sesi kedaluwarsa agar tabel tidak tumbuh tanpa batas.
  try {
    db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
  } catch {
    // Best-effort.
  }
  return token;
}

export function isSessionValid(db: Database.Database, token: string | undefined): boolean {
  if (!token) return false;
  const row = db.prepare(`SELECT expires_at FROM sessions WHERE token_hash = ?`).get(hashToken(token)) as
    | { expires_at: string }
    | undefined;
  if (!row) return false;
  return new Date(row.expires_at).getTime() > Date.now();
}

export function destroySession(db: Database.Database, token: string | undefined): void {
  if (!token) return;
  db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
}

export function registerAuthRoutes(app: FastifyInstance, db: Database.Database): void {
  app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const body = LoginSchema.parse(req.body);
    if (!(await verifyPassword(db, body.password))) {
      return reply.code(401).send({ error: 'Kata sandi salah' });
    }
    const token = createSession(db);
    reply.setCookie('session', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.protocol === 'https',
      path: '/',
      maxAge: SESSION_MAX_AGE_SEC,
    });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    destroySession(db, req.cookies.session);
    reply.clearCookie('session', {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: req.protocol === 'https',
    });
    return { ok: true };
  });

  app.post('/api/auth/logout-all', async (req, reply) => {
    if (!isSessionValid(db, req.cookies.session)) return reply.code(401).send({ error: 'Belum masuk' });
    db.prepare('DELETE FROM sessions').run();
    reply.clearCookie('session', {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: req.protocol === 'https',
    });
    return { ok: true };
  });

  app.post('/api/auth/change-password', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    if (!isSessionValid(db, req.cookies.session)) return reply.code(401).send({ error: 'Belum masuk' });
    const body = z.object({ oldPassword: z.string().min(1).max(72), newPassword: z.string().min(6).max(72) }).parse(req.body);
    if (!(await verifyPassword(db, body.oldPassword))) return reply.code(401).send({ error: 'Kata sandi lama salah' });
    setPasswordHash(db, await bcrypt.hash(body.newPassword, 10));
    db.prepare('DELETE FROM sessions').run();
    const token = createSession(db);
    reply.setCookie('session', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.protocol === 'https',
      path: '/',
      maxAge: SESSION_MAX_AGE_SEC,
    });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const authed = isSessionValid(db, req.cookies.session);
    const needsSetup = !getPasswordHash(db);
    return { authenticated: authed, needsSetup };
  });

  app.post('/api/auth/setup', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    if (getPasswordHash(db)) return reply.code(400).send({ error: 'Sudah dikonfigurasi' });
    const body = SetupSchema.parse(req.body);
    setPasswordHash(db, await bcrypt.hash(body.password, 10));
    const token = createSession(db);
    reply.setCookie('session', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.protocol === 'https',
      path: '/',
      maxAge: SESSION_MAX_AGE_SEC,
    });
    return { ok: true };
  });
}
