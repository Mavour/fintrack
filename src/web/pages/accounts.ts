import { api } from '../lib/api.js';
import { formatIdr } from '../lib/format.js';
import { openModal } from '../components/modal.js';
import { isPrivat } from '../lib/state.js';

export async function renderAccounts(el: HTMLElement): Promise<void> {
  el.innerHTML = `<div class="card"><div class="skeleton"></div></div>`;
  const accounts = (await api.get('/api/accounts')) as Array<{
    id: number; name: string; type: string; balance_idr: number; is_active: number;
  }>;
  const total = accounts.filter((a) => a.is_active).reduce((s, a) => s + a.balance_idr, 0);
  el.innerHTML = `
  <div class="card">
    <div class="between"><div><span class="eyebrow">Total Kas</span><div class="big-num" style="font-size:26px">${isPrivat() ? '••••••' : formatIdr(total)}</div></div>
    <button class="btn-primary" id="btn-add">+ Akun</button></div>
  </div>
  <div class="card"><strong>Daftar Akun</strong>
    <div class="acc-list">
    ${accounts.map((a) => `
      <div class="acc-item between">
        <div class="row"><span class="avatar" style="width:38px;height:38px;font-size:15px">${a.name[0]}</span>
        <div><strong>${a.name}</strong><div class="muted">${a.type.replace('_', ' ')}${a.is_active ? '' : ' • nonaktif'}</div>
        <div style="font-weight:800">${isPrivat() ? '••••••' : formatIdr(a.balance_idr)}</div></div></div>
        <button class="btn-ghost" data-edit="${a.id}">Ubah</button>
      </div>`).join('') || '<div class="empty">Belum ada akun. Tambahkan BCA / GoPay / Tunai.</div>'}
  </div>`;

  document.getElementById('btn-add')!.onclick = () => {
    const { close, el: body } = openModal('Akun Baru', `
      <label for="c-name">Nama</label><input id="c-name" placeholder="BCA" />
      <label for="c-type">Tipe</label><select id="c-type"><option value="bank">bank</option><option value="e_wallet">e_wallet</option><option value="cash">cash</option></select>
      <label for="c-bal">Saldo awal (Rp)</label><input id="c-bal" type="number" min="0" value="0" inputmode="numeric" />
      <button class="btn-primary" id="c-save">Simpan</button>`);
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

  el.querySelectorAll('[data-edit]').forEach(
    (b) => ((b as HTMLElement).onclick = () => {
      const id = (b as HTMLElement).dataset.edit!;
      const cur = accounts.find((a) => String(a.id) === id)!;
      const { close, el: body } = openModal(`Ubah ${cur.name}`, `
        <label for="c-name">Nama</label><input id="c-name" value="${cur.name}" />
        <label for="c-bal">Saldo (Rp)</label><input id="c-bal" type="number" min="0" value="${cur.balance_idr}" inputmode="numeric" />
        <button class="btn-primary" id="c-save">Simpan</button>`);
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
    }),
  );
}
