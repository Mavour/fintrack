import { api } from '../lib/api.js';
import { formatIdr, timeAgo } from '../lib/format.js';
import { openModal } from '../components/modal.js';
import { isPrivat } from '../lib/state.js';
import { chainBadge, walletChip, shortAddr } from '../lib/chains.js';

interface WalletRow {
  id: number; label: string; address: string; network_type: string;
}
interface SyncRow {
  provider: string; wallet_id: number | null; last_success_at: string | null; last_error: string | null; updated_at: string;
}

export async function renderAccounts(el: HTMLElement): Promise<void> {
  if (!el.innerHTML.trim()) el.innerHTML = `<div class="card"><div class="skeleton"></div></div>`;
  try {
    await renderAccountsInner(el);
  } catch {
    el.innerHTML = `<div class="card"><div class="card-error">Gagal memuat, coba lagi.</div></div>`;
  }
}

/** Modal "Akun Baru" yang sama dipakai di halaman Akun dan Beranda (mobile). */
export function openAddAccountModal(onSaved: () => void): void {
  const { close, el: body } = openModal('Akun Baru', `
    <label for="c-name">Nama</label><input id="c-name" placeholder="BCA" />
    <label for="c-type">Tipe</label><select id="c-type"><option value="bank">bank</option><option value="e_wallet">e_wallet</option><option value="cash">cash</option></select>
    <label for="c-bal">Saldo awal (Rp)</label><input id="c-bal" type="number" min="0" value="0" inputmode="numeric" />
    <button class="btn-primary" id="c-save">Simpan</button>`);
  (body.querySelector('#c-save') as HTMLButtonElement).onclick = async (e) => {
    const btn = e.target as HTMLButtonElement;
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('btn-loading');
    const v = (id: string) => (body.querySelector(id) as HTMLInputElement | HTMLSelectElement).value;
    try {
      await api.post('/api/accounts', { name: v('#c-name'), type: v('#c-type'), balance_idr: Number(v('#c-bal')) });
      close();
      onSaved();
    } catch (err) {
      alert((err as Error).message);
      btn.disabled = false;
      btn.classList.remove('btn-loading');
    }
  };
}

