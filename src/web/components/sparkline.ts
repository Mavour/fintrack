/** Tiny sparkline from price_history points. */
export function sparkline(points: Array<{ price_idr: number }>, w = 110, h = 32): string {
  if (points.length < 2) return `<span class="muted">—</span>`;
  const vals = points.map((p) => p.price_idr);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = w / (vals.length - 1);
  const d = vals
    .map(
      (v, i) =>
        `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(1)}`,
    )
    .join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  const color = up ? '#0e9f6e' : '#e5484d';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Tren harga 7 hari"><title>Tren 7 hari</title><path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/></svg>`;
}
