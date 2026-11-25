import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

function worker() {
  const handlers: Record<string, (event: any) => void> = {};
  const fetch = vi.fn().mockRejectedValue(new Error('Offline'));
  const caches = {
    match: vi.fn(async (key) => key === '/index.html' ? new Response('<html>offline page</html>') : undefined),
    keys: vi.fn().mockResolvedValue(['fintrack-shell-v4', 'fintrack-shell-v5', 'another-app']),
    delete: vi.fn().mockResolvedValue(true),
    open: vi.fn().mockResolvedValue({ put: vi.fn().mockResolvedValue(undefined) }),
  };
  const clients = { claim: vi.fn().mockResolvedValue(undefined) };
  vm.runInNewContext(fs.readFileSync('src/web/public/sw.js', 'utf8'), {
    self: { addEventListener: (name: string, handler: (event: any) => void) => { handlers[name] = handler; }, clients },
    location: { origin: 'https://fintrack.test' }, caches, fetch, URL, Response, AbortSignal,
  });
  const request = (path: string, mode: string) => {
    let response: Promise<Response> | undefined;
    handlers.fetch({ request: { method: 'GET', url: `https://fintrack.test${path}`, mode }, respondWith: (value: Promise<Response>) => { response = value; }, waitUntil: vi.fn() });
    return response;
  };
  return { handlers, caches, fetch, request };
}

describe('service worker update cache', () => {
  it('falls back to HTML only for navigation, never for missing script files', async () => {
    const w = worker();
    expect(await (await w.request('/?test=1', 'navigate'))!.text()).toContain('offline page');
    expect((await w.request('/assets/index-new.js', 'cors'))!.type).toBe('error');
    expect(w.fetch).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ cache: 'no-store', signal: expect.anything() }));
  });

  it('does not intercept financial API requests', () => {
    const w = worker();
    expect(w.request('/api/transactions', 'cors')).toBeUndefined();
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it.each(['/assets/old.js', '/assets/old.css'])('rejects HTML from the network and cache for %s', async (path) => {
    const w = worker();
    const html = () => new Response('<html>wrong asset</html>', { headers: { 'Content-Type': 'text/html' } });
    w.fetch.mockResolvedValue(html());
    w.caches.match.mockResolvedValue(html());
    expect((await w.request(path, 'cors'))!.type).toBe('error');
    expect(w.caches.open).not.toHaveBeenCalled();
  });

  it('cleans only older FinTrack caches during activation', async () => {
    const w = worker();
    let done!: Promise<unknown>;
    w.handlers.activate({ waitUntil: (value: Promise<unknown>) => { done = value; } });
    await done;
    expect(w.caches.delete).toHaveBeenCalledTimes(1);
    expect(w.caches.delete).toHaveBeenCalledWith('fintrack-shell-v4');
  });
});
