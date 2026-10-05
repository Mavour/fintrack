export function formatIdr(n: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(n);
}

export function formatPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return 'belum pernah';
  const ms = Date.now() - new Date(iso.endsWith('Z') ? iso : iso + 'Z').getTime();
  if (ms < 60_000) return 'baru saja';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} mnt lalu`;
  return `${Math.floor(ms / 3_600_000)} jam lalu`;
}
