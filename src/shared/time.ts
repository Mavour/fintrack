export const WITA_ZONE = 'Asia/Makassar';

/** SQLite timestamps without an offset are UTC; date-only values retain their calendar day. */
export function parseTimestamp(iso: string): Date {
  if (iso.length === 10) return new Date(`${iso}T00:00:00+08:00`);
  const normalized = iso.replace(' ', 'T');
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`);
}

export function normalizeTransactionTimestamp(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ]([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/i.exec(value);
  if (!match) return null;
  const day = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || !day.toISOString().startsWith(match[1] + 'T')) return null;
  const timestamp = parseTimestamp(value);
  if (!Number.isFinite(timestamp.getTime())) return null;
  const utc = timestamp.toISOString();
  return /^\d{4}-/.test(utc) ? utc : null;
}

export function toWitaInput(iso: string): string {
  const date = parseTimestamp(iso);
  return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() + 8 * 3_600_000).toISOString().slice(0, 16);
}

export function fromWitaInput(value: string): string {
  return new Date(`${value}+08:00`).toISOString();
}

export function witaMonth(iso = new Date().toISOString()): string {
  return toWitaInput(iso).slice(0, 7);
}
