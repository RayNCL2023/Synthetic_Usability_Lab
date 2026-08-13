/**
 * Model pricing and cost accounting.
 *
 * This is the single choke point that turns token usage into money. Every run
 * row's `total_cost_cents` traces back here, and COSTS.md is generated from
 * measurements taken through it — so a bug here makes the product's central
 * claim ("a directional read for cents") quietly false.
 *
 * Two things make this less trivial than a multiply:
 *
 *  1. Sonnet 5 has an INTRODUCTORY rate that expires. Entries are therefore
 *     date-effective and `computeCostCents` takes the run timestamp, so a run
 *     costed today and the same run re-costed in September agree with the bill.
 *
 *  2. Cache tokens are multipliers on base input keyed by TTL, not a separate
 *     price: writes are 1.25x at 5-minute TTL but 2.00x at 1-hour, and reads
 *     are 0.10x. Lumping cache tokens into plain input is the easiest way to
 *     make the numbers wrong in the direction that flatters us.
 */

export type CacheTtl = "5m" | "1h";

export interface PricingEntry {
  model: string;
  /** Inclusive ISO date, or null for "since forever". */
  from: string | null;
  /** Inclusive ISO date, or null for "until further notice". */
  to: string | null;
  /** USD per million tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
}

export const PRICING: readonly PricingEntry[] = [
  // Sonnet 5's introductory pricing runs through 2026-08-31 and reverts on
  // 2026-09-01. Both rows are kept so historical runs re-cost correctly.
  {
    model: "claude-sonnet-5",
    from: null,
    to: "2026-08-31",
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
  },
  {
    model: "claude-sonnet-5",
    from: "2026-09-01",
    to: null,
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
  },
  {
    model: "claude-opus-5",
    from: null,
    to: null,
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
  },
  {
    model: "claude-haiku-4-5",
    from: null,
    to: null,
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
  },
];

/** Multipliers applied to the model's base INPUT rate. */
export const CACHE_WRITE_MULTIPLIER: Record<CacheTtl, number> = {
  "5m": 1.25,
  "1h": 2.0,
};
export const CACHE_READ_MULTIPLIER = 0.1;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

/** Total billable tokens, for the `runs.total_tokens` column. */
export function totalTokens(u: TokenUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheWriteTokens + u.cacheReadTokens;
}

export class UnknownModelPricingError extends Error {
  constructor(model: string, at: Date) {
    super(
      `No pricing entry for model "${model}" effective at ${at.toISOString().slice(0, 10)}. ` +
        `Add a row to PRICING in packages/shared/src/pricing.ts — cost accounting fails ` +
        `loudly rather than silently reporting a run as free.`,
    );
    this.name = "UnknownModelPricingError";
  }
}

export function findPricing(model: string, at: Date): PricingEntry {
  const day = at.toISOString().slice(0, 10);
  const entry = PRICING.find(
    (p) =>
      p.model === model &&
      (p.from === null || day >= p.from) &&
      (p.to === null || day <= p.to),
  );
  if (!entry) throw new UnknownModelPricingError(model, at);
  return entry;
}

export interface CostBreakdown {
  inputCents: number;
  outputCents: number;
  cacheWriteCents: number;
  cacheReadCents: number;
  totalCents: number;
}

/**
 * Cost in cents, unrounded. Callers that display money should round at the
 * point of display; callers that accumulate should keep the float and round
 * once at the end, or a 15-step run loses a cent to rounding drift.
 */
export function computeCost(
  usage: TokenUsage,
  model: string,
  ttl: CacheTtl,
  at: Date,
): CostBreakdown {
  const p = findPricing(model, at);
  const perToken = (perMTok: number) => perMTok / 1_000_000;

  const inputCents = usage.inputTokens * perToken(p.inputPerMTok) * 100;
  const outputCents = usage.outputTokens * perToken(p.outputPerMTok) * 100;
  const cacheWriteCents =
    usage.cacheWriteTokens *
    perToken(p.inputPerMTok) *
    CACHE_WRITE_MULTIPLIER[ttl] *
    100;
  const cacheReadCents =
    usage.cacheReadTokens * perToken(p.inputPerMTok) * CACHE_READ_MULTIPLIER * 100;

  return {
    inputCents,
    outputCents,
    cacheWriteCents,
    cacheReadCents,
    totalCents: inputCents + outputCents + cacheWriteCents + cacheReadCents,
  };
}

export function computeCostCents(
  usage: TokenUsage,
  model: string,
  ttl: CacheTtl,
  at: Date,
): number {
  return computeCost(usage, model, ttl, at).totalCents;
}

/** Money for humans. Four decimals because a single step can cost < $0.01. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(4)}`;
}
