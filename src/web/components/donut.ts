import { formatIdr } from '../lib/format.js';

/** Lightweight SVG donut (no chart lib). Tooltips via <title>. */
export function donut(
  items: Array<{ label: string; value: number; color: string }>,
  size = 150,
): string {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total <= 0) return `<div class="empty"><div class="big">○</div>Belum ada data</div>`;
  const r = 54;
  const c = 2 * Math.PI * r;
  let acc = 0;
  const segs = items
    .filter((i) => i.value > 0)
    .map((i) => {
      const frac = i.value / total;
      const dash = `${(frac * c).toFixed(1)} ${(c - frac * c).toFixed(1)}`;
      const el = `<circle r="${r}" cx="75" cy="75" fill="transparent" stroke="${i.color}" stroke-width="22" stroke-dasharray="${dash}" stroke-dashoffset="${(-acc * c).toFixed(1)}"><title>${i.label}: ${formatIdr(i.value)}</title></circle>`;
      acc += frac;
      return el;
    })
    .join('');
  const legend = items
    .filter((i) => i.value > 0)
    .map(
      (i) => `<div class="row" style="font-size:12.5px"><span style="width:10px;height:10px;border-radius:3px;background:${i.color};display:inline-block;flex:none"></span><span>${i.label}</span><strong style="margin-left:auto">${((i.value / total) * 100).toFixed(0)}%</strong></div>`,
    )
    .join('');
  return `<div class="row" style="align-items:center"><svg width="${size}" height="${size}" viewBox="0 0 150 150" role="img" aria-label="Diagram lingkaran">${segs}<circle r="${r}" cx="75" cy="75" fill="transparent" /></svg><div style="flex:1;display:grid;gap:6px">${legend}</div></div>`;
}

export const PALETTE = ['#0e9f6e', '#1d7fd6', '#f59e0b', '#e5484d', '#14b8a6', '#8b5cf6', '#64748b'];
export const ALLOC_COLORS = ['#1d7fd6', '#f59e0b', '#14b8a6', '#0e9f6e'];
