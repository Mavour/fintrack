import { api } from '../lib/api.js';
import { formatIdr, formatCompactIdr, formatPct, formatUsd } from '../lib/format.js';
import { donut, PALETTE, ALLOC_COLORS } from '../components/donut.js';
import { isDesktop, isPrivat } from '../lib/state.js';
import { icons } from '../components/icons.js';

const show = (n: number) => (isPrivat() ? '••••••' : formatIdr(n));
const showCompact = (n: number) => (isPrivat() ? '•••' : formatCompactIdr(n));

export async function renderHome(el: HTMLElement): Promise<void> {
  el.innerHTML = `<div class="card"><div class="skeleton"></div><div class="skeleton"></div></div>`.repeat(3);
  const month = new Date().toISOString().slice(0, 7);
  const [dash, accounts, txs, pf] = await Promise.all([
    api.get(`/api/dashboard?month=${month}`) as Promise<{
      total_wealth_idr: number; total_pl_idr: number;
      allocation: Array<{ label: string; value_idr: number }>;
      expense_by_category: Array<{ category: string; total_idr: number }>;
    }>,
    api.get('/api/accounts') as Promise<Array<{ id: number; name: string; type: string; balance_idr: number }>>,
    api.get('/api/transactions?limit=5') as Promise<
      Array<{ category: string; note: string; amount_idr: number; occurred_at: string; kind: string }>
    >,
    api.get('/api/portfolio').catch(() => null) as Promise<{
      assets: Array<{ symbol: string; type: string; current_price_idr: number | null; current_value_idr: number | null; current_price_usd: number | null; pl_percent: number | null }>;
    } | null>,
  ]);

  const alloc = dash.allocation;
  const total = alloc.reduce((s, a) => s + a.value_idr, 0) || 1;
  const order = ['Saham', 'Crypto', 'Reksadana', 'Kas'];
  const sorted = [...alloc].sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  const tileFor = (label: string, tileLabel: string) => {
    const a = alloc.find((x) => x.label === label);
    const v = a?.value_idr ?? 0;
    return `<div class="tile"><div class="t-label">${tileLabel}</div><div class="t-val">${showCompact(v)}</div><div class="t-pct">${((v / total) * 100).toFixed(0)}%</div></div>`;
  };

  const accCards = accounts
    .map(
      (a) => `<button class="acc-card" data-acc="${a.id}"><div class="a-name">${a.name}</div><div class="a-type">${a.type.replace('_', ' ')}</div><div class="a-bal">${show(a.balance_idr)}</div></button>`,
    )
    .join('');
  const pl = dash.total_pl_idr;

  const balanceCard = `
    <div class="card">
      <div class="networth-label">Halo</div>
      <h2 style="font-size:19px">Total Kekayaan Bersih (Net Worth)</h2>
      <div class="between" style="margin-top:10px"><span class="eyebrow">Saldo Konsolidasi</span></div>
      <div class="big-num">${show(dash.total_wealth_idr)}</div>
      <span class="pill ${pl >= 0 ? 'up' : 'down'}">P/L ${isPrivat() ? '•••' : formatIdr(pl)}</span>
      <div class="alloc-bar" role="img" aria-label="Alokasi aset">${sorted.map((a, i) => `<span style="width:${((a.value_idr / total) * 100).toFixed(1)}%;background:${ALLOC_COLORS[i % 4]}" title="${a.label}"></span>`).join('')}</div>
      <div class="tiles">
        ${tileFor('Saham', 'Saham')}${tileFor('Crypto', 'Crypto')}${tileFor('Reksadana', 'Reksadana')}${tileFor('Kas', 'Kas & Wallet')}
      </div>
    </div>`;

  const qaTiles = isDesktop()
    ? ''
    : `<div class="card"><div class="qa-grid">
      <button class="qa-tile" data-q="expense"><span class="qa-ic">${icons.minus}</span>Pengeluaran</button>
      <button class="qa-tile" data-q="income"><span class="qa-ic">${icons.plus}</span>Top Up</button>
      <button class="qa-tile" data-q="transfer"><span class="qa-ic">${icons.swap}</span>Transfer</button>
      <button class="qa-tile" data-q="invest"><span class="qa-ic">${icons.invest}</span>Investasi</button>
    </div></div>`;

  const sumberDana = `
    <div class="card">
      <div class="between"><strong>Sumber Dana Aktif</strong><a href="#/akun">Kelola</a></div>
      ${isDesktop() ? `<div class="acc-grid" style="margin-top:10px">${accCards || '<div class="empty">Belum ada akun</div>'}</div>`
        : `<div class="hscroll">${accCards}<button class="acc-card acc-add" data-add-acc>+<span>Akun</span></button></div>`}
    </div>`;

  const kpiCard = (label: string, value: number) =>
    `<div class="card"><div class="eyebrow">${label}</div><div style="font-size:21px;font-weight:800">${show(value)}</div></div>`;
  const val = (l: string) => alloc.find((a) => a.label === l)?.value_idr ?? 0;

  const watchHtml =
    !pf || pf.assets.length === 0
      ? '<div class="empty">Belum ada aset pantauan</div>'
      : pf.assets
        .slice(0, 4)
        .map(
          (a) => `<div class="watch-card"><div class="between"><span class="w-sym">${a.symbol}</span><span class="type-chip">${a.type}</span></div>
        <div class="w-price" style="margin-top:6px">${a.current_price_idr != null ? show(a.current_price_idr) : '—'}</div>
        ${a.type === 'crypto' && a.current_price_usd != null ? `<div class="muted" style="font-size:11.5px">${formatUsd(a.current_price_usd)}</div>` : ''}
        <span class="pill ${(a.pl_percent ?? 0) >= 0 ? 'up' : 'down'}">${formatPct(a.pl_percent)}</span></div>`,
        )
        .join('');

  if (isDesktop()) {
    el.innerHTML = `<div class="grid12">
      <div class="span8">${balanceCard}</div>
      <div class="span4"><div class="card"><strong>Alokasi Aset</strong><div style="margin-top:8px">${donut(sorted.map((a, i) => ({ label: a.label, value: a.value_idr, color: ALLOC_COLORS[i % 4] })))}</div></div></div>
      <div class="span3">${kpiCard('Kas & Wallet', val('Kas'))}</div>
      <div class="span3">${kpiCard('Saham', val('Saham'))}</div>
      <div class="span3">${kpiCard('Crypto', val('Crypto'))}</div>
      <div class="span3">${kpiCard('Reksadana', val('Reksadana'))}</div>
      <div class="span7">${sumberDana}<div class="card"><strong>Watchlist</strong><div class="grid2" style="margin-top:8px">${watchHtml}</div></div></div>
      <div class="span5"><div class="card"><strong>Pengeluaran per kategori</strong><div style="margin-top:8px">${donut(dash.expense_by_category.map((c, i) => ({ label: c.category, value: c.total_idr, color: PALETTE[i % PALETTE.length] })))}</div></div>
      <div class="card"><div class="between"><strong>Pengeluaran Terkini</strong><a href="#/transaksi">Semua</a></div>${recentTx(txs)}</div></div>
    </div>`;
  } else {
    el.innerHTML = `${balanceCard}${qaTiles}${sumberDana}
      <div class="card"><div class="between"><strong>Watchlist</strong><a href="#/portofolio">Semua</a></div><div class="grid2" style="margin-top:8px">${watchHtml}</div></div>
      <div class="card"><strong>Pengeluaran bulan ini</strong><div style="margin-top:8px">${donut(dash.expense_by_category.map((c, i) => ({ label: c.category, value: c.total_idr, color: PALETTE[i % PALETTE.length] })))}</div></div>
      <div class="card"><div class="between"><strong>Pengeluaran Terkini</strong><a href="#/transaksi">Semua</a></div>${recentTx(txs)}</div>`;
  }

  el.querySelectorAll('[data-q]').forEach(
    (b) => ((b as HTMLElement).onclick = () => (location.hash = `#/transaksi?baru=${(b as HTMLElement).dataset.q}`)),
  );
  el.querySelectorAll('[data-add-acc]').forEach(
    (b) => ((b as HTMLElement).onclick = () => (location.hash = '#/akun')),
  );
  el.querySelectorAll('[data-acc]').forEach(
    (b) => ((b as HTMLElement).onclick = () => (location.hash = '#/akun')),
  );
}

function recentTx(
  txs: Array<{ category: string; note: string; amount_idr: number; occurred_at: string; kind: string }>,
): string {
  if (txs.length === 0) return '<div class="empty">Belum ada transaksi</div>';
  return `<table class="data" style="min-width:0"><tbody>${txs
    .map(
      (t) => `<tr><td style="padding-top:13px;padding-bottom:13px"><strong>${t.category}</strong><div class="muted">${t.note || ''} • ${t.occurred_at.slice(0, 10)}</div></td>
    <td style="text-align:right" class="${t.kind === 'expense' ? 'neg' : 'pos'}"><strong>${t.kind === 'expense' ? '−' : '+'}${formatIdr(t.amount_idr)}</strong></td></tr>`,
    )
    .join('')}</tbody></table>`;
}
