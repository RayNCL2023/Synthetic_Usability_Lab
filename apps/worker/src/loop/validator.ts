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
  /** Well-formed responses that referenced elements not on the page. */
  rejectedDecisions: number;
  /**
   * Responses that failed to parse against the schema at all — a bad enum
   * value, a missing field, malformed JSON.
   *
   * Tracked separately from grounding because the two say different things
   * about a provider. A high grounding rate means the model is hallucinating
   * page structure; a high schema rate means the provider's structured-output
   * constraint is not holding. Averaging them into one number would hide
   * whichever is actually broken — and the two providers differ here by
   * construction (Gemini keeps enums as a real constraint, Anthropic demotes
   * them to prose), so this is the metric that makes them comparable.
   */
  schemaRejections: number;
  droppedObservations: number;
  totalObservations: number;
}

export function emptyGroundingStats(): GroundingStats {
  return {
    decisions: 0,
    rejectedDecisions: 0,
    schemaRejections: 0,
    droppedObservations: 0,
    totalObservations: 0,
  };
}

/** Share of decisions that referenced elements not present in the snapshot. */
export function groundingRejectionRate(s: GroundingStats): number {
  return s.decisions === 0 ? 0 : s.rejectedDecisions / s.decisions;
}

/** Share of decisions the provider returned in a shape we could not parse. */
export function schemaRejectionRate(s: GroundingStats): number {
  return s.decisions === 0 ? 0 : s.schemaRejections / s.decisions;
}
