import { api } from '../lib/api.js';

export async function renderLogin(el: HTMLElement): Promise<void> {
  const me = (await api.get('/api/auth/me')) as { authenticated: boolean; needsSetup: boolean };
  if (me.authenticated) {
    location.hash = '#/';
    return;
  }
  el.innerHTML = `<div class="card login-wrap">
    <div class="eyebrow">FinTrack • Dompet Saya</div>
    <h2 style="margin:6px 0 4px">${me.needsSetup ? 'Buat kata sandi' : 'Masuk'}</h2>
    <p class="muted" style="margin-top:0">${me.needsSetup ? 'Pengaturan pertama kali (min. 8 karakter).' : 'Aplikasi single-user berjalan di server pribadi Anda.'}</p>
    <label for="pw" class="muted">Kata sandi</label>
    <input id="pw" type="password" placeholder="Kata sandi" autocomplete="current-password" style="width:100%;margin:4px 0 12px" />
    <button class="btn-primary" id="go" style="width:100%">${me.needsSetup ? 'Simpan & Masuk' : 'Masuk'}</button>
  </div>`;
  const go = async () => {
    const pw = (document.getElementById('pw') as HTMLInputElement).value;
    try {
      await api.post(me.needsSetup ? '/api/auth/setup' : '/api/auth/login', { password: pw });
      location.hash = '#/';
    } catch (e) {
      alert((e as Error).message);
    }
  };
  document.getElementById('go')!.onclick = go;
  document.getElementById('pw')!.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') go();
  });
}
