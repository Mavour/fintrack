import { api } from '../lib/api.js';

export async function renderLogin(el: HTMLElement): Promise<void> {
  const me = (await api.get('/api/auth/me')) as { authenticated: boolean; needsSetup: boolean };
  if (me.authenticated) {
    location.hash = '#/';
    return;
  }
  el.innerHTML = `<div class="card" style="max-width:400px;margin:40px auto">
    <h3>${me.needsSetup ? 'Buat kata sandi' : 'Masuk'}</h3>
    <p class="muted">${me.needsSetup ? 'Pengaturan pertama kali (min. 8 karakter).' : 'Aplikasi single-user.'}</p>
    <input id="pw" type="password" placeholder="Kata sandi" style="width:100%;padding:10px;border:1px solid #e9e4f5;border-radius:10px;margin-bottom:10px" />
    <button class="btn" id="go" style="width:100%">${me.needsSetup ? 'Simpan & Masuk' : 'Masuk'}</button>
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
  (document.getElementById('go') as HTMLButtonElement).onclick = go;
}
