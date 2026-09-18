import { describe, expect, it } from "vitest";
import { outcomeWord, reachedGoal, runOutcomeSummary } from "./outcome";

/**
 * A run that succeeds should say so.
 *
 * Two of the four recorded demos end with all three personas reaching the goal,
 * and both used to finish on a blank "No screenshot" card — because the last
 * step in chronological order happened to belong to the persona that never has
 * one. The strongest result the product produces was invisible.
 */

describe("outcomeWord", () => {
  it("states plainly that the goal was reached", () => {
    expect(outcomeWord("goal_achieved")).toBe("reached the goal");
  });

  it("distinguishes the ways a persona can stop short", () => {
    const words = new Set([
      outcomeWord("blocked"),
      outcomeWord("capped"),
      outcomeWord("error"),
      outcomeWord("gave_up"),
    ]);

    expect(words.size).toBe(4);
  });

  it("says nothing about a persona that is still going", () => {
    expect(outcomeWord(null)).toBeNull();
  });
});

describe("reachedGoal", () => {
  it("is true only for the goal outcome", () => {
    expect(reachedGoal("goal_achieved")).toBe(true);
    expect(reachedGoal("gave_up")).toBe(false);
    expect(reachedGoal(null)).toBe(false);
  });
});

describe("runOutcomeSummary", () => {
  it("celebrates a clean sweep", () => {
    const summary = runOutcomeSummary([
      { outcome: "goal_achieved" },
      { outcome: "goal_achieved" },
      { outcome: "goal_achieved" },
    ]);

    expect(summary).toBe("All 3 personas reached the goal");
  });

  it("counts a partial success honestly", () => {
    const summary = runOutcomeSummary([
      { outcome: "goal_achieved" },
      { outcome: "gave_up" },
      { outcome: "gave_up" },
    ]);

    expect(summary).toBe("1 of 3 personas reached the goal");
  });

  it("does not dress up a run where nobody got there", () => {
    const summary = runOutcomeSummary([
      { outcome: "gave_up" },
      { outcome: "capped" },
      { outcome: "blocked" },
    ]);

    expect(summary).toBe("No persona reached the goal");
  });

  it("says nothing while any persona is still working", () => {
    expect(
      runOutcomeSummary([{ outcome: "goal_achieved" }, { outcome: null }]),
    ).toBeNull();
  });

  it("says nothing for a run with no personas at all", () => {
    expect(runOutcomeSummary([])).toBeNull();
  });
});
