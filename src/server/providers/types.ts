export interface Price {
  symbol: string;
  priceIdr: number;
  source: string;
}

export interface PriceProvider {
  readonly name: string;
  fetch(symbols: string[]): Promise<Price[]>;
}

/** Small fetch helper with timeout. */
export async function fetchWithTimeout(
  url: string,
  ms = 10_000,
  init: RequestInit = {},
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      // Jangan retry 4xx (kecuali 429): request salah, retry hanya buang waktu + rate-limit.
      const status = (e as { httpStatus?: number; statusCode?: number }).httpStatus ?? (e as { statusCode?: number }).statusCode;
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) throw e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw last;
}
