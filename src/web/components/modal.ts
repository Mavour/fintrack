import { icons } from './icons.js';
import { escAttr, escHtml } from '../lib/escape.js';
import { api } from '../lib/api.js';
import { toWitaInput, fromWitaInput } from '../../shared/time.js';

export { escAttr };

export function openModal(title: string, bodyHtml: string): { close: () => void; el: HTMLElement } {
  const root = document.getElementById('modal-root')!;
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${escAttr(title)}">
    <div class="between modal-header"><strong>${escHtml(title)}</strong><button class="btn-ghost icon-btn" data-x aria-label="Tutup">${icons.close}</button></div>
    <div class="modal-scroll"><div data-body>${bodyHtml}</div></div></div>`;
  root.appendChild(back);
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    previouslyFocused?.focus?.({ preventScroll: true });
    document.dispatchEvent(new Event('modal:closed'));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('click', (e) => {
    if (e.target === back || (e.target as HTMLElement).closest('[data-x]')) close();
  });
  const first = back.querySelector('input, select, button.btn-primary') as HTMLElement | null;
  first?.focus?.({ preventScroll: true });
  return { close, el: back.querySelector('[data-body]') as HTMLElement };
}

export const TX_CATEGORIES: Record<string, string[]> = {
  expense: ['Makan', 'Transport', 'Belanja', 'Hiburan', 'Kesehatan', 'Pendidikan', 'Tagihan', 'Rumah Tangga', 'Lainnya'],
  income: ['Gaji', 'Bonus', 'Hadiah', 'Bunga & Dividen', 'Lainnya'],
  transfer: ['Pindah Dana'],
  withdrawal: ['Tarik Tunai'],
  investment_withdrawal: ['Pencairan Investasi'],
};

export interface TxAccountRef {
  id: number;
  name: string;
  type: string;
  is_active: number;
}

/** Withdrawal selects a bank and defaults to the first active cash account. */
export function wireTxAccounts(body: HTMLElement, accounts: TxAccountRef[]): void {
  const kind = body.querySelector('#f-kind') as HTMLSelectElement;
  const from = body.querySelector('#f-acc') as HTMLSelectElement;
  const to = body.querySelector('#f-to') as HTMLSelectElement | null;
  if (from.tagName !== 'SELECT' || !to) return;
  const toWrap = body.querySelector('#f-to-wrap') as HTMLElement;
  const hint = body.querySelector('#f-withdrawal-hint') as HTMLElement;
  const save = body.querySelector('#f-save') as HTMLButtonElement;
  const fill = (select: HTMLSelectElement, rows: TxAccountRef[], empty: string) => {
    const previous = select.value;
    select.innerHTML = rows.length
      ? rows.map((a) => `<option value="${a.id}">${escHtml(a.name)}</option>`).join('')
      : `<option value="">${empty}</option>`;
    if (rows.some((a) => String(a.id) === previous)) select.value = previous;
  };
  const sync = () => {
    const withdrawal = kind.value === 'withdrawal';
    const investment = kind.value === 'investment_withdrawal';
    const editing = kind.tagName === 'INPUT';
    const current = (a: TxAccountRef, field: HTMLSelectElement) => editing && String(a.id) === field.value;
    const banks = withdrawal || investment
      ? accounts.filter((a) => (a.type === 'bank' && a.is_active) || current(a, from))
      : accounts;
    const cash = withdrawal
      ? accounts.filter((a) => (a.type === 'cash' && a.is_active) || current(a, to))
      : accounts;
    fill(from, banks, 'Belum ada akun bank aktif');
    fill(to, cash, 'Belum ada akun tunai aktif');
    toWrap.style.display = kind.value === 'transfer' || withdrawal ? 'block' : 'none';
    body.querySelector('label[for="f-acc"]')!.textContent = withdrawal ? 'Dari bank'
      : investment ? 'Rekening tujuan' : kind.value === 'income' ? 'Masuk ke akun' : 'Dari akun';
    body.querySelector('label[for="f-to"]')!.textContent = withdrawal ? 'Masuk ke akun tunai' : 'Ke akun';
    hint.hidden = !withdrawal;
    const missing = withdrawal && (!banks.length || !cash.length);
    hint.innerHTML = missing
      ? 'Tambahkan akun bank dan akun bertipe tunai yang aktif di menu Akun &amp; Bank terlebih dahulu.'
      : 'Saldo bank berkurang dan saldo tunai bertambah sesuai nominal. Total uang tetap sama.';
    save.disabled = missing;
  };
  kind.addEventListener('change', sync);
  sync();
}

/** Keep presets and saved categories together without duplicate names. */
export function catOptions(kind: string, saved: string[] = [], selected = ''): string {
  const names = new Map<string, string>();
  for (const name of [...(TX_CATEGORIES[kind] ?? TX_CATEGORIES.expense), ...saved, ...(selected ? [selected] : [])]) {
    names.set(name.toLocaleLowerCase(), name);
  }
  return [...names.values()].map((name) => `<option${name === selected ? ' selected' : ''}>${escHtml(name)}</option>`).join('');
}

/** Load shared categories and allow adding one without leaving the transaction. */
export function wireCatOptions(body: HTMLElement): void {
  const kindSel = body.querySelector('#f-kind') as HTMLSelectElement | HTMLInputElement | null;
  const catSel = body.querySelector('#f-cat') as HTMLSelectElement | null;
  if (!kindSel || !catSel) return;
  const controls = body.querySelector('#f-cat-controls') as HTMLElement;
  const editor = body.querySelector('#f-cat-editor') as HTMLElement;
  const nameInput = body.querySelector('#f-cat-name') as HTMLInputElement;
  const addBtn = body.querySelector('#f-cat-add') as HTMLButtonElement;
  const saveBtn = body.querySelector('#f-cat-save') as HTMLButtonElement;
  const cancelBtn = body.querySelector('#f-cat-cancel') as HTMLButtonElement;
  const txSave = body.querySelector('#f-save') as HTMLButtonElement;
  const status = body.querySelector('#f-cat-status') as HTMLElement;
  let saved: Record<string, string[]> = {};
  const refill = (selected = catSel.value) => {
    catSel.innerHTML = catOptions(kindSel.value, saved[kindSel.value], selected);
  };
  const showEditor = (open: boolean) => {
    editor.hidden = !open;
    addBtn.hidden = open;
    txSave.disabled = open;
    status.textContent = '';
    if (open) { nameInput.value = ''; nameInput.focus(); }
  };
  kindSel.addEventListener('change', () => {
    showEditor(false);
    controls.hidden = kindSel.value === 'transfer' || kindSel.value === 'withdrawal';
    catSel.disabled = kindSel.value === 'withdrawal';
    refill('');
  });
  addBtn.onclick = () => showEditor(true);
  cancelBtn.onclick = () => { showEditor(false); addBtn.focus(); };
  saveBtn.onclick = async () => {
    if (saveBtn.disabled) return;
    const name = nameInput.value.trim();
    if (!name || name.length > 60) {
      status.textContent = 'Isi nama kategori antara 1–60 karakter.';
      nameInput.focus();
      return;
    }
    const kind = kindSel.value;
    saveBtn.disabled = cancelBtn.disabled = kindSel.disabled = true;
    try {
      const category = await api.post('/api/transactions/categories', { kind, name }) as { kind: string; name: string };
      (saved[category.kind] ??= []).push(category.name);
      refill(category.name);
      showEditor(false);
      catSel.focus();
    } catch (e) {
      status.textContent = (e as Error).message;
    } finally {
      saveBtn.disabled = cancelBtn.disabled = kindSel.disabled = false;
    }
  };
  nameInput.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
  };
  void api.get('/api/transactions/categories').then((data) => {
    for (const [kind, names] of Object.entries(data as Record<string, string[]>)) {
      saved[kind] = [...names, ...(saved[kind] ?? [])];
    }
    refill();
  }).catch(() => {
    status.textContent = 'Kategori tersimpan belum dapat dimuat. Buka ulang formulir untuk mencoba lagi.';
  });
}
const KIND_LABEL: Record<string, string> = {
  expense: 'Pengeluaran',
  income: 'Pemasukan (Top Up)',
  transfer: 'Transfer',
  withdrawal: 'Tarik Tunai',
  investment_withdrawal: 'Pencairan Investasi',
};

/** Baca input tanggal-waktu dari body form. Kosong = waktu sekarang. */
export function readOccurredAt(body: HTMLElement): string {
  const el = body.querySelector('#f-date') as HTMLInputElement | null;
  const v = el?.value ?? '';
  return v ? fromWitaInput(v) : new Date().toISOString();
}

export interface TxFormInit {
  amount_idr?: number | null;
  account_id?: number | null;
  to_account_id?: number | null;
  category?: string | null;
  note?: string | null;
  occurred_at?: string | null;
  /** Mode ubah: jenis tidak bisa diganti (sama dengan sisi server). */
  lockKind?: boolean;
  /** Mode ubah: akun asal (dan tujuan saat transfer) tidak bisa diganti. */
  lockAccounts?: boolean;
}

export function txForm(accounts: TxAccountRef[], kind = 'expense', init?: TxFormInit): string {
  const accOpts = (selected?: number | null) => accounts.map((a) => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${escHtml(a.name)}</option>`).join('');
  const accName = (id: number | null | undefined): string => (id == null ? '' : accounts.find((a) => a.id === id)?.name ?? '');

  const cats = catOptions(kind, [], init?.category ?? '');
  const fixedCategory = kind === 'withdrawal' || kind === 'investment_withdrawal';

  const fields: string[] = [];
  if (init?.lockKind) {
    fields.push(
      `<label for="f-kind">Jenis</label><div class="muted" style="margin-top:-6px">${KIND_LABEL[kind] ?? kind} — tidak bisa diubah</div><input type="hidden" id="f-kind" value="${kind}" />`,
    );
  } else {
    fields.push(
      `<label for="f-kind">Jenis</label>
      <select id="f-kind">
        <option value="expense" ${kind === 'expense' ? 'selected' : ''}>Pengeluaran</option>
        <option value="income" ${kind === 'income' ? 'selected' : ''}>Pemasukan (Top Up)</option>
        <option value="transfer" ${kind === 'transfer' ? 'selected' : ''}>Transfer</option>
        <option value="withdrawal" ${kind === 'withdrawal' ? 'selected' : ''}>Tarik Tunai</option>
      </select>`,
    );
  }

  fields.push(
    `<label for="f-amount">Nominal (Rp)</label><input id="f-amount" type="number" min="1" step="1" inputmode="numeric" value="${init?.amount_idr ?? ''}" required />`,
  );

  if (init?.lockAccounts) {
    fields.push(
      `<label for="f-acc">Dari akun</label><div class="muted" style="margin-top:-6px">${escHtml(accName(init.account_id)) || '—'} — tidak bisa diubah</div><input type="hidden" id="f-acc" value="${escAttr(init.account_id ?? '')}" />`,
    );
    if (kind === 'transfer' || kind === 'withdrawal') {
      fields.push(
        `<div class="muted" style="margin-top:2px">Ke akun: ${escHtml(accName(init.to_account_id)) || '—'} — tidak bisa diubah</div><input type="hidden" id="f-to" value="${escAttr(init.to_account_id ?? '')}" />`,
      );
    }
    fields.push(`<div id="f-to-wrap" style="display:none"></div>`);
  } else {
    fields.push(
      `<label for="f-acc">Dari akun</label><select id="f-acc">${accOpts(init?.account_id)}</select>`,
      `<div id="f-to-wrap" style="display:none"><label for="f-to">Ke akun</label><select id="f-to">${accOpts(init?.to_account_id)}</select></div>`,
    );
  }

  fields.push(
    `<div id="f-withdrawal-hint" class="muted" hidden style="margin-top:8px"></div>`,
    `<label for="f-cat">Kategori</label><select id="f-cat"${fixedCategory ? ' disabled' : ''}>${cats}</select>`,
    `<div id="f-cat-controls"${kind === 'transfer' || fixedCategory ? ' hidden' : ''}>
      <button type="button" class="btn-ghost" id="f-cat-add" style="margin-top:8px">+ Kategori baru</button>
      <div id="f-cat-editor" hidden>
        <label for="f-cat-name">Nama kategori baru</label>
        <input id="f-cat-name" maxlength="60" placeholder="Misalnya: Servis Motor atau Freelance" />
        <div class="row" style="margin-top:8px;flex-wrap:wrap">
          <button type="button" class="btn-ghost" id="f-cat-save">Tambah kategori</button>
          <button type="button" class="btn-ghost" id="f-cat-cancel">Batal</button>
        </div>
      </div>
    </div><div class="muted" id="f-cat-status" role="status"></div>`,
    `<label for="f-date">Tanggal &amp; waktu (WITA)</label><input id="f-date" type="datetime-local" value="${init?.occurred_at ? toWitaInput(init.occurred_at) : ''}" />
    <div class="muted" style="margin-top:-6px">Kosongkan = waktu sekarang.</div>`,
    `<label for="f-note">Catatan</label><input id="f-note" value="${escAttr(init?.note ?? '')}" placeholder="cth. Kopi" />`,
    `<button class="btn-primary" id="f-save">Simpan</button>`,
  );

  return fields.join('\n');
}
