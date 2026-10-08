import { icons } from './icons.js';

export function openModal(title: string, bodyHtml: string): { close: () => void; el: HTMLElement } {
  const root = document.getElementById('modal-root')!;
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${title}">
    <div class="between"><strong style="font-size:17px">${title}</strong><button class="btn-ghost icon-btn" data-x aria-label="Tutup">${icons.close}</button></div>
    <div data-body>${bodyHtml}</div></div>`;
  root.appendChild(back);
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    previouslyFocused?.focus?.();
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
  first?.focus?.();
  return { close, el: back.querySelector('[data-body]') as HTMLElement };
}

export const TX_CATEGORIES: Record<string, string[]> = {
  expense: ['Makan', 'Transport', 'Belanja', 'Hiburan', 'Kesehatan', 'Pendidikan', 'Tagihan', 'Rumah Tangga', 'Lainnya'],
  income: ['Gaji', 'Bonus', 'Hadiah', 'Bunga & Dividen', 'Lainnya'],
  transfer: ['Pindah Dana'],
};

/** Preset options so categories stay consistent for grouping (no free typing). */
export function catOptions(kind: string): string {
  return (TX_CATEGORIES[kind] ?? TX_CATEGORIES.expense).map((c) => `<option>${c}</option>`).join('');
}

/** Re-fill the category select when the kind changes. */
export function wireCatOptions(body: HTMLElement): void {
  const kindSel = body.querySelector('#f-kind') as HTMLSelectElement | null;
  const catSel = body.querySelector('#f-cat') as HTMLSelectElement | null;
  if (!kindSel || !catSel) return;
  kindSel.addEventListener('change', () => {
    catSel.innerHTML = catOptions(kindSel.value);
  });
}
const KIND_LABEL: Record<string, string> = {
  expense: 'Pengeluaran',
  income: 'Pemasukan (Top Up)',
  transfer: 'Transfer',
};

const escAttr = (s: string): string =>
  s.replace(/[&"'<>]/g, (c) => (c === '&' ? '&amp;' : c === '"' ? '&quot;' : c === "'" ? '&#39;' : c === '<' ? '&lt;' : '&gt;'));

/** ISO → nilai <input type="datetime-local"> (waktu lokal pembaca). */
function toLocalInput(iso: string): string {
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Baca input tanggal-waktu dari body form. Kosong = waktu sekarang. */
export function readOccurredAt(body: HTMLElement): string {
  const el = body.querySelector('#f-date') as HTMLInputElement | null;
  const v = el?.value ?? '';
  return v ? new Date(v).toISOString() : new Date().toISOString();
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

export function txForm(accounts: Array<{ id: number; name: string }>, kind = 'expense', init?: TxFormInit): string {
  const accOpts = accounts.map((a) => `<option value="${a.id}" ${String(a.id) === String(init?.account_id ?? '') ? 'selected' : ''}>${a.name}</option>`).join('');
  const accName = (id: number | null | undefined): string => (id == null ? '' : accounts.find((a) => a.id === id)?.name ?? '');

  let cats = catOptions(kind);
  if (init?.category) {
    const lit = `<option>${escAttr(init.category)}</option>`;
    cats = cats.includes(lit)
      ? cats.replace(lit, `<option selected>${escAttr(init.category)}</option>`)
      : `<option selected>${escAttr(init.category)}</option>${cats}`;
  }

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
      </select>`,
    );
  }

  fields.push(
    `<label for="f-amount">Nominal (Rp)</label><input id="f-amount" type="number" min="1" step="1" inputmode="numeric" value="${init?.amount_idr ?? ''}" required />`,
  );

  if (init?.lockAccounts) {
    fields.push(
      `<label for="f-acc">Dari akun</label><div class="muted" style="margin-top:-6px">${accName(init.account_id) || '—'} — tidak bisa diubah</div><input type="hidden" id="f-acc" value="${init.account_id ?? ''}" />`,
    );
    if (kind === 'transfer') {
      fields.push(
        `<div class="muted" style="margin-top:2px">Ke akun: ${accName(init.to_account_id) || '—'} — tidak bisa diubah</div><input type="hidden" id="f-to" value="${init.to_account_id ?? ''}" />`,
      );
    }
    fields.push(`<div id="f-to-wrap" style="display:none"></div>`);
  } else {
    fields.push(
      `<label for="f-acc">Dari akun</label><select id="f-acc">${accOpts}</select>`,
      `<div id="f-to-wrap" style="display:none"><label for="f-to">Ke akun</label><select id="f-to">${accOpts}</select></div>`,
    );
  }

  fields.push(
    `<label for="f-cat">Kategori</label><select id="f-cat">${cats}</select>`,
    `<label for="f-date">Tanggal &amp; waktu</label><input id="f-date" type="datetime-local" value="${init?.occurred_at ? toLocalInput(init.occurred_at) : ''}" />
    <div class="muted" style="margin-top:-6px">Kosongkan = waktu sekarang.</div>`,
    `<label for="f-note">Catatan</label><input id="f-note" value="${escAttr(init?.note ?? '')}" placeholder="cth. Kopi" />`,
    `<button class="btn-primary" id="f-save">Simpan</button>`,
  );

  return fields.join('\n');
}
