import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { laneFrames, mergeSteps, orderEvents, type DisplayStep } from "./steps";
import type { RunPayload } from "./api";

/**
 * The live view derives its filmstrip and hero plate from these two sources,
 * and getting the merge wrong is invisible in the demo: seeded replays ship a
 * complete `steps` payload, so a merge that ignores the event log looks
 * perfect there and shows nothing at all during a real run.
 */

type PersistedStep = RunPayload["steps"][number];

function persistedStep(over: Partial<PersistedStep> = {}): PersistedStep {
  return {
    id: "db-id",
    personaKey: "impatient_mobile",
    index: 0,
    url: "https://example.com/",
    screenshotUrl: null,
    narration: "",
    action: null,
    ...over,
  };
}

function stepEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "persona.step",
    personaKey: "impatient_mobile",
    stepIndex: 0,
    url: "https://example.com/",
    screenshotUrl: null,
    narration: "",
    ...over,
  };
}

describe("mergeSteps", () => {
  it("returns the persisted steps when no events have arrived", () => {
    const steps = [persistedStep({ index: 0 }), persistedStep({ id: "b", index: 1 })];

    expect(mergeSteps(steps, [])).toEqual(steps);
  });

  it("shows a screenshot from a live step event before the payload has caught up", () => {
    const merged = mergeSteps(
      [],
      [stepEvent({ screenshotUrl: "https://minio/shot-0.jpg", narration: "tapped nav" })],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.screenshotUrl).toBe("https://minio/shot-0.jpg");
    expect(merged[0]?.narration).toBe("tapped nav");
  });

  it("reveals only the steps whose events have been seen", () => {
    const persisted = [
      persistedStep({ id: "a", index: 0 }),
      persistedStep({ id: "b", index: 1 }),
      persistedStep({ id: "c", index: 2 }),
    ];

    const merged = mergeSteps(persisted, [stepEvent({ stepIndex: 0 })]);

    expect(merged.map((s) => s.index)).toEqual([0]);
  });

  it("prefers the persisted screenshot once the payload catches up", () => {
    const merged = mergeSteps(
      [persistedStep({ id: "db-0", screenshotUrl: "https://minio/fresh.jpg" })],
      [stepEvent({ screenshotUrl: "https://minio/stale.jpg" })],
    );

    expect(merged[0]?.screenshotUrl).toBe("https://minio/fresh.jpg");
    expect(merged[0]?.id).toBe("db-0");
  });

  it("leaves the screenshot null for a persona that never receives one", () => {
    const merged = mergeSteps(
      [persistedStep({ personaKey: "screen_reader", screenshotUrl: null })],
      [stepEvent({ personaKey: "screen_reader", screenshotUrl: null })],
    );

    expect(merged[0]?.screenshotUrl).toBeNull();
  });

  it("orders steps by event arrival when personas interleave", () => {
    const merged = mergeSteps(
      [],
      [
        stepEvent({ personaKey: "impatient_mobile", stepIndex: 0 }),
        stepEvent({ personaKey: "procurement", stepIndex: 0 }),
        stepEvent({ personaKey: "impatient_mobile", stepIndex: 1 }),
      ],
    );

    expect(merged.map((s) => `${s.personaKey}:${s.index}`)).toEqual([
      "impatient_mobile:0",
      "procurement:0",
      "impatient_mobile:1",
    ]);
  });

  it("does not duplicate a step present in both the event log and the payload", () => {
    const merged = mergeSteps(
      [persistedStep({ id: "db-0", index: 0 })],
      [stepEvent({ stepIndex: 0 }), stepEvent({ stepIndex: 0 })],
    );

    expect(merged).toHaveLength(1);
  });

  /**
   * The regression guard that matters. A live run is a page whose payload is
   * still empty while its event log fills up, and that state is unreachable
   * from the seeded replay route — so the check uses a real recorded log with
   * the payload deliberately withheld.
   */
  it("reveals screenshots from a real recorded event log with no payload at all", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../../../fixtures/seeded-runs/hacker-news.json", import.meta.url),
        "utf8",
      ),
    ) as { events: Array<Record<string, unknown>> };

    const merged = mergeSteps([], fixture.events);

    const stepEvents = fixture.events.filter((e) => e["type"] === "persona.step");
    expect(merged).toHaveLength(stepEvents.length);
    expect(merged.filter((s) => s.screenshotUrl !== null).length).toBe(
      stepEvents.filter((e) => e["screenshotUrl"] !== null).length,
    );
    expect(merged.some((s) => s.screenshotUrl !== null)).toBe(true);
  });

  it("gives every step a stable key even before the payload assigns an id", () => {
    const merged = mergeSteps(
      [],
      [
        stepEvent({ personaKey: "impatient_mobile", stepIndex: 0 }),
        stepEvent({ personaKey: "procurement", stepIndex: 0 }),
      ],
    );

    expect(new Set(merged.map((s) => s.id)).size).toBe(2);
  });
});

