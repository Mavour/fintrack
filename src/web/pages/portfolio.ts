import { api } from '../lib/api.js';
import { formatIdr, formatPct, formatUsd, timeAgo } from '../lib/format.js';
import { escAttr, escHtml } from '../lib/escape.js';
import { coinAvatar } from '../lib/coinIcons.js';
import { wealthTrendCard } from '../lib/trend.js';
import { bindTrendHover } from '../components/trendline.js';
import { donut } from '../components/donut.js';
import { openModal } from '../components/modal.js';
import { isDesktop, isPrivat } from '../lib/state.js';
import { chainBadge, walletChip, walletUrl } from '../lib/chains.js';

let filter = 'Semua';
let lpSort: { key: 'tvl' | 'fees' | 'pool'; dir: 1 | -1 } = { key: 'tvl', dir: -1 };
let assetSort: { key: 'nama' | 'nilai'; dir: 1 | -1 } = { key: 'nilai', dir: -1 };
/** Cache harga beli wallet (dari /api/portfolio) untuk modal cost basis. */
let data_costCache: Record<string, number> = {};
/** Snapshot aset manual terakhir — dipakai untuk prefill form Ubah Aset. */
let data_assets: AssetV[] = [];
/** Snapshot token wallet terakhir — dipakai untuk modal detail aset. */
let data_wallets: WalletTokenV[] = [];
/** Snapshot limit order terakhir — dipakai untuk popup rincian per wallet. */
let data_defi: DefiV[] = [];

const show = (n: number) => (isPrivat() ? '••••••' : formatIdr(n));

/** Chip wallet yang bisa diklik → detail onchain (tab baru). */
function walletChips(labels: string[], addrs?: Array<string | undefined>): string {
  return labels
    .map((l, i) => {
      const a = addrs?.[i];
      return walletChip(l || 'Wallet', a ? walletUrl(a) : null);
    })
    .join('');
}

/** P/L per baris (tabel desktop): Mode Privat menyembunyikan nominal & persen,
 * belum ada harga beli = "—". */
function plCell(plIdr: number | null, plPercent: number | null): string {
  if (isPrivat()) return '<span class="muted">•••</span>';
  if (plIdr === null || plPercent === null) return '<span class="muted">—</span>';
  return `<strong class="${plIdr >= 0 ? 'pos' : 'neg'}">${formatIdr(plIdr)}</strong><div class="muted">${formatPct(plPercent)}</div>`;
}

/** P/L per baris (kartu mobile) — aturan yang sama dengan plCell. */
function plStat(plIdr: number | null, plPercent: number | null): string {
  if (isPrivat()) return '<span class="muted">•••</span>';
  if (plIdr === null || plPercent === null) return '<span class="muted">—</span>';
  return `<strong class="${plIdr >= 0 ? 'pos' : 'neg'}">${formatIdr(plIdr)}</strong><div class="muted">${formatPct(plPercent)}</div>`;
}

/** Satu sumber warna/urutan/label per jenis — dipakai donut & bar profil risiko. */
const TYPE_META: Array<[type: string, label: string, color: string]> = [
  ['crypto', 'Crypto', '#e5484d'],
  ['saham', 'Saham', '#f59e0b'],
  ['reksadana', 'Reksadana', '#0e9f6e'],
];
const typeOf = (r: assetRow): string => (r.k === 'm' ? r.a.type : 'crypto');
const typeLabel = (t: string): string => TYPE_META.find(([k]) => k === t)?.[1] ?? t;

interface AssetV {
  symbol: string; type: string; name: string; qty: string;
  avg_buy_price_idr: number; current_price_idr: number | null;
  current_value_idr: number | null; current_price_usd: number | null;
  current_value_usd: number | null; cost_idr: number;
  pl_idr: number | null; pl_percent: number | null;
  price_source: string | null; price_fetched_at: string | null; is_stale: boolean;
  chain: string | null;
  mint?: string | null;
  icon?: string | null;
  source: 'manual';
}

interface WalletTokenV {
  source: 'wallet'; type: 'crypto'; symbol: string; name: string; amount: string;
  price_usd: number | null; value_usd: number | null;
  price_idr: number | null; value_idr: number | null;
  cost_idr: number | null; pl_idr: number | null; pl_percent: number | null;
  has_cost: boolean; chains: string[]; wallets: string[];
  wallet_addrs?: string[];
  mint?: string | null;
  icon?: string | null;
}

interface DefiV {
  source: 'wallet'; type: 'crypto'; symbol: string; name: string; amount: string;
  price_usd: number | null; value_usd: number | null;
  price_idr: number | null; value_idr: number | null;
  output_symbol: string | null; order_side?: 'input' | 'output'; filled_pct: number | null; protocol: string;
  chains: string[]; wallets: string[];
  breakdown: Array<{
    wallet: string; address: string; amount: string; value_usd: number | null;
    value_idr: number | null; filled_pct: number | null;
  }>;
}

function usdNote(v: number | null, isCrypto: boolean): string {
  if (!isCrypto || v === null) return '';
  return ` <span class="muted">(${formatUsd(v)})</span>`;
}

