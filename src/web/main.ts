import { api } from './lib/api.js';
import { todayLong, timeAgo } from './lib/format.js';
import { priceStatus, type CachedPrice } from './lib/prices.js';
import { connectSse, type SseScope } from './lib/sse.js';
import { isDesktop, isPrivat, togglePrivat, getTheme, toggleTheme, applyTheme } from './lib/state.js';
import { icons } from './components/icons.js';
import { openModal, txForm, wireCatOptions, readOccurredAt } from './components/modal.js';
import { invalidateTxCache } from './pages/transactions.js';
import { renderHome } from './pages/home.js';
import { renderPortfolio } from './pages/portfolio.js';
import { renderTransactions } from './pages/transactions.js';
import { renderAccounts } from './pages/accounts.js';
import { renderLogin } from './pages/login.js';

const sidebar = document.getElementById('sidebar')!;
const bottomnav = document.getElementById('bottomnav')!;
const topbar = document.getElementById('topbar')!;
const pagehead = document.getElementById('pagehead')!;
const app = document.getElementById('app')!;

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
  renderChrome();
}

/** Render sidebar XOR bottom nav — never both. Bottom nav node is emptied on desktop. */
function renderChrome(): void {
  const h = location.hash.split('?')[0] || '#/';
  const desktop = isDesktop();
  const canLogout = h !== '#/masuk';
  if (desktop) {
    bottomnav.innerHTML = '';
    bottomnav.style.display = 'none';
    sidebar.style.display = 'flex';
    sidebar.innerHTML = `
      <div class="side-logo"><span class="logo-box">${icons.trend}</span>
        <span><div class="brand-name">FinTrack</div><div class="brand-sub">Dompet Saya</div></span></div>
      <nav>${NAV.map((l) => `<a href="${l.hash}" class="${h === l.hash || (h === '' && l.hash === '#/') ? 'active' : ''}">${l.icon}<span>${l.label}</span></a>`).join('')}</nav>
      <div class="side-foot"><div class="muted" style="margin-bottom:6px">Status harga</div>${priceBadgeHtml}${canLogout ? '<button class="btn-ghost btn-logout" id="btn-logout">Keluar</button>' : ''}</div>`;
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
  topbar.innerHTML = `
    <div class="brand"><span class="logo-box">${icons.trend}</span>
      <span><div class="brand-name">FinTrack</div><div class="brand-sub">${title}</div></span></div>
    <div class="row">
      ${!desktop && canLogout ? '<button class="btn-ghost btn-logout" id="btn-logout">Keluar</button>' : ''}
      <button class="theme-switch" id="btn-theme" role="switch" aria-checked="${dark}" aria-label="Mode gelap/terang" title="Mode gelap/terang">
        <span class="ts-sun">${icons.sun}</span><span class="ts-knob"></span><span class="ts-moon">${icons.moon}</span>
      </button>
      <div>${priceBadgeHtml}</div>
    </div>`;
  document.getElementById('btn-theme')!.onclick = (e) => {
    const next = toggleTheme();
    (e.currentTarget as HTMLButtonElement).setAttribute('aria-checked', String(next === 'dark'));
  };
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
  if (location.hash.split('?')[0] === '#/masuk') void route();
  else location.hash = '#/masuk';
}

/** Page header: title + date left; privat + record button right (desktop). */
function renderPagehead(): void {
  const h = location.hash.split('?')[0] || '#/';
  if (h === '#/masuk') {
    pagehead.innerHTML = '';
    return;
  }
  const title = TITLES[h] ?? 'Beranda';
  const desktop = isDesktop();
  pagehead.innerHTML = `
    <div><div class="title">${title}</div><div class="date">${todayLong()}</div>
      ${desktop ? `<div class="quick-row" id="quick-row"></div>` : ''}
    </div>
    <div class="header-actions">
      <button class="btn-ghost" id="btn-privat" aria-pressed="${isPrivat()}">${isPrivat() ? 'Tampilkan' : 'Privat'}</button>
      ${desktop ? `<button class="btn-primary" id="btn-record">+ Catat Transaksi</button>` : ''}
    </div>`;
  document.getElementById('btn-privat')!.onclick = () => {
    togglePrivat();
    renderPagehead();
    route();
  };
  if (desktop) {
    document.getElementById('btn-record')!.onclick = () => openQuickTx('expense');
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
  renderChrome();
  renderPagehead();
  const h = location.hash.split('?')[0] || '#/';
  try {
    if (h === '#/portofolio') await renderPortfolio(app);
    else if (h === '#/transaksi') await renderTransactions(app);
    else if (h === '#/akun') await renderAccounts(app);
    else if (h === '#/masuk') await renderLogin(app);
    else await renderHome(app);
  } catch (e) {
    app.innerHTML = `<div class="card empty"><div class="big">!</div>Gagal memuat: ${(e as Error).message}</div>`;
  }
}

window.matchMedia('(min-width: 900px)').addEventListener?.('change', () => {
  renderChrome();
  renderPagehead();
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

void refreshPriceBadge();
setInterval(refreshPriceBadge, 60_000);
applyTheme(getTheme());
void route();

// Live update tanpa reload: SSE sync:done → refresh badge + halaman aktif.
// Di-throttle (maks 1×/5 dtk), scroll dipertahankan, modal terbuka dilewati.
let ssePending: SseScope[] = [];
let sseTimer: ReturnType<typeof setTimeout> | null = null;
connectSse({
  onSync: (scopes) => {
    ssePending = [...new Set([...ssePending, ...scopes])];
    if (sseTimer) return;
    sseTimer = setTimeout(() => {
      sseTimer = null;
      ssePending = [];
      if (document.hidden) return;
      if (document.querySelector('.modal-back')) return; // jangan ganggu modal
      const y = window.scrollY;
      void refreshPriceBadge();
      void route().then(() => {
        window.scrollTo(0, y);
      }).catch(() => undefined);
    }, 1000);
  },
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
