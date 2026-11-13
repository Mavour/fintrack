import { api } from '../lib/api.js';
import { isScrollActive } from '../lib/scrollActivity.js';
import { formatIdr, formatCompactIdr, formatPct } from '../lib/format.js';
import { escAttr, escHtml } from '../lib/escape.js';
import { wealthTrendCard } from '../lib/trend.js';
import { bindTrendHover } from '../components/trendline.js';
import { donut, PALETTE, ALLOC_COLORS } from '../components/donut.js';
import { isDesktop, isPrivat } from '../lib/state.js';
import { icons } from '../components/icons.js';
import { coinAvatar } from '../lib/coinIcons.js';
import { openAddAccountModal } from './accounts.js';
import type { PortfolioFrame } from './portfolio.js';

const show = (n: number) => (isPrivat() ? '••••••' : formatIdr(n));
const showCompact = (n: number) => (isPrivat() ? '•••' : formatCompactIdr(n));

function setText(node: Element | null, value: string): void {
  if (!node || node.textContent === value) return;
  if (node.childNodes.length === 1 && node.firstChild?.nodeType === 3) node.firstChild.nodeValue = value;
  else node.textContent = value;
}

export function applyLiveHome(el: HTMLElement, frame: PortfolioFrame): void {
  const card = el.querySelector<HTMLElement>('[data-live-cash]');
  if (!card) return;
  const cash = Number(card.dataset.liveCash);
  const wealth = cash + frame.total_value_idr;
  const amount = card.querySelector('.big-num');
  setText(amount, show(wealth));
  const pill = card.querySelector('.pill');
  if (pill) { setText(pill, `P/L ${isPrivat() ? '•••' : formatIdr(frame.floating_pl_idr)}`); pill.className = `pill ${frame.floating_pl_idr >= 0 ? 'up' : 'down'}`; }
  el.querySelectorAll<HTMLElement>('[data-live-allocation]').forEach((tile) => {
    const label = tile.dataset.liveAllocation!;
    const value = label === 'Kas' ? cash : frame.by_type[label === 'Crypto' ? 'crypto' : label === 'Saham' ? 'saham' : 'reksadana'] ?? 0;
    const amount = tile.querySelector('.t-val'), percent = tile.querySelector('.t-pct');
    setText(amount, showCompact(value));
    setText(percent, `${((value / (wealth || 1)) * 100).toFixed(0)}% dari total`);
  });
  const allocation: Record<string, number> = { Kas: cash, Crypto: frame.by_type.crypto ?? 0, Saham: frame.by_type.saham ?? 0, Reksadana: frame.by_type.reksadana ?? 0 };
  card.querySelectorAll<HTMLElement>('.alloc-bar > span[title]').forEach(segment => {
    segment.style.width = `${(((allocation[segment.title] ?? 0) / (wealth || 1)) * 100).toFixed(1)}%`;
  });
  const chart = el.querySelector('.allocation-chart');
  let offset = 0;
  chart?.querySelectorAll('svg circle').forEach(circle => {
    const title = circle.querySelector('title');
    if (!title) return;
    const label = title.textContent?.split(':')[0] ?? '';
    const value = allocation[label] ?? 0;
    const circumference = 2 * Math.PI * Number(circle.getAttribute('r'));
    const fraction = value / (wealth || 1);
    circle.setAttribute('stroke-dasharray', `${(fraction * circumference).toFixed(1)} ${((1 - fraction) * circumference).toFixed(1)}`);
    circle.setAttribute('stroke-dashoffset', (-offset * circumference).toFixed(1));
    offset += fraction;
    setText(title, `${label}: ${show(value)}`);
  });
  chart?.querySelectorAll('svg + div > .row').forEach(row => {
    const label = row.children[1]?.textContent ?? '';
    setText(row.querySelector('strong'), `${(((allocation[label] ?? 0) / (wealth || 1)) * 100).toFixed(0)}%`);
  });
  el.querySelectorAll<HTMLElement>('[data-watch-symbol]').forEach((watch) => {
    const symbol = watch.dataset.watchSymbol;
    const a = frame.assets.find((a) => a.symbol === symbol);
    const w = frame.wallet_tokens.find((w) => w.symbol === symbol);
    const value = a?.current_value_idr ?? w?.value_idr;
    const price = watch.querySelector('.w-price');
    if (value != null) setText(price, show(value));
    const pl = a?.pl_percent ?? w?.pl_percent;
    const plNode = watch.querySelector('.muted > span');
    if (plNode && pl != null) {
      setText(plNode, `${isPrivat() ? '•••' : formatPct(pl)} P/L`);
      plNode.className = pl >= 0 ? 'pos' : 'neg';
    }
  });
}

