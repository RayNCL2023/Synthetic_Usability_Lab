import { describe, expect, it } from "vitest";
import { storeStepScreenshot, type ScreenshotSink } from "./step-screenshot.js";

/**
 * This logic was copy-pasted into three call sites — the persona worker, the
 * single-persona CLI, and the eval harness — and the eval copy silently lost
 * its upload, so every eval run persisted a trace with no evidence in it and
 * rendered as a broken run in the UI. One implementation, tested once.
 */

/** A real in-memory sink, so the assertions are about stored bytes. */
function memorySink(enabled = true): ScreenshotSink & { stored: Map<string, Buffer> } {
  const stored = new Map<string, Buffer>();
  return {
    enabled,
    stored,
    async upload(key, body) {
      stored.set(key, body);
      return key;
    },
  };
}

const RUN = "11111111-2222-3333-4444-555555555555";

describe("storeStepScreenshot", () => {
  it("stores the screenshot and returns the key it was stored under", async () => {
    const sink = memorySink();
    const shot = Buffer.from("jpeg-bytes");

    const key = await storeStepScreenshot(sink, {
      runId: RUN,
      personaKey: "impatient_mobile",
      stepIndex: 0,
      screenshot: shot,
    });

    expect(key).toBe(`runs/${RUN}/impatient_mobile/000.jpg`);
    expect(sink.stored.get(key!)).toEqual(shot);
  });

  it("returns null and stores nothing when object storage is not configured", async () => {
    const sink = memorySink(false);

    const key = await storeStepScreenshot(sink, {
      runId: RUN,
      personaKey: "impatient_mobile",
      stepIndex: 0,
      screenshot: Buffer.from("jpeg-bytes"),
    });

    expect(key).toBeNull();
    expect(sink.stored.size).toBe(0);
  });

  it("returns null for a persona that never produces a screenshot", async () => {
    const sink = memorySink();

    const key = await storeStepScreenshot(sink, {
      runId: RUN,
      personaKey: "screen_reader",
      stepIndex: 2,
      screenshot: null,
    });

    expect(key).toBeNull();
    expect(sink.stored.size).toBe(0);
  });

  it("keeps personas in separate keyspaces within a run", async () => {
    const sink = memorySink();
    const shot = Buffer.from("x");

    await storeStepScreenshot(sink, {
      runId: RUN,
      personaKey: "impatient_mobile",
      stepIndex: 1,
      screenshot: shot,
    });
    await storeStepScreenshot(sink, {
      runId: RUN,
      personaKey: "procurement",
      stepIndex: 1,
      screenshot: shot,
    });

    expect(sink.stored.size).toBe(2);
  });

  it("pads the step index so keys sort in step order past nine", async () => {
    const sink = memorySink();
    for (const stepIndex of [9, 10]) {
      await storeStepScreenshot(sink, {
        runId: RUN,
        personaKey: "procurement",
        stepIndex,
        screenshot: Buffer.from("x"),
      });
    }

    expect([...sink.stored.keys()].sort()).toEqual([
      `runs/${RUN}/procurement/009.jpg`,
      `runs/${RUN}/procurement/010.jpg`,
    ]);
  });
});
