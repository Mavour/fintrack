import { api, isApiReadPaused, isTemporaryApiError, rememberApiSnapshot } from './lib/api.js';
import { todayLong, timeAgo } from './lib/format.js';
import { escHtml } from './lib/escape.js';
import { priceStatus, type CachedPrice } from './lib/prices.js';
import { connectSse } from './lib/sse.js';
import { isDesktop, isPrivat, togglePrivat, getTheme, toggleTheme, applyTheme, getAuthed, setAuthed } from './lib/state.js';
import { icons } from './components/icons.js';
import { openModal, txForm, wireCatOptions, readOccurredAt } from './components/modal.js';
import { invalidateTxCache } from './pages/transactions.js';
import { renderHome, applyLiveHome } from './pages/home.js';
import { renderPortfolio, applyLivePortfolio, type PortfolioFrame } from './pages/portfolio.js';
import { renderTransactions } from './pages/transactions.js';
import { renderAccounts } from './pages/accounts.js';
import { renderLogin } from './pages/login.js';
import { installCoinIconHandlers } from './lib/coinIcons.js';

const sidebar = document.getElementById('sidebar')!;
const bottomnav = document.getElementById('bottomnav')!;
const topbar = document.getElementById('topbar')!;
const pagehead = document.getElementById('pagehead')!;
const app = document.getElementById('app')!;
const delayNote = document.createElement('div');
delayNote.className = 'data-delay-note muted';
delayNote.setAttribute('role', 'status');
delayNote.hidden = true;
delayNote.textContent = 'Pembaruan sebagian data tertunda. Data terakhir tetap ditampilkan dan akan diperbarui otomatis.';
app.before(delayNote);
document.addEventListener('api:stale', () => { delayNote.hidden = location.hash.startsWith('#/masuk'); });
document.addEventListener('api:recovered', () => { delayNote.hidden = true; });

const NAV = [
  { hash: '#/', label: 'Beranda', icon: icons.wallet },
  { hash: '#/portofolio', label: 'Portofolio', icon: icons.chart },
  { hash: '#/transaksi', label: 'Transaksi', icon: icons.receipt },
  { hash: '#/akun', label: 'Akun & Bank', icon: icons.bank },
];

const TITLES: Record<string, string> = {
  '#/': 'Beranda',
  '#/portofolio': 'Portofolio',
  '#/transaksi': 'Transaksi',
  '#/akun': 'Akun & Bank',
  '#/masuk': 'Masuk',
};

let priceBadgeHtml = `<span class="badge"><span class="dot"></span>Memuat harga…</span>`;

interface TierInfo {
  intervalSec: number; activeIntervalSec: number; lastSuccessAt: string | null;
  lastError: string | null; throttled: boolean; note: string | null; idle: boolean;
}

function tierAgeOk(t: TierInfo | undefined): boolean {
  if (!t?.lastSuccessAt) return false;
  const ts = new Date(t.lastSuccessAt.endsWith('Z') ? t.lastSuccessAt : t.lastSuccessAt + 'Z').getTime();
  return Date.now() - ts < 2 * t.activeIntervalSec * 1000;
}

function tierRow(label: string, t: TierInfo | undefined): string {
  if (!t) return `<div class="muted">${label}: —</div>`;
  const when = t.lastSuccessAt ? timeAgo(t.lastSuccessAt) : 'belum pernah';
  return `<div class="muted">${label}: ${when} • tiap ${t.activeIntervalSec} dtk${t.throttled ? ' • melambat' : ''}${t.idle ? ' • hemat' : ''}</div>`;
}

