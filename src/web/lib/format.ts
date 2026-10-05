export function formatIdr(n: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(n);
}

/** Compact form: Rp 132,4jt / Rp 1,2M / Rp 850rb. */
export function formatCompactIdr(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}Rp ${(abs / 1_000_000_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })}M`;
  if (abs >= 1_000_000) return `${sign}Rp ${(abs / 1_000_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })}jt`;
  if (abs >= 1_000) return `${sign}Rp ${(abs / 1_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })}rb`;
  return formatIdr(n);
}

export function formatPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/** USD with $ prefix; tiny prices (<$1) get 4 decimals. */
export function formatUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const digits = Math.abs(n) < 1 ? 4 : 2;
  return (
    '$' +
    n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  );
}

export function timeAgo(iso: string | null): string {
  if (!iso) return 'belum pernah';
  const t = new Date(iso.endsWith('Z') ? iso : iso + 'Z').getTime();
  const ms = Date.now() - t;
  if (ms < 60_000) return 'baru saja';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} mnt lalu`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} jam lalu`;
  return `${Math.floor(ms / 86_400_000)} hari lalu`;
}

export function todayLong(): string {
  return new Intl.DateTimeFormat('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());
}

export function fmtDate(iso: string): string {
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  return new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}
