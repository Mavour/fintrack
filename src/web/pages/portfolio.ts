import { api } from '../lib/api.js';
import { formatIdr, formatPct, formatUsd } from '../lib/format.js';
import { donut, PALETTE } from '../components/donut.js';
import { sparkline } from '../components/sparkline.js';
import { openModal } from '../components/modal.js';
import { isDesktop, isPrivat } from '../lib/state.js';

let filter = 'Semua';
const show = (n: number) => (isPrivat() ? '••••••' : formatIdr(n));

interface AssetV {
  symbol: string; type: string; name: string; qty: string;
  avg_buy_price_idr: number; current_price_idr: number | null;
  current_value_idr: number | null; current_price_usd: number | null;
  current_value_usd: number | null; cost_idr: number;
  pl_idr: number | null; pl_percent: number | null;
  price_source: string | null; price_fetched_at: string | null; is_stale: boolean;
}

function usdNote(v: number | null, isCrypto: boolean): string {
  if (!isCrypto || v === null) return '';
  return ` <span class="muted">(${formatUsd(v)})</span>`;
}

function plCell(a: AssetV): string {
  if (a.pl_idr === null) {
    const hint = a.avg_buy_price_idr === 0 ? 'harga beli belum diisi' : '—';
    return `<div class="muted">P/L disembunyikan (${hint})</div>`;
  }
  const dir = a.pl_idr >= 0 ? 'pos' : 'neg';
  return `<strong class="${dir}">${show(a.pl_idr)}</strong>
    <div class="${dir}" style="font-size:12px;font-weight:700">${formatPct(a.pl_percent)}</div>`;
}

function plBlock(a: AssetV): string {
  if (a.pl_idr === null) {
    const hint = a.avg_buy_price_idr === 0 ? ' — harga beli belum diisi' : '';
    return `<span class="muted">—${hint}</span>`;
  }
  return formatPct(a.pl_percent);
}

export async function renderPortfolio(el: HTMLElement): Promise<void> {
  el.innerHTML = `<div class="card"><div class="skeleton"></div><div class="skeleton"></div></div>`;
  const data = (await api.get('/api/portfolio')) as {
    assets: AssetV[]; total_value_idr: number; total_cost_idr: number;
    floating_pl_idr: number; diversification_score: number; diversification_label: string;
  };
  const counts = (t: string) => (t === 'Semua' ? data.assets.length : data.assets.filter((a) => a.type === t.toLowerCase()).length);
  const shown = data.assets.filter((a) => filter === 'Semua' || a.type === filter.toLowerCase());
  const byTypeVal = (t: string) => data.assets.filter((a) => a.type === t).reduce((s, a) => s + (a.current_value_idr ?? 0), 0);
  const tv = data.total_value_idr || 1;
  const riskRows: Array<[string, string, number, string]> = [
    ['Tinggi', 'Crypto', byTypeVal('crypto'), '#e5484d'],
    ['Moderat', 'Saham', byTypeVal('saham'), '#f59e0b'],
    ['Rendah', 'Reksadana', byTypeVal('reksadana'), '#0e9f6e'],
  ];

  const summaryCard = `
    <div class="card">
      <div class="between"><span class="eyebrow">Total Investasi</span></div>
      <div class="big-num">${show(data.total_value_idr)}</div>
      <span class="pill ${data.floating_pl_idr >= 0 ? 'up' : 'down'}">P/L all-time ${isPrivat() ? '•••' : formatIdr(data.floating_pl_idr)}</span>
      <div style="margin-top:14px;background:var(--soft);border-radius:14px;padding:12px">
        <div class="eyebrow" style="margin-bottom:8px">Alokasi Profil Risiko</div>
        <div class="alloc-bar" style="background:var(--border)">${riskRows.map(([, , v, c]) => `<span style="width:${((v / tv) * 100).toFixed(1)}%;background:${c}"></span>`).join('')}</div>
        ${riskRows.map(([risk, label, v, c]) => `<div class="row muted" style="justify-content:space-between;font-size:12.5px"><span><span style="display:inline-block;width:9px;height:9px;border-radius:3px;background:${c};margin-right:6px"></span>${risk} (${label})</span><strong>${isPrivat() ? '•••' : formatIdr(v)}</strong></div>`).join('')}
      </div>
    </div>`;

  const chips = `<div class="chips" role="tablist" aria-label="Filter jenis aset">${['Semua', 'Crypto', 'Saham', 'Reksadana'].map((c) => `<button class="chip ${filter === c ? 'active' : ''}" data-f="${c}" role="tab" aria-selected="${filter === c}">${c} (${counts(c)})</button>`).join('')}</div>`;

  const compDonut = `<div class="card"><strong>Komposisi Portofolio</strong><div style="margin-top:8px">${donut(shown.filter((a) => (a.current_value_idr ?? 0) > 0).map((a, i) => ({ label: a.symbol, value: a.current_value_idr ?? 0, color: PALETTE[i % PALETTE.length] })))}</div></div>`;

  const analysis = `
    <div class="card"><strong>Analisis Keuntungan</strong>
      <div class="between" style="margin-top:10px"><span class="muted">Laba mengambang</span><strong class="${data.floating_pl_idr >= 0 ? 'pos' : 'neg'}">${show(data.floating_pl_idr)}</strong></div>
      <div class="between" style="margin-top:6px"><span class="muted">Modal</span><strong>${show(data.total_cost_idr)}</strong></div>
      <div class="between" style="margin-top:6px"><span class="muted">Skor diversifikasi</span><strong>${data.diversification_score}/100</strong></div>
      <div class="muted">${data.diversification_label}</div>
      <div style="display:grid;gap:8px;margin-top:12px">
        <button class="btn-primary" id="btn-add">+ Tambah Aset</button>
        <button class="btn-ghost" id="btn-sync">Perbarui Harga</button>
        <button class="btn-ghost" id="btn-wallet">Sinkron Dompet</button>
      </div>
    </div>`;

  if (isDesktop()) {
    el.innerHTML = `<div class="grid12">
      <div class="span8">${summaryCard}${chips}</div>
      <div class="span4">${compDonut}</div>
      <div class="span8"><div class="card"><strong>Daftar Aset</strong><div class="tbl-wrap" style="margin-top:8px">${assetTable(shown)}</div></div></div>
      <div class="span4">${analysis}</div>
    </div>`;
  } else {
    el.innerHTML = `${summaryCard}${chips}${compDonut}<div id="assets">${await assetCards(shown)}</div>${analysis}`;
  }

  el.querySelectorAll('[data-f]').forEach(
    (b) => ((b as HTMLElement).onclick = () => {
      filter = (b as HTMLElement).dataset.f!;
      renderPortfolio(el);
    }),
  );
  document.getElementById('btn-sync')!.onclick = async (e) => {
    const btn = e.target as HTMLButtonElement;
    btn.textContent = 'Menyinkron…';
    try {
      await api.post('/api/prices/refresh', {});
    } catch (err) {
      alert((err as Error).message);
    }
    renderPortfolio(el);
  };
  document.getElementById('btn-add')!.onclick = () => openAssetForm(el);
  document.getElementById('btn-wallet')!.onclick = () => openWalletSync(el);
  if (isDesktop()) bindRowEdit(el);
}

