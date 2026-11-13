/** Escape terpusat untuk semua interpolasi innerHTML. */
export function escHtml(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function escAttr(s: unknown): string {
  return String(s ?? '').replace(/[&"'<>]/g, (c) =>
    c === '&' ? '&amp;' : c === '"' ? '&quot;' : c === "'" ? '&#39;' : c === '<' ? '&lt;' : '&gt;',
  );
}
