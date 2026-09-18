import { describe, expect, it } from "vitest";
import { elapsedMsFromEvents } from "./run-clock";

/**
 * Elapsed used to be wall-clock since the page mounted, driven by a setInterval
 * with no stop condition. That was wrong twice over: it never stopped when the
 * personas did, and it reported how long you had been watching rather than how
 * long the run took — a 2m17s run displayed as 0:14.
 *
 * Deriving it from the revealed events fixes both at once. There is no timer to
 * forget to clear, and the value cannot keep climbing after the log runs out.
 */

const at = (ts: number) => ({ type: "persona.step", ts });

describe("elapsedMsFromEvents", () => {
  it("reports nothing before any event has been revealed", () => {
    expect(elapsedMsFromEvents([])).toBe(0);
  });

  it("reports nothing on the very first event", () => {
    expect(elapsedMsFromEvents([at(1_000)])).toBe(0);
  });

  it("reports the span from the first event to the most recent", () => {
    expect(elapsedMsFromEvents([at(1_000), at(3_500)])).toBe(2_500);
  });

  it("grows as more of the log is revealed", () => {
    const log = [at(1_000), at(2_000), at(5_000)];

    expect(elapsedMsFromEvents(log.slice(0, 2))).toBe(1_000);
    expect(elapsedMsFromEvents(log)).toBe(4_000);
  });

  it("stops growing once the log is exhausted", () => {
    const log = [at(1_000), at(5_000)];

    expect(elapsedMsFromEvents(log)).toBe(elapsedMsFromEvents(log));
  });

  it("ignores events carrying no usable timestamp", () => {
    expect(
      elapsedMsFromEvents([at(1_000), { type: "x" }, at(4_000)]),
    ).toBe(3_000);
  });

  it("never reports a negative span if events arrive out of order", () => {
    expect(elapsedMsFromEvents([at(5_000), at(1_000)])).toBe(4_000);
  });
});
