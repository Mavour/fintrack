import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let icons: typeof import('../src/web/lib/coinIcons.js');
beforeEach(async () => { vi.resetModules(); icons = await import('../src/web/lib/coinIcons.js'); });
afterEach(() => vi.unstubAllGlobals());

class ImageStub {
  dataset: Record<string, string>;
  naturalWidth = 0;
  removed = false;
  classes = new Set<string>();
  parentElement = { classList: { add: (s: string) => this.classes.add(s), remove: (s: string) => this.classes.delete(s) } };
  constructor(public src: string, rest: string[] = []) { this.dataset = { fallbacks: JSON.stringify(rest) }; }
  getAttribute(name: string): string | null { return name === 'src' ? this.src : null; }
  hasAttribute(name: string): boolean { return name === 'data-coin-icon'; }
  remove(): void { this.removed = true; }
}

function handlers(): Map<string, (e: { target: ImageStub }) => void> {
  vi.stubGlobal('HTMLImageElement', ImageStub);
  const listeners = new Map<string, (e: { target: ImageStub }) => void>();
  icons.installCoinIconHandlers({ addEventListener: (type: string, fn: (e: { target: ImageStub }) => void, capture: boolean) => {
    expect(capture).toBe(true); listeners.set(type, fn);
  } } as unknown as Document);
  return listeners;
}

it('keeps a local monogram visible without guessing unsupported ticker or EVM-as-Solana URLs', () => {
  const html = icons.coinAvatar('$ASCEND', { mint: '0x1111111111111111111111111111111111111111' });
  expect(html).toContain('coin-monogram'); expect(html).toContain('>AS</span>');
  expect(html).not.toContain('<img'); expect(html).not.toContain('onerror');
  expect(icons.coinIconUrl('$ASCEND')).toBeNull();
});

it('uses captured events under CSP and removes failed images after trying the next source', () => {
  const events = handlers();
  const img = new ImageStub('https://example.com/missing.png', ['https://example.com/fallback.png']);
  events.get('error')!({ target: img });
  expect(img.src).toBe('https://example.com/fallback.png'); expect(img.removed).toBe(false);
  expect(img.dataset.coinLoaded).toBeUndefined();
  events.get('error')!({ target: img });
  expect(img.removed).toBe(true); expect(img.classes.has('has-coin-icon')).toBe(false);
  // Live refresh does not request the same failed source repeatedly.
  expect(icons.coinAvatar('UNKNOWN', { icon: 'https://example.com/missing.png' })).not.toContain('<img');
});

it('reveals only decoded images and restores the fallback after a later image failure', () => {
  const events = handlers();
  const img = new ImageStub('https://example.com/coin.png'); img.naturalWidth = 64;
  events.get('load')!({ target: img });
  expect(img.dataset.coinLoaded).toBe('true'); expect(img.classes.has('has-coin-icon')).toBe(true);
  events.get('error')!({ target: img });
  expect(img.classes.has('has-coin-icon')).toBe(false); expect(img.removed).toBe(true);
});

it('treats zero-width loads as failures and escapes metadata without inline scripts', () => {
  const events = handlers(); const img = new ImageStub('https://example.com/empty.png');
  events.get('load')!({ target: img }); expect(img.removed).toBe(true);
  const html = icons.coinAvatar('<ETH>', { icon: 'https://example.com/logo?q="test"' });
  expect(html).toContain('&quot;test&quot;'); expect(html).not.toContain('onerror='); expect(html).not.toContain('onload=');
});
