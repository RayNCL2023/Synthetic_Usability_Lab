import { z } from "zod/v4";

/**
 * The model's per-step decision.
 *
 * This schema is the single definition consumed by three things: the Anthropic
 * request (via zodOutputFormat), the grounding validator, and the TS types the
 * worker uses. Changing it here changes all three.
 *
 * Deliberately FLAT. Structured outputs reject recursive schemas and numeric
 * constraints (`minimum`, `maxLength`, ...), and a discriminated union over
 * action types produces a nested anyOf whose validation errors are hard to turn
 * into a useful retry prompt. So the wire shape keeps `type` plus optional
 * fields, and the conditional requirements ("click needs a ref") are enforced
 * by `checkActionShape` below — which produces plain-English problems we can
 * feed straight back to the model on a retry.
 */

export const ACTION_TYPES = [
  "click",
  "type",
  "scroll",
  "go_back",
  "wait",
  "finish",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const SEVERITIES = ["blocker", "major", "minor", "nitpick"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  "navigation",
  "clarity",
  "trust",
  "accessibility",
  "performance",
  "forms",
  "content",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const OUTCOMES = ["goal_achieved", "gave_up"] as const;
export type FinishOutcome = (typeof OUTCOMES)[number];

export const ObservationSchema = z.object({
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  /** Must be present in the CURRENT step's snapshot. Enforced by the validator. */
  ref: z.string(),
  /** The persona's own words about this element. */
  quote: z.string(),
  /** What is wrong, in neutral language. */
  description: z.string(),
});
export type ModelObservation = z.infer<typeof ObservationSchema>;

export const ActionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  /** Required for click and type. */
  ref: z.string().nullable(),
  /** Required for type. */
  text: z.string().nullable(),
  /** Required for scroll. */
  direction: z.enum(["down", "up"]).nullable(),
  /** Required for finish. */
  outcome: z.enum(OUTCOMES).nullable(),
});
export type ModelAction = z.infer<typeof ActionSchema>;

export const DecisionSchema = z.object({
  /** First person, in persona voice, one or two sentences. Shown to the user. */
  narration: z.string(),
  /** Why this action. Not shown by default. */
  reasoning: z.string(),
  action: ActionSchema,
  /**
   * Optional and expected to be empty on a frictionless step. Never incentivise
   * inventing problems — a persona that manufactures findings is worse than one
   * that misses some.
   */
  observations: z.array(ObservationSchema),
});
export type Decision = z.infer<typeof DecisionSchema>;

/**
 * Conditional-requirement check that the flat wire schema cannot express.
 * Returns human-readable problems suitable for a retry prompt; empty means OK.
 */
export function checkActionShape(action: ModelAction): string[] {
  const problems: string[] = [];
  switch (action.type) {
    case "click":
      if (!action.ref) problems.push('action.type "click" requires "ref".');
      break;
    case "type":
      if (!action.ref) problems.push('action.type "type" requires "ref".');
      if (action.text === null || action.text === "")
        problems.push('action.type "type" requires non-empty "text".');
      break;
    case "scroll":
      if (!action.direction)
        problems.push('action.type "scroll" requires "direction" of "up" or "down".');
      break;
    case "finish":
      if (!action.outcome)
        problems.push(
          'action.type "finish" requires "outcome" of "goal_achieved" or "gave_up".',
        );
      break;
    case "go_back":
    case "wait":
      break;
  }
  return problems;
}

/** Actions that reference an element and therefore need a grounded ref. */
export function actionRequiresRef(type: ActionType): boolean {
  return type === "click" || type === "type";
}
