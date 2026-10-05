import { api } from '../lib/api.js';
import { formatIdr, fmtDate } from '../lib/format.js';
import { openModal, txForm } from '../components/modal.js';
import { isDesktop } from '../lib/state.js';

interface Tx {
  id: number; kind: string; amount_idr: number; account_id: number | null;
  to_account_id: number | null; category: string; note: string; occurred_at: string;
}

let sortKey: 'date' | 'amount' = 'date';
let sortDir: 1 | -1 = -1;
let fSearch = '';
let fMonth = '';
let fCat = '';
let fAcc = '';

export async function renderTransactions(el: HTMLElement): Promise<void> {
  el.innerHTML = `<div class="card"><div class="skeleton"></div><div class="skeleton"></div></div>`;
  const [txs, accounts] = await Promise.all([
    api.get('/api/transactions?limit=200') as Promise<Tx[]>,
    api.get('/api/accounts') as Promise<Array<{ id: number; name: string }>>,
  ]);
  const accName = new Map(accounts.map((a) => [a.id, a.name]));
  const cats = [...new Set(txs.map((t) => t.category))].sort();
  if (!fMonth) fMonth = new Date().toISOString().slice(0, 7);

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
      </div>`;
  } else {
    el.innerHTML = `
      <div class="card"><div class="between"><strong>Transaksi</strong><button class="btn-primary" id="btn-new">+ Catat</button></div></div>
      <div class="card">${txCards(filtered, accName)}</div>`;
  }

  const rebind = () => {
    fSearch = (document.getElementById('t-search') as HTMLInputElement)?.value ?? fSearch;
    fMonth = (document.getElementById('t-month') as HTMLInputElement)?.value ?? fMonth;
    fCat = (document.getElementById('t-cat') as HTMLSelectElement)?.value ?? '';
    fAcc = (document.getElementById('t-acc') as HTMLSelectElement)?.value ?? '';
  };
  (document.getElementById('t-search') as HTMLInputElement)?.addEventListener('input', () => {
    fSearch = (document.getElementById('t-search') as HTMLInputElement).value;
    renderTransactions(el);
    const s = document.getElementById('t-search') as HTMLInputElement;
    s.focus();
    s.setSelectionRange(s.value.length, s.value.length);
  });
  document.getElementById('t-month')!.onchange = () => {
    rebind();
    renderTransactions(el);
  };
  document.getElementById('t-cat')!.onchange = () => {
    rebind();
    renderTransactions(el);
  };
  document.getElementById('t-acc')!.onchange = () => {
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
  el.querySelectorAll('[data-del]').forEach(
    (b) => ((b as HTMLElement).onclick = async () => {
      if (!confirm('Hapus transaksi ini? Saldo akan dikembalikan.')) return;
      await api.del(`/api/transactions/${(b as HTMLElement).dataset.del}`);
      renderTransactions(el);
    }),
  );

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
    <th class="sortable" data-sort="amount" tabindex="0" style="text-align:right">Nominal${arrow('amount')}</th><th></th>
  </tr></thead><tbody>${txs
    .map(
      (t) => `<tr><td style="white-space:nowrap">${fmtDate(t.occurred_at)}</td>
      <td>${t.note || '—'}${t.kind === 'transfer' ? `<div class="muted">→ ${accName.get(t.to_account_id ?? -1) ?? ''}</div>` : ''}</td>
      <td>${t.category}</td><td>${accName.get(t.account_id ?? -1) ?? '—'}</td>
      <td style="text-align:right" class="${t.kind === 'expense' ? 'neg' : 'pos'}"><strong>${t.kind === 'expense' ? '−' : '+'}${formatIdr(t.amount_idr)}</strong></td>
      <td style="text-align:right"><button class="btn-ghost" data-del="${t.id}" style="min-height:40px">Hapus</button></td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function txCards(txs: Tx[], accName: Map<number, string>): string {
  if (txs.length === 0) return '<div class="empty"><div class="big">🧾</div>Belum ada transaksi.</div>';
  return txs
    .map(
      (t) => `<div class="between" style="padding:10px 0;border-bottom:1px solid var(--soft)">
      <div class="row"><span class="avatar" style="width:38px;height:38px;font-size:15px;background:${t.kind === 'expense' ? '#e5484d' : t.kind === 'income' ? '#0e9f6e' : '#2b3445'}">${t.kind === 'expense' ? '−' : t.kind === 'income' ? '+' : '⇄'}</span>
      <div><strong>${t.category}</strong><div class="muted">${t.note || ''} • ${accName.get(t.account_id ?? -1) ?? ''} • ${t.occurred_at.slice(0, 10)}</div></div></div>
      <div style="text-align:right"><div class="${t.kind === 'expense' ? 'neg' : 'pos'}"><strong>${t.kind === 'expense' ? '−' : '+'}${formatIdr(t.amount_idr)}</strong></div>
      <button class="btn-ghost" data-del="${t.id}" style="min-height:40px;font-size:12px;padding:4px 10px">Hapus</button></div></div>`,
    )
    .join('');
}

function openNew(el: HTMLElement, kind: string, accounts: Array<{ id: number; name: string }>): void {
  if (accounts.length === 0) {
    location.hash = '#/akun';
    return;
  }
  const { close, el: body } = openModal('Catat Transaksi', txForm(accounts, kind === 'invest' ? 'expense' : kind));
  const kindSel = body.querySelector('#f-kind') as HTMLSelectElement;
  const toWrap = body.querySelector('#f-to-wrap') as HTMLElement;
  const sync = () => {
    toWrap.style.display = kindSel.value === 'transfer' ? 'block' : 'none';
  };
  kindSel.onchange = sync;
  sync();
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
      });
      close();
      renderTransactions(el);
    } catch (e) {
      alert((e as Error).message);
    }
  };
}
