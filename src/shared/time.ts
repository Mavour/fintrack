export const WITA_ZONE = 'Asia/Makassar';

/** SQLite timestamps without an offset are UTC; date-only values retain their calendar day. */
export function parseTimestamp(iso: string): Date {
  if (iso.length === 10) return new Date(`${iso}T00:00:00+08:00`);
  const normalized = iso.replace(' ', 'T');
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`);
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
