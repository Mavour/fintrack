import { renderHome, applyLiveHome } from './pages/home.js';
import { formatIdr } from './lib/format.js';

const root = document.createElement('main');
document.body.append(root);
const results = [];
const check = (name, condition) => {
  results.push({ name, passed: Boolean(condition) });
  if (!condition) throw new Error(name);
};
let cash = 1000000;
const accounts = [{ id: 1, name: 'Test bank', type: 'bank', balance_idr: cash }];
const frame = {
  assets: [{ symbol: 'TEST', type: 'crypto', current_value_idr: 2000000, pl_percent: 1 }],
  wallet_tokens: [], total_value_idr: 2000000, floating_pl_idr: 1000,
  by_type: { crypto: 2000000 },
};
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async url => {
  calls.push(String(url));
  let data;
  if (String(url).startsWith('/api/dashboard')) data = {
    total_wealth_idr: cash + frame.total_value_idr, total_pl_idr: frame.floating_pl_idr,
    allocation: [{ label: 'Kas', value_idr: cash }, { label: 'Crypto', value_idr: frame.total_value_idr }], expense_by_category: [],
  };
  else if (url === '/api/accounts') data = accounts;
  else if (url === '/api/portfolio') data = frame;
  else if (String(url).startsWith('/api/wealth/trend')) data = { points: [] };
  else if (String(url).startsWith('/api/transactions')) data = [];
  else throw new Error(`Unexpected request: ${url}`);
  return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
};

try {
  await renderHome(root);
  const cards = [...root.querySelectorAll('.card')];
  const total = root.querySelector('.big-num');
  const totalText = total.firstChild;
  const price = root.querySelector('.w-price');
  const priceText = price.firstChild;
  const bank = root.querySelector('[data-acc]');
  const observer = new MutationObserver(() => {});
  observer.observe(root, { subtree: true, childList: true });
  calls.length = 0;
  cash = 1100000;
  accounts[0].balance_idr = cash;
  frame.total_value_idr = 2500000;
  frame.assets[0].current_value_idr = 2500000;
  frame.floating_pl_idr = 2000;
  frame.by_type.crypto = 2500000;
  await renderHome(root, true);
  check('background sync does not insert or remove any DOM nodes', observer.takeRecords().length === 0);
  check('keeps every home card and its order', cards.every((card, i) => root.querySelectorAll('.card')[i] === card));
  check('keeps price text nodes', total.firstChild === totalText && price.firstChild === priceText);
  check('updates total wealth and bank balance', total.textContent === formatIdr(3600000) && bank.querySelector('.a-bal').textContent === formatIdr(cash));
  check('updates watched asset values', price.textContent === formatIdr(2500000));
  const legend = root.querySelector('.allocation-chart');
  check('updates allocation without rebuilding the chart', !legend || legend.textContent.includes('69%'));
  check('does not fetch charts or transactions on background sync', !calls.some(url => /wealth\/trend|transactions/.test(url)));
  applyLiveHome(root, frame);
  check('repeated streaming frame makes no structural DOM mutations', observer.takeRecords().length === 0);
  observer.disconnect();
  document.body.dataset.result = 'passed';
} catch (error) {
  document.body.dataset.result = 'failed';
  results.push({ error: error.message });
} finally {
  globalThis.fetch = realFetch;
}
const report = document.createElement('pre');
report.textContent = JSON.stringify(results, null, 2);
document.body.prepend(report);
