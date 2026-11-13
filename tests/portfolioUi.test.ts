import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderPortfolio } from '../src/web/pages/portfolio.js';
import { formatIdr } from '../src/web/lib/format.js';

const mocks = vi.hoisted(() => ({ desktop: true, get: vi.fn() }));
vi.mock('../src/web/lib/api.js', () => ({ api: { get: mocks.get } }));
vi.mock('../src/web/lib/state.js', () => ({ isDesktop: () => mocks.desktop, isPrivat: () => false }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('portfolio crypto totals in the UI', () => {
  it.each([true, false])('includes LP and limit orders in the crypto summary (desktop=%s)', async (desktop) => {
    mocks.desktop = desktop;
    mocks.get.mockImplementation(async (url: string) => {
      if (url === '/api/portfolio') return {
        assets: [], wallet_tokens: [], wallet_defi: [{
          symbol: 'USDC', name: 'Order', amount: '2', value_idr: 2000, value_usd: 2,
          price_idr: 1000, price_usd: 1, output_symbol: 'SOL', filled_pct: 0,
          order_side: 'input', protocol: 'meteora', chains: ['solana'], wallets: ['S'],
          breakdown: [{ wallet: 'S', address: '', amount: '2', value_idr: 2000, value_usd: 2, filled_pct: 0 }],
        }],
        by_type: { crypto: 3000 }, total_value_idr: 3000, total_cost_idr: 0,
        floating_pl_idr: 0, lp_value_idr: 1000, lp_fees_idr: 100, cost_basis: {},
        hidden_tokens: 0, diversification_score: 50, diversification_label: 'Moderat',
      };
      if (url === '/api/wallets/registry') return { wallets: [{ id: 1, label: 'S', address: 'solana', network_type: 'solana' }] };
      if (url === '/api/wallets/lp') return { positions: [], summary: { count: 1, total_position_usd: 0.9, total_fees_usd: 0.1 } };
      if (url === '/api/wallets/status') return {
        health: { mode: 'live', last_success_at: null }, usd_idr: 1000,
        sync_status: [{ provider: 'meteora-dlmm', last_success_at: '2026-11-13T00:00:00Z', last_error: 'upstream unavailable' }], debank: { configured: true, budget: 0 },
      };
      if (url.startsWith('/api/wealth/trend')) return { points: [] };
      throw new Error(`Unexpected route: ${url}`);
    });
    vi.stubGlobal('document', { getElementById: () => ({ onclick: null }) });
    const root = { innerHTML: '', querySelectorAll: () => [] } as unknown as HTMLElement;
    await renderPortfolio(root);
    expect(root.innerHTML).toMatch(new RegExp(`Tinggi \\(Crypto\\)[\\s\\S]*?<strong>${formatIdr(3000)}</strong>`));
    expect(root.innerHTML).toContain('Total aset kripto');
    expect(root.innerHTML).toContain(`<title>Crypto: ${formatIdr(3000)}</title>`);
    expect(root.innerHTML).toContain('Limit order &amp; DeFi');
    expect(root.innerHTML).toContain('Token &amp; staking');
    expect(root.innerHTML).toContain('LP (termasuk fees)');
    expect(root.innerHTML).toContain('Subtotal aset langsung');
    expect(root.innerHTML).toContain('aria-label="Posisi portofolio"');
    expect(root.innerHTML).toContain('id="panel-lp" role="tabpanel" aria-labelledby="tab-lp" hidden');
    expect(root.innerHTML).toContain('id="panel-orders" role="tabpanel" aria-labelledby="tab-orders" hidden');
    expect(root.innerHTML).toContain('Meteora DLMM: upstream unavailable');
    expect(root.innerHTML.match(/Status data/g)).toHaveLength(1);
  });
});
