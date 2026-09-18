/**
 * How a persona's journey ended, in words.
 *
 * Kept in one place because three surfaces state it — the lane, the plate and
 * the timeline — and they must not drift into three different vocabularies for
 * the same result.
 */

export function outcomeWord(outcome: string | null): string | null {
  switch (outcome) {
    case "goal_achieved":
      return "reached the goal";
    case "blocked":
      return "blocked by the site";
    case "capped":
      return "hit the step limit";
    case "error":
      return "stopped on an error";
    case "gave_up":
      return "gave up";
    default:
      return outcome ? "finished" : null;
  }
}

export function reachedGoal(outcome: string | null): boolean {
  return outcome === "goal_achieved";
}

/**
 * The run-level result, stated once the last persona has stopped.
 *
 * Two of the four recorded demos end with every persona reaching the goal, and
 * both used to finish on an empty plate because the final step in chronological
 * order belonged to the persona that never has a screenshot. Success was the
 * one thing the view would not say.
 */
export function runOutcomeSummary(
  personaRuns: Array<{ outcome: string | null }>,
): string | null {
  if (personaRuns.length === 0) return null;
  // While anyone is still working, there is no result to report yet.
  if (personaRuns.some((p) => p.outcome === null)) return null;

  const total = personaRuns.length;
  const won = personaRuns.filter((p) => reachedGoal(p.outcome)).length;

  if (won === 0) return "No persona reached the goal";
  if (won === total) return `All ${total} personas reached the goal`;
  return `${won} of ${total} personas reached the goal`;
}
