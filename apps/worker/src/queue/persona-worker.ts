import type { Job } from "bullmq";
import type Redis from "ioredis";
import type { Database } from "@sul/shared/db";
import { getPersona, type BudgetConfig, type BrowserConfig } from "@sul/shared";
import type { PersonaJobData } from "./index.js";
import { BrowserDriver } from "../browser/driver.js";
import { runAgentLoop } from "../loop/agent.js";
import { RunBudget } from "../loop/budget.js";
import { RunEventEmitter } from "../events/emitter.js";
import { persistStep, updatePersonaRun } from "../persistence/repository.js";
import { presignScreenshot } from "../storage/s3.js";
import { s3Sink, storeStepScreenshot } from "../storage/step-screenshot.js";
import type { ModelClient } from "../model/client.js";
import { DailyQuotaExhaustedError } from "../model/ratelimit.js";

/**
 * Runs one persona to completion and streams its events.
 *
 * The browser is created per job rather than shared: personas need genuinely
 * different contexts (viewport, touch, throttling) and a leaked context between
 * runs would carry cookies across sites, which the consent rules forbid.
 */
export interface PersonaWorkerDeps {
  db: Database;
  redis: Redis;
  model: ModelClient;
  budgets: BudgetConfig;
  browser: BrowserConfig;
  /** Shared across personas within a run so caps are run-wide, not per persona. */
  budgetFor: (runId: string) => RunBudget;
}

export async function processPersonaJob(
  job: Job<PersonaJobData>,
  deps: PersonaWorkerDeps,
): Promise<void> {
  const { runId, personaRunId, personaKey, url, goal } = job.data;
  const persona = getPersona(personaKey);
  const emitter = new RunEventEmitter(deps.db, deps.redis, runId);
  const budget = deps.budgetFor(runId);
  const sink = s3Sink();

  await updatePersonaRun(deps.db, personaRunId, { status: "running" });

  const driver = new BrowserDriver({
    headless: deps.browser.SUL_HEADLESS,
    userAgent: deps.browser.SUL_USER_AGENT,
    navTimeoutMs: deps.browser.SUL_NAV_TIMEOUT_MS,
  });

  try {
    await driver.start();
    const session = await driver.createPersonaContext(persona);

    try {
      const result = await runAgentLoop({
        persona,
        goal,
        startUrl: url,
        page: session.page,
        model: deps.model,
        budget,
        stepTimeoutMs: deps.browser.SUL_STEP_TIMEOUT_MS,

        onStatus: async (label) => {
          await updatePersonaRun(deps.db, personaRunId, {
            currentActionLabel: label,
          });
          await emitter.emit({ type: "persona.status", personaKey, label });
        },

        onStep: async (step) => {
          const key = await storeStepScreenshot(sink, {
            runId,
            personaKey,
            stepIndex: step.index,
            screenshot: step.screenshot,
          });
          const { observationIds } = await persistStep(
            deps.db,
            personaRunId,
            step,
            key,
          );
          await updatePersonaRun(deps.db, personaRunId, {
            stepCount: step.index + 1,
          });

          const actionRef = step.decision.action.ref;
          const node = actionRef
            ? step.snapshot.nodes.find((n) => n.ref === actionRef)
            : undefined;

          await emitter.emit({
            type: "persona.step",
            personaKey,
            stepIndex: step.index,
            url: step.url,
            screenshotUrl: key ? await presignScreenshot(key) : null,
            narration: step.narration,
            actionType: step.decision.action.type,
            actionRef,
            actionBox: node?.box ?? null,
          });

          // Observations are emitted individually so the UI can drop pins in
          // one at a time rather than all at once at the end of the step.
          for (const [i, obs] of step.observations.entries()) {
            const obsNode = step.snapshot.nodes.find((n) => n.ref === obs.ref);
            await emitter.emit({
              type: "persona.observation",
              personaKey,
              stepIndex: step.index,
              observationId: observationIds[i] ?? `${step.index}-${i}`,
              severity: obs.severity,
              category: obs.category,
              quote: obs.quote,
              description: obs.description,
              elementRef: obs.ref,
              box: obsNode?.box ?? null,
            });
          }
        },
      });

      await updatePersonaRun(deps.db, personaRunId, {
        status: "finished",
        outcome: result.outcome,
        blockedReason: result.blockedReason,
        currentActionLabel: null,
      });

      await emitter.emit({
        type: "persona.finished",
        personaKey,
        outcome: result.outcome,
        stepCount: result.steps.length,
        blockedReason: result.blockedReason,
      });
    } finally {
      await session.close();
    }
  } catch (err) {
    // A daily quota is a run-level condition, not a persona-level one: the
    // other personas will hit it too, so say so plainly rather than reporting
    // three separate mysterious failures.
    const daily = err instanceof DailyQuotaExhaustedError;
    const message = err instanceof Error ? err.message : String(err);

    await updatePersonaRun(deps.db, personaRunId, {
      status: "failed",
      outcome: "error",
      blockedReason: message,
      currentActionLabel: null,
    });
    await emitter.emit({
      type: "persona.finished",
      personaKey,
      outcome: "error",
      stepCount: 0,
      blockedReason: message,
    });
    await emitter.emit({
      type: "run.error",
      personaKey,
      message,
      fatal: daily,
    });
    // Swallow rather than rethrow: the aggregate must still run. BullMQ would
    // mark the child failed either way, but a thrown error here also produces
    // noisy retries for a condition retrying cannot fix.
  } finally {
    await driver.stop();
  }
}
