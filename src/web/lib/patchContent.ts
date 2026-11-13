const keys = ['id', 'data-edit', 'data-cost', 'data-acc', 'data-position-tab', 'data-panel'];

function key(node: Node): string {
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  for (const name of keys) if (el.hasAttribute(name)) return `${name}:${el.getAttribute(name)}`;
  return '';
}

/** Reconcile background data without replacing the page, images, or scroll containers. */
function patchChildren(current: Node, incoming: Node): void {
  const wanted = [...incoming.childNodes];
  for (let i = 0; i < wanted.length; i++) {
    const next = wanted[i];
    let old = current.childNodes[i];
    const nextKey = key(next);
    if (nextKey && key(old ?? next) !== nextKey) {
      const found = [...current.childNodes].slice(i + 1).find(node => key(node) === nextKey);
      if (found) { current.insertBefore(found, old ?? null); old = found; }
      else if (old && key(old) && wanted.slice(i + 1).some(node => key(node) === key(old))) {
        current.insertBefore(next.cloneNode(true), old);
        continue;
      }
    }
    if (!old || old.nodeType !== next.nodeType || old.nodeName !== next.nodeName || key(old) !== nextKey) {
      const copy = next.cloneNode(true);
      if (old) current.replaceChild(copy, old);
      else current.appendChild(copy);
      continue;
    }
    if (old.isEqualNode(next)) continue;
    if (old.nodeType !== 1) {
      if (old.nodeValue !== next.nodeValue) old.nodeValue = next.nodeValue;
      continue;
    }
    const el = old as Element, updated = next as Element;
    // Preserve edited controls and disclosure state during automatic updates.
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) continue;
    // Icon load/fallback handlers own this subtree; do not clear their loaded state.
    if (el.classList.contains('coin-avatar') && updated.classList.contains('coin-avatar')
      && el.querySelector('.coin-monogram')?.textContent === updated.querySelector('.coin-monogram')?.textContent) continue;
    if (el.classList.contains('trend-wrap')) {
      if (el.getAttribute('data-trend') !== updated.getAttribute('data-trend')) current.replaceChild(next.cloneNode(true), old);
      continue;
    }
    for (const attr of [...el.attributes]) {
      if (attr.name === 'open' || attr.name === 'data-bound') continue;
      if (!updated.hasAttribute(attr.name)) el.removeAttribute(attr.name);
    }
    for (const attr of [...updated.attributes]) {
      if (attr.name !== 'open' && el.getAttribute(attr.name) !== attr.value) el.setAttribute(attr.name, attr.value);
    }
    patchChildren(el, updated);
  }
  while (current.childNodes.length > wanted.length) current.removeChild(current.lastChild!);
}

export function patchContent(root: Element, html: string): void {
  const template = document.createElement('template');
  template.innerHTML = html;
  patchChildren(root, template.content);
}

export function renderContent(root: HTMLElement, html: string, background: boolean): void {
  if (background) patchContent(root, html);
  else root.innerHTML = html;
}
