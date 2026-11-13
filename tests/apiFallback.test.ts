import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, clearApiSnapshots, isApiReadPaused, rememberApiSnapshot } from '../src/web/lib/api.js';
import { getAuthed, setAuthed } from '../src/web/lib/state.js';

beforeEach(() => {
  vi.useFakeTimers();
  clearApiSnapshots();
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('location', { hash: '#/portofolio' });
});
afterEach(() => { clearApiSnapshots(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
const limited = (retryAfter = '27') => new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429, headers: { 'Retry-After': retryAfter } });

describe('last good API data during rate limiting', () => {
  it('retains the last value, pauses other reads, then refreshes automatically after Retry-After', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok({ price: 100 })).mockResolvedValueOnce(limited()).mockResolvedValueOnce(ok({ price: 110 }));
    vi.stubGlobal('fetch', fetchMock);
    const retry = vi.fn(), recovered = vi.fn();
    document.addEventListener('api:retry', retry);
    document.addEventListener('api:recovered', recovered);
    await api.get('/api/portfolio');
    expect(await api.get('/api/portfolio')).toEqual({ price: 100 });
    expect(isApiReadPaused()).toBe(true);
    expect(await api.get('/api/portfolio')).toEqual({ price: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(api.get('/api/accounts')).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(27099);
    expect(retry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(await api.get('/api/portfolio')).toEqual({ price: 110 });
    expect(isApiReadPaused()).toBe(false);
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it('uses the latest streaming frame as fallback and does not let callers mutate the snapshot', async () => {
    rememberApiSnapshot('/api/portfolio', { price: 123 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(limited()));
    const data = await api.get('/api/portfolio') as { price: number };
    data.price = 999;
    expect(await api.get('/api/portfolio')).toEqual({ price: 123 });
  });

  it('handles an HTTP-date Retry-After and never invents data when no snapshot exists', async () => {
    const until = new Date(Date.now() + 60000).toUTCString();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(limited(until)));
    await expect(api.get('/api/portfolio')).rejects.toBeInstanceOf(ApiError);
    expect(isApiReadPaused()).toBe(true);
    vi.advanceTimersByTime(59000);
    expect(isApiReadPaused()).toBe(true);
  });

  it('does not replay a rate-limited write or apply a write cooldown to all reads', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(limited()).mockResolvedValueOnce(ok({ price: 120 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.post('/api/transactions', { amount_idr: 1 })).rejects.toMatchObject({ status: 429 });
    vi.advanceTimersByTime(60000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isApiReadPaused()).toBe(false);
    expect(await api.get('/api/portfolio')).toEqual({ price: 120 });
  });

  it('clears financial snapshots on 401 and redirects to login instead of serving cached data', async () => {
    rememberApiSnapshot('/api/portfolio', { price: 123 });
    setAuthed(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValueOnce(limited()));
    await expect(api.get('/api/portfolio')).rejects.toMatchObject({ status: 401 });
    expect(getAuthed()).toBe(false);
    expect(location.hash).toBe('#/masuk');
    await expect(api.get('/api/portfolio')).rejects.toMatchObject({ status: 429 });
  });

  it('deduplicates concurrent identical reads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ price: 100 }));
    vi.stubGlobal('fetch', fetchMock);
    const [a, b] = await Promise.all([api.get('/api/portfolio'), api.get('/api/portfolio')]);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'server'])('retains the last successful value after a transient %s failure', async (kind) => {
    rememberApiSnapshot('/api/portfolio', { price: 123 });
    const fetchMock = kind === 'network' ? vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
      : vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await api.get('/api/portfolio')).toEqual({ price: 123 });
    expect(isApiReadPaused()).toBe(true);
  });
});
