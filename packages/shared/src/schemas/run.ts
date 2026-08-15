import { z } from "zod/v4";
import { CATEGORIES, SEVERITIES } from "./action.js";
import { BoxSchema } from "./snapshot.js";

export const RUN_STATUSES = [
  "queued",
  "preflight",
  "running",
  "clustering",
  "finished",
  "failed",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const PERSONA_RUN_STATUSES = [
  "queued",
  "running",
  "finished",
  "failed",
] as const;
export type PersonaRunStatus = (typeof PERSONA_RUN_STATUSES)[number];

/** How a persona's journey ended. `blocked` is a first-class outcome, not an error. */
export const PERSONA_OUTCOMES = [
  "goal_achieved",
  "gave_up",
  "blocked",
  "capped",
  "error",
] as const;
export type PersonaOutcome = (typeof PERSONA_OUTCOMES)[number];

export const ABORT_REASONS = [
  "step_cap",
  "model_call_cap",
  "wall_clock",
  "cost_cap",
  "preflight_failed",
  "internal_error",
] as const;
export type AbortReason = (typeof ABORT_REASONS)[number];

export const ModelConfigSchema = z.object({
  loopModel: z.string(),
  loopEffort: z.string(),
  clusterModel: z.string(),
  clusterEffort: z.string(),
  cacheTtl: z.string(),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const RunSchema = z.object({
  id: z.string(),
  url: z.string(),
  goal: z.string(),
  status: z.enum(RUN_STATUSES),
  createdAt: z.date(),
  finishedAt: z.date().nullable(),
  totalCostCents: z.number(),
  totalTokens: z.number(),
  abortReason: z.enum(ABORT_REASONS).nullable(),
  /** Which models produced this run — makes the eval matrix sweep analysable. */
  modelConfig: ModelConfigSchema.nullable(),
});
export type Run = z.infer<typeof RunSchema>;

export const PersonaRunSchema = z.object({
  id: z.string(),
  runId: z.string(),
  personaKey: z.string(),
  status: z.enum(PERSONA_RUN_STATUSES),
  currentActionLabel: z.string().nullable(),
  stepCount: z.number(),
  outcome: z.enum(PERSONA_OUTCOMES).nullable(),
  /** Set when outcome is `blocked` — "we couldn't get past X". */
  blockedReason: z.string().nullable(),
});
export type PersonaRun = z.infer<typeof PersonaRunSchema>;

export const StepSchema = z.object({
  id: z.string(),
  personaRunId: z.string(),
  index: z.number(),
  url: z.string(),
  screenshotKey: z.string().nullable(),
  snapshotJson: z.unknown(),
  actionJson: z.unknown(),
  narration: z.string(),
  reasoning: z.string(),
  latencyMs: z.number(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  /** Cache tokens are priced differently from base input — see pricing.ts. */
  cacheWriteTokens: z.number(),
  cacheReadTokens: z.number(),
  /**
   * Persisted because `max_tokens` (truncation) and a bad ref (hallucination)
   * need opposite responses, and conflating them is the most likely source of a
   * runaway retry loop.
   */
  stopReason: z.string().nullable(),
  modelId: z.string(),
});
export type Step = z.infer<typeof StepSchema>;

export const ObservationRecordSchema = z.object({
  id: z.string(),
  stepId: z.string(),
  personaRunId: z.string(),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  elementRef: z.string(),
  elementDescription: z.string(),
  quote: z.string(),
  viewportBox: BoxSchema.nullable(),
});
export type ObservationRecord = z.infer<typeof ObservationRecordSchema>;

export const IssueSchema = z.object({
  id: z.string(),
  runId: z.string(),
  title: z.string(),
  description: z.string(),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  rank: z.number(),
  recommendation: z.string(),
});
export type Issue = z.infer<typeof IssueSchema>;