/**
 * The three lanes are the claim this product makes about itself — that the
 * personas run at the same time, not one after another. Showing each lane's
 * own frame is what turns that claim into something visible while a run is
 * still going.
 */
describe("laneFrames", () => {
  function display(over: Partial<DisplayStep> = {}): DisplayStep {
    return {
      id: "s",
      personaKey: "impatient_mobile",
      index: 0,
      url: "https://example.com/",
      screenshotUrl: "https://minio/a.jpg",
      narration: "",
      ...over,
    };
  }

  it("gives each persona its own most recent step", () => {
    const frames = laneFrames([
      display({ id: "m0", personaKey: "impatient_mobile", index: 0 }),
      display({ id: "p0", personaKey: "procurement", index: 0 }),
      display({ id: "m1", personaKey: "impatient_mobile", index: 1 }),
    ]);

    expect(frames.get("impatient_mobile")?.step.id).toBe("m1");
    expect(frames.get("procurement")?.step.id).toBe("p0");
  });

  it("holds the last frame it had when the newest step has no image yet", () => {
    const frames = laneFrames([
      display({ id: "m0", index: 0, screenshotUrl: "https://minio/a.jpg" }),
      display({ id: "m1", index: 1, screenshotUrl: null }),
    ]);

    // The lane keeps showing something rather than blinking empty mid-run.
    expect(frames.get("impatient_mobile")?.step.id).toBe("m1");
    expect(frames.get("impatient_mobile")?.screenshotUrl).toBe("https://minio/a.jpg");
    expect(frames.get("impatient_mobile")?.screenshotStepIndex).toBe(0);
  });

  it("reports no frame for a persona that never produces one", () => {
    const frames = laneFrames([
      display({ id: "sr0", personaKey: "screen_reader", screenshotUrl: null }),
    ]);

    expect(frames.get("screen_reader")?.screenshotUrl).toBeNull();
    expect(frames.get("screen_reader")?.screenshotStepIndex).toBeNull();
  });

  it("has nothing to say about a persona that has not stepped yet", () => {
    const frames = laneFrames([display({ personaKey: "procurement" })]);

    expect(frames.has("impatient_mobile")).toBe(false);
  });

  it("never shows one persona's frame in another persona's lane", () => {
    const frames = laneFrames([
      display({ id: "m0", personaKey: "impatient_mobile", screenshotUrl: "https://minio/m.jpg" }),
      display({ id: "p0", personaKey: "procurement", screenshotUrl: null }),
    ]);

    expect(frames.get("procurement")?.screenshotUrl).toBeNull();
  });
});

/**
 * `seq` comes from a single per-run Postgres sequence and is the log's stated
 * ordering authority — array order is not. The committed demo fixtures are in
 * fact stored unsorted, so a consumer that trusts array order replays a run in
 * the wrong order and builds a filmstrip that jumps backwards.
 */
describe("orderEvents", () => {
  it("orders the log by seq rather than by array position", () => {
    const ordered = orderEvents([
      { seq: 40, type: "persona.step" },
      { seq: 11, type: "persona.step" },
      { seq: 25, type: "persona.step" },
    ]);

    expect(ordered.map((e) => e["seq"])).toEqual([11, 25, 40]);
  });

  it("leaves an already-ordered log alone", () => {
    const log = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];

    expect(orderEvents(log).map((e) => e["seq"])).toEqual([1, 2, 3]);
  });

  it("does not mutate the caller's array", () => {
    const log = [{ seq: 3 }, { seq: 1 }];
    orderEvents(log);

    expect(log.map((e) => e["seq"])).toEqual([3, 1]);
  });

  it("keeps events with no seq in their original relative order, at the end", () => {
    const ordered = orderEvents([
      { seq: 2, id: "b" },
      { id: "x" },
      { seq: 1, id: "a" },
      { id: "y" },
    ]);

    expect(ordered.map((e) => e["id"])).toEqual(["a", "b", "x", "y"]);
  });

  it("puts the real fixture log into ascending seq order", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../../../fixtures/seeded-runs/fixture-badsite.json", import.meta.url),
        "utf8",
      ),
    ) as { events: Array<Record<string, unknown>> };

    const seqs = orderEvents(fixture.events).map((e) => e["seq"] as number);

    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});
