import { escAttr, escHtml } from './escape.js';

/**
 * Logo koin berlapis:
 * 1. icon resmi dari server (Jupiter verified → DexScreener), bila ada.
 * 2. TrustWallet assets by mint (tepat untuk SPL token).
 * 3. CDN ikon by-symbol (kurasi mayor + tebakan generik).
 * 4. Huruf fallback (img menghapus dirinya bila semua gagal).
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

function symbolUrl(symbol: string): string {
  const up = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const id = KNOWN[up] ?? up.toLowerCase();
  return `${SYMBOL_CDN}/${id}.png`;
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
  const letter = escHtml(((symbol || '?')[0] ?? '?').toUpperCase());
  const alt = escAttr(symbol.toUpperCase());
  const style = o.extraStyle ? ` style="${escAttr(o.extraStyle)}"` : '';
  const chain: string[] = [];
  if (o.icon) chain.push(o.icon);
  if (o.mint) chain.push(mintUrl(o.mint));
  chain.push(symbolUrl(symbol));
  const [first, ...rest] = chain;
  const fb = rest.map((u) => escAttr(u)).join('|');
  return `<span class="avatar"${style}>${letter}<img src="${escAttr(first)}"${fb ? ` data-fb="${fb}"` : ''} alt="${alt}" loading="lazy" onerror="if(this.dataset.fb){var n=this.dataset.fb.split('|');this.src=n[0];this.dataset.fb=n.slice(1).join('|')}else{this.remove()}" /></span>`;
}

/** URL logo lapis pertama (untuk pramuat bila perlu). */
export function coinIconUrl(symbol: string, opts: Pick<CoinAvatarOpts, 'icon' | 'mint'> = {}): string {
  if (opts.icon) return opts.icon;
  if (opts.mint) return mintUrl(opts.mint);
  return symbolUrl(symbol);
}