function assetTable(assets: AssetV[]): string {
  if (assets.length === 0) return '<div class="empty">Belum ada aset pada filter ini.</div>';
  const tv = assets.reduce((s, a) => s + (a.current_value_idr ?? 0), 0) || 1;
  return `<table class="data"><thead><tr>
    <th>Aset</th><th>Jenis</th><th style="text-align:right">Qty</th><th style="text-align:right">Harga</th>
    <th style="text-align:right">Nilai</th><th style="text-align:right">P/L %</th><th style="text-align:right">Bobot %</th><th>Tren 7h</th>
  </tr></thead><tbody>${assets
    .map(
      (a) => `<tr class="clickable" data-edit="${a.symbol}" tabindex="0">
      <td><div class="row"><span class="avatar" style="width:34px;height:34px;font-size:14px">${a.symbol[0]}</span><strong>${a.symbol}</strong></div></td>
      <td><span class="type-chip">${a.type}</span></td>
      <td style="text-align:right">${a.qty}</td>
      <td style="text-align:right">${a.current_price_idr != null ? show(a.current_price_idr) : '—'}${a.type === 'crypto' && a.current_price_usd != null ? `<div class="muted">${formatUsd(a.current_price_usd)}</div>` : ''}</td>
      <td style="text-align:right"><strong>${a.current_value_idr != null ? show(a.current_value_idr) : '—'}</strong>${a.type === 'crypto' && a.current_value_usd != null ? `<div class="muted">${formatUsd(a.current_value_usd)}</div>` : ''}</td>
      <td style="text-align:right" class="${(a.pl_percent ?? 0) >= 0 ? 'pos' : 'neg'}">${plBlock(a)}</td>
      <td style="text-align:right">${(((a.current_value_idr ?? 0) / tv) * 100).toFixed(1)}%</td>
      <td data-spark="${a.symbol}"><span class="muted">…</span></td></tr>`,
    )
    .join('')}</tbody></table>`;
}