/** Badge "Sinkron Live" bila SEMUA tingkat fresh dalam 2× interval aktifnya. */
async function refreshPriceBadge(): Promise<void> {
  try {
    const [prices, wstatus] = await Promise.all([
      api.get('/api/prices') as Promise<CachedPrice[]>,
      api.get('/api/wallets/status').catch(() => null) as Promise<{
        health?: { mode?: string }; tiers?: Record<string, TierInfo>;
      } | null>,
    ]);
    const st = priceStatus(prices);
    const tiers = wstatus?.tiers;
    const walletMode = wstatus?.health?.mode;
    let inner: string;
    if (tiers) {
      const all = ['price', 'lp', 'solana', 'evm'].every((k) => tierAgeOk(tiers[k]));
      const latest = ['price', 'lp', 'solana', 'evm']
        .map((k) => tiers[k]?.lastSuccessAt ?? null)
        .filter((x): x is string => !!x)
        .sort()
        .pop() ?? null;
      inner = all
        ? `<span class="badge live"><span class="dot pulse"></span>Sinkron Live</span>`
        : latest
          ? `<span class="badge"><span class="dot"></span>Tertunda • ${timeAgo(latest)}</span>`
          : `<span class="badge"><span class="dot"></span>Harga manual<span class="b-detail"> • ${st.detail}</span></span>`;
      const pop = `<div class="badge-pop-body"><strong>Status sinkron</strong>${tierRow('Harga', tiers.price)}${tierRow('LP Meteora', tiers.lp)}${tierRow('Solana', tiers.solana)}${tierRow('EVM', tiers.evm)}</div>`;
      priceBadgeHtml = `<details class="badge-pop"><summary>${inner}</summary>${pop}</details>`;
    } else if (walletMode === 'live') {
      priceBadgeHtml = `<span class="badge live"><span class="dot pulse"></span>Sinkron Live<span class="b-detail"> • wallet</span></span>`;
    } else if (walletMode === 'stale') {
      priceBadgeHtml = `<span class="badge"><span class="dot"></span>Tertunda<span class="b-detail"> • ${st.detail}</span></span>`;
    } else {
      priceBadgeHtml =
        st.mode === 'live'
          ? `<span class="badge live"><span class="dot pulse"></span>Sinkron Live<span class="b-detail"> • ${st.detail}</span></span>`
          : `<span class="badge"><span class="dot"></span>Harga manual<span class="b-detail"> • ${st.detail}</span></span>`;
    }
  } catch {
    priceBadgeHtml = `<span class="badge"><span class="dot"></span>Harga manual</span>`;
  }
  // Jangan bangkitkan chrome di halaman masuk fullscreen.
  if ((location.hash.split('?')[0] || '#/') !== '#/masuk') renderChrome(getAuthed() === true);
}

