// Browser regression harness: serve beside the compiled patchContent.js module.
import { patchContent } from './patchContent.js';

const results = [];
const check = (name, condition) => {
  results.push({ name, passed: Boolean(condition) });
  if (!condition) throw new Error(name);
};
const root = document.createElement('div');
document.body.append(root);
const html = value => `<section id="panel"><details><summary>Status</summary>Fresh</details><input value="initial"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"><div id="scroll" style="height:40px;overflow:auto"><p style="height:200px">${value}</p></div><button id="a">${value}</button><button id="b">B</button><svg><path d="M0 0 L${value} 1"></path></svg></section>`;

try {
  root.innerHTML = html(1);
  const panel = root.querySelector('#panel');
  const image = root.querySelector('img');
  const input = root.querySelector('input');
  const details = root.querySelector('details');
  const scroll = root.querySelector('#scroll');
  const button = root.querySelector('#a');
  const path = root.querySelector('path');
  const avatar = document.createElement('span');
  avatar.className = 'avatar coin-avatar has-coin-icon';
  avatar.innerHTML = '<span class="coin-monogram">SOL</span><img data-coin-loaded="true">';
  panel.append(avatar);
  const coin = avatar.querySelector('img');
  input.value = 'user typing';
  input.focus();
  details.open = true;
  scroll.scrollTop = 80;
  let clicks = 0;
  button.onclick = () => clicks++;
  const nextHtml = html(2).replace('</section>', '<span class="avatar coin-avatar"><span class="coin-monogram">SOL</span><img></span></section>');
  patchContent(root, nextHtml);
  check('updates displayed values', button.textContent === '2');
  check('retains page, image and SVG nodes', root.querySelector('#panel') === panel && root.querySelector('img') === image && root.querySelector('path') === path);
  check('retains focus and typed values', document.activeElement === input && input.value === 'user typing');
  check('retains expanded disclosures', details.open);
  check('retains loaded coin icon visibility', avatar.classList.contains('has-coin-icon') && coin.dataset.coinLoaded === 'true');
  check('retains nested scroll position', root.querySelector('#scroll') === scroll && scroll.scrollTop === 80);
  button.click();
  check('retains button handlers', clicks === 1);
  const observer = new MutationObserver(() => {});
  observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  patchContent(root, nextHtml);
  check('unchanged frame makes no DOM mutations', observer.takeRecords().length === 0);
  observer.disconnect();
  patchContent(root, '<section id="panel"><button id="new">New</button><button id="b">B</button><button id="a">3</button></section>');
  check('supports insertion and reordering while retaining keyed nodes', root.querySelector('#a') === button && button.textContent === '3');
  patchContent(root, '<section id="panel"><button id="a">4</button></section>');
  check('removes obsolete positions', root.querySelector('#a') === button && !root.querySelector('#b'));
  document.body.dataset.result = 'passed';
} catch (error) {
  document.body.dataset.result = 'failed';
  results.push({ error: error.message });
}
root.remove();
const report = document.createElement('pre');
report.textContent = JSON.stringify(results, null, 2);
document.body.append(report);