async function assetCards(assets: AssetV[]): Promise<string> {
  if (assets.length === 0) return `<div class="card empty"><div class="big">◈</div>Belum ada aset. Tambahkan HYPE, SOL, atau BBCA.JK.</div>`;
  const cards = await Promise.all(
    assets.map(async (a) => {
      let hist: Array<{ price_idr: number }> = [];
      try {
        hist = (await api.get(`/api/prices/history?symbol=${a.symbol}`)) as typeof hist;
      } catch { /* keep cache */ }
      const isCrypto = a.type === 'crypto';
      return `<div class="card asset-card" data-edit="${a.symbol}" tabindex="0" role="button" aria-label="Ubah ${a.symbol}">
        <div class="row" style="align-items:center">
          <div class="avatar">${a.symbol[0]}</div>
          <div class="grow"><strong>${a.symbol}</strong> <span class="type-chip">${a.type}</span>
            <div class="muted">${a.qty} × ${a.current_price_idr != null ? show(a.current_price_idr) : '—'}${usdNote(a.current_price_usd, isCrypto)}</div>
          </div>
          <div style="flex:none">${sparkline(hist, 84, 30)}</div>
        </div>
        <div class="asset-stats">
          <div><span class="eyebrow">Nilai</span><strong>${a.current_value_idr != null ? show(a.current_value_idr) : '—'}</strong>${usdNote(a.current_value_usd, isCrypto)}</div>
          <div><span class="eyebrow">P/L</span>${plCell(a)}</div>
        </div>
      </div>`;
    }),
  );
  return cards.join('');
}

/** Lazy-load sparklines for desktop table rows (parallel). */
async function bindRowEdit(el: HTMLElement): Promise<void> {
  const cells = [...el.querySelectorAll('[data-spark]')];
  await Promise.all(
    cells.map(async (cell) => {
      const sym = (cell as HTMLElement).dataset.spark!;
      try {
        const hist = (await api.get(`/api/prices/history?symbol=${sym}`)) as Array<{ price_idr: number }>;
        cell.innerHTML = sparkline(hist);
      } catch {
        cell.innerHTML = '<span class="muted">—</span>';
      }
    }),
  );
  el.querySelectorAll('[data-edit]').forEach((row) => {
    const open = () => openAssetForm(el, (row as HTMLElement).dataset.edit!);
    (row as HTMLElement).onclick = open;
    (row as HTMLElement).onkeydown = (e) => {
      if ((e as KeyboardEvent).key === 'Enter') open();
    };
  });
  // mobile cards rendered? (desktop has none, but safe)
  el.querySelectorAll('.asset-card[data-edit]').forEach((c) => {
    (c as HTMLElement).onclick = () => openAssetForm(el, (c as HTMLElement).dataset.edit!);
  });
}

function openAssetForm(el: HTMLElement, symbol?: string): void {
  const { close, el: body } = openModal(symbol ? `Ubah ${symbol}` : 'Tambah Aset', `
    <label for="a-type">Tipe</label><select id="a-type"><option value="crypto">crypto</option><option value="saham">saham (.JK)</option><option value="reksadana">reksadana</option></select>
    ${symbol ? '' : '<label for="a-sym">Simbol (cth. HYPE / BBCA.JK)</label><input id="a-sym" />'}
    <label for="a-qty">Jumlah (qty)</label><input id="a-qty" value="1" inputmode="decimal" />
    <label for="a-buy">Harga beli rata-rata (Rp) — kosongkan bila lupa</label><input id="a-buy" type="number" min="0" placeholder="cth. 1500000" inputmode="numeric" />
    <label for="a-now">Harga sekarang manual (opsional, untuk reksadana)</label><input id="a-now" type="number" min="0" />
    <button class="btn-primary" id="a-save">Simpan</button>
    ${symbol ? '<button class="btn-danger-ghost" id="a-del" style="width:100%;margin-top:8px">Hapus aset</button>' : ''}`);
  (body.querySelector('#a-save') as HTMLButtonElement).onclick = async () => {
    const v = (id: string) => (body.querySelector(id) as HTMLInputElement).value;
    try {
      await api.put('/api/portfolio', {
        type: v('#a-type'),
        symbol: symbol ?? v('#a-sym'),
        qty: v('#a-qty'),
        avg_buy_price_idr: Number(v('#a-buy')),
        ...(v('#a-now') ? { price_idr: Number(v('#a-now')) } : {}),
      });
      close();
      renderPortfolio(el);
    } catch (err) {
      alert((err as Error).message);
    }
  };
  const del = body.querySelector('#a-del') as HTMLButtonElement | null;
  if (del && symbol) {
    del.onclick = async () => {
      if (!confirm(`Hapus aset ${symbol}?`)) return;
      await api.del(`/api/portfolio/${symbol}`);
      close();
      renderPortfolio(el);
    };
  }
}

