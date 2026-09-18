import { describe, expect, it } from "vitest";
import { eventDwellMs } from "./replay";

/**
 * Replay used to advance on a fixed interval per event, which sounds fair and
 * is not: roughly two thirds of every recorded log is `persona.status`, so two
 * thirds of each demo was spent watching a one-line label change while the
 * screenshots and findings — the things worth showing a recruiter — flicked
 * past in the same 300ms.
 */

const ev = (over: Record<string, unknown> = {}) => ({
  type: "persona.status",
  personaKey: "impatient_mobile",
  ...over,
});

describe("eventDwellMs", () => {
  it("passes over a status tick faster than anything with content", () => {
    const status = eventDwellMs(ev({ type: "persona.status" }), 1);
    const step = eventDwellMs(
      ev({ type: "persona.step", screenshotUrl: "https://minio/a.jpg" }),
      1,
    );
    const finding = eventDwellMs(ev({ type: "persona.observation" }), 1);

    expect(status).toBeLessThan(step);
    expect(status).toBeLessThan(finding);
  });

  it("holds a step that brings a new screenshot longer than one without", () => {
    const withShot = eventDwellMs(
      ev({ type: "persona.step", screenshotUrl: "https://minio/a.jpg" }),
      1,
    );
    const withoutShot = eventDwellMs(
      ev({ type: "persona.step", screenshotUrl: null }),
      1,
    );

    expect(withShot).toBeGreaterThan(withoutShot);
    // A screenshot-less step is still a narration beat, not a status tick.
    expect(withoutShot).toBeGreaterThan(eventDwellMs(ev(), 1));
  });

  it("gives a finding real screen time so the pin drop is readable", () => {
    expect(eventDwellMs(ev({ type: "persona.observation" }), 1)).toBeGreaterThanOrEqual(
      1500,
    );
  });

  it("holds a lane transition when a persona finishes", () => {
    const finished = eventDwellMs(ev({ type: "persona.finished" }), 1);

    expect(finished).toBeGreaterThan(eventDwellMs(ev(), 1));
  });

  it("scales with the replay speed", () => {
    const one = eventDwellMs(ev({ type: "persona.observation" }), 1);
    const three = eventDwellMs(ev({ type: "persona.observation" }), 3);

    expect(three).toBeCloseTo(one / 3, 0);
  });

  it("gives a short lead-in before the first event", () => {
    const lead = eventDwellMs(null, 1);

    expect(lead).toBeGreaterThan(0);
    expect(lead).toBeLessThan(eventDwellMs(ev({ type: "persona.observation" }), 1));
  });

  it("never stalls or runs backwards on an unknown event type", () => {
    const unknown = eventDwellMs(ev({ type: "something.new" }), 3);

    expect(unknown).toBeGreaterThan(0);
    expect(Number.isFinite(unknown)).toBe(true);
  });

  it("stays watchable even at an absurd speed", () => {
    // A frame that renders and vanishes inside one repaint reads as a glitch.
    expect(eventDwellMs(ev({ type: "persona.step" }), 1000)).toBeGreaterThanOrEqual(16);
  });
});
