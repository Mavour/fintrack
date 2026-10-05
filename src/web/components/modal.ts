export function openModal(title: string, bodyHtml: string): { close: () => void; el: HTMLElement } {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal"><div class="between"><strong>${title}</strong><button class="btn ghost" data-x>✕</button></div><div data-body>${bodyHtml}</div></div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener('click', (e) => {
    if (e.target === back || (e.target as HTMLElement).closest('[data-x]')) close();
  });
  return { close, el: back.querySelector('[data-body]') as HTMLElement };
}

export function txForm(accounts: Array<{ id: number; name: string }>, kind = 'expense'): string {
  const accOpts = accounts.map((a) => `<option value="${a.id}">${a.name}</option>`).join('');
  return `
    <label class="muted">Jenis</label>
    <select id="f-kind">
      <option value="expense" ${kind === 'expense' ? 'selected' : ''}>Pengeluaran</option>
      <option value="income" ${kind === 'income' ? 'selected' : ''}>Pemasukan (Top Up)</option>
      <option value="transfer" ${kind === 'transfer' ? 'selected' : ''}>Transfer</option>
    </select>
    <label class="muted">Nominal (Rp)</label><input id="f-amount" type="number" min="1" step="1" required />
    <label class="muted">Dari akun</label><select id="f-acc">${accOpts}</select>
    <div id="f-to-wrap" style="display:none"><label class="muted">Ke akun</label><select id="f-to">${accOpts}</select></div>
    <label class="muted">Kategori</label><input id="f-cat" value="Lainnya" />
    <label class="muted">Catatan</label><input id="f-note" placeholder="cth. Kopi" />
    <button class="btn" id="f-save" style="width:100%">Simpan</button>`;
}
