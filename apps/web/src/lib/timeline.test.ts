import { describe, expect, it } from "vitest";
import { buildTimeline } from "./timeline";
import type { DisplayStep } from "./steps";

/**
 * The readable record of a run.
 *
 * A persona's reasoning was only ever visible in the lane cards, which show the
 * newest two entries clamped to two lines each — so most of what the personas
 * actually said could not be read at all. The timeline is where the full text
 * lives, with the frame it belongs to and the findings it produced.
 */

const step = (over: Partial<DisplayStep> = {}): DisplayStep => ({
  id: "m0",
  personaKey: "impatient_mobile",
  index: 0,
  url: "https://example.com/",
  screenshotUrl: "https://minio/a.jpg",
  narration: "",
  ...over,
});

const stepEvent = (over: Record<string, unknown> = {}) => ({
  type: "persona.step",
  personaKey: "impatient_mobile",
  stepIndex: 0,
  ts: 1_000,
  narration: "",
  ...over,
});

describe("buildTimeline", () => {
  it("builds one row per revealed step, in the order they arrived", () => {
    const rows = buildTimeline(
      [step({ id: "m0", index: 0 }), step({ id: "m1", index: 1 })],
      [
        stepEvent({ stepIndex: 0, ts: 1_000 }),
        stepEvent({ stepIndex: 1, ts: 4_000 }),
      ],
    );

    expect(rows.map((r) => r.kind)).toEqual(["step", "step"]);
    expect(rows.map((r) => r.step?.id)).toEqual(["m0", "m1"]);
  });

  it("times each row from the start of the run", () => {
    const rows = buildTimeline(
      [step({ id: "m0", index: 0 }), step({ id: "m1", index: 1 })],
      [
        stepEvent({ stepIndex: 0, ts: 10_000 }),
        stepEvent({ stepIndex: 1, ts: 22_500 }),
      ],
    );

    expect(rows[0]?.atMs).toBe(0);
    expect(rows[1]?.atMs).toBe(12_500);
  });

  it("keeps the whole thought rather than a clamped preview", () => {
    const thought =
      "I tapped what looked like the navigation but nothing happened, so I scrolled down to see whether the menu had moved below the fold.";

    const rows = buildTimeline([step()], [stepEvent({ narration: thought })]);

    expect(rows[0]?.narration).toBe(thought);
  });

  it("attaches a finding to the step that produced it", () => {
    const rows = buildTimeline(
      [step({ id: "m0", index: 0 })],
      [
        stepEvent({ stepIndex: 0 }),
        {
          type: "persona.observation",
          personaKey: "impatient_mobile",
          stepIndex: 0,
          ts: 1_200,
          severity: "major",
          description: "Navigation is unlabelled",
          quote: "the icons mean nothing",
        },
      ],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.findings).toHaveLength(1);
    expect(rows[0]?.findings[0]?.severity).toBe("major");
  });

  it("does not attach one persona's finding to another's step", () => {
    const rows = buildTimeline(
      [step({ id: "m0", personaKey: "impatient_mobile", index: 0 })],
      [
        stepEvent({ personaKey: "impatient_mobile", stepIndex: 0 }),
        {
          type: "persona.observation",
          personaKey: "procurement",
          stepIndex: 0,
          ts: 1_200,
          severity: "major",
          description: "different persona",
          quote: "q",
        },
      ],
    );

    expect(rows[0]?.findings).toHaveLength(0);
  });

  it("carries the frame from the merged step list", () => {
    const rows = buildTimeline(
      [step({ id: "m0", screenshotUrl: "https://minio/real.jpg" })],
      [stepEvent()],
    );

    expect(rows[0]?.step?.screenshotUrl).toBe("https://minio/real.jpg");
  });

  it("closes a persona's thread with how it ended", () => {
    const rows = buildTimeline(
      [step()],
      [
        stepEvent({ ts: 1_000 }),
        {
          type: "persona.finished",
          personaKey: "impatient_mobile",
          outcome: "goal_achieved",
          ts: 9_000,
        },
      ],
    );

    expect(rows).toHaveLength(2);
    expect(rows[1]?.kind).toBe("outcome");
    expect(rows[1]?.outcome).toBe("goal_achieved");
    expect(rows[1]?.atMs).toBe(8_000);
  });

  it("ignores an observation for a step that has not been revealed", () => {
    const rows = buildTimeline(
      [],
      [
        {
          type: "persona.observation",
          personaKey: "impatient_mobile",
          stepIndex: 3,
          ts: 1_000,
          severity: "minor",
          description: "orphan",
          quote: "q",
        },
      ],
    );

    expect(rows).toEqual([]);
  });

  it("interleaves the personas so the run reads chronologically", () => {
    const rows = buildTimeline(
      [
        step({ id: "m0", personaKey: "impatient_mobile", index: 0 }),
        step({ id: "p0", personaKey: "procurement", index: 0 }),
      ],
      [
        stepEvent({ personaKey: "impatient_mobile", stepIndex: 0, ts: 1_000 }),
        stepEvent({ personaKey: "procurement", stepIndex: 0, ts: 2_000 }),
      ],
    );

    expect(rows.map((r) => r.personaKey)).toEqual([
      "impatient_mobile",
      "procurement",
    ]);
  });

  it("has nothing to show for an empty log", () => {
    expect(buildTimeline([], [])).toEqual([]);
  });
});
