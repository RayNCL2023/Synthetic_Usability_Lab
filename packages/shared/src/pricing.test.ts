import { describe, expect, it } from "vitest";
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  UnknownModelPricingError,
  addUsage,
  computeCost,
  computeCostCents,
  findPricing,
  totalTokens,
} from "./pricing.js";

const M = 1_000_000;

describe("findPricing — date-effective entries", () => {
  it("uses Sonnet 5 introductory pricing before the cutover", () => {
    const p = findPricing("claude-sonnet-5", new Date("2026-08-13T12:00:00Z"));
    expect(p.inputPerMTok).toBe(2.0);
    expect(p.outputPerMTok).toBe(10.0);
  });

  it("uses standard pricing on the last introductory day", () => {
    const p = findPricing("claude-sonnet-5", new Date("2026-08-31T23:59:00Z"));
    expect(p.inputPerMTok).toBe(2.0);
  });

  it("reverts to standard pricing on 2026-09-01", () => {
    const p = findPricing("claude-sonnet-5", new Date("2026-09-01T00:00:01Z"));
    expect(p.inputPerMTok).toBe(3.0);
    expect(p.outputPerMTok).toBe(15.0);
  });

  it("treats undated models as always effective", () => {
    for (const day of ["2020-01-01", "2026-08-13", "2099-12-31"]) {
      expect(findPricing("claude-opus-5", new Date(`${day}T00:00:00Z`)).inputPerMTok).toBe(5.0);
    }
  });

  it("throws a named error rather than reporting an unknown model as free", () => {
    expect(() => findPricing("claude-imaginary-9", new Date())).toThrow(
      UnknownModelPricingError,
    );
    // The message must name the model and point at the fix.
    expect(() => findPricing("claude-imaginary-9", new Date())).toThrow(
      /claude-imaginary-9/,
    );
  });
});

describe("computeCost — cache tokens are multipliers on base input", () => {
  const at = new Date("2026-08-13T00:00:00Z");
  const usage = {
    inputTokens: M,
    outputTokens: M,
    cacheWriteTokens: M,
    cacheReadTokens: M,
  };

  it("prices plain input and output at the table rate", () => {
    const c = computeCost(usage, "claude-opus-5", "5m", at);
    expect(c.inputCents).toBeCloseTo(5.0 * 100, 6);
    expect(c.outputCents).toBeCloseTo(25.0 * 100, 6);
  });

  it("prices a 5-minute cache write at 1.25x base input", () => {
    const c = computeCost(usage, "claude-opus-5", "5m", at);
    expect(c.cacheWriteCents).toBeCloseTo(5.0 * 100 * 1.25, 6);
    expect(CACHE_WRITE_MULTIPLIER["5m"]).toBe(1.25);
  });

  it("prices a 1-hour cache write at 2x base input, not 1.25x", () => {
    const c = computeCost(usage, "claude-opus-5", "1h", at);
    expect(c.cacheWriteCents).toBeCloseTo(5.0 * 100 * 2.0, 6);
    expect(CACHE_WRITE_MULTIPLIER["1h"]).toBe(2.0);
  });

  it("prices cache reads at 0.1x base input", () => {
    const c = computeCost(usage, "claude-opus-5", "5m", at);
    expect(c.cacheReadCents).toBeCloseTo(5.0 * 100 * 0.1, 6);
    expect(CACHE_READ_MULTIPLIER).toBe(0.1);
  });

  it("does not lump cache tokens into plain input", () => {
    const withCache = computeCostCents(usage, "claude-opus-5", "5m", at);
    const withoutCache = computeCostCents(
      { ...usage, cacheWriteTokens: 0, cacheReadTokens: 0 },
      "claude-opus-5",
      "5m",
      at,
    );
    expect(withCache).toBeGreaterThan(withoutCache);
  });

  it("costs the same run differently either side of the Sonnet cutover", () => {
    const before = computeCostCents(usage, "claude-sonnet-5", "5m", new Date("2026-08-13"));
    const after = computeCostCents(usage, "claude-sonnet-5", "5m", new Date("2026-09-02"));
    expect(after).toBeGreaterThan(before);
    expect(after / before).toBeCloseTo(1.5, 2);
  });
});

describe("usage accumulation", () => {
  it("adds every token class", () => {
    const a = { inputTokens: 1, outputTokens: 2, cacheWriteTokens: 3, cacheReadTokens: 4 };
    const b = { inputTokens: 10, outputTokens: 20, cacheWriteTokens: 30, cacheReadTokens: 40 };
    expect(addUsage(a, b)).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheWriteTokens: 33,
      cacheReadTokens: 44,
    });
  });

  it("counts cache tokens in the run total", () => {
    expect(
      totalTokens({
        inputTokens: 1,
        outputTokens: 2,
        cacheWriteTokens: 3,
        cacheReadTokens: 4,
      }),
    ).toBe(10);
  });
});
