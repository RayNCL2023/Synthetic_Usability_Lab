import { describe, expect, it } from "vitest";
import { findReference, groupEvidenceByPersona } from "./evidence";
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

/**
 * A reference view is context, never evidence. It exists because the
 * screen-reader persona's findings are real and unillustrated — it navigates
 * by the accessibility tree and never receives an image — so a reader has
 * nothing to look at while reading a genuine blocker.
 *
 * The rules are therefore strict: only when the witness has no plate of its
 * own, only for the exact page the finding is on, and never carrying pins.
 */
describe("findReference", () => {
  const refs = [
    { url: "https://news.ycombinator.com/newsguidelines.html", capturedAt: "2026-09-18", screenshotUrl: "data:image/jpeg;base64,AAAA" },
    { url: "https://news.ycombinator.com/newsfaq.html", capturedAt: "2026-09-18", screenshotUrl: "data:image/jpeg;base64,BBBB" },
  ];

  it("finds the reference for the page the finding is on", () => {
    const witness = {
      personaKey: "screen_reader",
      step: step({ id: "sr2", personaKey: "screen_reader", screenshotUrl: null, url: "https://news.ycombinator.com/newsguidelines.html" }),
      pins: [],
      observations: [obs({ personaKey: "screen_reader", stepId: "sr2" })],
    };

    expect(findReference(witness, refs)?.screenshotUrl).toBe("data:image/jpeg;base64,AAAA");
  });

  it("offers nothing when the witness already has its own plate", () => {
    const witness = {
      personaKey: "impatient_mobile",
      step: step({ id: "m0", screenshotUrl: "https://minio/real.jpg", url: "https://news.ycombinator.com/newsguidelines.html" }),
      pins: [],
      observations: [obs()],
    };

    expect(findReference(witness, refs)).toBeNull();
  });

  it("never substitutes a screenshot of a different page", () => {
    const witness = {
      personaKey: "screen_reader",
      step: step({ id: "sr9", personaKey: "screen_reader", screenshotUrl: null, url: "https://news.ycombinator.com/" }),
      pins: [],
      observations: [obs()],
    };

    expect(findReference(witness, refs)).toBeNull();
  });

  it("offers nothing when there is no step and so no page to reference", () => {
    const witness = { personaKey: "screen_reader", step: null, pins: [], observations: [obs()] };

    expect(findReference(witness, refs)).toBeNull();
  });

  it("offers nothing when the run carries no references at all", () => {
    const witness = {
      personaKey: "screen_reader",
      step: step({ id: "sr2", screenshotUrl: null, url: "https://news.ycombinator.com/newsguidelines.html" }),
      pins: [],
      observations: [obs()],
    };

    expect(findReference(witness, undefined)).toBeNull();
  });
});
