import { api } from '../lib/api.js';
import { formatIdr } from '../lib/format.js';
import { openModal, txForm } from '../components/modal.js';

export async function renderTransactions(el: HTMLElement): Promise<void> {
  const month = new Date().toISOString().slice(0, 7);
  const [txs, accounts] = await Promise.all([
    api.get(`/api/transactions?limit=100&month=${month}`),
    api.get('/api/accounts'),
  ]);
  const accs = accounts as Array<{ id: number; name: string }>;
  el.innerHTML = `
  <div class="card between"><strong>Transaksi — ${month}</strong><button class="btn" id="btn-new">+ Baru</button></div>
  <div class="card"><table>
    ${(txs as Array<{ id: number; kind: string; category: string; note: string; amount_idr: number; occurred_at: string }>).map((t) => `
      <tr><td><strong>${t.kind === 'expense' ? '−' : t.kind === 'income' ? '+' : '⇄'} ${t.category}</strong><div class="muted">${t.note || ''} • ${t.occurred_at.slice(0, 10)}</div></td>
      <td style="text-align:right" class="${t.kind === 'expense' ? 'neg' : 'pos'}">${formatIdr(t.amount_idr)}</td>
      <td style="text-align:right"><button class="btn ghost" data-del="${t.id}">Hapus</button></td></tr>`).join('') || '<tr><td class="empty">Belum ada transaksi bulan ini</td></tr>'}
  </table></div>`;

  el.querySelectorAll('[data-del]').forEach((b) => ((b as HTMLElement).onclick = async () => {
    if (!confirm('Hapus transaksi ini? Saldo akan dikembalikan.')) return;
    await api.del(`/api/transactions/${(b as HTMLElement).dataset.del}`);
    renderTransactions(el);
  }));

  const openNew = (kind: string) => {
    if (accs.length === 0) {
      alert('Buat akun dulu di menu Akun & Bank');
      return;
    }
    const { close, el: body } = openModal(kind === 'invest' ? 'Investasi (catat aset)' : 'Transaksi Baru', txForm(accs, kind === 'invest' ? 'expense' : kind));
    if (kind === 'invest') {
      body.insertAdjacentHTML('beforeend', '<p class="muted">Investasi dicatat sebagai pengeluaran + tambah aset di Portofolio.</p>');
    }
    const kindSel = body.querySelector('#f-kind') as HTMLSelectElement;
    const toWrap = body.querySelector('#f-to-wrap') as HTMLElement;
    const sync = () => { toWrap.style.display = kindSel.value === 'transfer' ? 'block' : 'none'; };
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
  };

  (document.getElementById('btn-new') as HTMLButtonElement).onclick = () => openNew('expense');
  // FAB + quick-action deep link
  (document.getElementById('fab') as HTMLButtonElement).onclick = () => openNew('expense');
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
  if (q.get('baru')) {
    history.replaceState(null, '', '#/transaksi');
    openNew(q.get('baru')!);
  }
}
