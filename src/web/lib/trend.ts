import { api } from './api.js';
import { trendline, fmtDay, type TrendPoint } from '../components/trendline.js';
import { formatIdr } from './format.js';
import { isPrivat } from './state.js';

/** Kartu tren nilai portofolio dari snapshot harian (data asli, bukan estimasi).
 *  <2 titik → kartu pemberitahuan jujur (pencatatan baru dimulai). */
export async function wealthTrendCard(opts: {
  title: string;
  kind: 'total' | 'invest';
  sub: string;
  color?: string;
}): Promise<string> {
  const color = opts.color ?? '#2b5cff';
  let points: Array<{ day: string; total_wealth_idr: number; invest_value_idr: number }> = [];
  try {
    const res = (await api.get('/api/wealth/trend?days=90')) as { points?: typeof points };
    points = Array.isArray(res.points) ? res.points : [];
  } catch {
    return '';
  }
  const pick = (p: (typeof points)[number]): number => (opts.kind === 'total' ? p.total_wealth_idr : p.invest_value_idr);
  const valid = points.filter((p) => typeof p.day === 'string' && Number.isFinite(pick(p)));
  if (valid.length < 2) {
    return `<div class="card"><strong>${opts.title}</strong><div class="empty"><div class="big">◔</div>Pencatatan harian baru dimulai — garis tren muncul setelah 2 hari data.</div></div>`;
  }
  const pts: TrendPoint[] = valid.map((p) => ({
    t: `${p.day}T00:00:00`,
    v: pick(p),
    label: `${fmtDay(`${p.day}T00:00:00`)} • ${isPrivat() ? '••••••' : formatIdr(pick(p))}`,
  }));
  const first = pts[0].v;
  const last = pts[pts.length - 1].v;
  const pct = first > 0 ? ((last - first) / first) * 100 : 0;
  return `<div class="card"><strong>${opts.title}</strong>
    <div class="between" style="margin-top:8px"><span class="muted">${opts.sub}</span><span class="pill ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span></div>
    <div class="between" style="margin-top:4px"><span class="muted">Kini</span><strong>${isPrivat() ? '••••••' : formatIdr(last)}</strong></div>
    <div style="margin-top:8px;color:var(--muted)">${trendline(pts, color)}</div>
    <div class="muted" style="margin-top:6px;font-size:12px">Snapshot harian sejak ${valid[0].day} — awal periode direkonstruksi dari catatan transaksi & harga.</div>
  </div>`;
}
