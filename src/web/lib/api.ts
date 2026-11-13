import { setAuthed } from './state.js';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAt = 0) { super(message); }
}

const snapshots = new Map<string, unknown>();
const pending = new Map<string, Promise<unknown>>();
let retryAt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let stale = false;

function signal(name: string): void {
  if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') document.dispatchEvent(new Event(name));
}

export function isApiReadPaused(): boolean { return Date.now() < retryAt; }
export function isTemporaryApiError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status === 429 || error.status >= 500);
}

function pauseReads(waitMs: number): void {
  retryAt = Math.max(retryAt, Date.now() + Math.max(1000, waitMs));
  stale = true;
  signal('api:stale');
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { retryTimer = null; retryAt = 0; signal('api:retry'); }, retryAt - Date.now() + 100);
}

function waitFromHeader(value: string | null): number {
  if (!value) return 30_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1000, date - Date.now()) : 30_000;
}

export function rememberApiSnapshot(path: string, data: unknown): void {
  snapshots.delete(path);
  snapshots.set(path, structuredClone(data));
  if (snapshots.size > 80) snapshots.delete(snapshots.keys().next().value!);
}

async function req(path: string, init?: RequestInit): Promise<unknown> {
  const read = !init?.method || init.method === 'GET';
  const cacheable = read && path.startsWith('/api/') && !path.startsWith('/api/auth/');
  if (read && isApiReadPaused()) {
    if (cacheable && snapshots.has(path)) return structuredClone(snapshots.get(path));
    throw new ApiError('Pembaruan tertunda. Mencoba lagi otomatis.', 429, retryAt);
  }
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  } catch (e) {
    if (!read) throw e;
    pauseReads(30_000);
    if (cacheable && snapshots.has(path)) return structuredClone(snapshots.get(path));
    throw new ApiError('Koneksi tertunda. Mencoba lagi otomatis.', 0, retryAt);
  }
  if (res.status === 401) {
    clearApiSnapshots();
    setAuthed(false);
    if (!location.hash.startsWith('#/masuk')) location.hash = '#/masuk';
    throw new ApiError('Belum masuk', 401);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (read && (res.status === 429 || res.status >= 500)) {
      pauseReads(res.status === 429 ? waitFromHeader(res.headers.get('Retry-After')) : 30_000);
      if (cacheable && snapshots.has(path)) return structuredClone(snapshots.get(path));
    }
    throw new ApiError((json as { error?: string }).error ?? `HTTP ${res.status}`, res.status, read ? retryAt : 0);
  }
  if (cacheable) {
    rememberApiSnapshot(path, json);
  }
  if (!read) clearApiSnapshots();
  if (read && stale && !isApiReadPaused()) { stale = false; signal('api:recovered'); }
  return json;
}

export function clearApiSnapshots(): void {
  const wasStale = stale;
  snapshots.clear();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryAt = 0;
  stale = false;
  if (wasStale) signal('api:recovered');
}

function get(path: string): Promise<unknown> {
  const existing = pending.get(path);
  if (existing) return existing;
  const request = req(path).finally(() => { pending.delete(path); });
  pending.set(path, request);
  return request;
}

export const api = {
  get,
  post: (p: string, body: unknown) => req(p, { method: 'POST', body: JSON.stringify(body) }),
  put: (p: string, body: unknown) => req(p, { method: 'PUT', body: JSON.stringify(body) }),
  patch: (p: string, body: unknown) => req(p, { method: 'PATCH', body: JSON.stringify(body) }),
  del: (p: string) => req(p, { method: 'DELETE' }),
};
