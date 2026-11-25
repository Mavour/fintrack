import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAppEntry, reloadAppUpdate } from '../src/web/lib/appUpdate.js';

const html = () => new Response('<script type="module" src="/assets/index-new.js"></script>', { headers: { 'Content-Type': 'text/html' } });
const script = () => new Response('console.log("new version")', { headers: { 'Content-Type': 'application/javascript' } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('location', { href: 'https://fintrack.test/?view=compact#/transaksi', replace: vi.fn() });
  vi.stubGlobal('window', { caches: true });
  vi.stubGlobal('caches', { keys: vi.fn().mockResolvedValue(['fintrack-shell-v4', 'fintrack-shell-v5', 'other-app']), delete: vi.fn().mockResolvedValue(true) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const controls = () => ({ button: { disabled: false, textContent: 'Muat ulang' } as HTMLButtonElement, status: { textContent: '' } as HTMLElement });

describe('application update reload', () => {
  it('checks fresh HTML and script, removes only app caches and preserves the page on navigation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(html()).mockResolvedValueOnce(script());
    vi.stubGlobal('fetch', fetchMock);
    const { button, status } = controls();
    await reloadAppUpdate(button, status);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/', expect.objectContaining({ cache: 'no-store' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/assets/index-new.js', expect.objectContaining({ cache: 'no-store' }));
    expect(caches.delete).toHaveBeenCalledTimes(2);
    expect(caches.delete).not.toHaveBeenCalledWith('other-app');
    const url = new URL(vi.mocked(location.replace).mock.calls[0][0] as string);
    expect(url.hash).toBe('#/transaksi');
    expect(url.searchParams.get('view')).toBe('compact');
    expect(url.searchParams.has('_ft_update')).toBe(true);
    expect(button.disabled).toBe(true);
  });

  it('prevents a second click while checking the new version', async () => {
    let resolve!: (value: Response) => void;
    const fetchMock = vi.fn().mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; })).mockResolvedValueOnce(script());
    vi.stubGlobal('fetch', fetchMock);
    const { button, status } = controls();
    const first = reloadAppUpdate(button, status);
    expect(button.textContent).toBe('Memuat…');
    await reloadAppUpdate(button, status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(html());
    await first;
    expect(location.replace).toHaveBeenCalledTimes(1);
  });

  it.each(['server error', 'missing script', 'HTML instead of JS'])('allows retry without navigating when %s', async (failure) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(failure === 'server error' ? new Response('', { status: 503 }) : failure === 'missing script' ? new Response('<html></html>') : html()).mockResolvedValueOnce(html());
    vi.stubGlobal('fetch', fetchMock);
    const { button, status } = controls();
    await reloadAppUpdate(button, status);
    expect(location.replace).not.toHaveBeenCalled();
    expect(caches.delete).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Coba lagi');
    expect(status.textContent).toContain('belum siap');
  });

  it('times out a stalled connection and re-enables the button', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const { button, status } = controls();
    const update = reloadAppUpdate(button, status);
    await vi.advanceTimersByTimeAsync(10_000);
    await update;
    expect(button.disabled).toBe(false);
    expect(status.textContent).toContain('koneksi terlalu lama');
    expect(location.replace).not.toHaveBeenCalled();
  });

  it('still navigates when cache storage is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(html()).mockResolvedValueOnce(script()));
    vi.mocked(caches.keys).mockRejectedValue(new Error('Cache blocked'));
    const { button, status } = controls();
    await reloadAppUpdate(button, status);
    expect(location.replace).toHaveBeenCalledOnce();
  });

  it('does not report a version when the page is a development entry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<script src="/main.ts"></script>')));
    expect(await fetchAppEntry()).toBeNull();
  });

  it('does not get stuck waiting for cache storage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(html()).mockResolvedValueOnce(script()));
    vi.mocked(caches.keys).mockReturnValue(new Promise(() => {}));
    const { button, status } = controls();
    const update = reloadAppUpdate(button, status);
    await vi.advanceTimersByTimeAsync(2000);
    await update;
    expect(location.replace).toHaveBeenCalledOnce();
  });
});
