import { api } from '../lib/api.js';
import { formatIdr, fmtDate } from '../lib/format.js';
import { openModal, txForm, wireCatOptions, readOccurredAt, type TxFormInit } from '../components/modal.js';
import { isDesktop } from '../lib/state.js';

interface Tx {
  id: number; kind: string; amount_idr: number; account_id: number | null;
  to_account_id: number | null; category: string; note: string; occurred_at: string;
}

interface AccountRef {
  id: number; name: string;
}

let sortKey: 'date' | 'amount' = 'date';
let sortDir: 1 | -1 = -1;
let fSearch = '';
let fMonth = '';
let fMonthDefaulted = false;
let fCat = '';
let fAcc = '';
/** Halaman dimuat bertahap via offset; cache dipakai agar filter tidak refetch. */
let txCache: Tx[] | null = null;
let txExhausted = false;
const PAGE = 200;

function resetCache(): void {
  txCache = null;
  txExhausted = false;
}

/** Dipanggil dari luar (mis. quick action di main) setelah transaksi dibuat agar cache tidak basi. */
export function invalidateTxCache(): void {
  resetCache();
}

/** Ambil satu halaman berikutnya (default bulan dipakai server-side). */
async function loadPage(append: boolean): Promise<void> {
  const offset = append && txCache ? txCache.length : 0;
  const month = fMonth ? `&month=${fMonth}` : '';
  const page = (await api.get(`/api/transactions?limit=${PAGE}&offset=${offset}${month}`)) as Tx[];
  if (!txCache) txCache = [];
  txCache.push(...page);
  if (page.length < PAGE) txExhausted = true;
}

/** Tanggal transaksi + waktu bila bukan tengah malam. */
function tDate(iso: string): string {
  const t = iso.length > 10 ? iso.slice(11, 16) : '';
  return t && t !== '00:00' ? `${fmtDate(iso)} • ${t}` : fmtDate(iso);
}