export async function renderHome(el: HTMLElement, background = false): Promise<void> {
  const routeHash = background ? location.hash : '';
  if (!el.innerHTML.trim()) el.innerHTML = `<div class="card"><div class="skeleton"></div><div class="skeleton"></div></div>`.repeat(3);
  const month = new Date().toISOString().slice(0, 7);
  const [dash, accounts, txs, pf] = await Promise.all([
    api.get(`/api/dashboard?month=${month}`) as Promise<{
      total_wealth_idr: number; total_pl_idr: number;
      allocation: Array<{ label: string; value_idr: number }>;
      expense_by_category: Array<{ category: string; total_idr: number }>;
    }>,
    api.get('/api/accounts') as Promise<Array<{ id: number; name: string; type: string; balance_idr: number }>>,
    (background ? Promise.resolve([]) : api.get('/api/transactions?limit=5')) as Promise<
      Array<{ category: string; note: string; amount_idr: number; occurred_at: string; kind: string }>
    >,
    api.get('/api/portfolio').catch(() => null) as Promise<PortfolioFrame | null>,
  ]);

  if (background) {
    if (!pf || isScrollActive() || location.hash !== routeHash || document.querySelector('.modal-back')) return;
    const card = el.querySelector<HTMLElement>('[data-live-cash]');
    if (card) card.dataset.liveCash = String(dash.allocation.find(a => a.label === 'Kas')?.value_idr ?? 0);
    applyLiveHome(el, pf);
    el.querySelectorAll<HTMLElement>('[data-acc]').forEach(node => {
      const account = accounts.find(a => String(a.id) === node.dataset.acc);
      if (account) setText(node.querySelector('.a-bal'), show(account.balance_idr));
    });
    return;
  }

  const alloc = dash.allocation;
  const total = alloc.reduce((s, a) => s + a.value_idr, 0) || 1;
  const order = ['Saham', 'Crypto', 'Reksadana', 'Kas'];
  const sorted = [...alloc].sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  const tileFor = (label: string, tileLabel: string) => {
    const a = alloc.find((x) => x.label === label);
    const v = a?.value_idr ?? 0;
    return `<div class="tile" data-live-allocation="${label}"><div class="t-label">${tileLabel}</div><div class="t-val">${showCompact(v)}</div><div class="t-pct">${((v / total) * 100).toFixed(0)}% dari total</div></div>`;
  };

  const accCards = [...accounts]
    .sort((a, b) => b.balance_idr - a.balance_idr)
    .slice(0, 4)
    .map(
      (a) => `<button class="acc-card" data-acc="${a.id}"><div class="a-name">${escHtml(a.name)}</div><div class="a-type">${escHtml(a.type.replace('_', ' '))}</div><div class="a-bal">${show(a.balance_idr)}</div></button>`,
    )
    .join('');
  const pl = dash.total_pl_idr;

  const intro = `<div class="dashboard-intro"><div><div class="eyebrow">Ringkasan keuangan</div><h1>Lebih dekat dengan tujuan Anda.</h1><p>Kas, investasi, dan wallet dalam satu pandangan.</p></div><a class="overview-link" href="#/portofolio">Lihat portofolio <span aria-hidden="true">↗</span></a></div>`;
  const balanceCard = `
    <div class="card wealth-card" data-live-cash="${alloc.find((a) => a.label === 'Kas')?.value_idr ?? 0}">
      <div class="between"><span class="networth-label">Total kekayaan bersih</span><span class="wealth-icon">${icons.wallet}</span></div>
      <div class="big-num">${show(dash.total_wealth_idr)}</div>
      <div class="wealth-caption"><span class="pill ${pl >= 0 ? 'up' : 'down'}">P/L ${isPrivat() ? '•••' : formatIdr(pl)}</span><span>Berdasarkan modal tercatat</span></div>
      <div class="alloc-bar" role="img" aria-label="Alokasi aset">${sorted.map((a, i) => `<span style="width:${((a.value_idr / total) * 100).toFixed(1)}%;background:${ALLOC_COLORS[i % 4]}" title="${escAttr(a.label)}"></span>`).join('')}</div>
      <div class="tiles">
        ${tileFor('Kas', 'Kas & akun')}${tileFor('Crypto', 'Crypto')}${tileFor('Saham', 'Saham')}${tileFor('Reksadana', 'Reksadana')}
      </div>
    </div>`;

  const qaTiles = isDesktop()
    ? ''
    : `<div class="card quick-actions-card"><div class="qa-grid">
      <button class="qa-tile" data-q="expense"><span class="qa-ic">${icons.minus}</span>Pengeluaran</button>
      <button class="qa-tile" data-q="income"><span class="qa-ic">${icons.plus}</span>Top Up</button>
      <button class="qa-tile" data-q="transfer"><span class="qa-ic">${icons.swap}</span>Transfer</button>
    </div></div>`;

  const sumberDana = `
    <div class="card">
      <div class="between"><div><span class="eyebrow">Dana tersedia</span><h2 class="section-heading">Akun &amp; saldo</h2></div><a class="text-link" href="#/akun">Kelola ↗</a></div>
      <div class="acc-grid" style="margin-top:14px">${accCards || '<div class="empty">Belum ada akun</div>'}${isDesktop() ? '' : '<button class="acc-card acc-add" data-add-acc>+ Tambah akun</button>'}</div>
    </div>`;

  const watchAssets = [
    ...(pf?.assets ?? []).map((a) => ({ symbol: a.symbol, type: a.type, value: a.current_value_idr, pl: a.pl_percent, mint: null as string | null, icon: null as string | null })),
    ...(pf?.wallet_tokens ?? []).map((a) => ({ symbol: a.symbol, type: 'wallet', value: a.value_idr, pl: a.pl_percent, mint: a.mint, icon: a.icon })),
  ].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 4);
  const watchHtml = watchAssets.length === 0
    ? '<div class="empty">Aset Anda akan tampil di sini setelah ditambahkan.</div>'
    : watchAssets.map((a) => `<a class="watch-card" data-watch-symbol="${escAttr(a.symbol)}" href="#/portofolio"><div class="row">${coinAvatar(a.symbol, { mint: a.mint, icon: a.icon })}<div><div class="w-sym">${escHtml(a.symbol)}</div><div class="muted">${a.type === 'wallet' ? 'Dari wallet' : escHtml(a.type)}</div></div></div>
        <div class="w-price">${a.value != null ? show(a.value) : 'Belum ada harga'}</div>
        <div class="muted">${a.pl === null ? 'Modal belum tercatat' : `<span class="${a.pl >= 0 ? 'pos' : 'neg'}">${isPrivat() ? '•••' : formatPct(a.pl)} P/L</span>`}</div></a>`).join('');

  const trendCard = await wealthTrendCard({
    title: 'Tren Kekayaan Bersih',
    kind: 'total',
    sub: 'Total kas + investasi',
  });

  let html: string;
  if (isDesktop()) {
    html = `${intro}<div class="grid12 home-grid home-balanced">
      <div class="span7">${balanceCard}</div>
      <div class="span5">${sumberDana}</div>
      <div class="span12 home-trend">${trendCard}</div>
      <div class="span4"><div class="card allocation-card"><span class="eyebrow">Komposisi kekayaan</span><h2 class="section-heading">Alokasi aset</h2><div class="allocation-chart">${donut(sorted.map((a, i) => ({ label: a.label, value: a.value_idr, color: ALLOC_COLORS[i % 4] })))}</div></div></div>
      <div class="span6"><div class="card"><div class="between"><div><span class="eyebrow">Portofolio Anda</span><h2 class="section-heading">Aset terbesar</h2></div><a class="text-link" href="#/portofolio">Lihat semua ↗</a></div><div class="grid2">${watchHtml}</div></div></div>
      <div class="span6"><div class="card"><div class="between"><h2 class="section-heading">Transaksi terkini</h2><a class="text-link" href="#/transaksi">Lihat semua ↗</a></div>${recentTx(txs)}</div></div>
      ${dash.expense_by_category.length ? `<div class="span12"><div class="card"><h2 class="section-heading">Pengeluaran per kategori</h2><div style="margin-top:14px">${donut(dash.expense_by_category.map((c, i) => ({ label: c.category, value: c.total_idr, color: PALETTE[i % PALETTE.length] })))}</div></div></div>` : ''}
    </div>`;
  } else {
    html = `${intro}${balanceCard}${qaTiles}${sumberDana}
      <div class="card"><div class="between"><h2 class="section-heading">Aset terbesar</h2><a class="text-link" href="#/portofolio">Lihat semua ↗</a></div><div class="grid2">${watchHtml}</div></div>
      ${trendCard}
      ${dash.expense_by_category.length ? `<div class="card"><strong>Pengeluaran bulan ini</strong><div style="margin-top:8px">${donut(dash.expense_by_category.map((c, i) => ({ label: c.category, value: c.total_idr, color: PALETTE[i % PALETTE.length] })))}</div></div>` : ''}
      <div class="card"><div class="between"><strong>Transaksi terkini</strong><a href="#/transaksi">Semua</a></div>${recentTx(txs)}</div>`;
  }

  el.innerHTML = html;

  el.querySelectorAll('[data-q]').forEach(
    (b) => ((b as HTMLElement).onclick = () => (location.hash = `#/transaksi?baru=${(b as HTMLElement).dataset.q}`)),
  );
  el.querySelectorAll('[data-add-acc]').forEach(
    (b) => ((b as HTMLElement).onclick = () => openAddAccountModal(() => renderHome(el))),
  );
  el.querySelectorAll('[data-acc]').forEach(
    (b) => ((b as HTMLElement).onclick = () => (location.hash = '#/akun')),
  );
  bindTrendHover(el);
}

function recentTx(
  txs: Array<{ category: string; note: string; amount_idr: number; occurred_at: string; kind: string }>,
): string {
  if (txs.length === 0) return '<div class="empty">Belum ada transaksi</div>';
  return `<table class="data" style="min-width:0"><tbody>${txs
    .map(
      (t) => `<tr><td style="padding-top:13px;padding-bottom:13px"><strong>${escHtml(t.category)}</strong><div class="muted">${escHtml(t.note) || ''} • ${escHtml(t.occurred_at.slice(0, 10))}</div></td>
    <td style="text-align:right" class="${t.kind === 'expense' ? 'neg' : 'pos'}"><strong>${t.kind === 'expense' ? '−' : '+'}${formatIdr(t.amount_idr)}</strong></td></tr>`,
    )
    .join('')}</tbody></table>`;
}
