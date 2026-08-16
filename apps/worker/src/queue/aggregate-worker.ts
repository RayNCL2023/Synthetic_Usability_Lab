import type { Job } from "bullmq";
import type Redis from "ioredis";
import { eq } from "drizzle-orm";
import type { Database } from "@sul/shared/db";
import { issueObservations, issues, observations, personaRuns, steps } from "@sul/shared/db";
import { getPersona, totalTokens, type Severity } from "@sul/shared";
import type { AggregateJobData } from "./index.js";
import { RunEventEmitter } from "../events/emitter.js";
import { finishRun, setRunStatus } from "../persistence/repository.js";
import type { ClusterObservationInput, ModelClient } from "../model/client.js";
import { RunBudget } from "../loop/budget.js";

const SEVERITY_ORDER: Record<Severity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  nitpick: 3,
};

/** One step up the severity ladder, saturating at blocker. */
function escalate(s: Severity): Severity {
  const order: Severity[] = ["nitpick", "minor", "major", "blocker"];
  const i = order.indexOf(s);
  return order[Math.min(order.length - 1, i + 1)] ?? s;
}

export interface AggregateWorkerDeps {
  db: Database;
  redis: Redis;
  model: ModelClient;
  budgetFor: (runId: string) => RunBudget;
  disposeBudget: (runId: string) => void;
}

export async function processAggregateJob(
  job: Job<AggregateJobData>,
  deps: AggregateWorkerDeps,
): Promise<void> {
  const { runId, url, goal } = job.data;
  const emitter = new RunEventEmitter(deps.db, deps.redis, runId);
  const budget = deps.budgetFor(runId);

  await setRunStatus(deps.db, runId, "clustering");

  // Gather every observation across personas, including from personas that
  // failed part-way — a partial run still produces a report.
  const rows = await deps.db
    .select({
      obsId: observations.id,
      severity: observations.severity,
      category: observations.category,
      elementDescription: observations.elementDescription,
      quote: observations.quote,
      personaKey: personaRuns.personaKey,
      stepIndex: steps.index,
    })
    .from(observations)
    .innerJoin(personaRuns, eq(personaRuns.id, observations.personaRunId))
    .innerJoin(steps, eq(steps.id, observations.stepId))
    .where(eq(personaRuns.runId, runId));

  const inputs: ClusterObservationInput[] = rows.map((r) => ({
    observationId: r.obsId,
    personaKey: r.personaKey,
    personaName: safePersonaName(r.personaKey),
    severity: r.severity as Severity,
    category: r.category as ClusterObservationInput["category"],
    elementDescription: r.elementDescription,
    quote: r.quote,
    description: r.elementDescription,
    stepIndex: r.stepIndex,
  }));

  const personaOf = new Map(rows.map((r) => [r.obsId, r.personaKey]));
  const stepOf = new Map(rows.map((r) => [r.obsId, r.stepIndex]));
  const severityOf = new Map(rows.map((r) => [r.obsId, r.severity as Severity]));

  let clustered: Awaited<ReturnType<ModelClient["cluster"]>> | null = null;
  if (inputs.length > 0) {
    try {
      clustered = await deps.model.cluster({ url, goal, observations: inputs });
      budget.recordModelCall(clustered.usage, clustered.modelId);
    } catch (err) {
      await emitter.emit({
        type: "run.error",
        personaKey: null,
        message: `Clustering failed: ${err instanceof Error ? err.message : String(err)}`,
        fatal: false,
      });
    }
  }

  // Rank: severity, then distinct-persona count, then earliest in the journey.
  const ranked = (clustered?.issues ?? [])
    .map((issue) => {
      const personas = new Set(
        issue.observationIds.map((id) => personaOf.get(id)).filter(Boolean) as string[],
      );
      const earliest = Math.min(
        ...issue.observationIds.map((id) => stepOf.get(id) ?? 99),
      );
      // Cross-persona agreement is the strongest signal the product has, so it
      // raises severity rather than only being displayed.
      const observed = issue.observationIds
        .map((id) => severityOf.get(id))
        .filter(Boolean) as Severity[];
      const worst =
        observed.sort((a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b])[0] ??
        issue.severity;
      const severity = personas.size >= 2 ? escalate(worst) : worst;

      return { ...issue, severity, personaKeys: [...personas], earliest };
    })
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        b.personaKeys.length - a.personaKeys.length ||
        a.earliest - b.earliest,
    );

  const persistedIssues: Array<{
    id: string;
    title: string;
    description: string;
    severity: Severity;
    category: ClusterObservationInput["category"];
    rank: number;
    recommendation: string;
    personaKeys: string[];
    observationIds: string[];
  }> = [];

  for (const [i, issue] of ranked.entries()) {
    const [row] = await deps.db
      .insert(issues)
      .values({
        runId,
        title: issue.title,
        description: issue.description,
        severity: issue.severity,
        category: issue.category,
        rank: i + 1,
        recommendation: issue.recommendation,
      })
      .returning({ id: issues.id });
    if (!row) continue;

    for (const obsId of issue.observationIds) {
      await deps.db
        .insert(issueObservations)
        .values({ issueId: row.id, observationId: obsId })
        .onConflictDoNothing();
    }

    persistedIssues.push({
      id: row.id,
      title: issue.title,
      description: issue.description,
      severity: issue.severity,
      category: issue.category,
      rank: i + 1,
      recommendation: issue.recommendation,
      personaKeys: issue.personaKeys,
      observationIds: issue.observationIds,
    });
  }

  await emitter.emit({ type: "run.issues", personaKey: null, issues: persistedIssues });

  const totals = budget.totals;
  await finishRun(deps.db, runId, {
    status: "finished",
    totalCostCents: totals.costCents,
    totalTokens: totalTokens(totals.usage),
    abortReason: null,
  });

  await emitter.emit({
    type: "run.finished",
    personaKey: null,
    totalCostCents: totals.costCents,
    totalTokens: totalTokens(totals.usage),
    abortReason: null,
    issueCount: persistedIssues.length,
  });

  deps.disposeBudget(runId);
}

function safePersonaName(key: string): string {
  try {
    return getPersona(key).displayName;
  } catch {
    return key;
  }
}
