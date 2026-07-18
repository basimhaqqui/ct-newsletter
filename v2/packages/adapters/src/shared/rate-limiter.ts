// Token-bucket rate limiter shared by adapters. Deterministic-friendly: the
// clock is injectable for tests.

export interface RateLimiterOptions {
  capacity: number; // max burst tokens
  refillRatePerSec: number; // tokens added per second
  now?: () => number; // ms clock, injectable for tests
}

export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRatePerSec: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    this.capacity = Math.max(1, options.capacity);
    this.refillRatePerSec = Math.max(0.001, options.refillRatePerSec);
    this.now = options.now ?? (() => Date.now());
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsedS = (nowMs - this.lastRefill) / 1000;
    if (elapsedS > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedS * this.refillRatePerSec);
      this.lastRefill = nowMs;
    }
  }

  /** Waits until a token is available, then consumes it. */
  async take(): Promise<void> {
    this.refill();
    while (this.tokens < 1) {
      const deficitS = (1 - this.tokens) / this.refillRatePerSec;
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(deficitS * 1000)));
      this.refill();
    }
    this.tokens -= 1;
  }

  /** Non-blocking: true if a token was available and consumed. */
  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  getTokens(): number {
    this.refill();
    return this.tokens;
  }
}

/** Deterministic FNV-1a payload hash used for idempotency across adapters. */
export function hashPayload(data: unknown): string {
  const str = canonicalStringify(data);
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000197);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
}
