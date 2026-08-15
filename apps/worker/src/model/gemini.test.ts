import { describe, expect, it } from "vitest";
import { computeCostCents } from "@sul/shared";
import { mapFinishReason, usageFrom } from "./gemini.js";
import {
  DailyQuotaExhaustedError,
  TokenBucketLimiter,
  backoffDelayMs,
  classifyRateLimit,
} from "./ratelimit.js";

describe("finishReason -> the loop's three-way branch", () => {
  it("maps STOP to a normal completion", () => {
    expect(mapFinishReason("STOP")).toBe("end_turn");
  });

  it("maps MAX_TOKENS to truncation, so the loop raises the budget", () => {
    expect(mapFinishReason("MAX_TOKENS")).toBe("max_tokens");
  });

  it("maps every safety-ish reason to refusal, so the loop never retries as-is", () => {
    for (const r of [
      "SAFETY",
      "RECITATION",
      "BLOCKLIST",
      "PROHIBITED_CONTENT",
      "SPII",
      "IMAGE_SAFETY",
    ]) {
      expect(mapFinishReason(r), r).toBe("refusal");
    }
  });

  it("treats anything unrecognised as unknown rather than guessing", () => {
    expect(mapFinishReason("LANGUAGE")).toBe("unknown");
    expect(mapFinishReason(undefined)).toBe("unknown");
  });
});

describe("usageMetadata -> our token fields", () => {
  it("adds thinking tokens to output — Gemini's total treats them as a separate addend", () => {
    // The trap: candidatesTokenCount EXCLUDES thoughts on Gemini, unlike
    // Anthropic's output_tokens which includes them. Mapping candidates
    // straight across would undercount billable output on every call.
    const u = usageFrom({
      promptTokenCount: 1000,
      candidatesTokenCount: 200,
      thoughtsTokenCount: 500,
      totalTokenCount: 1700,
    });
    expect(u.outputTokens).toBe(700);
  });

  it("subtracts cached tokens from the prompt count to avoid double-counting", () => {
    // promptTokenCount is documented to already include cached content.
    const u = usageFrom({
      promptTokenCount: 1000,
      cachedContentTokenCount: 400,
      candidatesTokenCount: 100,
      totalTokenCount: 1100,
    });
    expect(u.inputTokens).toBe(600);
    expect(u.cacheReadTokens).toBe(400);
    // 600 + 400 reconstructs the original 1000 exactly once.
    expect(u.inputTokens + u.cacheReadTokens).toBe(1000);
  });

  it("never returns negative input if the API reports cached > prompt", () => {
    const u = usageFrom({ promptTokenCount: 100, cachedContentTokenCount: 900 });
    expect(u.inputTokens).toBe(0);
  });

  it("handles a completely absent usageMetadata", () => {
    expect(usageFrom(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
  });

  it("prices Gemini through the shared cost function", () => {
    const u = usageFrom({
      promptTokenCount: 1_000_000,
      candidatesTokenCount: 1_000_000,
    });
    const cents = computeCostCents(u, "gemini-2.5-flash", "5m", new Date());
    // 1M in at $0.30 + 1M out at $2.50 = $2.80 = 280 cents.
    expect(cents).toBeCloseTo(280, 4);
  });
});

describe("429 classification", () => {
  it("identifies a daily quota as unrecoverable", () => {
    const c = classifyRateLimit(
      429,
      '{"error":{"message":"Quota exceeded for quota metric GenerateRequestsPerDayPerProjectPerModel"}}',
    );
    expect(c.kind).toBe("daily");
  });

  it("identifies a per-minute limit as retryable", () => {
    const c = classifyRateLimit(
      429,
      '{"error":{"message":"Quota exceeded: GenerateRequestsPerMinutePerProjectPerModel"}}',
    );
    expect(c.kind).toBe("per_minute");
  });

  it("reads the server's suggested retry delay from the error body", () => {
    const c = classifyRateLimit(
      429,
      '{"error":{"details":[{"retryDelay":"31s"}],"message":"per minute"}}',
    );
    expect(c.retryAfterMs).toBe(31_000);
  });

  it("reads Retry-After from headers when present", () => {
    const c = classifyRateLimit(429, "per minute", { "retry-after": "12" });
    expect(c.retryAfterMs).toBe(12_000);
  });

  it("falls back to retrying an unclassified 429 rather than aborting", () => {
    expect(classifyRateLimit(429, "slow down").kind).toBe("unknown");
  });

  it("has a distinct error type for daily exhaustion", () => {
    const e = new DailyQuotaExhaustedError("daily quota exhausted");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toMatch(/cannot recover/);
  });
});

describe("backoff", () => {
  it("is jittered so parallel workers do not retry in lockstep", () => {
    // Full jitter: the delay is uniform in [0, ceiling), not a fixed value.
    expect(backoffDelayMs(3, undefined, () => 0)).toBe(0);
    expect(backoffDelayMs(3, undefined, () => 0.999)).toBeGreaterThan(0);
  });

  it("is bounded by maxMs", () => {
    expect(backoffDelayMs(20, undefined, () => 0.999)).toBeLessThanOrEqual(60_000);
  });
});

describe("shared token bucket", () => {
  it("serialises concurrent callers rather than letting them burst", async () => {
    // 600 RPM keeps the test fast while still exercising the spacing logic.
    const limiter = new TokenBucketLimiter({ requestsPerMinute: 600, burst: 1 });
    const started = Date.now();
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    // Three acquisitions at 100ms spacing cannot complete instantly.
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it("lets the configured burst through immediately", async () => {
    const limiter = new TokenBucketLimiter({ requestsPerMinute: 60, burst: 3 });
    const started = Date.now();
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
