/* Seed dummy data + verify every feature end-to-end via the live API.
 * Run: DEMO_MODE=true node scripts/seed-dummy.mjs (server must be up; first-run open mode).
 * Refuses to run unless DEMO_MODE=true so demo data never lands in a real DB.
 * Exits non-zero on any failed check. Uses delta assertions so existing data is safe. */
if (process.env.DEMO_MODE !== 'true') {
  console.error('REFUSED: set DEMO_MODE=true to seed demo data (default false, protects real DBs).');
  process.exit(2);
}
const BASE = process.env.SEED_BASE ?? 'http://127.0.0.1:3000';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} ${extra}`);
  }
}

async function api(path, init = {}) {
  const hasBody = init.body !== undefined;
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

const me = await api('/api/auth/me');
check('auth: first-run open', me.body.authenticated === true);

// ---------- accounts ----------
async function findOrCreateAccount(name, type, balance) {
  const list = await api('/api/accounts');
  const found = list.body.find((a) => a.name === name);
  if (found) return found;
  const created = await api('/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ name, type, balance_idr: balance }),
  });
  check(`account: create ${name}`, created.status === 200 && created.body.balance_idr === balance);
  return created.body;
}

const bca = await findOrCreateAccount('BCA', 'bank', 10_000_000);
const gopay = await findOrCreateAccount('GoPay', 'e_wallet', 2_000_000);
await findOrCreateAccount('Tunai', 'cash', 500_000);
await findOrCreateAccount('Mandiri', 'bank', 5_000_000);
const accList = await api('/api/accounts');
check('account: list >= 4', accList.body.length >= 4, `got ${accList.body.length}`);

// edit balance (update) then revert
const origBal = bca.balance_idr;
const upd = await api(`/api/accounts/${bca.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ balance_idr: origBal + 1000 }),
});
check('account: edit balance', upd.body.balance_idr === origBal + 1000);
await api(`/api/accounts/${bca.id}`, { method: 'PATCH', body: JSON.stringify({ balance_idr: origBal }) });

// ---------- transactions (atomic balance) ----------
async function delTx(id, label) {
  const r = await api(`/api/transactions/${id}`, { method: 'DELETE' });
  check(`tx: delete ${label} (status)`, r.status === 200 && r.body.ok === true, `status=${r.status}`);
}

async function balanceOf(id) {
  const l = await api('/api/accounts');
  return l.body.find((a) => a.id === id).balance_idr;
}

// expense Rp50.000 exact
const b0 = await balanceOf(bca.id);
const tx = await api('/api/transactions', {
  method: 'POST',
  body: JSON.stringify({ kind: 'expense', amount_idr: 50_000, account_id: bca.id, category: 'Makan', note: 'dummy kopi' }),
});
check('tx: create expense 50rb', tx.status === 201);
check('tx: expense reduces exactly 50rb', (await balanceOf(bca.id)) === b0 - 50_000);
// update amount -> corrects
await api(`/api/transactions/${tx.body.id}`, { method: 'PATCH', body: JSON.stringify({ amount_idr: 30_000 }) });
check('tx: update corrects balance', (await balanceOf(bca.id)) === b0 - 30_000);
// delete -> restores
await delTx(tx.body.id, 'expense');
check('tx: delete restores balance', (await balanceOf(bca.id)) === b0);

// income adds
const g0 = await balanceOf(gopay.id);
const inc = await api('/api/transactions', {
  method: 'POST',
  body: JSON.stringify({ kind: 'income', amount_idr: 200_000, account_id: gopay.id, category: 'Hadiah', note: 'dummy' }),
});
check('tx: income adds exactly', (await balanceOf(gopay.id)) === g0 + 200_000);
await delTx(inc.body.id, 'income');

