import { api } from '../lib/api.js';
import { formatIdr, formatCompactIdr, fmtTransactionDate } from '../lib/format.js';
import { parseTimestamp, toWitaInput, witaMonth } from '../../shared/time.js';
import { escAttr, escHtml } from '../lib/escape.js';
import { openModal, txForm, wireCatOptions, wireTxAccounts, readOccurredAt, type TxFormInit, type TxAccountRef } from '../components/modal.js';
import { icons } from '../components/icons.js';
import { isDesktop } from '../lib/state.js';

interface Tx {
  id: number; kind: string; amount_idr: number; account_id: number | null;
  to_account_id: number | null; category: string; note: string; occurred_at: string;
  investment_symbol?: string | null;
  investment_asset_key?: string | null;
}

function transactionNote(tx: Tx): string {
  const assetKey = tx.investment_asset_key;
  const [, chain, contract] = assetKey?.split(':') ?? [];
  const asset = [tx.investment_symbol, chain, contract ? `…${contract.slice(-8)}` : ''].filter(Boolean).join(' · ');
  const text = escHtml([asset, tx.note].filter(Boolean).join(' • '));
  return assetKey ? `<span title="${escAttr(assetKey)}">${text}</span>` : text;
}

type AccountRef = TxAccountRef;

let sortKey: 'date' | 'amount' = 'date';
let sortDir: 1 | -1 = -1;
let fSearch = '';
let fMonth = '';
let fCat = '';
let fAcc = '';
let selectedDay = '';
let monthCache: { month: string; rows: Promise<Tx[]> } | null = null;
const PAGE = 200;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthFormat = new Intl.DateTimeFormat('id-ID', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const dayFormat = new Intl.DateTimeFormat('id-ID', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const weekdays = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];

/** Dipanggil dari luar (mis. quick action di main) setelah transaksi dibuat agar cache tidak basi. */
export function invalidateTxCache(): void {
  monthCache = null;
}

async function fetchMonth(month: string): Promise<Tx[]> {
  const rows: Tx[] = [];
  // Include all pages before publishing daily amounts.
  for (let offset = 0; ; offset += PAGE) {
    const page = await api.get(`/api/transactions?limit=${PAGE}&offset=${offset}&month=${month}`) as Tx[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

function loadMonth(month: string): Promise<Tx[]> {
  if (monthCache?.month === month) return monthCache.rows;
  const rows = fetchMonth(month).catch((err) => {
    if (monthCache?.rows === rows) invalidateTxCache();
    throw err;
  });
  monthCache = { month, rows };
  return rows;
}

function calendarDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

function adjacentMonth(month: string, direction: number): string {
  const date = calendarDate(`${month}-01`);
  date.setUTCMonth(date.getUTCMonth() + direction);
  return date.toISOString().slice(0, 7);
}

function cashflow(rows: Tx[]): { income: number; expense: number } {
  let income = 0;
  let expense = 0;
  for (const row of rows) {
    if (row.kind === 'expense') expense += row.amount_idr;
    if (row.kind === 'income' && !row.investment_symbol) income += row.amount_idr;
  }
  return { income, expense };
}

function flowClass(net: number): string {
  return net < 0 ? 'neg' : net > 0 ? 'pos' : '';
}

function totals(rows: Tx[]): string {
  const { income, expense } = cashflow(rows);
  return `<dl class="tx-totals">
    <div><dt>Pemasukan</dt><dd class="pos">${formatIdr(income)}</dd></div>
    <div><dt>Pengeluaran</dt><dd class="neg">${formatIdr(expense)}</dd></div>
    <div><dt>Selisih</dt><dd class="${flowClass(income - expense)}">${formatIdr(income - expense)}</dd></div>
  </dl>`;
}

function calendar(month: string, groups: Map<string, Tx[]>): string {
  const start = calendarDate(`${month}-01`);
  const leading = (start.getUTCDay() + 6) % 7;
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  const today = toWitaInput(new Date().toISOString()).slice(0, 10);
  const gaps = (count: number) => '<span class="tx-day-gap" aria-hidden="true"></span>'.repeat(count);
  const cells = Array.from({ length: end.getUTCDate() }, (_, i) => {
    const day = `${month}-${String(i + 1).padStart(2, '0')}`;
    const dayRows = groups.get(day) ?? [];
    const { income, expense } = cashflow(dayRows);
    const net = income - expense;
    const compact = formatCompactIdr(net).replace(/Rp\s*/, '');
    const amount = `${net > 0 ? '+' : ''}${compact}`;
    const description = `${dayFormat.format(calendarDate(day))}, ${dayRows.length} transaksi${dayRows.length ? `, selisih ${formatIdr(net)}` : ''}`;
    const label = `<span class="tx-day-number">${i + 1}</span>`;
    const current = day === today ? ' aria-current="date"' : '';
    if (!dayRows.length) return `<span class="tx-day tx-day-empty" aria-label="${escAttr(description)}"${current}>${label}</span>`;
    return `<button type="button" class="tx-day" data-day="${day}" aria-controls="tx-day-detail" aria-expanded="${day === selectedDay}"
      aria-label="${escAttr(description)}" title="${escAttr(description)}"${current}>
      ${label}<strong class="tx-day-amount ${flowClass(net)}">${amount}</strong>
      <span class="tx-day-count">${dayRows.length} transaksi</span>
    </button>`;
  }).join('');
  const trailing = (7 - (leading + end.getUTCDate()) % 7) % 7;
  return `<p class="tx-calendar-caption muted">Selisih harian (Rp). Pilih tanggal untuk melihat transaksi.</p>
    <div class="tx-calendar" role="group" aria-label="Kalender transaksi ${monthFormat.format(start)}">
      ${weekdays.map((day) => `<span class="tx-weekday" aria-hidden="true">${day}</span>`).join('')}
      ${gaps(leading)}${cells}${gaps(trailing)}
    </div>`;
}

function matchesFilters(tx: Tx, query: string): boolean {
  return (!fCat || tx.category === fCat)
    && (!fAcc || String(tx.account_id) === fAcc || String(tx.to_account_id) === fAcc)
    && (!query || [tx.note, tx.category, tx.investment_symbol, tx.investment_asset_key].some((value) => value?.toLowerCase().includes(query)));
}

function refreshAfterSave(el: HTMLElement, tx: Tx): void {
  invalidateTxCache();
  if (location.hash.split('?')[0] !== '#/transaksi') return;
  selectedDay = toWitaInput(tx.occurred_at).slice(0, 10);
  fMonth = selectedDay.slice(0, 7) || witaMonth();
  void renderTransactions(el);
}

export async function renderTransactions(el: HTMLElement): Promise<void> {
  const month = fMonth ||= witaMonth();
  el.innerHTML = `<section class="card tx-calendar-card" aria-labelledby="tx-calendar-title">
    <h2 id="tx-calendar-title">Kalender Transaksi</h2>
    <div class="toolbar tx-filters" role="search">
      <input type="search" id="t-search" placeholder="Cari catatan / kategori…" value="${escAttr(fSearch)}" aria-label="Cari transaksi" disabled />
      <select id="t-cat" aria-label="Filter kategori" disabled><option value="">Semua kategori</option></select>
      <select id="t-acc" aria-label="Filter akun" disabled><option value="">Semua akun</option></select>
    </div>
    <div class="tx-month-controls">
      <button type="button" class="btn-ghost icon-btn" id="tx-prev" aria-label="Bulan sebelumnya"${month === '0001-01' ? ' disabled' : ''}>${icons.chevronLeft}</button>
      <div class="tx-month-picker"><input type="month" id="t-month" value="${month}" min="0001-01" max="9999-12" aria-label="Pilih bulan" /></div>
      <button type="button" class="btn-ghost icon-btn" id="tx-next" aria-label="Bulan berikutnya"${month === '9999-12' ? ' disabled' : ''}>${icons.chevronRight}</button>
    </div>
    <div id="tx-month-content" aria-busy="true"><p class="muted" role="status">Memuat transaksi…</p></div>
  </section>
  <section class="card tx-day-detail" id="tx-day-detail" aria-labelledby="tx-day-heading" hidden></section>`;

  const content = el.querySelector<HTMLElement>('#tx-month-content')!;
  const detail = el.querySelector<HTMLElement>('#tx-day-detail')!;
  const current = () => content.isConnected && location.hash.split('?')[0] === '#/transaksi';
  const monthInput = el.querySelector<HTMLInputElement>('#t-month')!;
  const changeMonth = (next: string, focusId: string) => {
    if (!MONTH_PATTERN.test(next) || next.startsWith('0000-') || next === month) {
      monthInput.value = month;
      return;
    }
    fMonth = next;
    selectedDay = '';
    void renderTransactions(el);
    el.querySelector<HTMLElement>(`#${focusId}`)?.focus({ preventScroll: true });
  };
  el.querySelector<HTMLButtonElement>('#tx-prev')!.onclick = () => changeMonth(adjacentMonth(month, -1), 'tx-prev');
  el.querySelector<HTMLButtonElement>('#tx-next')!.onclick = () => changeMonth(adjacentMonth(month, 1), 'tx-next');
  monthInput.onchange = () => changeMonth(monthInput.value || witaMonth(), 't-month');

  let txs: Tx[];
  let accounts: AccountRef[];
  try {
    [txs, accounts] = await Promise.all([loadMonth(month), api.get('/api/accounts') as Promise<AccountRef[]>]);
  } catch (err) {
    if (!current()) return;
    content.setAttribute('aria-busy', 'false');
    content.innerHTML = `<div class="empty" role="status"><p>${escHtml((err as Error).message)}</p><button class="btn-ghost">Coba lagi</button></div>`;
    content.querySelector('button')!.onclick = () => void renderTransactions(el);
    return;
  }
  if (!current()) return;
  content.setAttribute('aria-busy', 'false');

  const accName = new Map(accounts.map((a) => [a.id, a.name]));
  const search = el.querySelector<HTMLInputElement>('#t-search')!;
  const categories = el.querySelector<HTMLSelectElement>('#t-cat')!;
  const accountFilter = el.querySelector<HTMLSelectElement>('#t-acc')!;
  const cats = [...new Set(txs.map((t) => t.category))].sort();
  if (fCat && !cats.includes(fCat)) fCat = '';
  for (const category of cats) categories.add(new Option(category, category));
  for (const account of accounts) accountFilter.add(new Option(account.name, String(account.id)));
  search.disabled = categories.disabled = accountFilter.disabled = false;
  categories.value = fCat;
  accountFilter.value = fAcc;
  fAcc = accountFilter.value;

  const groups = new Map<string, Tx[]>();
  const updateDetail = (focus = false) => {
    const dayRows = groups.get(selectedDay);
    detail.hidden = !dayRows;
    detail.innerHTML = '';
    for (const button of content.querySelectorAll<HTMLButtonElement>('button[data-day]')) {
      button.setAttribute('aria-expanded', String(button.dataset.day === selectedDay));
    }
    if (!dayRows) return;
    const sorted = dayRows.slice().sort((a, b) => {
      const delta = sortKey === 'amount' ? a.amount_idr - b.amount_idr
        : parseTimestamp(a.occurred_at).getTime() - parseTimestamp(b.occurred_at).getTime();
      return (delta || a.id - b.id) * sortDir;
    });
    detail.innerHTML = `<div class="between"><div>
      <h2 id="tx-day-heading" tabindex="-1">${dayFormat.format(calendarDate(selectedDay))}</h2>
      <div class="muted">${dayRows.length} transaksi</div>
    </div><button class="btn-ghost" data-close-day>Tutup</button></div>
    ${totals(dayRows)}
    ${isDesktop() ? `<div class="tbl-wrap">${txTable(sorted, accName)}</div>` : txCards(sorted, accName)}`;
    if (focus) detail.querySelector<HTMLElement>('#tx-day-heading')!.focus();
  };
  const updateCalendar = () => {
    groups.clear();
    const query = fSearch.trim().toLowerCase();
    const filtered = txs.filter((tx) => {
      if (!matchesFilters(tx, query)) return false;
      const day = toWitaInput(tx.occurred_at).slice(0, 10);
      if (!day.startsWith(month)) return false;
      const group = groups.get(day);
      if (group) group.push(tx);
      else groups.set(day, [tx]);
      return true;
    });
    if (!groups.has(selectedDay)) selectedDay = '';
    content.innerHTML = totals(filtered) + calendar(month, groups)
      + (filtered.length ? '' : '<p class="tx-calendar-empty muted" role="status">Tidak ada transaksi yang cocok di bulan ini.</p>');
    updateDetail();
  };
  search.oninput = () => { fSearch = search.value; updateCalendar(); };
  categories.onchange = () => { fCat = categories.value; updateCalendar(); };
  accountFilter.onchange = () => { fAcc = accountFilter.value; updateCalendar(); };
  content.onclick = (e) => {
    const day = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-day]')?.dataset.day;
    if (!day) return;
    selectedDay = selectedDay === day ? '' : day;
    updateDetail(!!selectedDay);
  };
  detail.onclick = async (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    if (button.hasAttribute('data-close-day')) {
      const dayButton = content.querySelector<HTMLButtonElement>(`[data-day="${selectedDay}"]`);
      selectedDay = '';
      updateDetail();
      dayButton?.focus();
    } else if (button.dataset.sort === 'date' || button.dataset.sort === 'amount') {
      const key = button.dataset.sort;
      sortDir = sortKey === key && sortDir === -1 ? 1 : -1;
      sortKey = key;
      updateDetail();
      detail.querySelector<HTMLButtonElement>(`[data-sort="${key}"]`)?.focus();
    } else if (button.dataset.editId) {
      const tx = groups.get(selectedDay)?.find((row) => row.id === Number(button.dataset.editId));
      if (tx) openEdit(el, tx, accounts);
    } else if (button.dataset.del && !button.disabled && confirm('Hapus transaksi ini? Saldo akan disesuaikan kembali.')) {
      button.disabled = true;
      button.classList.add('btn-loading');
      try {
        await api.del(`/api/transactions/${button.dataset.del}`);
        invalidateTxCache();
        if (current()) await renderTransactions(el);
      } catch (err) {
        alert((err as Error).message);
        button.disabled = false;
        button.classList.remove('btn-loading');
      }
    }
  };
  updateCalendar();

  const kind = new URLSearchParams(location.hash.split('?')[1] ?? '').get('baru');
  if (kind) {
    history.replaceState(null, '', '#/transaksi');
    openNew(el, kind, accounts);
  }
}

function txTable(txs: Tx[], accName: Map<number, string>): string {
  const arrow = (k: string) => (sortKey === k ? (sortDir === 1 ? ' ▲' : ' ▼') : '');
  return `<table class="data fixed"><thead><tr>
    <th${sortKey === 'date' ? ` aria-sort="${sortDir === 1 ? 'ascending' : 'descending'}"` : ''}><button class="tx-sort" data-sort="date" aria-label="Urutkan tanggal">Tanggal${arrow('date')}</button></th>
    <th>Keterangan</th><th>Kategori</th><th>Akun</th>
    <th style="text-align:right"${sortKey === 'amount' ? ` aria-sort="${sortDir === 1 ? 'ascending' : 'descending'}"` : ''}><button class="tx-sort" data-sort="amount" aria-label="Urutkan nominal">Nominal${arrow('amount')}</button></th><th style="text-align:right">Aksi</th>
  </tr></thead><tbody>${txs
    .map(
      (t) => `<tr><td style="white-space:nowrap">${escHtml(fmtTransactionDate(t.occurred_at))}</td>
      <td>${transactionNote(t) || '—'}${t.kind === 'transfer' ? `<div class="muted">→ ${escHtml(accName.get(t.to_account_id ?? -1) ?? '')}</div>` : ''}</td>
      <td>${escHtml(t.category)}</td><td>${escHtml(accName.get(t.account_id ?? -1) ?? '—')}</td>
      <td style="text-align:right" class="${t.kind === 'expense' ? 'neg' : t.kind === 'income' ? 'pos' : ''}"><strong>${t.kind === 'expense' ? '−' : t.kind === 'income' ? '+' : ''}${formatIdr(t.amount_idr)}</strong></td>
      <td style="text-align:right;white-space:nowrap"><button class="btn-ghost" data-edit-id="${t.id}" style="min-height:40px">Ubah</button> <button class="btn-ghost" data-del="${t.id}" style="min-height:40px">Hapus</button></td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function txCards(txs: Tx[], accName: Map<number, string>): string {
  return txs
    .map((t) => {
      const avatarBg = t.kind === 'expense' ? '#e5484d' : t.kind === 'income' ? '#0e9f6e' : '#2b3445';
      const avatarSign = t.kind === 'expense' ? '−' : t.kind === 'income' ? '+' : '⇄';
      const amtCls = t.kind === 'expense' ? 'neg' : t.kind === 'income' ? 'pos' : '';
      const amtSign = t.kind === 'expense' ? '−' : t.kind === 'income' ? '+' : '';
      return `<div class="between tx-detail-row">
      <div class="row"><span class="avatar" style="width:38px;height:38px;font-size:15px;background:${avatarBg}">${avatarSign}</span>
      <div><strong>${escHtml(t.category)}</strong><div class="muted">${transactionNote(t)}${t.kind === 'transfer' ? ` → ${escHtml(accName.get(t.to_account_id ?? -1) ?? '')}` : ''} • ${escHtml(accName.get(t.account_id ?? -1) ?? '')} • ${escHtml(fmtTransactionDate(t.occurred_at))}</div></div></div>
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
  wireCatOptions(body);
  wireTxAccounts(body, accounts);
  (body.querySelector('#f-save') as HTMLButtonElement).onclick = async () => {
    const v = (id: string) => (body.querySelector(id) as HTMLInputElement | HTMLSelectElement).value;
    try {
      const saved = await api.post('/api/transactions', {
        kind: v('#f-kind'),
        amount_idr: Number((body.querySelector('#f-amount') as HTMLInputElement).value),
        account_id: Number(v('#f-acc')),
        ...(['transfer', 'withdrawal'].includes(v('#f-kind')) ? { to_account_id: Number(v('#f-to')) } : {}),
        category: v('#f-cat') || 'Lainnya',
        note: v('#f-note'),
        occurred_at: readOccurredAt(body),
      }) as Tx;
      close();
      refreshAfterSave(el, saved);
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
  };
  const kind = tx.investment_symbol ? 'investment_withdrawal'
    : tx.kind === 'transfer' && tx.category === 'Tarik Tunai' ? 'withdrawal' : tx.kind;
  const { close, el: body } = openModal(`Ubah Transaksi`, txForm(accounts, kind, init));
  wireCatOptions(body);
  wireTxAccounts(body, accounts);
  const dateField = body.querySelector<HTMLInputElement>('#f-date')!;
  const originalDate = dateField.value;
  (body.querySelector('#f-save') as HTMLButtonElement).onclick = async (e) => {
    const btn = e.target as HTMLButtonElement;
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('btn-loading');
    const v = (id: string) => (body.querySelector(id) as HTMLInputElement | HTMLSelectElement).value;
    try {
      const saved = await api.patch(`/api/transactions/${tx.id}`, {
        amount_idr: Number(v('#f-amount')),
        account_id: Number(v('#f-acc')),
        ...(tx.kind === 'transfer' ? { to_account_id: Number(v('#f-to')) } : {}),
        category: v('#f-cat') || tx.category,
        note: v('#f-note'),
        ...(dateField.value !== originalDate ? { occurred_at: readOccurredAt(body) } : {}),
      }) as Tx;
      close();
      refreshAfterSave(el, saved);
    } catch (err) {
      alert((err as Error).message);
      btn.disabled = false;
      btn.classList.remove('btn-loading');
    }
  };
}
