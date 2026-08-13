import { z } from "zod";
import { CATEGORIES, SEVERITIES } from "./action.js";
import { BoxSchema } from "./snapshot.js";
import { ABORT_REASONS, PERSONA_OUTCOMES } from "./run.js";

/**
 * The live event contract, emitted over WebSocket at /ws/runs/:id and persisted
 * to `run_events`.
 *
 * Ordering rules that the rest of the system depends on:
 *
 *  1. `seq` comes from a SINGLE authority (a per-run Postgres sequence), never
 *     from a per-worker counter — three persona workers emit concurrently and
 *     any local counter makes ordering ambiguous.
 *  2. The DB commit ALWAYS precedes the Redis publish. A subscriber must never
 *     observe an event that a page refresh would lose.
 *  3. Clients dedupe by `seq` across the replay -> subscribe handover, because
 *     the window between "replay finished" and "subscription live" can
 *     legitimately deliver the same event twice.
 *
 * This log is also the single source of truth for /demo/[slug] replay, which is
 * why the demo route cannot drift from the live view: same events, same
 * renderer.
 */

const base = {
  runId: z.string(),
  personaKey: z.string().nullable(),
  seq: z.number(),
  ts: z.number(),
};

export const RunStartedEvent = z.object({
  ...base,
  type: z.literal("run.started"),
  url: z.string(),
  goal: z.string(),
  personaKeys: z.array(z.string()),
});

export const PersonaStatusEvent = z.object({
  ...base,
  type: z.literal("persona.status"),
  personaKey: z.string(),
  /** Short human label: "scrolling...", "confused by nav". */
  label: z.string(),
});

export const PersonaStepEvent = z.object({
  ...base,
  type: z.literal("persona.step"),
  personaKey: z.string(),
  stepIndex: z.number(),
  url: z.string(),
  /** Presigned; null for the screen-reader persona, which never gets one. */
  screenshotUrl: z.string().nullable(),
  narration: z.string(),
  actionType: z.string(),
  actionRef: z.string().nullable(),
  /** Bounding box of the acted-on element, for the animated cursor tween. */
  actionBox: BoxSchema.nullable(),
});

export const PersonaObservationEvent = z.object({
  ...base,
  type: z.literal("persona.observation"),
  personaKey: z.string(),
  stepIndex: z.number(),
  observationId: z.string(),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  quote: z.string(),
  description: z.string(),
  elementRef: z.string(),
  box: BoxSchema.nullable(),
});

export const PersonaFinishedEvent = z.object({
  ...base,
  type: z.literal("persona.finished"),
  personaKey: z.string(),
  outcome: z.enum(PERSONA_OUTCOMES),
  stepCount: z.number(),
  blockedReason: z.string().nullable(),
});

export const RunIssuesEvent = z.object({
  ...base,
  type: z.literal("run.issues"),
  issues: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      severity: z.enum(SEVERITIES),
      category: z.enum(CATEGORIES),
      rank: z.number(),
      recommendation: z.string(),
      personaKeys: z.array(z.string()),
      observationIds: z.array(z.string()),
    }),
  ),
});

export const RunFinishedEvent = z.object({
  ...base,
  type: z.literal("run.finished"),
  totalCostCents: z.number(),
  totalTokens: z.number(),
  abortReason: z.enum(ABORT_REASONS).nullable(),
  issueCount: z.number(),
});

export const RunErrorEvent = z.object({
  ...base,
  type: z.literal("run.error"),
  message: z.string(),
  fatal: z.boolean(),
});

export const RunEventSchema = z.discriminatedUnion("type", [
  RunStartedEvent,
  PersonaStatusEvent,
  PersonaStepEvent,
  PersonaObservationEvent,
  PersonaFinishedEvent,
  RunIssuesEvent,
  RunFinishedEvent,
  RunErrorEvent,
]);

export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventType = RunEvent["type"];

/** Payload minus the envelope fields the emitter assigns. */
export type RunEventInput =
  | Omit<z.infer<typeof RunStartedEvent>, "seq" | "ts" | "runId">
  | Omit<z.infer<typeof PersonaStatusEvent>, "seq" | "ts" | "runId">
  | Omit<z.infer<typeof PersonaStepEvent>, "seq" | "ts" | "runId">
  | Omit<z.infer<typeof PersonaObservationEvent>, "seq" | "ts" | "runId">
  | Omit<z.infer<typeof PersonaFinishedEvent>, "seq" | "ts" | "runId">
  | Omit<z.infer<typeof RunIssuesEvent>, "seq" | "ts" | "runId">
  | Omit<z.infer<typeof RunFinishedEvent>, "seq" | "ts" | "runId">
  | Omit<z.infer<typeof RunErrorEvent>, "seq" | "ts" | "runId">;

export function redisChannelForRun(runId: string): string {
  return `run:${runId}`;
}