// transfer moves
const t = await api('/api/transactions', {
  method: 'POST',
  body: JSON.stringify({ kind: 'transfer', amount_idr: 150_000, account_id: bca.id, to_account_id: gopay.id, category: 'Pindah', note: 'dummy' }),
});
check(
  'tx: transfer moves exactly',
  (await balanceOf(bca.id)) === b0 - 150_000 && (await balanceOf(gopay.id)) === g0 + 150_000,
);
await delTx(t.body.id, 'transfer');
check('tx: delete transfer restores both', (await balanceOf(bca.id)) === b0 && (await balanceOf(gopay.id)) === g0);

// validation
const bad1 = await api('/api/transactions', {
  method: 'POST',
  body: JSON.stringify({ kind: 'expense', amount_idr: -5, account_id: bca.id, category: 'X', note: '' }),
});
check('tx: rejects negative amount', bad1.status === 400);
const bad2 = await api('/api/transactions', {
  method: 'POST',
  body: JSON.stringify({ kind: 'transfer', amount_idr: 1000, account_id: bca.id, to_account_id: bca.id, category: 'X', note: '' }),
});
check('tx: rejects same-account transfer', bad2.status === 400);
const bad3 = await api('/api/transactions', {
  method: 'POST',
  body: JSON.stringify({ kind: 'expense', amount_idr: 999_999_999_999, account_id: gopay.id, category: 'X', note: '' }),
});
check('tx: rejects over-balance expense', bad3.status === 400);

// dummy history across categories + income + transfer (kept, for charts)
const month = new Date().toISOString().slice(0, 7);
const seedTx = [
  { kind: 'expense', amount_idr: 45_000, account_id: bca.id, category: 'Makan', note: 'Warung' },
  { kind: 'expense', amount_idr: 120_000, account_id: bca.id, category: 'Transport', note: 'Bensin' },
  { kind: 'expense', amount_idr: 85_000, account_id: gopay.id, category: 'Hiburan', note: 'Bioskop' },
  { kind: 'expense', amount_idr: 350_000, account_id: bca.id, category: 'Belanja', note: 'Baju' },
  { kind: 'expense', amount_idr: 150_000, account_id: bca.id, category: 'Kesehatan', note: 'Apotek' },
  { kind: 'income', amount_idr: 8_000_000, account_id: bca.id, category: 'Gaji', note: 'Gaji Okt' },
];
for (const s of seedTx) await api('/api/transactions', { method: 'POST', body: JSON.stringify(s) });
const monthTx = await api(`/api/transactions?limit=200&month=${month}`);
check('tx: month filter returns seeded rows', monthTx.body.length >= seedTx.length);

// ---------- portfolio ----------
const dummyAssets = [
  { type: 'crypto', symbol: 'HYPE', name: 'Hyperliquid', qty: '25.5', avg_buy_price_idr: 400_000, price_idr: 520_000 },
  { type: 'crypto', symbol: 'SOL', name: 'Solana', qty: '12.5', avg_buy_price_idr: 1_500_000, price_idr: 2_400_000 },
  { type: 'crypto', symbol: 'MET', name: 'Met Dummy', qty: '100', avg_buy_price_idr: 15_000, price_idr: 18_500 },
  { type: 'saham', symbol: 'BBCA.JK', name: 'Bank BCA', qty: '100', avg_buy_price_idr: 9800, price_idr: 10_250 },
  { type: 'saham', symbol: 'TLKM.JK', name: 'Telkom', qty: '500', avg_buy_price_idr: 3200, price_idr: 3050 },
  { type: 'reksadana', symbol: 'RDNPU', name: 'RDN Pasar Uang', qty: '5000', avg_buy_price_idr: 1200, price_idr: 1280 },
];
for (const a of dummyAssets) {
  const r = await api('/api/portfolio', { method: 'PUT', body: JSON.stringify(a) });
  check(`portfolio: upsert ${a.symbol}`, r.status === 201 && r.body.symbol === a.symbol);
}
const pf = await api('/api/portfolio');
const bySym = Object.fromEntries(pf.body.assets.map((a) => [a.symbol, a]));
// SOL: 12.5 x 2.400.000 = 30.000.000, cost 18.750.000, P/L +11.250.000 (+60%)
check('portfolio: SOL value exact', bySym.SOL.current_value_idr === 30_000_000, `got ${bySym.SOL.current_value_idr}`);
check('portfolio: SOL P/L exact', bySym.SOL.pl_idr === 11_250_000 && bySym.SOL.pl_percent === 60);
// TLKM loser: 500 x 3050 = 1.525.000 vs cost 1.600.000 -> -75.000
check('portfolio: TLKM loss exact', bySym['TLKM.JK'].pl_idr === -75_000);
check(
  'portfolio: totals consistent',
  pf.body.total_value_idr === pf.body.assets.reduce((s, a) => s + (a.current_value_idr ?? 0), 0),
);
check('portfolio: diversification + label', pf.body.diversification_score > 0 && typeof pf.body.diversification_label === 'string', `${pf.body.diversification_score}/${pf.body.diversification_label}`);