export async function renderTransactions(el: HTMLElement): Promise<void> {
  if (!el.innerHTML.trim()) el.innerHTML = `<div class="card"><div class="skeleton"></div><div class="skeleton"></div></div>`;
  const accounts = (await api.get('/api/accounts')) as AccountRef[];
  if (!fMonthDefaulted) {
    fMonth = new Date().toISOString().slice(0, 7);
    fMonthDefaulted = true;
  }
  if (!txCache) await loadPage(false);
  const txs = txCache!;
  const accName = new Map(accounts.map((a) => [a.id, a.name]));
  const cats = [...new Set(txs.map((t) => t.category))].sort();

  const filtered = txs
    .filter((t) => (fMonth ? t.occurred_at.slice(0, 7) === fMonth : true))
    .filter((t) => (fCat ? t.category === fCat : true))
    .filter((t) => (fAcc ? String(t.account_id) === fAcc : true))
    .filter((t) => {
      const q = fSearch.trim().toLowerCase();
      return !q || t.note.toLowerCase().includes(q) || t.category.toLowerCase().includes(q);
    })
    .sort((a, b) =>
      sortKey === 'date'
        ? (a.occurred_at < b.occurred_at ? -1 : 1) * sortDir
        : (a.amount_idr - b.amount_idr) * sortDir,
    );

  const more =
    txExhausted || txs.length === 0
      ? ''
      : `<div style="text-align:center;margin-top:12px"><button class="btn-ghost" id="btn-more">Muat lebih banyak</button></div>`;

  const toolbar = `
    <div class="toolbar" role="search">
      <input type="search" id="t-search" placeholder="Cari catatan / kategori…" value="${fSearch}" aria-label="Cari transaksi" />
      <input type="month" id="t-month" value="${fMonth}" aria-label="Filter bulan" />
      <select id="t-cat" aria-label="Filter kategori"><option value="">Semua kategori</option>${cats.map((c) => `<option ${fCat === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
      <select id="t-acc" aria-label="Filter akun"><option value="">Semua akun</option>${accounts.map((a) => `<option value="${a.id}" ${fAcc === String(a.id) ? 'selected' : ''}>${a.name}</option>`).join('')}</select>
    </div>`;

  if (isDesktop()) {
    el.innerHTML = `
      <div class="card">
        <div class="between"><strong>Riwayat Transaksi</strong><button class="btn-primary" id="btn-new">+ Catat</button></div>
        <div style="margin-top:12px">${toolbar}</div>
        <div class="tbl-wrap">${txTable(filtered, accName)}</div>
        ${more}
      </div>`;
  } else {
    el.innerHTML = `
      <div class="card"><div class="between"><strong>Transaksi</strong><button class="btn-primary" id="btn-new">+ Catat</button></div></div>
      <div class="card">${toolbar}</div>
      <div class="card">${txCards(filtered, accName)}${more}</div>`;
  }

  const tSearch = document.getElementById('t-search') as HTMLInputElement | null;
  const tMonth = document.getElementById('t-month') as HTMLInputElement | null;
  const tCat = document.getElementById('t-cat') as HTMLSelectElement | null;
  const tAcc = document.getElementById('t-acc') as HTMLSelectElement | null;
  const rebind = () => {
    if (tSearch) fSearch = tSearch.value;
    if (tMonth) fMonth = tMonth.value;
    fCat = tCat?.value ?? '';
    fAcc = tAcc?.value ?? '';
  };
  tSearch?.addEventListener('input', () => {
    fSearch = tSearch.value;
    renderTransactions(el);
    const s = document.getElementById('t-search') as HTMLInputElement | null;
    s?.focus();
    if (s) s.setSelectionRange(s.value.length, s.value.length);
  });
  if (tMonth) tMonth.onchange = () => {
    rebind();
    resetCache();
    renderTransactions(el);
  };
  if (tCat) tCat.onchange = () => {
    rebind();
    renderTransactions(el);
  };
  if (tAcc) tAcc.onchange = () => {
    rebind();
    renderTransactions(el);
  };
  el.querySelectorAll('[data-sort]').forEach(
    (th) => ((th as HTMLElement).onclick = () => {
      const k = (th as HTMLElement).dataset.sort as 'date' | 'amount';
      if (sortKey === k) sortDir = sortDir === 1 ? -1 : 1;
      else {
        sortKey = k;
        sortDir = -1;
      }
      renderTransactions(el);
    }),
  );

  document.getElementById('btn-new')!.onclick = () => openNew(el, 'expense', accounts);
  el.querySelectorAll('[data-edit-id]').forEach(
    (b) => ((b as HTMLElement).onclick = () => {
      const tx = txs.find((t) => String(t.id) === (b as HTMLElement).dataset.editId)!;
      openEdit(el, tx, accounts);
    }),
  );
  el.querySelectorAll('[data-del]').forEach(
    (b) => ((b as HTMLElement).onclick = async () => {
      if (!confirm('Hapus transaksi ini? Saldo akan dikembalikan.')) return;
      await api.del(`/api/transactions/${(b as HTMLElement).dataset.del}`);
      resetCache();
      renderTransactions(el);
    }),
  );
  const moreBtn = document.getElementById('btn-more') as HTMLButtonElement | null;
  if (moreBtn) {
    moreBtn.onclick = async () => {
      if (moreBtn.disabled) return;
      moreBtn.disabled = true;
      moreBtn.textContent = 'Memuat…';
      await loadPage(true);
      renderTransactions(el);
    };
  }

  const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
  if (q.get('baru')) {
    history.replaceState(null, '', '#/transaksi');
    openNew(el, q.get('baru')!, accounts);
  }
}

function txTable(txs: Tx[], accName: Map<number, string>): string {
  if (txs.length === 0) return '<div class="empty">Tidak ada transaksi yang cocok.</div>';
  const arrow = (k: string) => (sortKey === k ? (sortDir === 1 ? ' ▲' : ' ▼') : '');
  return `<table class="data"><thead><tr>
    <th class="sortable" data-sort="date" tabindex="0">Tanggal${arrow('date')}</th>
    <th>Keterangan</th><th>Kategori</th><th>Akun</th>
    <th class="sortable" data-sort="amount" tabindex="0" style="text-align:right">Nominal${arrow('amount')}</th><th style="text-align:right">Aksi</th>
  </tr></thead><tbody>${txs
    .map(
      (t) => `<tr><td style="white-space:nowrap">${tDate(t.occurred_at)}</td>
      <td>${t.note || '—'}${t.kind === 'transfer' ? `<div class="muted">→ ${accName.get(t.to_account_id ?? -1) ?? ''}</div>` : ''}</td>
      <td>${t.category}</td><td>${accName.get(t.account_id ?? -1) ?? '—'}</td>
      <td style="text-align:right" class="${t.kind === 'expense' ? 'neg' : t.kind === 'income' ? 'pos' : ''}"><strong>${t.kind === 'expense' ? '−' : t.kind === 'income' ? '+' : ''}${formatIdr(t.amount_idr)}</strong></td>
      <td style="text-align:right;white-space:nowrap"><button class="btn-ghost" data-edit-id="${t.id}" style="min-height:40px">Ubah</button> <button class="btn-ghost" data-del="${t.id}" style="min-height:40px">Hapus</button></td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function txCards(txs: Tx[], accName: Map<number, string>): string {
  if (txs.length === 0) return '<div class="empty"><div class="big">🧾</div>Belum ada transaksi.</div>';
  return txs
    .map((t) => {
      const avatarBg = t.kind === 'expense' ? '#e5484d' : t.kind === 'income' ? '#0e9f6e' : '#2b3445';
      const avatarSign = t.kind === 'expense' ? '−' : t.kind === 'income' ? '+' : '⇄';
      const amtCls = t.kind === 'expense' ? 'neg' : t.kind === 'income' ? 'pos' : '';
      const amtSign = t.kind === 'expense' ? '−' : t.kind === 'income' ? '+' : '';
      return `<div class="between" style="padding:10px 0;border-bottom:1px solid var(--soft)">
      <div class="row"><span class="avatar" style="width:38px;height:38px;font-size:15px;background:${avatarBg}">${avatarSign}</span>
      <div><strong>${t.category}</strong><div class="muted">${t.note || ''}${t.kind === 'transfer' ? ` → ${accName.get(t.to_account_id ?? -1) ?? ''}` : ''} • ${accName.get(t.account_id ?? -1) ?? ''} • ${tDate(t.occurred_at)}</div></div></div>
      <div style="text-align:right"><div class="${amtCls}"><strong>${amtSign}${formatIdr(t.amount_idr)}</strong></div>
      <div class="row" style="gap:6px;justify-content:flex-end;margin-top:4px"><button class="btn-ghost" data-edit-id="${t.id}" style="min-height:40px;font-size:12px;padding:4px 10px">Ubah</button><button class="btn-ghost" data-del="${t.id}" style="min-height:40px;font-size:12px;padding:4px 10px">Hapus</button></div></div></div>`;
    })
    .join('');
}

function openNew(el: HTMLElement, kind: string, accounts: AccountRef[]): void {
  if (accounts.length === 0) {
    location.hash = '#/akun';
    return;
  }
  const { close, el: body } = openModal('Catat Transaksi', txForm(accounts, kind));
  const kindSel = body.querySelector('#f-kind') as HTMLSelectElement;
  const toWrap = body.querySelector('#f-to-wrap') as HTMLElement;
  const sync = () => {
    toWrap.style.display = kindSel.value === 'transfer' ? 'block' : 'none';
  };
  kindSel.onchange = sync;
  sync();
  wireCatOptions(body);
  (body.querySelector('#f-save') as HTMLButtonElement).onclick = async () => {
    const v = (id: string) => (body.querySelector(id) as HTMLInputElement | HTMLSelectElement).value;
    try {
      await api.post('/api/transactions', {
        kind: v('#f-kind'),
        amount_idr: Number((body.querySelector('#f-amount') as HTMLInputElement).value),
        account_id: Number(v('#f-acc')),
        ...(v('#f-kind') === 'transfer' ? { to_account_id: Number(v('#f-to')) } : {}),
        category: v('#f-cat') || 'Lainnya',
        note: v('#f-note'),
        occurred_at: readOccurredAt(body),
      });
      close();
      resetCache();
      renderTransactions(el);
    } catch (e) {
      alert((e as Error).message);
    }
  };
}

function openEdit(el: HTMLElement, tx: Tx, accounts: AccountRef[]): void {
  const init: TxFormInit = {
    amount_idr: tx.amount_idr,
    account_id: tx.account_id,
    to_account_id: tx.to_account_id,
    category: tx.category,
    note: tx.note,
    occurred_at: tx.occurred_at,
    lockKind: true,
    lockAccounts: true,
  };
  const { close, el: body } = openModal(`Ubah Transaksi`, txForm(accounts, tx.kind, init));
  (body.querySelector('#f-save') as HTMLButtonElement).onclick = async (e) => {
    const btn = e.target as HTMLButtonElement;
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('btn-loading');
    const v = (id: string) => (body.querySelector(id) as HTMLInputElement | HTMLSelectElement).value;
    try {
      await api.patch(`/api/transactions/${tx.id}`, {
        amount_idr: Number(v('#f-amount')),
        category: v('#f-cat') || tx.category,
        note: v('#f-note'),
        occurred_at: readOccurredAt(body),
      });
      close();
      resetCache();
      renderTransactions(el);
    } catch (err) {
      alert((err as Error).message);
      btn.disabled = false;
      btn.classList.remove('btn-loading');
    }
  };
}