export async function renderPortfolio(el: HTMLElement): Promise<void> {
  // Tanpa kedip: skeleton hanya saat pertama (konten lama dipertahankan saat refresh SSE).
  if (!el.innerHTML.trim()) el.innerHTML = `<div class="card"><div class="skeleton"></div><div class="skeleton"></div></div>`;
  const data = (await api.get(`/api/portfolio`)) as {
    assets: AssetV[]; wallet_tokens: WalletTokenV[]; cost_basis: Record<string, number>; hidden_tokens: number;
    total_value_idr: number; total_cost_idr: number;
    floating_pl_idr: number; diversification_score: number; diversification_label: string;
    lp_value_idr: number; lp_fees_idr: number; wallet_defi: DefiV[];
  };
  const lpValue = data.lp_value_idr ?? 0;
  const lpFees = data.lp_fees_idr ?? 0;
  data_costCache = data.cost_basis ?? {};
  const wallets = data.wallet_tokens ?? [];
  data_wallets = wallets;
  const manuals = data.assets;
  data_assets = manuals;
  // Baris terpadu Daftar Aset: manual (bisa edit) + wallet (read-only).
  // Server sudah memfilter: duplikat wallet, token tanpa harga, dan < $1 tidak dikirim.
  const combined = (t: string) => [
    ...manuals.filter((a) => t === 'Semua' || a.type === t.toLowerCase()).map((a) => ({ k: 'm' as const, a })),
    ...(t === 'Semua' || t === 'Crypto' ? wallets.map((w) => ({ k: 'w' as const, w })) : []),
  ];
  const counts = (t: string) => combined(t).length;
  const shown = combined(filter);
  // Donut & profil risiko selalu dari SELURUH aset (bukan filter aktif),
  // agar konsisten dengan Total Investasi yang global. Filter hanya untuk daftar.
  const allShown = combined('Semua');
  const valOf = (r: { k: 'm'; a: AssetV } | { k: 'w'; w: WalletTokenV }): number =>
    r.k === 'm' ? (r.a.current_value_idr ?? 0) : (r.w.value_idr ?? 0);
  const byTypeVal = (t: string) =>
    allShown.filter((r) => typeOf(r) === t).reduce((s, r) => s + valOf(r), 0) + (t === 'crypto' ? lpValue : 0);
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
      ${lpValue > 0 ? `<div class="between" style="margin-top:8px"><span class="muted">LP &amp; DeFi (termasuk di total)</span><strong>${show(lpValue)}</strong></div>${lpFees > 0 ? `<div class="muted" style="font-size:12px">termasuk fees belum diklaim ${show(lpFees)}</div>` : ''}` : ''}
      <div style="margin-top:14px;background:var(--soft);border-radius:14px;padding:12px">
        <div class="eyebrow" style="margin-bottom:8px">Alokasi Profil Risiko</div>
        <div class="alloc-bar" style="background:var(--border)">${riskRows.map(([, , v, c]) => `<span style="width:${((v / tv) * 100).toFixed(1)}%;background:${c}"></span>`).join('')}</div>
        ${riskRows.map(([risk, label, v, c]) => `<div class="row muted" style="justify-content:space-between;font-size:12.5px"><span><span style="display:inline-block;width:9px;height:9px;border-radius:3px;background:${c};margin-right:6px"></span>${risk} (${label})</span><strong>${isPrivat() ? '•••' : formatIdr(v)}</strong></div>`).join('')}
      </div>
    </div>`;

  const chips = `<div class="chips" role="tablist" aria-label="Filter jenis aset">${['Semua', 'Crypto', 'Saham', 'Reksadana'].map((c) => `<button class="chip ${filter === c ? 'active' : ''}" data-f="${c}" role="tab" aria-selected="${filter === c}">${c} (${counts(c)})</button>`).join('')}</div>`;

  const symOf = (r: { k: 'm'; a: AssetV } | { k: 'w'; w: WalletTokenV }): string =>
    r.k === 'm' ? r.a.symbol : r.w.symbol;
  // Posisi LP tidak lagi dipotong jadi section terpisah — LP hanya tampil
  // di kartu "Posisi LP". Baris aset ber-prefix LP- tidak ikut daftar.
  const spot = shown.filter((r) => !symOf(r).startsWith('LP-'));
  const cmp = (a: (typeof spot)[number], b: (typeof spot)[number]): number => {
    const d = assetSort.key === 'nama' ? symOf(a).localeCompare(symOf(b)) : valOf(a) - valOf(b);
    return d * assetSort.dir;
  };
  const spotSorted = [...spot].sort(cmp);
  // Ringkasan daftar yang sedang tampil (mengikuti filter aktif).
  const asetTotalIdr = spotSorted.reduce((s, r) => s + valOf(r), 0);
  const asetTotalUsd = spotSorted.reduce(
    (s, r) => s + (r.k === 'm' ? (r.a.current_value_usd ?? 0) : (r.w.value_usd ?? 0)), 0);
  const asetSummary = `<div class="between wrap" style="margin:8px 0 4px"><span class="muted">Total daftar ini (${spotSorted.length} aset)</span><span style="text-align:right"><strong>${show(asetTotalIdr)}</strong>${isPrivat() ? '' : `<div class="muted">${formatUsd(asetTotalUsd)}</div>`}</span></div>`;
  // Bukti live-update: umur harga termuda di daftar (halaman refresh otomatis via SSE tiap ada perubahan).
  const newestPriceAt = spotSorted
    .filter((r) => r.k === 'm' && r.a.price_fetched_at)
    .map((r) => (r as { k: 'm'; a: AssetV }).a.price_fetched_at as string)
    .sort()
    .pop();
  const freshNote = newestPriceAt ? ` <span class="muted" style="font-weight:400;font-size:12px">• harga ${timeAgo(newestPriceAt)}</span>` : '';
  const byTypeAll = new Map<string, number>();
  for (const r of allShown) {
    if (valOf(r) <= 0) continue;
    const t = typeOf(r);
    byTypeAll.set(t, (byTypeAll.get(t) ?? 0) + valOf(r));
  }
  if (lpValue > 0) byTypeAll.set('crypto', (byTypeAll.get('crypto') ?? 0) + lpValue);
  const compDonut = `<div class="card"><strong>Komposisi Portofolio</strong><div style="margin-top:8px">${donut(
    TYPE_META.filter(([t]) => (byTypeAll.get(t) ?? 0) > 0).map(([t, label, color]) => ({
      label,
      value: byTypeAll.get(t)!,
      color,
    })),
  )}</div></div>`;
  const hiddenHint = data.hidden_tokens > 0
    ? `<div class="muted" style="margin-top:8px;font-size:12.5px">${data.hidden_tokens} token di bawah $1 / tanpa harga disembunyikan dari daftar ini — lihat di Akun &amp; Bank › Wallet.</div>`
    : '';
  const withBuyPrice = (r: { k: 'm'; a: AssetV } | { k: 'w'; w: WalletTokenV }): boolean =>
    r.k === 'm' ? r.a.avg_buy_price_idr > 0 : r.w.has_cost;
  const buttons =
    `<button class="btn-primary" id="btn-add">+ Tambah Aset</button>
     <button class="btn-ghost" id="btn-sync">Perbarui Harga</button>`;
  const analysis = shown.some(withBuyPrice)
    ? `<div class="card"><strong>Analisis Keuntungan</strong>
      <div class="between" style="margin-top:10px"><span class="muted">Laba mengambang</span><strong class="${data.floating_pl_idr >= 0 ? 'pos' : 'neg'}">${show(data.floating_pl_idr)}</strong></div>
      <div class="between" style="margin-top:6px"><span class="muted">Modal</span><strong>${show(data.total_cost_idr)}</strong></div>
      ${lpValue > 0 ? `<div class="between" style="margin-top:6px"><span class="muted">LP &amp; DeFi</span><strong>${show(lpValue)}</strong></div>` : ''}
      <div class="between" style="margin-top:6px"><span class="muted">Skor diversifikasi</span><strong>${data.diversification_score}/100</strong></div>
      <div class="muted">${data.diversification_label}</div>
      <div style="display:grid;gap:8px;margin-top:12px">${buttons}</div>
    </div>`
    : `<div class="card"><div style="display:grid;gap:8px">${buttons}</div></div>`;

  // Limit order & DeFi wallet: dana dikunci di order — sudah termasuk Total Investasi.
  const defiList = data.wallet_defi ?? [];
  data_defi = defiList;
  const defiTotalIdr = defiList.reduce((s, d) => s + (d.value_idr ?? 0), 0);
  const defiTotalUsd = defiList.reduce((s, d) => s + (d.value_usd ?? 0), 0);
  const defiSection = defiList.length === 0 ? '' : `<div class="card lp-section">
    <div class="between"><strong>Limit Order &amp; DeFi</strong><span class="muted">${defiList.length} kelompok dana</span></div>
    <div class="between wrap" style="margin:8px 0 4px"><span class="muted">Total section ini</span><span style="text-align:right"><strong>${show(defiTotalIdr)}</strong>${isPrivat() ? '' : `<div class="muted">${formatUsd(defiTotalUsd)}</div>`}</span></div>
    ${defiList.map((d, i) => {
      const filled = d.filled_pct === null || d.filled_pct === undefined
        ? ''
        : ` • terisi ${(d.filled_pct * 100).toFixed(2)}%`;
      const wallets = walletChips(
        d.breakdown.map((b) => b.wallet),
        d.breakdown.map((b) => b.address),
      );
      const nW = d.breakdown.length > 1 ? ` • ${d.breakdown.length} wallet` : '';
      return `<div class="acc-item clickable" data-defi="${i}" tabindex="0" role="button" title="Klik untuk rincian per wallet${escAttr(nW)}"><div class="row" style="justify-content:space-between;flex-wrap:wrap">
        <span>${d.order_side === 'output' ? `<strong>${escHtml(d.symbol)}</strong> <span class="muted">hasil fill belum ditarik</span>` : `<strong>${escHtml(d.symbol)}</strong> → <strong>${escHtml(d.output_symbol ?? '?')}</strong>`}
          <span class="muted">${escHtml(d.amount)}${escHtml(filled)}${escHtml(nW)}</span></span>
        <span style="text-align:right"><strong>${d.value_idr != null ? show(d.value_idr) : '—'}</strong>${d.value_usd != null && !isPrivat() ? `<div class="muted">${formatUsd(d.value_usd)}</div>` : ''}</span></div>
        <div class="badges" style="margin-top:6px">${wallets}${d.chains.map((c) => chainBadge(c)).join('')}</div>
      </div>`;
    }).join('')}
  </div>`;
  // Error boundary per kartu: seksi wallet gagal → pesan di tempat, halaman tetap utuh.
  // Limit Order, DeFi, dan LP semuanya crypto — hanya tampil di filter Semua/Crypto.
  const showCryptoSections = filter === 'Semua' || filter === 'Crypto';
  let walletSection = '';
  if (showCryptoSections) {
    try {
      walletSection = await walletPositionsCard();
    } catch {
      walletSection = `<div class="card lp-section"><strong>Posisi LP</strong><div class="card-error">Gagal memuat, coba lagi.</div></div>`;
    }
  }
  const defiShown = showCryptoSections ? defiSection : '';

  // Tren nilai investasi dari snapshot harian (data asli).
  const trendCard = await wealthTrendCard({
    title: 'Tren Nilai Investasi',
    kind: 'invest',
    sub: 'Tanpa kas',
    color: '#8b5cf6',
  });

  if (isDesktop()) {
    el.innerHTML = `<div class="grid12">
      <div class="span8">${summaryCard}${chips}</div>
      <div class="span4">${compDonut}</div>
      ${trendCard ? `<div class="span12">${trendCard}</div>` : ''}
      <div class="span8"><div class="card"><strong>Daftar Aset</strong>${freshNote}${asetSummary}<div class="tbl-wrap" style="margin-top:8px">${assetTable(spotSorted)}</div>${hiddenHint}</div></div>
      <div class="span4">${analysis}</div>
      ${defiShown ? `<div class="span12">${defiShown}</div>` : ''}
      <div class="span12">${walletSection}</div>
    </div>`;
  } else {
    el.innerHTML = `${summaryCard}${chips}${compDonut}${trendCard}<div class="card">${asetSummary}</div><div id="assets">${await assetCards(spotSorted)}</div>${hiddenHint}${defiShown}${walletSection}${analysis}`;
  }

  el.querySelectorAll('[data-f]').forEach(
    (b) => ((b as HTMLElement).onclick = () => {
      filter = (b as HTMLElement).dataset.f!;
      renderPortfolio(el);
    }),
  );
  el.querySelectorAll('[data-asset-sort]').forEach(
    (b) => ((b as HTMLElement).onclick = () => {
      const key = (b as HTMLElement).dataset.assetSort as 'nama' | 'nilai';
      assetSort = assetSort.key === key ? { key, dir: assetSort.dir === 1 ? -1 : 1 } : { key, dir: -1 };
      renderPortfolio(el);
    }),
  );
  el.querySelectorAll('[data-lpsort]').forEach(
    (b) => ((b as HTMLElement).onclick = () => {
      const key = (b as HTMLElement).dataset.lpsort as 'tvl' | 'fees' | 'pool';
      lpSort = lpSort.key === key ? { key, dir: lpSort.dir === 1 ? -1 : 1 } : { key, dir: -1 };
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
  bindRowEdit(el);
  bindTrendHover(el);
}

type assetRow = { k: 'm'; a: AssetV } | { k: 'w'; w: WalletTokenV };

/** Sel ASET: avatar + simbol + chip label wallet + chain badge (hanya crypto).
 * Baris wallet ditandai pill "wallet" (read-only). Server sudah menyembunyikan baris duplikat. */
function assetCell(r: assetRow): string {
  if (r.k === 'w') {
    const w = r.w;
    const labels = walletChips(w.wallets, w.wallet_addrs);
    return `<div class="row">${coinAvatar(w.symbol, { icon: w.icon, mint: w.mint, extraStyle: 'width:34px;height:34px;font-size:14px' })}<strong>${escHtml(w.symbol)}</strong><span class="wallet-chip">wallet</span></div>
      <div class="badges">${labels}${w.chains.map((c) => chainBadge(c)).join('')}</div>`;
  }
  const a = r.a;
  const chains = a.type === 'crypto' && a.chain ? chainBadge(a.chain) : '';
  return `<div class="row">${coinAvatar(a.symbol, { icon: a.icon, mint: a.mint, extraStyle: 'width:34px;height:34px;font-size:14px' })}<strong>${escHtml(a.symbol)}</strong></div>
    ${chains ? `<div class="badges">${chains}</div>` : ''}`;
}

function assetTable(rows: assetRow[]): string {
  if (rows.length === 0) return '<div class="empty">Belum ada aset pada filter ini.</div>';
  const arrow = (k: 'nama' | 'nilai'): string => (assetSort.key === k ? (assetSort.dir === 1 ? ' ↑' : ' ↓') : '');
  return `<table class="data assets"><thead><tr>
    <th class="col-aset sortable" data-asset-sort="nama">Aset${arrow('nama')}</th><th class="col-jenis">Jenis</th><th class="col-qty" style="text-align:right">Qty</th><th class="col-harga" style="text-align:right">Harga</th><th class="col-nilai sortable" data-asset-sort="nilai" style="text-align:right">Nilai${arrow('nilai')}</th><th class="col-pl" style="text-align:right">P/L</th>
  </tr></thead><tbody>${rows
    .map((r) => {
      if (r.k === 'w') {
        const w = r.w;
        return `<tr data-cost="${escAttr(w.symbol)}" tabindex="0" title="Klik untuk lihat detail ${escAttr(w.symbol)}">
        <td>${assetCell(r)}</td>
        <td><span class="type-chip">${typeLabel('crypto')}</span></td>
        <td style="text-align:right">${escHtml(w.amount)}</td>
        <td style="text-align:right">${w.price_idr != null ? show(w.price_idr) : '—'}${w.price_usd != null ? `<div class="muted">${formatUsd(w.price_usd)}</div>` : ''}</td>
        <td style="text-align:right"><strong>${w.value_idr != null ? show(w.value_idr) : '—'}</strong>${w.value_usd != null ? `<div class="muted">${formatUsd(w.value_usd)}</div>` : ''}</td>
        <td style="text-align:right">${plCell(w.pl_idr, w.pl_percent)}</td>
      </tr>`;
      }
      const a = r.a;
      return `<tr class="clickable" data-edit="${escAttr(a.symbol)}" tabindex="0" title="Klik untuk lihat detail ${escAttr(a.symbol)}">
      <td>${assetCell(r)}</td>
      <td><span class="type-chip">${typeLabel(a.type)}</span></td>
      <td style="text-align:right">${escHtml(a.qty)}</td>
      <td style="text-align:right">${a.current_price_idr != null ? show(a.current_price_idr) : '—'}${a.type === 'crypto' && a.current_price_usd != null ? `<div class="muted">${formatUsd(a.current_price_usd)}</div>` : ''}</td>
      <td style="text-align:right"><strong>${a.current_value_idr != null ? show(a.current_value_idr) : '—'}</strong>${a.type === 'crypto' && a.current_value_usd != null ? `<div class="muted">${formatUsd(a.current_value_usd)}</div>` : ''}</td>
      <td style="text-align:right">${plCell(a.pl_idr, a.pl_percent)}</td>
    </tr>`;
    })
    .join('')}</tbody></table>`;
}

async function assetCards(rows: assetRow[]): Promise<string> {
  if (rows.length === 0) return `<div class="card empty"><div class="big">◈</div>Belum ada aset. Tambahkan HYPE, SOL, atau BBCA.JK.</div>`;
  const cards = rows.map((r) => {
    if (r.k === 'w') {
      const w = r.w;
      const labels = walletChips(w.wallets, w.wallet_addrs);
      return `<div class="card asset-card" data-cost="${escAttr(w.symbol)}" tabindex="0" role="button" aria-label="Lihat detail ${escAttr(w.symbol)}">
        <div class="row" style="align-items:center">
          ${coinAvatar(w.symbol, { icon: w.icon, mint: w.mint })}
          <div class="grow"><strong>${escHtml(w.symbol)}</strong> <span class="type-chip">${typeLabel('crypto')}</span>
            <div class="muted">${escHtml(w.amount)} × ${w.price_idr != null ? show(w.price_idr) : '—'}${usdNote(w.price_usd, true)}</div>
            <div class="badges">${labels}<span class="wallet-chip">wallet</span>${w.chains.map((c) => chainBadge(c)).join('')}</div>
          </div>
        </div>
        <div class="asset-stats">
          <div><span class="eyebrow">Nilai</span><strong>${w.value_idr != null ? show(w.value_idr) : '—'}</strong>${usdNote(w.value_usd, true)}</div>
          <div><span class="eyebrow">P/L</span>${plStat(w.pl_idr, w.pl_percent)}</div>
        </div>
      </div>`;
    }
    const a = r.a;
    const isCrypto = a.type === 'crypto';
    return `<div class="card asset-card" data-edit="${escAttr(a.symbol)}" tabindex="0" role="button" aria-label="Lihat detail ${escAttr(a.symbol)}">
      <div class="row" style="align-items:center">
        ${coinAvatar(a.symbol, { icon: a.icon, mint: a.mint })}
        <div class="grow"><strong>${escHtml(a.symbol)}</strong> <span class="type-chip">${typeLabel(a.type)}</span>
          <div class="muted">${escHtml(a.qty)} × ${a.current_price_idr != null ? show(a.current_price_idr) : '—'}${usdNote(a.current_price_usd, isCrypto)}</div>
          ${isCrypto && a.chain ? `<div class="badges">${chainBadge(a.chain)}</div>` : ''}
        </div>
      </div>
      <div class="asset-stats">
        <div><span class="eyebrow">Nilai</span><strong>${a.current_value_idr != null ? show(a.current_value_idr) : '—'}</strong>${usdNote(a.current_value_usd, isCrypto)}</div>
        <div><span class="eyebrow">P/L</span>${plStat(a.pl_idr, a.pl_percent)}</div>
      </div>
    </div>`;
  });
  return cards.join('');
}

/** Bind klik baris tabel + kartu: selalu buka detail dulu, aksi edit/harga beli ada di dalam detail. */
function bindRowEdit(el: HTMLElement): void {
  el.querySelectorAll('[data-edit]').forEach((row) => {
    const open = () => openAssetDetail(el, (row as HTMLElement).dataset.edit!);
    (row as HTMLElement).onclick = open;
    (row as HTMLElement).onkeydown = (e) => {
      if ((e as KeyboardEvent).key === 'Enter') open();
    };
  });
  // Baris wallet read-only: klik membuka detail (harga beli ada di dalam detail).
  el.querySelectorAll('[data-cost]').forEach((row) => {
    if ((row as HTMLElement).tagName === 'BUTTON') return; // tombol kecil ditangani sendiri
    const open = (e: Event) => {
      if ((e.target as HTMLElement).closest('[data-cost-btn],button,a')) return;
      const sym = (row as HTMLElement).getAttribute('data-cost')!;
      openAssetDetail(el, sym);
    };
    (row as HTMLElement).style.cursor = 'pointer';
    (row as HTMLElement).onclick = open as EventListener;
    (row as HTMLElement).onkeydown = (e) => {
      if ((e as KeyboardEvent).key === 'Enter') open(e);
    };
  });
  el.querySelectorAll('button[data-cost]').forEach((b) => {
    (b as HTMLElement).onclick = (e) => {
      e.stopPropagation();
      openAssetDetail(el, (b as HTMLElement).dataset.cost!);
    };
  });
  // mobile cards rendered? (desktop has none, but safe)
  el.querySelectorAll('.asset-card[data-edit]').forEach((c) => {
    (c as HTMLElement).onclick = (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      openAssetDetail(el, (c as HTMLElement).dataset.edit!);
    };
  });
  // Limit order: klik baris membuka popup rincian per wallet (klik chip wallet = tab onchain).
  el.querySelectorAll('[data-defi]').forEach((row) => {
    const open = (e: Event) => {
      if ((e.target as HTMLElement).closest('a')) return;
      openDefiDetail(Number((row as HTMLElement).dataset.defi));
    };
    (row as HTMLElement).style.cursor = 'pointer';
    (row as HTMLElement).onclick = open as EventListener;
    (row as HTMLElement).onkeydown = (e) => {
      if ((e as KeyboardEvent).key === 'Enter' && !(e.target as HTMLElement).closest('a')) open(e);
    };
  });
  el.querySelectorAll('.asset-card[data-cost]').forEach((c) => {
    (c as HTMLElement).onclick = (e) => {
      if ((e.target as HTMLElement).closest('button,a')) return;
      openAssetDetail(el, (c as HTMLElement).dataset.cost!);
    };
  });
}

/** Detail aset: klik baris/kartu selalu mendarat di sini dulu.
 *  Manual → info lengkap + tombol Ubah; wallet → info + tombol isi harga beli. */
function openAssetDetail(el: HTMLElement, symbol: string): void {
  const symU = symbol.toUpperCase();
  const manual = data_assets.find((a) => a.symbol.toUpperCase() === symU);
  const wallet = data_wallets.find((w) => w.symbol.toUpperCase() === symU);
  const kv = (k: string, v: string): string =>
    `<div class="between" style="margin-top:6px"><span class="muted">${k}</span><strong style="text-align:right">${v}</strong></div>`;
  if (manual) {
    const a = manual;
    const isCrypto = a.type === 'crypto';
    const pl = isPrivat() ? '•••' : (a.pl_idr === null || a.pl_percent === null
      ? '—'
      : `${formatIdr(a.pl_idr)} (${formatPct(a.pl_percent)})`);
    const { close, el: body } = openModal(`Detail ${a.symbol}`, `
      <div class="muted" style="margin-top:0">${a.name || ''} • <span class="type-chip">${typeLabel(a.type)}</span>${isCrypto && a.chain ? ` ${chainBadge(a.chain)}` : ''}</div>
      ${kv('Jumlah (qty)', a.qty)}
      ${kv('Harga beli rata-rata', a.avg_buy_price_idr > 0 ? show(a.avg_buy_price_idr) : '—')}
      ${kv('Harga sekarang', a.current_price_idr != null ? show(a.current_price_idr) : '—')}
      ${isCrypto && a.current_price_usd != null ? kv('Harga (USD)', formatUsd(a.current_price_usd)) : ''}
      ${kv('Nilai sekarang', a.current_value_idr != null ? show(a.current_value_idr) : '—')}
      ${kv('Modal', show(a.cost_idr))}
      ${kv('P/L', pl)}
      ${kv('Sumber harga', a.price_source ?? '—')}
      ${kv('Diperbarui', a.price_fetched_at ? timeAgo(a.price_fetched_at) : '—')}
      ${a.is_stale ? '<div class="muted" style="margin-top:4px">Harga basi — coba Perbarui Harga.</div>' : ''}
      <button class="btn-primary" id="d-edit">Ubah aset</button>`);
    (body.querySelector('#d-edit') as HTMLButtonElement).onclick = () => {
      close();
      openAssetForm(el, a.symbol);
    };
    return;
  }
  if (wallet) {
    const w = wallet;
    const cost = w.cost_idr ?? data_costCache[symU] ?? null;
    const pl = isPrivat() ? '•••' : (w.pl_idr === null || w.pl_percent === null
      ? '— (isi harga beli)'
      : `${formatIdr(w.pl_idr)} (${formatPct(w.pl_percent)})`);
    const labels = walletChips(w.wallets, w.wallet_addrs);
    const { close, el: body } = openModal(`Detail ${w.symbol}`, `
      <div class="muted" style="margin-top:0">${w.name || ''} • <span class="type-chip">crypto</span> <span class="wallet-chip">wallet</span></div>
      <div class="badges" style="margin-top:6px">${labels} ${w.chains.map((c) => chainBadge(c)).join(' ')}</div>
      ${kv('Jumlah', w.amount)}
      ${kv('Harga sekarang', w.price_idr != null ? show(w.price_idr) : '—')}
      ${w.price_usd != null ? kv('Harga (USD)', formatUsd(w.price_usd)) : ''}
      ${kv('Nilai sekarang', w.value_idr != null ? show(w.value_idr) : '—')}
      ${kv('Harga beli (input manual)', cost != null ? show(cost) : '—')}
      ${kv('P/L', pl)}
      <p class="muted" style="margin-bottom:0">Posisi wallet read-only — tidak bisa diubah/hapus dari sini. P/L dihitung dari harga beli yang Anda isi.</p>
      <button class="btn-primary" id="d-cost">${cost != null ? 'Ubah harga beli' : 'Isi harga beli'}</button>`);
    (body.querySelector('#d-cost') as HTMLButtonElement).onclick = () => {
      close();
      openCostForm(el, w.symbol);
    };
    return;
  }
  // Fallback: simbol tidak dikenal (mis. data basi) — buka form yang relevan.
  if (data_costCache[symU] != null) openCostForm(el, symbol);
  else openAssetForm(el, symbol);
}

/** Harga beli token wallet: satu-satunya sumber P/L wallet. Kosong = "-". */
function openCostForm(el: HTMLElement, symbol: string): void {
  const current = (data_costCache[symbol.toUpperCase()] ?? null) as number | null;
  const { close, el: body } = openModal(`Harga beli ${symbol}`, `
    <p class="muted" style="margin-top:0">Posisi wallet read-only. P/L hanya dihitung dari harga beli yang Anda isi di sini.</p>
    <label for="c-buy">Harga beli rata-rata (Rp)</label><input id="c-buy" type="number" min="0" value="${current ?? ''}" placeholder="cth. 1500000" inputmode="numeric" />
    <button class="btn-primary" id="c-save">Simpan</button>
    ${current !== null ? '<button class="btn-danger-ghost" id="c-del" style="width:100%;margin-top:8px">Hapus harga beli</button>' : ''}`);
  const saveBtn = body.querySelector('#c-save') as HTMLButtonElement;
  saveBtn.onclick = async (e) => {
    const btn = e.target as HTMLButtonElement;
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('btn-loading');
    try {
      await api.put('/api/cost-basis', {
        symbol,
        buy_price_idr: Number((body.querySelector('#c-buy') as HTMLInputElement).value),
      });
      close();
      renderPortfolio(el);
    } catch (err) {
      alert((err as Error).message);
      btn.disabled = false;
      btn.classList.remove('btn-loading');
    }
  };
  const del = body.querySelector('#c-del') as HTMLButtonElement | null;
  if (del) {
    del.onclick = async () => {
      try {
        await api.del(`/api/cost-basis/${symbol}`);
        close();
        renderPortfolio(el);
      } catch (err) {
        alert((err as Error).message);
      }
    };
  }
}

function openAssetForm(el: HTMLElement, symbol?: string): void {
  const cur = symbol ? data_assets.find((a) => a.symbol === symbol) : undefined;
  const typeVal = cur?.type ?? 'crypto';
  const qtyVal = cur?.qty ?? '1';
  const buyVal = cur && cur.avg_buy_price_idr > 0 ? String(cur.avg_buy_price_idr) : '';
  const { close, el: body } = openModal(symbol ? `Ubah ${symbol}` : 'Tambah Aset', `
    <label for="a-type">Tipe</label><select id="a-type"><option value="crypto" ${typeVal === 'crypto' ? 'selected' : ''}>Crypto</option><option value="saham" ${typeVal === 'saham' ? 'selected' : ''}>Saham (.JK)</option><option value="reksadana" ${typeVal === 'reksadana' ? 'selected' : ''}>Reksadana</option></select>
    ${symbol ? '' : '<label for="a-sym">Simbol (cth. HYPE / BBCA.JK)</label><input id="a-sym" />'}
    <label for="a-qty">Jumlah (qty)</label><input id="a-qty" value="${qtyVal}" inputmode="decimal" />
    <label for="a-buy">Harga beli rata-rata (Rp) — kosongkan bila lupa</label><input id="a-buy" type="number" min="0" value="${buyVal}" placeholder="cth. 1500000" inputmode="numeric" />
    <label for="a-now">Harga sekarang manual (opsional, untuk reksadana)</label><input id="a-now" type="number" min="0" />
    <button class="btn-primary" id="a-save">Simpan</button>
    ${symbol ? '<button class="btn-danger-ghost" id="a-del" style="width:100%;margin-top:8px">Hapus aset</button>' : ''}`);
  (body.querySelector('#a-save') as HTMLButtonElement).onclick = async () => {
    const v = (id: string) => (body.querySelector(id) as HTMLInputElement).value;
    // Kosong = tidak diubah: kirim harga beli tersimpan, jangan ditimpa jadi 0.
    const buyRaw = v('#a-buy').trim();
    const avg = buyRaw === '' ? (cur?.avg_buy_price_idr ?? 0) : Number(buyRaw);
    try {
      await api.put('/api/portfolio', {
        type: v('#a-type'),
        symbol: symbol ?? v('#a-sym'),
        qty: v('#a-qty'),
        avg_buy_price_idr: avg,
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

/** Popup rincian limit order per wallet pembentuk baris gabungan. */
function openDefiDetail(idx: number): void {
  const d = data_defi[idx];
  if (!d) return;
  const filled = (f: number | null): string =>
    f === null || f === undefined ? '—' : `${(f * 100).toFixed(2)}%`;
  const rows = d.breakdown
    .map(
      (b) => `<tr><td>${b.address ? `<a href="${escAttr(walletUrl(b.address))}" target="_blank" rel="noopener" title="Lihat detail onchain">${escHtml(b.wallet)}</a>` : escHtml(b.wallet)}</td>
        <td style="text-align:right">${escHtml(b.amount)}</td>
        <td style="text-align:right"><strong>${b.value_idr != null ? show(b.value_idr) : '—'}</strong>${b.value_usd != null && !isPrivat() ? `<div class="muted">${formatUsd(b.value_usd)}</div>` : ''}</td>
        <td style="text-align:right">${filled(b.filled_pct)}</td></tr>`,
    )
    .join('');
  openModal(d.order_side === 'output' ? `Hasil fill ${d.symbol} belum ditarik` : `${d.symbol} → ${d.output_symbol ?? '?'}`, `
    <div class="between"><span class="muted">Total terkunci</span><strong>${d.value_idr != null ? show(d.value_idr) : '—'}</strong></div>
    <div class="between" style="margin-top:4px"><span class="muted">Terisi (rata-rata)</span><strong>${filled(d.filled_pct)}</strong></div>
    <div class="muted" style="margin:8px 0 4px">${escHtml(d.protocol)} • terbagi di ${d.breakdown.length} wallet:</div>
    <div class="tbl-wrap"><table class="data"><thead><tr><th>Wallet</th><th style="text-align:right">Qty</th><th style="text-align:right">Nilai</th><th style="text-align:right">Terisi</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted" style="margin-bottom:0">Posisi wallet read-only — dana dikunci di order onchain.</p>`);
}