// 7-day history for sparklines (backdated points)
const { default: Database } = await import('better-sqlite3');
const dbPath = process.env.DATABASE_PATH ?? './data/app.db';
const db = new Database(dbPath);
const hist = db.prepare('INSERT OR IGNORE INTO price_history (symbol, price_idr, fetched_at) VALUES (?, ?, ?)');
const bases = { HYPE: [480_000, 8_000], SOL: [2_100_000, 60_000], MET: [17_000, 300], 'BBCA.JK': [9900, 60], 'TLKM.JK': [3150, -25], RDNPU: [1240, 8] };
for (const [sym, [baseV, step]] of Object.entries(bases)) {
  for (let d = 7; d >= 1; d--) {
    const ts = new Date(Date.now() - d * 864_000_00).toISOString().slice(0, 19).replace('T', ' ');
    hist.run(sym, Math.round(baseV + (7 - d) * step), ts);
  }
}
db.close();
// Tandai simbol demo agar bisa dibersihkan tanpa menyentuh data user.
{
  const { default: Database2 } = await import('better-sqlite3');
  const db2 = new Database2(dbPath);
  db2.prepare(`INSERT INTO meta (key, value) VALUES ('demo_seed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify({ symbols: dummyAssets.map((a) => a.symbol), at: new Date().toISOString() }));
  db2.close();
}
for (const s of ['SOL', 'BBCA.JK', 'RDNPU']) {
  const h = await api(`/api/prices/history?symbol=${s}`);
  check(`prices: history ${s} >= 7 points`, h.body.length >= 7, `got ${h.body.length}`);
}

// ---------- prices + dashboard ----------
const prices = await api('/api/prices');
check(
  'prices: all dummy symbols cached',
  dummyAssets.every((a) => prices.body.some((p) => p.symbol === a.symbol)),
);
const refresh = await api('/api/prices/refresh', { method: 'POST', body: JSON.stringify({}) });
check('prices: manual refresh 200 + cache intact', refresh.status === 200 && refresh.body.prices.length >= dummyAssets.length);

const dash = await api(`/api/dashboard?month=${month}`);
const freshAcc = await api('/api/accounts');
const freshPf = await api('/api/portfolio'); // re-read: refresh above may have pulled live prices
const cashTotal = freshAcc.body.filter((a) => a.is_active).reduce((s, a) => s + a.balance_idr, 0);
check('dashboard: wealth = cash + invested', dash.body.total_wealth_idr === cashTotal + freshPf.body.total_value_idr);
check('dashboard: 3 chart datasets present', dash.body.expense_by_category.length > 0 && dash.body.allocation.length === 4 && dash.body.portfolio_by_asset.length >= 6);
check('dashboard: expense categories >= 5', dash.body.expense_by_category.length >= 5, `got ${dash.body.expense_by_category.length}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
