import { api } from '../lib/api.js';
import { formatIdr, formatPct, timeAgo } from '../lib/format.js';
import { donut, PALETTE } from '../components/donut.js';
import { sparkline } from '../components/sparkline.js';
import { openModal } from '../components/modal.js';

let filter: string = 'Semua';

function badge(source: string | null, fetchedAt: string | null, stale: boolean): string {
  if (!source || !fetchedAt) return `<span class="badge">Harga manual</span>`;
  if (stale) return `<span class="badge stale">Harga tertunda • ${timeAgo(fetchedAt)}</span>`;
  if (source === 'manual') return `<span class="badge">Harga manual</span>`;
  return `<span class="badge live">Sinkron Live • ${timeAgo(fetchedAt)}</span>`;
}

export async function renderPortfolio(el: HTMLElement): Promise<void> {
  el.innerHTML = `<div class="card"><div class="skeleton"></div></div>`;
  const data = (await api.get('/api/portfolio')) as {
    assets: Array<{
      symbol: string; type: string; name: string; qty: string;
      current_price_idr: number | null; current_value_idr: number | null;
      cost_idr: number; pl_idr: number | null; pl_percent: number | null;
      price_source: string | null; price_fetched_at: string | null; is_stale: boolean;
    }>;
    total_value_idr: number; total_cost_idr: number; floating_pl_idr: number;
    diversification_score: number;
  };
  const shown = data.assets.filter((a) => filter === 'Semua' || a.type === filter.toLowerCase());

  const risk = [
    { label: 'Tinggi (crypto)', value: data.assets.filter((a) => a.type === 'crypto').reduce((s, a) => s + (a.current_value_idr ?? 0), 0) },
    { label: 'Moderat (saham)', value: data.assets.filter((a) => a.type === 'saham').reduce((s, a) => s + (a.current_value_idr ?? 0), 0) },
    { label: 'Rendah (reksadana)', value: data.assets.filter((a) => a.type === 'reksadana').reduce((s, a) => s + (a.current_value_idr ?? 0), 0) },
  ];

  el.innerHTML = `
  <div class="card">
    <div class="between"><div><div class="muted">Total Investasi</div><h2 style="margin:4px 0">${formatIdr(data.total_value_idr)}</h2></div>
    <div><button class="btn" id="btn-add">Tambah Aset</button> <button class="btn ghost" id="btn-sync">Sinkron Ulang</button></div></div>
    <div class="muted">Profil risiko</div>
    <div>${risk.map((r) => `<div class="row muted" style="font-size:12px;justify-content:space-between"><span>${r.label}</span><span>${formatIdr(r.value)}</span></div>`).join('')}</div>
  </div>
  <div class="chips">${['Semua', 'Crypto', 'Saham', 'Reksadana'].map((c) => `<button class="chip ${filter === c ? 'active' : ''}" data-f="${c}">${c}</button>`).join('')}</div>
  <div id="assets">${await assetsHtml(shown)}</div>
  <div class="cards2">
    <div class="card"><strong>Komposisi per aset</strong>${donut(shown.filter((a) => (a.current_value_idr ?? 0) > 0).map((a, i) => ({ label: a.symbol, value: a.current_value_idr ?? 0, color: PALETTE[i % PALETTE.length] })))}</div>
    <div class="card"><strong>Analisis Keuntungan</strong>
      <div class="row" style="justify-content:space-between"><span class="muted">Laba mengambang</span><strong class="${data.floating_pl_idr >= 0 ? 'pos' : 'neg'}">${formatIdr(data.floating_pl_idr)}</strong></div>
      <div class="row" style="justify-content:space-between"><span class="muted">Modal</span><strong>${formatIdr(data.total_cost_idr)}</strong></div>
      <div class="row" style="justify-content:space-between"><span class="muted">Skor diversifikasi</span><strong>${data.diversification_score}/100</strong></div>
    </div>
  </div>`;

  el.querySelectorAll('[data-f]').forEach((b) => ((b as HTMLElement).onclick = () => { filter = (b as HTMLElement).dataset.f!; renderPortfolio(el); }));
  (document.getElementById('btn-sync') as HTMLButtonElement).onclick = async (e) => {
    (e.target as HTMLButtonElement).textContent = 'Menyinkron…';
    try {
      await api.post('/api/prices/refresh', {});
    } catch (err) {
      alert((err as Error).message);
    }
    renderPortfolio(el);
  };
  (document.getElementById('btn-add') as HTMLButtonElement).onclick = () => {
    const { close, el: body } = openModal('Tambah Aset', `
      <label class="muted">Tipe</label><select id="a-type"><option value="crypto">crypto</option><option value="saham">saham (.JK)</option><option value="reksadana">reksadana</option></select>
      <label class="muted">Simbol (cth. HYPE / BBCA.JK)</label><input id="a-sym" />
      <label class="muted">Jumlah (qty)</label><input id="a-qty" value="1" />
      <label class="muted">Harga beli rata-rata (Rp)</label><input id="a-buy" type="number" min="0" value="0" />
      <label class="muted">Harga sekarang manual (opsional, untuk reksadana)</label><input id="a-now" type="number" min="0" />
      <button class="btn" id="a-save" style="width:100%">Simpan</button>`);
    (body.querySelector('#a-save') as HTMLButtonElement).onclick = async () => {
      const v = (id: string) => (body.querySelector(id) as HTMLInputElement).value;
      try {
        await api.put('/api/portfolio', {
          type: v('#a-type'), symbol: v('#a-sym'), qty: v('#a-qty'),
          avg_buy_price_idr: Number(v('#a-buy')),
          ...(v('#a-now') ? { price_idr: Number(v('#a-now')) } : {}),
        });
        close();
        renderPortfolio(el);
      } catch (err) {
        alert((err as Error).message);
      }
    };
  };
}

async function assetsHtml(assets: Array<{
  symbol: string; type: string; current_value_idr: number | null;
  pl_idr: number | null; pl_percent: number | null;
  price_source: string | null; price_fetched_at: string | null; is_stale: boolean;
  current_price_idr: number | null; qty: string;
}>): Promise<string> {
  if (assets.length === 0) return `<div class="card empty">Belum ada aset. Tambahkan HYPE, SOL, atau BBCA.JK.</div>`;
  const cards = await Promise.all(assets.map(async (a) => {
    let hist: Array<{ price_idr: number }> = [];
    try {
      hist = (await api.get(`/api/prices/history?symbol=${a.symbol}`)) as typeof hist;
    } catch { /* ignore */ }
    return `<div class="card asset-card">
      <div class="avatar">${a.symbol[0]}</div>
      <div style="flex:1"><strong>${a.symbol}</strong> <span class="muted">${a.type} • ${a.qty}</span><br/>
      <span>${a.current_value_idr != null ? formatIdr(a.current_value_idr) : '—'}</span>
      <span class="${(a.pl_idr ?? 0) >= 0 ? 'pos' : 'neg'}"> ${a.pl_idr != null ? formatIdr(a.pl_idr) + ' (' + formatPct(a.pl_percent) + ')' : ''}</span><br/>
      ${badge(a.price_source, a.price_fetched_at, a.is_stale)}</div>
      <div>${sparkline(hist)}</div>
    </div>`;
  }));
  return cards.join('');
}
