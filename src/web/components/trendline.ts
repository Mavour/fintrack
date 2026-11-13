import { escAttr, escHtml } from '../lib/escape.js';

export interface TrendPoint {
  t: string;
  v: number;
  /** Teks tooltip siap tampil (dibangun pemanggil agar format mata uang benar). */
  label?: string;
}

const W = 560;
const H = 180;
const PAD = 8;
const BASE = H;

/** Catmull-Rom → bezier kubik: garis mulus tanpa sudut kaku. */
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length < 3) return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

/** Line + area SVG responsif (viewBox, tanpa lib). Titik diratakan bila > 30. */
export function trendline(points: TrendPoint[], color = '#2b5cff'): string {
  if (points.length < 2) return '<div class="empty">Belum cukup data tren.</div>';
  let pts = points;
  if (pts.length > 30) {
    const step = (pts.length - 1) / 29;
    pts = Array.from({ length: 30 }, (_, i) => pts[Math.round(i * step)]);
  }
  const vs = pts.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  const x = (i: number): number => PAD + (i / (pts.length - 1)) * (W - PAD * 2);
  const y = (v: number): number => PAD + (1 - (v - min) / span) * (H - PAD * 2 - 18);
  const xy = pts.map((p, i) => ({ x: x(i), y: y(p.v) }));
  const line = smoothPath(xy);
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${BASE} L${x(0).toFixed(1)},${BASE} Z`;
  const up = pts[pts.length - 1].v >= pts[0].v;
  const gid = `tg${Math.abs(hashStr(line)) % 100000}`;
  const first = fmtDay(pts[0].t);
  const last = fmtDay(pts[pts.length - 1].t);
  // Grid horizontal samar agar fluktuasi terbaca.
  const grids = [0.25, 0.5, 0.75]
    .map((f) => {
      const gy = (PAD + f * (H - PAD * 2 - 18)).toFixed(1);
      return `<line x1="${PAD}" y1="${gy}" x2="${W - PAD}" y2="${gy}" stroke="currentColor" stroke-opacity="0.12" stroke-width="1" />`;
    })
    .join('');
  const data = escAttr(JSON.stringify(pts.map((p) => ({ t: p.t, v: p.v, label: p.label ?? '' }))));
  return `<div class="trend-wrap" data-trend="${data}" data-n="${pts.length}">
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img" aria-label="Tren harga">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity="0.35" />
        <stop offset="1" stop-color="${color}" stop-opacity="0.02" />
      </linearGradient></defs>
      ${grids}
      <path d="${area}" fill="${'url(#' + gid + ')'}" />
      <path d="${line}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      <line class="trend-cross" x1="0" y1="${PAD}" x2="0" y2="${H - 18}" stroke="${color}" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.7" visibility="hidden" />
      <circle class="trend-dot" r="5.5" fill="${color}" stroke="#fff" stroke-width="2.5" visibility="hidden" />
      <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(pts[pts.length - 1].v).toFixed(1)}" r="5" fill="${color}" stroke="#fff" stroke-width="2.5" />
      <text x="${PAD}" y="${H - 4}" font-size="11" fill="currentColor" opacity="0.55">${escHtml(first)}</text>
      <text x="${W - PAD}" y="${H - 4}" font-size="11" fill="currentColor" opacity="0.55" text-anchor="end">${escHtml(last)}${up ? ' ▲' : ' ▼'}</text>
    </svg>
    <div class="trend-tip" hidden></div>
  </div>`;
}

/** Aktifkan hover tooltip + crosshair untuk semua .trend-wrap di root. */
export function bindTrendHover(root: ParentNode): void {
  root.querySelectorAll('.trend-wrap').forEach((wrap) => {
    if ((wrap as HTMLElement).dataset.bound) return;
    (wrap as HTMLElement).dataset.bound = '1';
    const el = wrap as HTMLElement;
    let pts: Array<{ t: string; v: number; label: string }> = [];
    try {
      pts = JSON.parse(el.dataset.trend ?? '[]') as typeof pts;
    } catch {
      return;
    }
    const n = Number(el.dataset.n ?? pts.length) || pts.length;
    if (pts.length < 2) return;
    const svg = el.querySelector('svg');
    const tip = el.querySelector('.trend-tip') as HTMLElement | null;
    const cross = el.querySelector('.trend-cross') as SVGLineElement | null;
    const dot = el.querySelector('.trend-dot') as SVGCircleElement | null;
    if (!svg || !tip || !cross || !dot) return;
    const hide = (): void => {
      tip.hidden = true;
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
    };
    el.addEventListener('mousemove', (e) => {
      const me = e as MouseEvent;
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0) return;
      const px = ((me.clientX - rect.left) / rect.width) * W;
      let i = Math.round(((px - PAD) / (W - PAD * 2)) * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));
      const p = pts[i];
      if (!p) return;
      const cx = PAD + (i / (n - 1)) * (W - PAD * 2);
      const vs = pts.map((q) => q.v);
      const min = Math.min(...vs);
      const max = Math.max(...vs);
      const span = max - min || 1;
      const cy = PAD + (1 - (p.v - min) / span) * (H - PAD * 2 - 18);
      cross.setAttribute('x1', String(cx));
      cross.setAttribute('x2', String(cx));
      cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', String(cx));
      dot.setAttribute('cy', String(cy));
      dot.setAttribute('visibility', 'visible');
      tip.textContent = p.label || `${fmtDay(p.t)} • ${p.v}`;
      tip.hidden = false;
      const pct = (cx / W) * 100;
      tip.style.left = `${pct}%`;
      tip.style.transform = pct > 68 ? 'translate(-105%, -130%)' : 'translate(5%, -130%)';
    });
    el.addEventListener('mouseleave', hide);
  });
}

export function fmtDay(iso: string): string {
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  if (isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}
