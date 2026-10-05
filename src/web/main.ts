import { renderHome } from './pages/home.js';
import { renderPortfolio } from './pages/portfolio.js';
import { renderTransactions } from './pages/transactions.js';
import { renderAccounts } from './pages/accounts.js';
import { renderLogin } from './pages/login.js';

const app = document.getElementById('app')!;
const nav = document.getElementById('bottomnav')!;

const links = [
  { hash: '#/', label: 'Beranda', icon: '⌂' },
  { hash: '#/portofolio', label: 'Portofolio', icon: '◈' },
  { hash: '#/transaksi', label: 'Transaksi', icon: '⇄' },
  { hash: '#/akun', label: 'Akun & Bank', icon: '🏦' },
];

nav.innerHTML = links.map((l) => `<a href="${l.hash}"><div>${l.icon}</div>${l.label}</a>`).join('');

async function route(): Promise<void> {
  const h = location.hash.split('?')[0];
  nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === h || (h === '' && a.getAttribute('href') === '#/')));
  try {
    if (h === '#/portofolio') await renderPortfolio(app);
    else if (h === '#/transaksi') await renderTransactions(app);
    else if (h === '#/akun') await renderAccounts(app);
    else if (h === '#/masuk') await renderLogin(app);
    else await renderHome(app);
  } catch (e) {
    app.innerHTML = `<div class="card empty">Gagal memuat: ${(e as Error).message}</div>`;
  }
  // Polling ringan harga tiap 60 detik di halaman portofolio/beranda tanpa reload.
  if ((h === '#/portofolio' || h === '' || h === '#/') && !location.hash.includes('masuk')) {
    // next poll handled by timer below
  }
}

window.addEventListener('hashchange', route);
void route();

// Light polling: re-render watchlist prices every 60s without full reload.
setInterval(() => {
  const h = location.hash.split('?')[0];
  if (h === '#/portofolio' || h === '' || h === '#/' || h === '#') route();
}, 60_000);

if ('serviceWorker' in navigator) {
  // Minimal PWA: no offline cache yet, just registers if sw.js exists.
  fetch('/sw.js', { method: 'HEAD' }).then((r) => {
    if (r.ok) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }).catch(() => undefined);
}
