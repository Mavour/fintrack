import { escAttr, escHtml } from './escape.js';

/**
 * Logo koin berlapis:
 * 1. icon resmi dari server (Jupiter verified → DexScreener), bila ada.
 * 2. TrustWallet assets by mint (tepat untuk SPL token).
 * 3. CDN ikon by-symbol yang dikenal.
 * 4. Monogram lokal yang tetap terlihat selama gambar belum siap.
 */

const SYMBOL_CDN = 'https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color';
const TRUST_SOL = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/assets';

/** Simbol umum → id file di CDN (lowercase, tanpa spasi). */
const KNOWN: Record<string, string> = {
  BTC: 'btc',
  ETH: 'eth',
  WETH: 'eth',
  SOL: 'sol',
  USDC: 'usdc',
  USDT: 'usdt',
  HYPE: 'hype',
  JUP: 'jup',
  JTO: 'jto',
  JITOSOL: 'jitosol',
  MSOL: 'msol',
  BONK: 'bonk',
  WIF: 'wif',
  RAY: 'ray',
  ORCA: 'orca',
  RENDER: 'render',
  PYTH: 'pyth',
  WBTC: 'wbtc',
  DAI: 'dai',
  LINK: 'link',
  AVAX: 'avax',
  MATIC: 'matic',
  POL: 'matic',
  ARB: 'arb',
  OP: 'op',
  BNB: 'bnb',
  DOGE: 'doge',
  XRP: 'xrp',
  ADA: 'ada',
  DOT: 'dot',
  ATOM: 'atom',
  NEAR: 'near',
  APT: 'apt',
  SUI: 'sui',
  TIA: 'tia',
  SEI: 'sei',
  ONDO: 'ondo',
  DRIFT: 'drift',
  KMNO: 'kmno',
};

function symbolUrl(symbol: string): string | null {
  const up = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const id = KNOWN[up];
  return id ? `${SYMBOL_CDN}/${id}.png` : null;
}

const failedUrls = new Set<string>();

function candidates(symbol: string, o: CoinAvatarOpts): string[] {
  const urls: string[] = [];
  if (o.icon) urls.push(o.icon);
  if (o.mint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(o.mint)) urls.push(mintUrl(o.mint));
  const known = symbolUrl(symbol);
  if (known) urls.push(known);
  return [...new Set(urls)].filter((u) => !failedUrls.has(u));
}

/** Capture non-bubbling image events. Inline handlers are blocked by the CSP.
 * Installed before any page renders; also covers cards inserted by live sync. */
export function installCoinIconHandlers(root: Document = document): void {
  const failed = (img: HTMLImageElement): void => {
    if (img.getAttribute('src')) failedUrls.add(img.getAttribute('src')!);
    img.parentElement?.classList.remove('has-coin-icon');
    delete img.dataset.coinLoaded;
    let remaining: string[] = [];
    try { remaining = JSON.parse(img.dataset.fallbacks ?? '[]') as string[]; } catch { /* Keep the local monogram. */ }
    remaining = remaining.filter((u) => typeof u === 'string' && !failedUrls.has(u));
    const next = remaining.shift();
    if (!next) { img.remove(); return; }
    img.dataset.fallbacks = JSON.stringify(remaining);
    img.src = next;
  };
  root.addEventListener('error', (event) => {
    const img = event.target;
    if (img instanceof HTMLImageElement && img.hasAttribute('data-coin-icon')) failed(img);
  }, true);
  root.addEventListener('load', (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.hasAttribute('data-coin-icon')) return;
    if (!img.naturalWidth) { failed(img); return; }
    img.dataset.coinLoaded = 'true';
    img.parentElement?.classList.add('has-coin-icon');
  }, true);
}

function mintUrl(mint: string): string {
  return `${TRUST_SOL}/${mint}/logo.png`;
}

export interface CoinAvatarOpts {
  icon?: string | null;
  mint?: string | null;
  extraStyle?: string;
}

/**
 * Avatar lingkaran: huruf sebagai fallback, logo menutupinya bila termuat.
 * Rantai fallback: icon server → TrustWallet by mint → CDN by symbol → huruf.
 */
export function coinAvatar(symbol: string, opts: CoinAvatarOpts | string = {}): string {
  const o: CoinAvatarOpts = typeof opts === 'string' ? { extraStyle: opts } : opts;
  const monogram = escHtml(symbol.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 2) || '•');
  const style = o.extraStyle ? ` style="${escAttr(o.extraStyle)}"` : '';
  const [first, ...rest] = candidates(symbol, o);
  return `<span class="avatar coin-avatar"${style}><span class="coin-monogram" aria-hidden="true">${monogram}</span>${first ? `<img data-coin-icon src="${escAttr(first)}" data-fallbacks="${escAttr(JSON.stringify(rest))}" alt="" aria-hidden="true" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : ''}</span>`;
}

/** URL logo lapis pertama (untuk pramuat bila perlu). */
export function coinIconUrl(symbol: string, opts: Pick<CoinAvatarOpts, 'icon' | 'mint'> = {}): string | null {
  return candidates(symbol, opts)[0] ?? null;
}
