import { api } from '../lib/api.js';
import { formatIdr } from '../lib/format.js';
import { openModal } from '../components/modal.js';

export async function renderAccounts(el: HTMLElement): Promise<void> {
  const accounts = (await api.get('/api/accounts')) as Array<{
    id: number; name: string; type: string; balance_idr: number; is_active: number;
  }>;
  el.innerHTML = `
  <div class="card between"><strong>Akun & Bank</strong><button class="btn" id="btn-add">+ Akun</button></div>
  ${accounts.map((a) => `
    <div class="card between">
      <div><strong>${a.name}</strong><div class="muted">${a.type} ${a.is_active ? '' : '• nonaktif'}</div><div>${formatIdr(a.balance_idr)}</div></div>
      <div><button class="btn ghost" data-edit="${a.id}">Ubah</button></div>
    </div>`).join('') || '<div class="card empty">Belum ada akun. Tambahkan BCA / GoPay / Tunai.</div>'}
  `;

  (document.getElementById('btn-add') as HTMLButtonElement).onclick = () => {
    const { close, el: body } = openModal('Akun Baru', `
      <label class="muted">Nama</label><input id="c-name" placeholder="BCA" />
      <label class="muted">Tipe</label><select id="c-type"><option value="bank">bank</option><option value="e_wallet">e_wallet</option><option value="cash">cash</option></select>
      <label class="muted">Saldo awal (Rp)</label><input id="c-bal" type="number" min="0" value="0" />
      <button class="btn" id="c-save" style="width:100%">Simpan</button>`);
    (body.querySelector('#c-save') as HTMLButtonElement).onclick = async () => {
      const v = (id: string) => (body.querySelector(id) as HTMLInputElement | HTMLSelectElement).value;
      try {
        await api.post('/api/accounts', { name: v('#c-name'), type: v('#c-type'), balance_idr: Number(v('#c-bal')) });
        close();
        renderAccounts(el);
      } catch (e) {
        alert((e as Error).message);
      }
    };
  };

  el.querySelectorAll('[data-edit]').forEach((b) => ((b as HTMLElement).onclick = async () => {
    const id = (b as HTMLElement).dataset.edit!;
    const cur = accounts.find((a) => String(a.id) === id)!;
    const { close, el: body } = openModal(`Ubah ${cur.name}`, `
      <label class="muted">Nama</label><input id="c-name" value="${cur.name}" />
      <label class="muted">Saldo (Rp)</label><input id="c-bal" type="number" min="0" value="${cur.balance_idr}" />
      <button class="btn" id="c-save" style="width:100%">Simpan</button>`);
    (body.querySelector('#c-save') as HTMLButtonElement).onclick = async () => {
      try {
        await api.patch(`/api/accounts/${id}`, {
          name: (body.querySelector('#c-name') as HTMLInputElement).value,
          balance_idr: Number((body.querySelector('#c-bal') as HTMLInputElement).value),
        });
        close();
        renderAccounts(el);
      } catch (e) {
        alert((e as Error).message);
      }
    };
  }));
}