/** Pesan status per provider dari sync_status (ramah, tanpa stack trace). */
function providerWarnings(
  rows: Array<{ provider: string; last_success_at: string | null; last_error: string | null }>,
  wallets: Array<{ id: number; label: string }>,
): string[] {
  void wallets;
  const LABEL: Record<string, string> = {
    'jupiter-portfolio-v1': 'Jupiter',
    'jupiter-staking-v2': 'Jupiter Staking',
    'jupiter-limit-v2': 'Jupiter Limit Order',
    'solana-rpc-fallback': 'Solana RPC',
    'meteora-dlmm': 'Meteora DLMM',
    'meteora-damm-v2': 'Meteora DAMM v2',
    debank: 'DeBank',
    'evm-explorer': 'Blockscout',
    'evm-rpc': 'EVM RPC',
    ethplorer: 'Ethplorer',
    'hyperliquid-spot': 'HyperCore',
    'debank-budget': 'Kuota DeBank',
  };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.provider.startsWith('tier-') || r.provider.endsWith('-stub')) continue;
    if (!r.last_error || r.last_success_at) continue;
    if (seen.has(r.provider)) continue;
    seen.add(r.provider);
    const label = LABEL[r.provider] ?? r.provider;
    const err = r.last_error;
    if (/JUPITER_API_KEY belum diisi/.test(err)) out.push('Belum tersinkron: JUPITER_API_KEY belum diisi — token Solana memakai RPC publik.');
    else if (/DEBANK_ACCESS_KEY belum diisi/.test(err)) out.push('Belum tersinkron: DEBANK_ACCESS_KEY belum diisi — posisi EVM belum tersedia.');
    else if (/tidak ditemukan \(404\)/.test(err)) out.push(`${label}: endpoint wallet belum terverifikasi — memakai data terakhir.`);
    else if (/Circuit terbuka/.test(err)) out.push(`${label}: diistirahatkan sementara setelah gagal beruntun.`);
    else out.push(`${label}: ${err.slice(0, 90)}`);
    if (out.length >= 4) break;
  }
  return out;
}

