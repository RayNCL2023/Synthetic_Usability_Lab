import type { Decision, Snapshot } from "@sul/shared";
import { actionRequiresRef, checkActionShape, snapshotRefs } from "@sul/shared";

/**
 * Grounding validation.
 *
 * Enforced in code, never on trust. The prompt asks the model to stay grounded;
 * this decides whether it did. Every rejection increments the run's
 * grounding_rejection_rate, which is a headline eval metric precisely because
 * it measures the thing the product's credibility rests on.
 */

export interface ValidationResult {
  ok: boolean;
  /** Plain-English problems, suitable for feeding straight back to the model. */
  problems: string[];
  /**
   * Observations whose refs were valid. Ungrounded observations are DROPPED
   * rather than failing the whole step: a step can produce a good action and
   * one bad citation, and throwing away the action too would waste a step and
   * a model call for no gain.
   */
  keptObservations: Decision["observations"];
  droppedObservations: number;
}

export function validateDecision(
  decision: Decision,
  snapshot: Snapshot,
): ValidationResult {
  const problems: string[] = [];
  const known = snapshotRefs(snapshot);

  // 1. Conditional shape requirements the flat wire schema cannot express.
  problems.push(...checkActionShape(decision.action));

  // 2. The action's ref must be in THIS step's snapshot.
  if (actionRequiresRef(decision.action.type)) {
    const ref = decision.action.ref;
    if (ref && !known.has(ref)) {
      problems.push(
        `action.ref "${ref}" is not in the current snapshot. ` +
          `Refs from earlier steps are never valid — use a ref from the snapshot above.`,
      );
    }
  }

  // 3. Observation refs are checked independently, and bad ones are dropped
  //    rather than failing the step.
  const kept: Decision["observations"] = [];
  let dropped = 0;
  for (const obs of decision.observations) {
    if (known.has(obs.ref)) kept.push(obs);
    else dropped++;
  }

  return {
    ok: problems.length === 0,
    problems,
    keptObservations: kept,
    droppedObservations: dropped,
  };
}

/** The retry prompt sent after a first failure. */
export function buildRetryMessage(problems: string[]): string {
  return [
    "Your previous response could not be used:",
    ...problems.map((p) => `  - ${p}`),
    "",
    "Respond again using only refs that appear in the snapshot for this step.",
  ].join("\n");
}

export interface GroundingStats {
  decisions: number;
  rejectedDecisions: number;
  droppedObservations: number;
  totalObservations: number;
}

export function emptyGroundingStats(): GroundingStats {
  return {
    decisions: 0,
    rejectedDecisions: 0,
    droppedObservations: 0,
    totalObservations: 0,
  };
}

/** The headline metric: share of decisions that failed grounding validation. */
export function groundingRejectionRate(s: GroundingStats): number {
  return s.decisions === 0 ? 0 : s.rejectedDecisions / s.decisions;
}
