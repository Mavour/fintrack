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
export function txForm(accounts: Array<{ id: number; name: string }>, kind = 'expense'): string {
  const accOpts = accounts.map((a) => `<option value="${a.id}">${a.name}</option>`).join('');
  return `
    <label for="f-kind">Jenis</label>
    <select id="f-kind">
      <option value="expense" ${kind === 'expense' ? 'selected' : ''}>Pengeluaran</option>
      <option value="income" ${kind === 'income' ? 'selected' : ''}>Pemasukan (Top Up)</option>
      <option value="transfer" ${kind === 'transfer' ? 'selected' : ''}>Transfer</option>
    </select>
    <label for="f-amount">Nominal (Rp)</label><input id="f-amount" type="number" min="1" step="1" inputmode="numeric" required />
    <label for="f-acc">Dari akun</label><select id="f-acc">${accOpts}</select>
    <div id="f-to-wrap" style="display:none"><label for="f-to">Ke akun</label><select id="f-to">${accOpts}</select></div>
    <label for="f-cat">Kategori</label><select id="f-cat">${catOptions(kind)}</select>
    <label for="f-note">Catatan</label><input id="f-note" placeholder="cth. Kopi" />
    <button class="btn-primary" id="f-save">Simpan</button>`;
}
