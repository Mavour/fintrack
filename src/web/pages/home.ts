import { api } from '../lib/api.js';
import { formatIdr, formatPct, timeAgo } from '../lib/format.js';
import { donut, PALETTE } from '../components/donut.js';

let privat = false;

export async function renderHome(el: HTMLElement): Promise<void> {
  el.innerHTML = `<div class="card"><div class="skeleton"></div></div>`.repeat(3);
  const month = new Date().toISOString().slice(0, 7);
  const [dash, accounts, txs, prices] = await Promise.all([
    api.get(`/api/dashboard?month=${month}`),
    api.get('/api/accounts'),
    api.get('/api/transactions?limit=5'),
    api.get('/api/prices').catch(() => []),
  ]);
  const priceAt = (s: string) => (prices as Array<{ symbol: string; fetched_at: string }>).find((p) => p.symbol === s)?.fetched_at ?? null;

  const alloc = dash.allocation as Array<{ label: string; value_idr: number }>;
  const total = alloc.reduce((s, a) => s + a.value_idr, 0) || 1;
  const colors = ['#6d28d9', '#f59e0b', '#0d9488', '#3b82f6'];
  const show = (n: number) => (privat ? '••••••' : formatIdr(n));

  el.innerHTML = `
  <div id="sidenav"></div>
  <div>
  <div class="card balance-card">
    <div class="between"><span class="muted">Total Kekayaan</span><button class="btn ghost" id="btn-privat">${privat ? 'Tampil' : 'Privat'}</button></div>
    <h2 style="margin:6px 0">${show(dash.total_wealth_idr)}</h2>
    <div class="row muted" style="gap:14px">
      <span>Masuk: ${show(dash.income_this_month_idr)}</span>
      <span>Keluar: ${show(dash.expense_this_month_idr)}</span>
      <span class="${dash.total_pl_idr >= 0 ? '' : ''}">P/L: ${show(dash.total_pl_idr)}</span>
    </div>
  </div>

  <div class="card">
    <strong>Alokasi</strong>
    <div class="alloc-bar">${alloc.map((a, i) => `<span style="width:${((a.value_idr / total) * 100).toFixed(1)}%;background:${colors[i % 4]}"></span>`).join('')}</div>
    <div class="tiles">${alloc.map((a) => `<div class="tile"><div class="muted">${a.label}</div><strong>${privat ? '•••' : formatIdr(a.value_idr)}</strong></div>`).join('')}</div>
  </div>

  <div class="card">
    <div class="quick">
      <button data-q="expense">−<br/>Pengeluaran</button>
      <button data-q="income">+<br/>Top Up</button>
      <button data-q="transfer">⇄<br/>Transfer</button>
      <button data-q="invest">◎<br/>Investasi</button>
    </div>
  </div>

  <div class="card">
    <div class="between"><strong>Sumber Dana Aktif</strong><a href="#/akun">Lihat</a></div>
    <div class="hscroll" style="margin-top:8px">
      ${(accounts as Array<{ name: string; balance_idr: number }>).filter(() => true).map((a) => `<div class="pill"><div class="muted">${a.name}</div><strong>${show(a.balance_idr)}</strong></div>`).join('') || '<div class="empty">Belum ada akun</div>'}
    </div>
  </div>

  <div class="cards2">
    <div class="card"><strong>Pengeluaran per kategori</strong><div style="margin-top:8px">${donut((dash.expense_by_category as Array<{ category: string; total_idr: number }>).map((c, i) => ({ label: c.category, value: c.total_idr, color: PALETTE[i % PALETTE.length] })))}</div></div>
    <div class="card"><strong>Alokasi aset</strong><div style="margin-top:8px">${donut(alloc.map((a, i) => ({ label: a.label, value: a.value_idr, color: colors[i % 4] })))}</div></div>
  </div>

  <div class="card">
    <div class="between"><strong>Watchlist</strong><a href="#/portofolio">Semua</a></div>
    <div class="grid2" style="margin-top:8px" id="watch"></div>
  </div>

  <div class="card">
    <div class="between"><strong>Pengeluaran Terkini</strong><a href="#/transaksi">Semua</a></div>
    <table>${(txs as Array<{ category: string; note: string; amount_idr: number; occurred_at: string }>).map((t) => `<tr><td>${t.category}<div class="muted">${t.note || ''}</div></td><td style="text-align:right" class="neg">−${formatIdr(t.amount_idr)}</td></tr>`).join('') || '<tr><td class="empty">Belum ada transaksi</td></tr>'}</table>
  </div>
  </div>`;

  document.getElementById('btn-privat')!.onclick = () => {
    privat = !privat;
    renderHome(el);
  };
  el.querySelectorAll('[data-q]').forEach((b) =>
    (b as HTMLElement).onclick = () => {
      location.hash = `#/transaksi?baru=${(b as HTMLElement).dataset.q}`;
    },
  );

  // Watchlist 2x2 from portfolio
  try {
    const pf = await api.get('/api/portfolio') as { assets: Array<{ symbol: string; type: string; current_value_idr: number | null; pl_percent: number | null }> };
    const w = document.getElementById('watch')!;
    w.innerHTML = pf.assets.slice(0, 4).map((a) => `
      <div class="pill"><div class="row"><div class="avatar">${a.symbol[0]}</div><div><strong>${a.symbol}</strong><div class="muted">${a.type}</div></div></div>
      <div style="margin-top:6px"><strong>${a.current_value_idr ? show(a.current_value_idr) : '—'}</strong>
      <div class="${(a.pl_percent ?? 0) >= 0 ? 'pos' : 'neg'}" style="font-size:12px">${formatPct(a.pl_percent)}</div>
      <div class="muted" style="font-size:11px">${timeAgo(priceAt(a.symbol))}</div></div></div>`).join('') || '<div class="empty">Belum ada aset</div>';
  } catch { /* ignore */ }
}