/** Render sidebar XOR bottom nav — never both. Bottom nav node is emptied on desktop. */
function renderChrome(authenticated: boolean): void {
  const syncOpen = topbar.querySelector('details.badge-pop')?.hasAttribute('open');
  const h = location.hash.split('?')[0] || '#/';
  const desktop = isDesktop();
  // Tombol Keluar hanya bila benar-benar punya sesi (bukan sekadar bukan di #/masuk).
  const canLogout = authenticated && h !== '#/masuk';
  if (desktop) {
    bottomnav.innerHTML = '';
    bottomnav.style.display = 'none';
    sidebar.style.display = 'flex';
    sidebar.innerHTML = `
      <div class="side-logo"><span class="logo-box"><img src="/icon.svg?v=2" alt="" width="42" height="42" /></span>
        <span><div class="brand-name">FinTrack</div><div class="brand-sub">Personal finance</div></span></div>
      <div class="nav-caption">WORKSPACE</div>
      <nav>${NAV.map((l) => `<a href="${l.hash}" ${h === l.hash ? 'aria-current="page"' : ''} class="${h === l.hash || (h === '' && l.hash === '#/') ? 'active' : ''}">${l.icon}<span>${l.label}</span><span class="nav-arrow" aria-hidden="true">↗</span></a>`).join('')}</nav>
      <div class="side-note"><span class="side-note-icon">${icons.invest}</span><strong>Kenali keuangan Anda.</strong><p>Setiap langkah kecil berarti untuk tujuan yang lebih besar.</p><a href="#/portofolio">Jelajahi portofolio ↗</a></div>
      <div class="side-foot"><div class="side-profile"><span class="profile-avatar">${icons.wallet}</span><div><strong>Ruang pribadi</strong><div class="muted">Dompet Saya</div></div></div>${canLogout ? '<button class="btn-ghost btn-logout" id="btn-logout">Keluar</button>' : ''}</div>`;
  } else {
    sidebar.innerHTML = '';
    sidebar.style.display = 'none';
    bottomnav.style.display = 'flex';
    bottomnav.innerHTML = NAV.map(
      (l) => `<a href="${l.hash}" class="${h === l.hash || (h === '' && l.hash === '#/') ? 'active' : ''}">${l.icon}<span>${l.label}</span></a>`,
    ).join('');
  }
  const title = TITLES[h] ?? 'Beranda';
  const dark = getTheme() === 'dark';
  // Mobile controls stay visible; the second header row holds sync status.
  topbar.innerHTML = desktop
    ? `
    <div><div class="tb-title">${title}</div><div class="tb-date">${todayLong()}</div></div>
    <div class="row">
      <div>${priceBadgeHtml}</div>
      <button class="theme-switch" id="btn-theme" role="switch" aria-checked="${dark}" aria-label="Mode gelap/terang" title="Mode gelap/terang">
        <span class="ts-sun">${icons.sun}</span><span class="ts-knob"></span><span class="ts-moon">${icons.moon}</span>
      </button>
    </div>`
    : `
    <div class="brand"><span class="logo-box"><img src="/icon.svg?v=2" alt="" width="42" height="42" /></span>
      <span><div class="brand-name">FinTrack</div><div class="brand-sub">${title}</div></span></div>
    <div class="mobile-controls">
      <button class="theme-switch" id="btn-theme" role="switch" aria-checked="${dark}" aria-label="Mode gelap/terang" title="Mode gelap/terang">
        <span class="ts-sun">${icons.sun}</span><span class="ts-knob"></span><span class="ts-moon">${icons.moon}</span>
      </button>
      ${canLogout ? '<button class="btn-ghost btn-logout" id="btn-logout">Keluar</button>' : ''}
    </div>
    <div class="mobile-sync"><span>Status sinkron</span>${priceBadgeHtml}</div>`;
  if (syncOpen) topbar.querySelector('details.badge-pop')?.setAttribute('open', '');
  document.getElementById('btn-theme')?.addEventListener('click', (e) => {
    const next = toggleTheme();
    (e.currentTarget as HTMLButtonElement).setAttribute('aria-checked', String(next === 'dark'));
  });
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) logoutBtn.onclick = () => void logout();
}

/** Putus sesi lalu pindah ke halaman masuk. */
async function logout(): Promise<void> {
  try {
    await api.post('/api/auth/logout', {});
  } catch {
    /* cookie mungkin sudah habis — tetap ke halaman masuk */
  }
  setAuthed(false);
  if (location.hash.split('?')[0] === '#/masuk') void route();
  else location.hash = '#/masuk';
}

/** Page header: judul+tanggal pindah ke topbar (tanpa logo berulang).
 *  Di sini tinggal aksi: quick-row (desktop) + privat/catat. */
