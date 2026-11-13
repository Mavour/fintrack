/** Chain badge config (single source of truth). No emoji. Unknown chains -> gray. */
export const CHAIN_COLORS: Record<string, string> = {
  solana: '#9945FF',
  eth: '#627EEA',
  ethereum: '#627EEA',
  arb: '#28A0F0',
  arbitrum: '#28A0F0',
  base: '#0052FF',
  bsc: '#B58900',
  polygon: '#8247E5',
  op: '#FF0420',
  optimism: '#FF0420',
  avax: '#E84142',
  avalanche: '#E84142',
  hypercore: '#00C2A8',
  hyperevm: '#7C8CF8',
  hype: '#7C8CF8',
  elysium: '#55C4AC',
};

export const CHAIN_LABELS: Record<string, string> = {
  solana: 'Solana',
  eth: 'Ethereum',
  ethereum: 'Ethereum',
  arb: 'Arbitrum',
  arbitrum: 'Arbitrum',
  base: 'Base',
  bsc: 'BSC',
  polygon: 'Polygon',
  op: 'Optimism',
  optimism: 'Optimism',
  avax: 'Avalanche',
  avalanche: 'Avalanche',
  hypercore: 'HyperCore',
  hyperevm: 'HyperEVM',
  hype: 'HyperEVM',
  elysium: 'Elysium',
};

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function chainColor(chainId: string): string {
  return CHAIN_COLORS[chainId.toLowerCase()] ?? '#6b7686';
}

export function chainLabel(chainId: string, fallback?: string): string {
  return CHAIN_LABELS[chainId.toLowerCase()] ?? fallback ?? chainId;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export { esc };

/** Pill 22px / 11px / 600, bg 12% opacity, colored text + dot. */
export function chainBadge(chainId: string, chainName?: string): string {
  const color = chainColor(chainId);
  const [r, g, b] = hexToRgb(color);
  const label = esc(chainLabel(chainId, chainName));
  return `<span class="chain-badge" style="background:rgba(${r},${g},${b},0.12);color:${color}"><span class="dot" style="background:${color}"></span>${label}</span>`;
}

/** Gray chip for wallet label. Bila href diisi → chip jadi link tab baru. */
export function walletChip(label: string, href?: string | null): string {
  const inner = esc(label);
  if (href) return `<a class="wallet-chip" href="${esc(href)}" target="_blank" rel="noopener" title="Lihat detail onchain">${inner}</a>`;
  return `<span class="wallet-chip">${inner}</span>`;
}

/** URL detail onchain per alamat: Solana → Jupiter Portfolio, EVM → DeBank. */
export function walletUrl(address: string): string {
  const a = address.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return `https://debank.com/profile/${a}`;
  return `https://jup.ag/portfolio/${a}`;
}

/** Alamat pendek sebagai link detail onchain (tab baru). */
export function shortAddrLink(addr: string): string {
  return `<a href="${esc(walletUrl(addr))}" target="_blank" rel="noopener" title="Lihat detail onchain"><strong>${shortAddr(addr)}</strong></a>`;
}

/** Short address with copy button (address stays visible in privat mode, shortened). */
export function shortAddr(addr: string): string {
  if (addr.length <= 10) return esc(addr);
  return esc(`${addr.slice(0, 4)}…${addr.slice(-4)}`);
}
