import { describe, expect, it } from "vitest";
import { groupEvidenceByPersona } from "./evidence";
import type { RunPayload } from "./api";

type Issue = RunPayload["issues"][number];
type Observation = Issue["observations"][number];
type Step = RunPayload["steps"][number];

/**
 * Cross-persona agreement is the strongest signal this product produces, and
 * the report collapsed it to whichever persona happened to be first: one plate,
 * with every persona's pins drawn on it. Those pins were measured in different
 * viewports on different pages, so they landed nowhere in particular.
 */

function step(over: Partial<Step> = {}): Step {
  return {
    id: "step-1",
    personaKey: "impatient_mobile",
    index: 0,
    url: "https://example.com/",
    screenshotUrl: "https://minio/shot.jpg",
    narration: "",
    action: null,
    ...over,
  };
}

function obs(over: Partial<Observation> = {}): Observation {
  return {
    id: "obs-1",
    severity: "major",
    category: "navigation",
    quote: "I cannot find the price",
    elementRef: "s1e1",
    elementDescription: 'link "Pricing"',
    box: { x: 10, y: 20, w: 30, h: 40 },
    personaKey: "impatient_mobile",
    stepId: "step-1",
    ...over,
  };
}

function index(steps: Step[]): Map<string, Step> {
  return new Map(steps.map((s) => [s.id, s]));
}

describe("groupEvidenceByPersona", () => {
  it("groups the observations by the persona that made them", () => {
    const steps = index([
      step({ id: "m0", personaKey: "impatient_mobile" }),
      step({ id: "p0", personaKey: "procurement" }),
    ]);

    const groups = groupEvidenceByPersona(
      [
        obs({ id: "a", personaKey: "impatient_mobile", stepId: "m0" }),
        obs({ id: "b", personaKey: "procurement", stepId: "p0" }),
        obs({ id: "c", personaKey: "impatient_mobile", stepId: "m0" }),
      ],
      steps,
    );

    expect(groups.map((g) => g.personaKey)).toEqual([
      "impatient_mobile",
      "procurement",
    ]);
    expect(groups[0]?.observations).toHaveLength(2);
    expect(groups[1]?.observations).toHaveLength(1);
  });

  it("pins only the observations measured on the plate being shown", () => {
    const steps = index([
      step({ id: "p0", personaKey: "procurement", index: 0 }),
      step({ id: "p5", personaKey: "procurement", index: 5 }),
    ]);

    const groups = groupEvidenceByPersona(
      [
        obs({ id: "a", personaKey: "procurement", stepId: "p0" }),
        obs({ id: "b", personaKey: "procurement", stepId: "p5" }),
      ],
      steps,
    );

    expect(groups[0]?.step?.id).toBe("p0");
    expect(groups[0]?.pins.map((o) => o.id)).toEqual(["a"]);
    // The quote from the later step survives even though it cannot be pinned.
    expect(groups[0]?.observations).toHaveLength(2);
  });

  it("never pins one persona's observation onto another persona's screenshot", () => {
    const steps = index([
      step({ id: "m0", personaKey: "impatient_mobile" }),
      step({ id: "p0", personaKey: "procurement" }),
    ]);

    const groups = groupEvidenceByPersona(
      [
        obs({ id: "a", personaKey: "impatient_mobile", stepId: "m0" }),
        obs({ id: "b", personaKey: "procurement", stepId: "p0" }),
      ],
      steps,
    );

    for (const group of groups) {
      for (const pin of group.pins) {
        expect(pin.personaKey).toBe(group.personaKey);
        expect(pin.stepId).toBe(group.step?.id);
      }
    }
  });

  it("prefers a step that actually has a screenshot to pin onto", () => {
    const steps = index([
      step({ id: "p0", personaKey: "procurement", screenshotUrl: null }),
      step({ id: "p1", personaKey: "procurement", screenshotUrl: "https://minio/p1.jpg" }),
    ]);

    const groups = groupEvidenceByPersona(
      [
        obs({ id: "a", personaKey: "procurement", stepId: "p0" }),
        obs({ id: "b", personaKey: "procurement", stepId: "p1" }),
      ],
      steps,
    );

    expect(groups[0]?.step?.id).toBe("p1");
    expect(groups[0]?.pins.map((o) => o.id)).toEqual(["b"]);
  });

  it("still reports the screen-reader persona, which has no screenshot at all", () => {
    const steps = index([
      step({ id: "sr4", personaKey: "screen_reader", screenshotUrl: null }),
    ]);

    const groups = groupEvidenceByPersona(
      [obs({ id: "a", personaKey: "screen_reader", stepId: "sr4" })],
      steps,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.step?.id).toBe("sr4");
    expect(groups[0]?.observations).toHaveLength(1);
  });

  it("pins nothing on a persona with no plate to pin onto", () => {
    const steps = index([
      step({ id: "sr4", personaKey: "screen_reader", screenshotUrl: null }),
    ]);

    // The observation has a box — the snapshot knows where the element is —
    // but there is no image to mark, so citing a pin number would point the
    // reader at a mark that is never drawn.
    const groups = groupEvidenceByPersona(
      [obs({ id: "a", personaKey: "screen_reader", stepId: "sr4" })],
      steps,
    );

    expect(groups[0]?.pins).toEqual([]);
    expect(groups[0]?.observations).toHaveLength(1);
  });

  it("drops boxless observations from the pins but keeps their quotes", () => {
    const steps = index([step({ id: "m0" })]);

    const groups = groupEvidenceByPersona(
      [
        obs({ id: "a", stepId: "m0", box: null }),
        obs({ id: "b", stepId: "m0" }),
      ],
      steps,
    );

    expect(groups[0]?.pins.map((o) => o.id)).toEqual(["b"]);
    expect(groups[0]?.observations).toHaveLength(2);
  });

  it("survives an observation whose step is missing from the payload", () => {
    const groups = groupEvidenceByPersona(
      [obs({ id: "a", stepId: "not-in-payload" })],
      index([]),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.step).toBeNull();
    expect(groups[0]?.pins).toEqual([]);
    expect(groups[0]?.observations).toHaveLength(1);
  });

  it("returns nothing for an issue with no observations", () => {
    expect(groupEvidenceByPersona([], index([]))).toEqual([]);
  });
});