function renderPagehead(): void {
  const h = location.hash.split('?')[0] || '#/';
  if (h === '#/masuk') {
    pagehead.innerHTML = '';
    return;
  }
  const desktop = isDesktop();
  pagehead.innerHTML = `
    <div class="between" style="width:100%">
      <div>${desktop ? `<div class="quick-row" id="quick-row"></div>` : `<div class="date">${todayLong()}</div>`}</div>
      <div class="header-actions">
        <button class="btn-ghost" id="btn-privat" aria-pressed="${isPrivat()}">${isPrivat() ? 'Tampilkan' : 'Privat'}</button>
        ${desktop ? `<button class="btn-primary" id="btn-record">+ Catat Transaksi</button>` : ''}
      </div>
    </div>${desktop ? '' : `<button class="btn-primary record-fab" id="btn-record" aria-label="Catat transaksi">${icons.plus}<span>Catat</span></button>`}`;
  document.getElementById('btn-privat')!.onclick = () => {
    togglePrivat();
    renderPagehead();
    route();
  };
  document.getElementById('btn-record')!.onclick = () => openQuickTx('expense');
  if (desktop) {
    const qr = document.getElementById('quick-row')!;
    const items: Array<[string, string]> = [
      ['expense', 'Pengeluaran'],
      ['income', 'Top Up'],
      ['transfer', 'Transfer'],
    ];
    qr.innerHTML = items.map(([k, l]) => `<button data-q="${k}">${l}</button>`).join('');
    qr.querySelectorAll('[data-q]').forEach(
      (b) => ((b as HTMLElement).onclick = () => openQuickTx((b as HTMLElement).dataset.q!)),
    );
  }
}

async function openQuickTx(kind: string): Promise<void> {
  try {
    const accounts = (await api.get('/api/accounts')) as Array<{ id: number; name: string }>;
    if (accounts.length === 0) {
      location.hash = '#/akun';
      return;
    }
    const { close, el: body } = openModal('Catat Transaksi', txForm(accounts, kind));
    const kindSel = body.querySelector('#f-kind') as HTMLSelectElement;
    const toWrap = body.querySelector('#f-to-wrap') as HTMLElement;
    const sync = () => {
      toWrap.style.display = kindSel.value === 'transfer' ? 'block' : 'none';
    };
    kindSel.onchange = sync;
    sync();
    wireCatOptions(body);
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
          occurred_at: readOccurredAt(body),
        });
        close();
        invalidateTxCache();
        route();
      } catch (e) {
        alert((e as Error).message);
      }
    };
  } catch (e) {
    if ((e as Error).message === 'Belum masuk') location.hash = '#/masuk';
  }
}

async function route(): Promise<void> {
  // Status sesi dicek sekali (cache); login/logout/401 me-reset cache.
  if (getAuthed() === null) {
    try {
      const me = (await api.get('/api/auth/me')) as { authenticated: boolean };
      setAuthed(me.authenticated);
    } catch (e) {
      if (isTemporaryApiError(e)) {
        if (!app.querySelector('.card:not(.empty)')) app.innerHTML = '<div class="card empty">Menunggu koneksi. Data akan dimuat otomatis.</div>';
        return;
      }
      setAuthed(false);
    }
  }
  const h = location.hash.split('?')[0] || '#/';
  if (h === '#/masuk') delayNote.hidden = true;
  // Halaman masuk: fullscreen tanpa chrome (sidebar/topbar/head/nav disembunyikan).
  document.body.classList.toggle('login-full', h === '#/masuk');
  if (h === '#/masuk') {
    sidebar.innerHTML = '';
    sidebar.style.display = 'none';
    bottomnav.innerHTML = '';
    bottomnav.style.display = 'none';
    topbar.innerHTML = '';
    topbar.style.display = 'none';
    pagehead.innerHTML = '';
    pagehead.style.display = 'none';
    try {
      await renderLogin(app);
    } catch (e) {
      app.textContent = '';
      const card = document.createElement('div');
      card.className = 'card empty';
      card.textContent = `Gagal memuat: ${(e as Error).message}`;
      app.appendChild(card);
    }
    return;
  }
  topbar.style.display = '';
  pagehead.style.display = '';
  renderChrome(getAuthed() === true);
  renderPagehead();
  try {
    if (h === '#/portofolio') await renderPortfolio(app);
    else if (h === '#/transaksi') await renderTransactions(app);
    else if (h === '#/akun') await renderAccounts(app);
    else await renderHome(app);
    app.dataset.loadedRoute = h;
  } catch (e) {
    if (isTemporaryApiError(e)) {
      if (app.dataset.loadedRoute !== h) app.innerHTML = '<div class="card empty">Menunggu pembaruan data. Akan dimuat otomatis setelah koneksi tersedia.</div>';
      return;
    }
    app.textContent = '';
    const card = document.createElement('div');
    card.className = 'card empty';
    card.textContent = `Gagal memuat: ${(e as Error).message}`;
    app.appendChild(card);
  }
}

