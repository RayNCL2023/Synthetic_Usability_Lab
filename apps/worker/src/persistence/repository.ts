import { eq, sql } from "drizzle-orm";
import type { Database } from "@sul/shared/db";
import {
  observations,
  personaRuns,
  runEvents,
  runSeqCounters,
  runs,
  steps,
} from "@sul/shared/db";
import type {
  AbortReason,
  ModelConfig,
  PersonaOutcome,
  RunEvent,
  RunEventInput,
} from "@sul/shared";
import type { StepRecord } from "../loop/agent.js";

/**
 * All database access for a run.
 *
 * The event-sequencing rules live here because they are easy to get subtly
 * wrong elsewhere: `seq` comes from a single per-run counter (three persona
 * workers emit concurrently, so any local counter makes ordering ambiguous),
 * and the DB commit always precedes the Redis publish so a subscriber can never
 * observe an event that a page refresh would lose.
 */

export async function createRun(
  db: Database,
  input: { url: string; goal: string; modelConfig: ModelConfig; slug?: string; isDemo?: boolean; createdByIp?: string },
): Promise<string> {
  const [row] = await db
    .insert(runs)
    .values({
      url: input.url,
      goal: input.goal,
      status: "queued",
      modelConfig: input.modelConfig,
      slug: input.slug ?? null,
      isDemo: input.isDemo ?? false,
      createdByIp: input.createdByIp ?? null,
    })
    .returning({ id: runs.id });
  if (!row) throw new Error("failed to create run");

  await db.insert(runSeqCounters).values({ runId: row.id, value: 0 });
  return row.id;
}

export async function setRunStatus(
  db: Database,
  runId: string,
  status: string,
): Promise<void> {
  await db.update(runs).set({ status }).where(eq(runs.id, runId));
}

export async function finishRun(
  db: Database,
  runId: string,
  input: {
    status: string;
    totalCostCents: number;
    totalTokens: number;
    abortReason: AbortReason | null;
  },
): Promise<void> {
  await db
    .update(runs)
    .set({
      status: input.status,
      finishedAt: new Date(),
      totalCostCents: input.totalCostCents,
      totalTokens: input.totalTokens,
      abortReason: input.abortReason,
    })
    .where(eq(runs.id, runId));
}

export async function createPersonaRun(
  db: Database,
  runId: string,
  personaKey: string,
): Promise<string> {
  const [row] = await db
    .insert(personaRuns)
    .values({ runId, personaKey, status: "queued" })
    .returning({ id: personaRuns.id });
  if (!row) throw new Error("failed to create persona run");
  return row.id;
}

export async function updatePersonaRun(
  db: Database,
  personaRunId: string,
  patch: Partial<{
    status: string;
    currentActionLabel: string | null;
    stepCount: number;
    outcome: PersonaOutcome | null;
    blockedReason: string | null;
  }>,
): Promise<void> {
  await db.update(personaRuns).set(patch).where(eq(personaRuns.id, personaRunId));
}

export interface PersistedStep {
  stepId: string;
  observationIds: string[];
}

export async function persistStep(
  db: Database,
  personaRunId: string,
  step: StepRecord,
  screenshotKey: string | null,
): Promise<PersistedStep> {
  const [row] = await db
    .insert(steps)
    .values({
      personaRunId,
      index: step.index,
      url: step.url,
      screenshotKey,
      snapshotJson: step.snapshot,
      actionJson: step.decision.action,
      narration: step.narration,
      reasoning: step.reasoning,
      latencyMs: step.latencyMs,
      tokensIn: step.usage.inputTokens,
      tokensOut: step.usage.outputTokens,
      cacheWriteTokens: step.usage.cacheWriteTokens,
      cacheReadTokens: step.usage.cacheReadTokens,
      stopReason: step.stopReason,
      modelId: step.modelId,
    })
    .returning({ id: steps.id });
  if (!row) throw new Error("failed to persist step");

  const observationIds: string[] = [];
  for (const obs of step.observations) {
    const node = step.snapshot.nodes.find((n) => n.ref === obs.ref);
    const [o] = await db
      .insert(observations)
      .values({
        stepId: row.id,
        personaRunId,
        severity: obs.severity,
        category: obs.category,
        elementRef: obs.ref,
        elementDescription: node
          ? `${node.role}${node.name ? ` "${node.name}"` : ""}`
          : obs.ref,
        quote: obs.quote,
        viewportBox: node?.box ?? null,
      })
      .returning({ id: observations.id });
    if (o) observationIds.push(o.id);
  }

  return { stepId: row.id, observationIds };
}

/**
 * Allocates the next sequence number for a run.
 *
 * A single UPDATE ... RETURNING is the whole point: it is atomic under
 * concurrent persona workers, where a read-then-write or a per-worker counter
 * would produce duplicate or out-of-order seq values and corrupt replay.
 */
export async function nextSeq(db: Database, runId: string): Promise<number> {
  const result = await db
    .update(runSeqCounters)
    .set({ value: sql`${runSeqCounters.value} + 1` })
    .where(eq(runSeqCounters.runId, runId))
    .returning({ value: runSeqCounters.value });
  const row = result[0];
  if (!row) throw new Error(`no sequence counter for run ${runId}`);
  return row.value;
}

/**
 * Persists an event and returns the full envelope, ready to publish.
 *
 * Callers MUST publish only what this returns, and only after it returns — the
 * commit-before-publish ordering is what guarantees a live subscriber never
 * sees an event that a page refresh would lose.
 */
export async function appendEvent(
  db: Database,
  runId: string,
  input: RunEventInput,
): Promise<RunEvent> {
  const seq = await nextSeq(db, runId);
  const event = { ...input, runId, seq, ts: Date.now() } as RunEvent;

  await db.insert(runEvents).values({
    runId,
    seq,
    type: event.type,
    payloadJson: event,
  });

  return event;
}

export async function loadEvents(
  db: Database,
  runId: string,
  fromSeq = 0,
): Promise<RunEvent[]> {
  const rows = await db
    .select({ payload: runEvents.payloadJson, seq: runEvents.seq })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(runEvents.seq);
  return rows.filter((r) => r.seq > fromSeq).map((r) => r.payload as RunEvent);
}

export async function getRun(db: Database, runId: string) {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId));
  return row ?? null;
}
