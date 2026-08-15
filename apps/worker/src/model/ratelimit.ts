/**
 * Shared rate limiting for the model provider.
 *
 * On a free tier this is not a nicety. Three persona workers run in parallel by
 * design, so without a shared limiter the run's very first act is to burst
 * three concurrent requests at a 10 RPM quota and start collecting 429s.
 *
 * The critical distinction this module exists to make: a PER-MINUTE 429 is
 * transient and backoff fixes it; a DAILY-QUOTA 429 is not, and retrying is
 * both futile and slow. Treating them alike means a run that has already
 * exhausted the day's quota spends its entire wall-clock budget backing off
 * before failing anyway. So daily exhaustion aborts the run immediately with a
 * reason the user can act on.
 */

export type QuotaKind = "per_minute" | "daily" | "unknown";

export interface RateLimitClassification {
  kind: QuotaKind;
  /** Server-suggested wait, if it supplied one. */
  retryAfterMs: number | null;
  detail: string;
}

/**
 * Classifies a 429 body/headers into per-minute vs daily.
 *
 * Google returns a `QuotaFailure` detail whose `quotaId` / `quotaMetric` names
 * the window — e.g. `GenerateRequestsPerMinutePerProjectPerModel` vs
 * `GenerateRequestsPerDayPerProjectPerModel`. We match on the window words
 * rather than the full id so this keeps working when the ids are renamed.
 */
export function classifyRateLimit(
  status: number,
  body: unknown,
  headers?: Record<string, string | undefined>,
): RateLimitClassification {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  const lower = text.toLowerCase();

  const retryHeader =
    headers?.["retry-after"] ?? headers?.["Retry-After"] ?? undefined;
  let retryAfterMs: number | null = null;
  if (retryHeader) {
    const secs = Number(retryHeader);
    if (Number.isFinite(secs)) retryAfterMs = secs * 1000;
  }
  // Google also embeds `retryDelay: "31s"` in the error details.
  const embedded = /"?retrydelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s"?/i.exec(text);
  if (retryAfterMs === null && embedded?.[1]) {
    retryAfterMs = Number(embedded[1]) * 1000;
  }

  if (status !== 429) {
    return { kind: "unknown", retryAfterMs, detail: `status ${status}` };
  }

  const daily =
    /per\s*day|perday|daily|requests_per_day|freetier.*day/i.test(lower) ||
    lower.includes("quota exceeded for quota metric") && /day/i.test(lower);
  if (daily) {
    return {
      kind: "daily",
      retryAfterMs,
      detail: "daily quota exhausted — backoff cannot recover this",
    };
  }

  const perMinute = /per\s*minute|perminute|requests_per_minute|rpm/i.test(lower);
  if (perMinute) {
    return { kind: "per_minute", retryAfterMs, detail: "per-minute rate limit" };
  }

  // Unknown 429s are treated as per-minute — retrying a daily cap wastes time,
  // but refusing to retry a transient limit breaks otherwise-fine runs. The
  // bounded attempt count keeps the downside small either way.
  return { kind: "unknown", retryAfterMs, detail: "unclassified 429" };
}

export interface TokenBucketOptions {
  /** Sustained requests per minute. Conservative until measured. */
  requestsPerMinute: number;
  /** Max requests allowed to burst. Keep at 1 on a free tier. */
  burst?: number;
}

/**
 * A shared token bucket. One instance is created per process and handed to
 * every persona worker, so the limit applies across the whole run rather than
 * per worker.
 */
export class TokenBucketLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillIntervalMs: number;
  private lastRefill = Date.now();
  /** Serialises waiters so they acquire in arrival order. */
  private queue: Array<() => void> = [];
  private draining = false;

  constructor(opts: TokenBucketOptions) {
    this.capacity = Math.max(1, opts.burst ?? 1);
    this.tokens = this.capacity;
    this.refillIntervalMs = 60_000 / Math.max(1, opts.requestsPerMinute);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    const gained = Math.floor(elapsed / this.refillIntervalMs);
    if (gained > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + gained);
      this.lastRefill += gained * this.refillIntervalMs;
    }
  }

  /** Milliseconds until at least one token is available. */
  private msUntilToken(): number {
    this.refill();
    if (this.tokens > 0) return 0;
    const elapsedInWindow = Date.now() - this.lastRefill;
    return Math.max(0, this.refillIntervalMs - elapsedInWindow);
  }

  /** Resolves when a request may proceed. FIFO across all callers. */
  async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const wait = this.msUntilToken();
        if (wait > 0) {
          await sleep(wait);
          continue;
        }
        this.tokens -= 1;
        const next = this.queue.shift();
        next?.();
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Called after a per-minute 429 to stop the whole bucket briefly. Without
   * this, the other two persona workers keep firing into a limit we already
   * know we are over.
   */
  penalise(ms: number): void {
    this.tokens = 0;
    this.lastRefill = Date.now() + Math.max(0, ms) - this.refillIntervalMs;
  }
}

/** Thrown when the provider's daily quota is gone. Aborts the run. */
export class DailyQuotaExhaustedError extends Error {
  constructor(detail: string) {
    super(
      `Provider daily quota exhausted: ${detail}. Backing off cannot recover ` +
        `this — the run was stopped rather than spending its time budget retrying.`,
    );
    this.name = "DailyQuotaExhaustedError";
  }
}

export interface BackoffOptions {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  maxAttempts: 5,
  baseMs: 2_000,
  maxMs: 60_000,
};

/** Full-jitter exponential backoff — avoids three workers retrying in lockstep. */
export function backoffDelayMs(
  attempt: number,
  opts: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