window.matchMedia('(min-width: 900px)').addEventListener?.('change', () => {
  route();
});
window.addEventListener('hashchange', route);
document.addEventListener('keydown', (e) => {
  if ((e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey) {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
    if (!isDesktop()) return;
    const h = location.hash.split('?')[0] || '#/';
    if (h === '#/masuk') return;
    e.preventDefault();
    openQuickTx('expense');
  }
});

installCoinIconHandlers();
void refreshPriceBadge();
setInterval(refreshPriceBadge, 60_000);
applyTheme(getTheme());
void route();

// Live update tanpa reload: SSE sync:done → refresh badge + halaman aktif.
// Coalesce bursts; retain updates while a modal is open and avoid overlapping renders.
let ssePending = false;
let sseRefreshing = false;
let sseTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleLiveRefresh(): void {
  if (!ssePending || sseTimer || sseRefreshing || isApiReadPaused() || document.hidden || document.querySelector('.modal-back')) return;
  sseTimer = setTimeout(async () => {
    sseTimer = null;
    if (document.hidden || document.querySelector('.modal-back')) return;
    ssePending = false;
    sseRefreshing = true;
    const y = window.scrollY;
    const hash = location.hash;
    try {
      await Promise.all([refreshPriceBadge(), route()]);
      if (location.hash === hash) window.scrollTo(0, y);
    } finally {
      sseRefreshing = false;
      scheduleLiveRefresh();
    }
  }, 250);
}
connectSse({
  onSync: () => { ssePending = true; scheduleLiveRefresh(); },
  onPortfolio: (data) => {
    if (document.hidden || !getAuthed()) return;
    const frame = data as PortfolioFrame;
    if (!Array.isArray(frame?.assets) || !Array.isArray(frame?.wallet_tokens)) return;
    rememberApiSnapshot('/api/portfolio', frame);
    const hash = location.hash.split('?')[0] || '#/';
    if (hash === '#/portofolio') applyLivePortfolio(app, frame);
    else if (hash === '#/') applyLiveHome(app, frame);
  },
});
document.addEventListener('modal:closed', scheduleLiveRefresh);
document.addEventListener('visibilitychange', scheduleLiveRefresh);
document.addEventListener('api:retry', () => { ssePending = true; scheduleLiveRefresh(); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

// Deteksi versi baru: bandingkan bundle ter-load vs index.html terbaru
// (SPA tidak reload sendiri — tanpa ini tab lama selamanya pakai kode lama).
let updateShown = false;
async function checkAppUpdate(): Promise<void> {
  if (updateShown) return;
  try {
    const html = await (await fetch('/', { cache: 'no-store' })).text();
    const m = /assets\/index-([^"']+)\.js/.exec(html);
    if (!m) return;
    const cur = (document.querySelector('script[type="module"]') as HTMLScriptElement | null)?.src ?? '';
    if (cur.includes(m[0])) return;
    updateShown = true;
    const bar = document.createElement('div');
    bar.className = 'update-bar';
    bar.innerHTML = `<span>Versi baru tersedia — muat ulang untuk tampilan terbaru.</span><button class="btn-primary" id="btn-update">Muat ulang</button>`;
    document.body.appendChild(bar);
    document.getElementById('btn-update')!.onclick = () => location.reload();
  } catch {
    // Offline / gagal — coba lagi nanti.
  }
}
void checkAppUpdate();
setInterval(checkAppUpdate, 5 * 60_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void checkAppUpdate();
});