async function renderAccountsInner(el: HTMLElement): Promise<void> {
  const accounts = (await api.get('/api/accounts')) as Array<{
    id: number; name: string; type: string; balance_idr: number; is_active: number;
  }>;
  const total = accounts.filter((a) => a.is_active).reduce((s, a) => s + a.balance_idr, 0);
  let wallets: WalletRow[] = [];
  let syncRows: SyncRow[] = [];
  let debankLine = '';
  let hiddenByWallet = new Map<number, string[]>();
  try {
    const w = (await api.get('/api/wallets/registry')) as { wallets: WalletRow[]; sync_status: SyncRow[] };
    wallets = w.wallets;
    syncRows = w.sync_status;
    // Token tersembunyi dari Daftar Aset (tanpa harga / < $1) per wallet.
    const pos = (await api.get('/api/wallets/positions?show_all=true')) as {
      positions: Array<{ wallet_id: number; kind: string; symbol: string; value_usd: number | null }>;
    };
    hiddenByWallet = new Map<number, string[]>();
    for (const p of pos.positions ?? []) {
      if (p.kind !== 'token' && p.kind !== 'staking') continue;
      if (p.value_usd !== null && p.value_usd >= 1) continue;
      const list = hiddenByWallet.get(p.wallet_id) ?? [];
      if (!list.includes(p.symbol)) list.push(p.symbol);
      hiddenByWallet.set(p.wallet_id, list);
    }
    const st = (await api.get('/api/wallets/status')) as {
      tiers?: { evm?: { throttled: boolean; note: string | null; activeIntervalSec: number } };
      debank: { configured: boolean; units_remaining: number | null; budget: number; used_24h: number | null; calls_24h: Record<string, number> };
    };
    if (st.debank.configured) {
      const used = st.debank.used_24h !== null ? `${st.debank.used_24h} unit/24 jam` : 'pemakaian diukur';
      const proj = st.tiers?.evm ? ` • interval EVM ${st.tiers.evm.activeIntervalSec} dtk` : '';
      debankLine = `<div class="muted" style="margin-top:4px">DeBank: ${used}${st.debank.budget > 0 ? ` / anggaran ${st.debank.budget}/hari` : ''} • sisa ${st.debank.units_remaining ?? '—'}${proj}${st.tiers?.evm?.throttled ? ' • <strong>EVM melambat (hemat unit)</strong>' : ''}</div>`;
      const calls = Object.entries(st.debank.calls_24h ?? {}).map(([k, v]) => `${k}: ${v}`).join(' • ');
      if (calls) debankLine += `<div class="muted">Unit per endpoint (24 jam): ${calls}</div>`;
    }
  } catch {
    wallets = [];
  }
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
  </div>
  <div class="card"><div class="between"><strong>Wallet (read-only)</strong><button class="btn-primary" id="btn-wadd" style="min-height:40px">+ Wallet</button></div>
    <div class="muted" style="margin-top:4px">Hanya alamat publik. Tanpa private key / seed phrase / koneksi wallet.</div>
    ${debankLine}
    <div class="acc-list">
    ${wallets.map((w) => {
      const rows = syncRows.filter((s) => s.wallet_id === w.id && !s.provider.startsWith('tier-'));
      const okRows = rows.filter((s) => s.last_success_at);
      const errRows = rows.filter((s) => !s.last_success_at && s.last_error);
      const okAt = okRows.map((s) => s.last_success_at as string).sort().pop();
      const provLine = (s: SyncRow): string =>
        `<div class="muted">• ${s.provider}: ${s.last_success_at ? `ok ${timeAgo(s.last_success_at)}` : `gagal — ${(s.last_error ?? '').slice(0, 80)}`}</div>`;
      const hidden = hiddenByWallet.get(w.id) ?? [];
      const hiddenRow = hidden.length > 0
        ? `<button class="chip" data-whidden="${w.id}" style="margin-top:8px">${hidden.length} token disembunyikan (&lt; $1 / tanpa harga)</button>
           <div id="whidden-${w.id}" style="display:none;margin-top:6px" class="muted">${hidden.sort().join(' • ')}</div>`
        : '';
      return `<div class="acc-item">
        <div class="row" style="flex-wrap:wrap">${chainBadge(w.network_type === 'evm' ? 'eth' : 'solana', w.network_type === 'evm' ? 'EVM' : undefined)}${walletChip(w.label || 'Wallet')}</div>
        <div style="margin-top:8px"><strong>${shortAddr(w.address)}</strong> <button class="btn-ghost copy-btn" data-copy="${w.address}">Salin</button></div>
        <div class="muted">Sync terakhir: ${okAt ? timeAgo(okAt) : 'belum pernah'}</div>
        ${okRows.slice(0, 5).map(provLine).join('')}
        ${errRows.slice(0, 4).map(provLine).join('')}
        ${hiddenRow}
        <div class="row" style="margin-top:8px">
          <button class="btn-ghost" data-wedit="${w.id}">Ubah</button>
          <button class="btn-ghost" data-wsync="${w.id}">Sinkron Ulang</button>
          <button class="btn-danger-ghost" data-wdel="${w.id}" style="border-radius:14px;padding:10px 16px;min-height:44px;font:inherit;cursor:pointer;font-weight:600">Hapus</button>
        </div>
      </div>`;
    }).join('') || '<div class="empty">Belum ada wallet. Tambahkan alamat Solana / EVM.</div>'}
    </div>
  </div>`;

  document.getElementById('btn-add')!.onclick = () => openAddAccountModal(() => renderAccounts(el));

  el.querySelectorAll('[data-edit]').forEach(
    (b) => ((b as HTMLElement).onclick = () => {
      const id = (b as HTMLElement).dataset.edit!;
      const cur = accounts.find((a) => String(a.id) === id)!;
      const { close, el: body } = openModal(`Ubah ${cur.name}`, `
        <label for="c-name">Nama</label><input id="c-name" value="${cur.name}" />
        <label for="c-bal">Saldo (Rp)</label><input id="c-bal" type="number" min="0" value="${cur.balance_idr}" inputmode="numeric" />
        <button class="btn-primary" id="c-save">Simpan</button>`);
      (body.querySelector('#c-save') as HTMLButtonElement).onclick = async (e) => {
        const btn = e.target as HTMLButtonElement;
        if (btn.disabled) return;
        btn.disabled = true;
        btn.classList.add('btn-loading');
        try {
          await api.patch(`/api/accounts/${id}`, {
            name: (body.querySelector('#c-name') as HTMLInputElement).value,
            balance_idr: Number((body.querySelector('#c-bal') as HTMLInputElement).value),
          });
          close();
          renderAccounts(el);
        } catch (err) {
          alert((err as Error).message);
          btn.disabled = false;
          btn.classList.remove('btn-loading');
        }
      };
    }),
  );

  el.querySelectorAll('[data-copy]').forEach(
    (b) => ((b as HTMLElement).onclick = async () => {
      try {
        await navigator.clipboard.writeText((b as HTMLElement).dataset.copy!);
      } catch {
        alert('Gagal menyalin');
      }
    }),
  );

  const wadd = document.getElementById('btn-wadd');
  if (wadd) {
    wadd.onclick = () => {
      const { close, el: body } = openModal('Tambah Wallet', `
        <label for="w-label">Label</label><input id="w-label" placeholder="Solana Utama" />
        <label for="w-addr">Alamat publik</label><input id="w-addr" placeholder="cth. 3keq…Xpd / 0x…" autocomplete="off" />
        <p class="muted">Jaringan terdeteksi otomatis dari format alamat.</p>
        <button class="btn-primary" id="w-save">Simpan</button>`);
      (body.querySelector('#w-save') as HTMLButtonElement).onclick = async (e) => {
        const btn = e.target as HTMLButtonElement;
        if (btn.disabled) return;
        btn.disabled = true;
        btn.classList.add('btn-loading');
        try {
          await api.post('/api/wallets/registry', {
            label: (body.querySelector('#w-label') as HTMLInputElement).value,
            address: (body.querySelector('#w-addr') as HTMLInputElement).value.trim(),
          });
          close();
          renderAccounts(el);
        } catch (err) {
          alert((err as Error).message);
          btn.disabled = false;
          btn.classList.remove('btn-loading');
        }
      };
    };
  }
  el.querySelectorAll('[data-wedit]').forEach(
    (b) => ((b as HTMLElement).onclick = () => {
      const id = (b as HTMLElement).dataset.wedit!;
      const cur = wallets.find((w) => String(w.id) === id)!;
      const { close, el: body } = openModal(`Ubah ${cur.label || 'Wallet'}`, `
        <label for="w-label">Label</label><input id="w-label" value="${cur.label}" />
        <label for="w-addr">Alamat publik</label><input id="w-addr" value="${cur.address}" autocomplete="off" />
        <button class="btn-primary" id="w-save">Simpan</button>`);
      (body.querySelector('#w-save') as HTMLButtonElement).onclick = async (e) => {
        const btn = e.target as HTMLButtonElement;
        if (btn.disabled) return;
        btn.disabled = true;
        btn.classList.add('btn-loading');
        try {
          await api.patch(`/api/wallets/registry/${id}`, {
            label: (body.querySelector('#w-label') as HTMLInputElement).value,
            address: (body.querySelector('#w-addr') as HTMLInputElement).value.trim(),
          });
          close();
          renderAccounts(el);
        } catch (err) {
          alert((err as Error).message);
          btn.disabled = false;
          btn.classList.remove('btn-loading');
        }
      };
    }),
  );
  el.querySelectorAll('[data-wdel]').forEach(
    (b) => ((b as HTMLElement).onclick = async () => {
      const id = (b as HTMLElement).dataset.wdel!;
      if (!confirm('Hapus wallet ini? Snapshot posisinya ikut terhapus.')) return;
      try {
        await api.del(`/api/wallets/registry/${id}`);
        renderAccounts(el);
      } catch (e) {
        alert((e as Error).message);
      }
    }),
  );
  el.querySelectorAll('[data-whidden]').forEach(
    (b) => ((b as HTMLElement).onclick = () => {
      const id = (b as HTMLElement).dataset.whidden!;
      const list = document.getElementById(`whidden-${id}`);
      if (list) list.style.display = list.style.display === 'none' ? 'block' : 'none';
    }),
  );
  el.querySelectorAll('[data-wsync]').forEach(
    (b) => ((b as HTMLElement).onclick = async (e) => {
      const btn = e.target as HTMLButtonElement;
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add('btn-loading');
      const label = btn.textContent;
      btn.textContent = 'Menyinkron…';
      try {
        await api.post(`/api/wallets/registry/${(b as HTMLElement).dataset.wsync}/sync`, {});
        renderAccounts(el);
      } catch (err) {
        alert((err as Error).message);
        btn.disabled = false;
        btn.classList.remove('btn-loading');
        btn.textContent = label;
      }
    }),
  );
}