/** Wallet tracker section: posisi LP per pool (tanpa filter — kolom Chain/Wallet ada di tabel). */
async function walletPositionsCard(): Promise<string> {
  let wallets: Array<{ id: number; label: string; address: string; network_type: string }> = [];
  let lp: Array<{
    wallet_id: number; wallet_label: string; pool_address: string; pair: string; protocol: string; chain_id: string;
    position_value_usd: number | null; unclaimed_fees_usd: number | null; pool_tvl_usd: number | null;
    in_range: number | null; position_address: string;
  }> = [];
  let lpSummary: { total_fees_usd: number; total_position_usd: number; count: number } = { total_fees_usd: 0, total_position_usd: 0, count: 0 };
  let health: { mode: string; last_success_at: string | null } = { mode: 'empty', last_success_at: null };
  let tiers: Record<string, { intervalSec: number; activeIntervalSec: number; lastSuccessAt: string | null; throttled: boolean; note: string | null }> | null = null;
  let usdIdr = 16000;
  let debankWarn = '';
  let debankProj = '';
  let providerWarns: string[] = [];
  try {
    const reg = (await api.get('/api/wallets/registry')) as { wallets: typeof wallets };
    wallets = reg.wallets;
    const lpr = (await api.get('/api/wallets/lp')) as { summary: typeof lpSummary; positions: typeof lp };
    lp = lpr.positions;
    lpSummary = lpr.summary;
    const st = (await api.get('/api/wallets/status')) as {
      health: typeof health; usd_idr: number;
      tiers?: Record<string, { intervalSec: number; activeIntervalSec: number; lastSuccessAt: string | null; throttled: boolean; note: string | null }>;
      sync_status: Array<{ provider: string; wallet_id: number | null; last_success_at: string | null; last_error: string | null }>;
      debank: { configured: boolean; units_remaining: number | null; budget: number; used_24h: number | null; calls_24h: Record<string, number> };
    };
    health = st.health;
    tiers = st.tiers ?? null;
    usdIdr = st.usd_idr || 16000;
    if (st.debank.configured && st.debank.budget > 0 && st.debank.units_remaining !== null && st.debank.units_remaining <= 0) {
      debankWarn = 'Unit DeBank habis — sync EVM otomatis dihentikan. Isi ulang unit di cloud.debank.com.';
    } else if (!st.debank.configured) {
      debankWarn = 'Belum tersinkron: DEBANK_ACCESS_KEY belum diisi — posisi EVM belum tersedia.';
    }
    // Status per provider (dari sync_status, tanpa key material ke frontend).
    providerWarns = providerWarnings(st.sync_status ?? [], wallets);
    if (st.debank.configured && st.debank.used_24h !== null) {
      debankProj = `DeBank 24 jam: ${st.debank.used_24h} unit dipakai${st.debank.budget > 0 ? ` dari anggaran ${st.debank.budget}/hari` : ''}.`;
    }
  } catch {
    return `<div class="card lp-section"><strong>Posisi LP</strong><div class="empty">Belum ada wallet. Tambahkan di Akun &amp; Bank &gt; Wallet.</div></div>`;
  }
  if (wallets.length === 0) {
    return `<div class="card lp-section"><strong>Posisi LP</strong><div class="empty">Belum ada wallet. Tambahkan di Akun &amp; Bank &gt; Wallet.</div></div>`;
  }
  const evmSlow = tiers?.evm?.throttled || tiers?.evm?.note ? `<span class="range-chip out">EVM melambat (hemat unit)</span>` : '';
  const badge = health.mode === 'live'
    ? `<span class="badge live"><span class="dot pulse"></span>Sinkron Live</span>`
    : `<span class="badge"><span class="dot"></span>Tertunda${health.last_success_at ? ` • ${timeAgo(health.last_success_at)}` : ''}</span>`;
  const walletChipFor = (id: number): string => {
    const w = wallets.find((x) => x.id === id);
    const label = w?.label ?? 'Wallet';
    return walletChip(label, w?.address ? walletUrl(w.address) : null);
  };
  const idrOf = (usd: number | null): string => (usd === null ? '—' : isPrivat() ? '••••••' : formatIdr(Math.round(usd * usdIdr)));
  /** Sel nilai ganda: Rp tebal + $ muted (seperti kolom Nilai di Daftar Aset). */
  const idrBoth = (usd: number | null): string => {
    if (usd === null) return '—';
    if (isPrivat()) return '•••';
    return `<strong>${formatIdr(Math.round(usd * usdIdr))}</strong><div class="muted">${formatUsd(usd)}</div>`;
  };
  const lpGrandUsd = lpSummary.total_position_usd + lpSummary.total_fees_usd;

  let body = '';
  {
    const val = (p: typeof lp[number], k: 'tvl' | 'fees' | 'pool'): number =>
      k === 'tvl' ? (p.position_value_usd ?? -1) : k === 'fees' ? (p.unclaimed_fees_usd ?? -1) : (p.pool_tvl_usd ?? -1);
    const rows = [...lp]
      .sort((a, b) => (val(a, lpSort.key) - val(b, lpSort.key)) * (lpSort.dir === 1 ? 1 : -1));
    const arrow = (k: 'tvl' | 'fees' | 'pool'): string => (lpSort.key === k ? (lpSort.dir === 1 ? ' ↑' : ' ↓') : '');
    const head = `<div class="between wrap" style="margin-bottom:4px"><span class="muted">Total Posisi LP (${lpSummary.count} pool)</span><span style="text-align:right"><strong>${isPrivat() ? '••••••' : formatIdr(Math.round(lpGrandUsd * usdIdr))}</strong>${isPrivat() ? '' : `<div class="muted">${formatUsd(lpGrandUsd)}</div>`}</span></div>
    <div class="between wrap" style="margin-bottom:8px"><span class="muted">TVL posisi: <strong>${isPrivat() ? '•••' : formatIdr(Math.round(lpSummary.total_position_usd * usdIdr))}</strong>${isPrivat() ? '' : ` (${formatUsd(lpSummary.total_position_usd)})`}</span><span class="muted">Fees belum diklaim: <strong>${isPrivat() ? '•••' : formatIdr(Math.round(lpSummary.total_fees_usd * usdIdr))}</strong>${isPrivat() ? '' : ` (${formatUsd(lpSummary.total_fees_usd)})`}</span></div>`;
    if (rows.length === 0) {
      body = head + '<div class="empty">Tidak ada posisi LP pada filter ini. Token wallet ditampilkan di Daftar Aset di atas.</div>';
    } else if (isDesktop()) {
      body = head + `<div class="tbl-wrap"><table class="data fixed"><thead><tr><th>Pool</th><th>Protokol</th><th>Chain</th><th>Wallet</th><th class="sortable" data-lpsort="tvl" style="text-align:right">TVL posisi${arrow('tvl')}</th><th class="sortable" data-lpsort="fees" style="text-align:right">Fees${arrow('fees')}</th><th class="sortable" data-lpsort="pool" style="text-align:right">TVL pool${arrow('pool')}</th></tr></thead><tbody>${rows.map((p) => `<tr><td><strong>${p.pair || p.pool_address.slice(0, 8)}</strong>${p.in_range === null ? '' : p.in_range ? ' <span class="range-chip in">In range</span>' : ' <span class="range-chip out">Out of range</span>'}</td><td><span class="type-chip">${p.protocol}</span></td><td>${chainBadge(p.chain_id)}</td><td>${walletChipFor(p.wallet_id)}</td><td style="text-align:right">${idrBoth(p.position_value_usd)}</td><td style="text-align:right">${idrBoth(p.unclaimed_fees_usd)}</td><td style="text-align:right">${idrBoth(p.pool_tvl_usd)}</td></tr>`).join('')}</tbody></table></div>`;
    } else {
      body = head + rows.map((p) => `<div class="card asset-card"><div class="row" style="flex-wrap:wrap"><strong>${p.pair || p.pool_address.slice(0, 8)}</strong><span class="type-chip">${p.protocol}</span>${chainBadge(p.chain_id)}${p.in_range === null ? '' : p.in_range ? '<span class="range-chip in">In range</span>' : '<span class="range-chip out">Out of range</span>'}</div><div style="margin-top:4px">${walletChipFor(p.wallet_id)}</div><div class="lp-nums"><div><span class="eyebrow">Fees belum diklaim</span>${idrBoth(p.unclaimed_fees_usd)}</div><div><span class="eyebrow">TVL posisi</span>${idrBoth(p.position_value_usd)}</div><div><span class="eyebrow">TVL pool</span>${idrBoth(p.pool_tvl_usd)}</div></div></div>`).join('');
    }
  }

  return `<div class="card lp-section">
    <div class="between"><strong>Posisi LP</strong><span class="row" style="flex-wrap:wrap">${badge}${evmSlow}</span></div>
    ${debankWarn ? `<div class="muted" style="margin-top:4px">${debankWarn}</div>` : ''}
    ${providerWarns.map((w) => `<div class="muted" style="margin-top:2px">• ${w}</div>`).join('')}
    ${debankProj ? `<div class="muted" style="margin-top:2px">${debankProj}</div>` : ''}
    <div style="margin-top:8px">${body}</div>
  </div>`;
}
