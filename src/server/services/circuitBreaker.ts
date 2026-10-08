/**
 * Circuit breaker per provider: buka setelah 5 kegagalan beruntun,
 * setengah-buka (half-open) untuk satu percobaan setelah cooldown,
 * tutup kembali saat percobaan berhasil. Mencegah banjir ke provider down.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  failureThreshold?: number;
  openCooldownMs?: number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: BreakerState = 'closed';

  constructor(private opts: BreakerOptions = {}) {}

  get threshold(): number {
    return this.opts.failureThreshold ?? 5;
  }

  get cooldownMs(): number {
    return this.opts.openCooldownMs ?? 60_000;
  }

  get current(): BreakerState {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half-open';
    }
    return this.state;
  }

  /** True bila panggilan boleh jalan (closed, atau half-open trial). */
  allow(): boolean {
    return this.current !== 'open';
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    } else if (this.state === 'half-open') {
      // Trial gagal -> buka lagi.
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }

  snapshot(): { state: BreakerState; failures: number } {
    return { state: this.current, failures: this.failures };
  }

  /** Test-only: paksa reset. */
  reset(): void {
    this.failures = 0;
    this.state = 'closed';
    this.openedAt = 0;
  }
}

/** Registry breaker per nama provider (satu proses tunggal). */
const breakers = new Map<string, CircuitBreaker>();

export function breakerFor(name: string, opts: BreakerOptions = {}): CircuitBreaker {
  let b = breakers.get(name);
  if (!b) {
    b = new CircuitBreaker(opts);
    breakers.set(name, b);
  }
  return b;
}

/** Test-only: bersihkan registry. */
export function resetBreakers(): void {
  breakers.clear();
}
