import { api } from '../lib/api.js';
import { setAuthed } from '../lib/state.js';

export async function renderLogin(el: HTMLElement): Promise<void> {
  const me = (await api.get('/api/auth/me')) as { authenticated: boolean; needsSetup: boolean };
  setAuthed(me.authenticated);
  if (me.authenticated) {
    location.hash = '#/';
    return;
  }
  el.innerHTML = `<div class="login-screen">
    <div class="login-hero">
      <span class="logo-box login-logo"><img src="/icon.svg?v=2" alt="" width="76" height="76" /></span>
      <h1 class="login-title">Fin<em>Track</em></h1>
      <p class="muted login-sub">Satu tempat untuk kas, investasi, dan tujuan keuangan Anda.</p>
      <div class="login-points">
        <span class="pill up">Read-only wallet</span>
        <span class="pill up">Ringkasan investasi</span>
        <span class="pill up">Akses pribadi</span>
      </div>
    </div>
    <div class="login-side"><div class="card login-card">
      <div class="eyebrow">FinTrack • Dompet Saya</div>
      <h2 style="margin:6px 0 4px">${me.needsSetup ? 'Buat kode akses' : 'Masuk dashboard'}</h2>
      <p class="muted" style="margin-top:0">${me.needsSetup ? 'Pengaturan pertama kali (min. 6 karakter).' : 'Masukkan kode akses untuk membuka dashboard.'}</p>
      <label for="pw" class="muted">Kode akses</label>
      <div class="login-pwrow">
        <input id="pw" type="password" placeholder="••••••" autocomplete="current-password" />
        <button class="btn-ghost" id="pw-toggle" type="button" aria-label="Tampilkan kode">Lihat</button>
      </div>
      <div class="login-err" id="pw-err" role="alert"></div>
      <button class="btn-primary" id="go">${me.needsSetup ? 'Simpan & Masuk' : 'Buka Dashboard'}</button>
      <p class="muted login-foot">Ruang pribadi untuk keuangan Anda.</p>
    </div></div>
  </div>`;
  const pw = document.getElementById('pw') as HTMLInputElement;
  const err = document.getElementById('pw-err') as HTMLElement;
  const fail = (m: string): void => {
    err.textContent = m;
    pw.classList.add('shake');
    setTimeout(() => pw.classList.remove('shake'), 400);
    pw.focus();
    pw.select();
  };
  const go = async (): Promise<void> => {
    if (!pw.value) {
      fail('Isi dulu kode aksesnya.');
      return;
    }
    const btn = document.getElementById('go') as HTMLButtonElement;
    btn.disabled = true;
    btn.classList.add('btn-loading');
    try {
      await api.post(me.needsSetup ? '/api/auth/setup' : '/api/auth/login', { password: pw.value });
      setAuthed(true);
      location.hash = '#/';
    } catch (e) {
      btn.disabled = false;
      btn.classList.remove('btn-loading');
      fail((e as Error).message);
    }
  };
  (document.getElementById('go') as HTMLButtonElement).onclick = () => void go();
  pw.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void go();
  });
  (document.getElementById('pw-toggle') as HTMLButtonElement).onclick = (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    b.textContent = show ? 'Tutup' : 'Lihat';
    pw.focus();
  };
  setTimeout(() => pw.focus(), 50);
}
