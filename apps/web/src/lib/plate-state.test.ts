import { describe, expect, it } from "vitest";
import { plateEmptyState } from "./plate-state";

/**
 * An empty plate is allowed to say exactly one true thing, and which thing is
 * true depends entirely on who was walking. Collapsing the cases is how a
 * plumbing failure spent a build disguised as a design decision.
 */

describe("plateEmptyState", () => {
  it("says the screen-reader persona has no screenshot by design", () => {
    const state = plateEmptyState({
      personaKey: "screen_reader",
      runFinished: true,
    });

    expect(state.kind).toBe("by_design");
    expect(state.detail).toMatch(/accessibility tree/i);
  });

  it("does not claim a sighted persona navigates by the accessibility tree", () => {
    const state = plateEmptyState({
      personaKey: "impatient_mobile",
      runFinished: true,
    });

    expect(state.kind).not.toBe("by_design");
    expect(state.detail).not.toMatch(/accessibility tree/i);
  });

  it("says a sighted persona's screenshot is still in flight mid-run", () => {
    const state = plateEmptyState({
      personaKey: "impatient_mobile",
      runFinished: false,
    });

    expect(state.kind).toBe("pending");
  });

  it("reports a genuinely missing screenshot once the run is over", () => {
    const state = plateEmptyState({
      personaKey: "procurement",
      runFinished: true,
    });

    expect(state.kind).toBe("missing");
  });

  it("waits for the first step before there is any persona to describe", () => {
    const state = plateEmptyState({ personaKey: null, runFinished: false });

    expect(state.kind).toBe("waiting");
  });

  it("treats an unknown persona as sighted rather than inventing a disability", () => {
    const state = plateEmptyState({ personaKey: "some_new_persona", runFinished: true });

    expect(state.kind).toBe("missing");
  });

  it("always provides a title and a detail to render", () => {
    for (const personaKey of [null, "screen_reader", "impatient_mobile"]) {
      for (const runFinished of [true, false]) {
        const state = plateEmptyState({ personaKey, runFinished });
        expect(state.title.length).toBeGreaterThan(0);
        expect(state.detail.length).toBeGreaterThan(0);
      }
    }
  });
});
