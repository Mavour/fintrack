/** Lightweight SVG donut (no chart lib). */
export function donut(
  items: Array<{ label: string; value: number; color: string }>,
  size = 150,
): string {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total <= 0) return `<div class="empty">Belum ada data</div>`;
  const r = 54;
  const c = 2 * Math.PI * r;
  let offset = 25;
  const segs = items
    .filter((i) => i.value > 0)
    .map((i) => {
      const frac = i.value / total;
      const dash = `${(frac * c).toFixed(1)} ${(c - frac * c).toFixed(1)}`;
      const el = `<circle r="${r}" cx="75" cy="75" fill="transparent" stroke="${i.color}" stroke-width="22" stroke-dasharray="${dash}" stroke-dashoffset="${(-offset).toFixed(1)}" />`;
      offset += frac * 100;
      return el;
    })
    .join('');
  const legend = items
    .map((i) => `<div class="row" style="font-size:12px"><span style="width:10px;height:10px;border-radius:3px;background:${i.color};display:inline-block"></span> ${i.label}</div>`)
    .join('');
  return `<div class="row"><svg width="${size}" height="${size}" viewBox="0 0 150 150">${segs}</svg><div>${legend}</div></div>`;
}

export const PALETTE = ['#6d28d9', '#0d9488', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6', '#64748b'];