/** Sync holdings from a public wallet address (Solana via Jupiter, EVM via explorer). */
async function openWalletSync(el: HTMLElement): Promise<void> {
  const { chains, etherscan_configured } = (await api.get('/api/wallets/chains')) as {
    chains: Array<{ id: string; label: string; needs_key: boolean }>;
    etherscan_configured: boolean;
  };
  const lastChain = localStorage.getItem('fintrack-wallet-chain') ?? 'solana';
  const lastAddr = localStorage.getItem('fintrack-wallet-addr') ?? '';
  const { close, el: body } = openModal(
    'Sinkron Dompet',
    `<p class="muted" style="margin-top:0">Hanya alamat publik (watch-only). Tanpa private key / seed phrase. Harga beli otomatis = harga pasar saat pertama disinkron (khusus yang belum diisi).</p>
    <label for="w-chain">Jaringan</label><select id="w-chain">${chains.map((c) => `<option value="${c.id}" ${c.id === lastChain ? 'selected' : ''}>${c.label}${c.needs_key ? ' (butuh API key)' : ''}</option>`).join('')}</select>
    <div class="muted" id="w-keyhint" style="margin-top:4px"></div>
    <label for="w-addr">Alamat wallet</label><input id="w-addr" value="${lastAddr}" placeholder="cth. 3keq…Xpd" autocomplete="off" />
    <button class="btn-primary" id="w-preview">Lihat Pratinjau</button>
    <div id="w-list" style="margin-top:12px"></div>`,
  );
  const list = body.querySelector('#w-list') as HTMLElement;
  const chainSel = body.querySelector('#w-chain') as HTMLSelectElement;
  const keyHint = body.querySelector('#w-keyhint') as HTMLElement;
  const syncHint = () => {
    const needs = chains.find((c) => c.id === chainSel.value)?.needs_key;
    keyHint.textContent =
      needs && !etherscan_configured
        ? 'Jaringan ini perlu API key Etherscan gratis — daftar di etherscan.io lalu isi ETHERSCAN_API_KEY di .env dan restart.'
        : '';
  };
  chainSel.addEventListener('change', syncHint);
  syncHint();
  (body.querySelector('#w-preview') as HTMLButtonElement).onclick = async (e) => {
    const btn = e.target as HTMLButtonElement;
    const chain = (body.querySelector('#w-chain') as HTMLSelectElement).value;
    const address = (body.querySelector('#w-addr') as HTMLInputElement).value.trim();
    if (!address) {
      alert('Isi alamat wallet dulu');
      return;
    }
    btn.textContent = 'Memuat…';
    try {
      const data = (await api.get(`/api/wallets/preview?chain=${chain}&address=${encodeURIComponent(address)}`)) as {
        holdings: Array<{ symbol: string; name: string; qty: string; price_idr: number | null; already_tracked: boolean }>;
      };
      localStorage.setItem('fintrack-wallet-chain', chain);
      localStorage.setItem('fintrack-wallet-addr', address);
      if (data.holdings.length === 0) {
        list.innerHTML = '<div class="empty">Tidak ada token bersistaldo di alamat ini.</div>';
        return;
      }
      list.innerHTML =
        data.holdings
          .map(
            (h) => `<label class="row" style="gap:10px;padding:9px 0;border-bottom:1px solid var(--soft);cursor:pointer">
            <input type="checkbox" data-sym="${h.symbol}" checked style="width:20px;height:20px;min-height:20px" />
            <span style="flex:1"><strong>${h.symbol}</strong><div class="muted">${h.name} • ${h.qty}${h.already_tracked ? ' • sudah dilacak' : ''}</div></span>
            <strong>${h.price_idr != null ? formatIdr(h.price_idr) : '—'}</strong></label>`,
          )
          .join('') + `<button class="btn-primary" id="w-import" style="margin-top:12px">Impor yang dipilih</button>`;
      (list.querySelector('#w-import') as HTMLButtonElement).onclick = async () => {
        const symbols = [...list.querySelectorAll('input[data-sym]:checked')].map(
          (c) => (c as HTMLInputElement).dataset.sym!,
        );
        if (symbols.length === 0) {
          alert('Pilih minimal satu token');
          return;
        }
        await api.post('/api/wallets/import', { chain, address, symbols });
        close();
        renderPortfolio(el);
      };
    } catch (err) {
      list.innerHTML = `<div class="empty">Gagal: ${(err as Error).message}</div>`;
    } finally {
      btn.textContent = 'Lihat Pratinjau';
    }
  };
}
