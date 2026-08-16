import { Worker } from "bullmq";
import {
  BrowserEnv,
  BudgetEnv,
  DataEnv,
  loadEnv,
  redisChannelForRun,
} from "@sul/shared";
import { getDb } from "@sul/shared/db";
import {
  AGGREGATE_QUEUE,
  PERSONA_QUEUE,
  connectionFor,
  createRedis,
  type AggregateJobData,
  type PersonaJobData,
} from "./queue/index.js";
import { processPersonaJob } from "./queue/persona-worker.js";
import { processAggregateJob } from "./queue/aggregate-worker.js";
import { buildModelClient } from "./model/factory.js";
import { RunBudget } from "./loop/budget.js";
import { ensureBucket, isStorageConfigured } from "./storage/s3.js";

/**
 * Worker entrypoint.
 *
 * Persona concurrency is 3 — one per persona — so a single run fans out truly
 * in parallel. That is deliberate and is exactly why the model rate limiter is
 * shared and process-wide: three workers pulling from a 10 RPM budget must
 * queue against each other, not against three separate budgets.
 */

const data = loadEnv(DataEnv);
const budgets = loadEnv(BudgetEnv);
const browser = loadEnv(BrowserEnv);

const db = getDb(data.DATABASE_URL);
const redis = createRedis(data.REDIS_URL);
const connection = connectionFor(data.REDIS_URL);
const built = buildModelClient();

/**
 * One budget per run, shared by that run's personas so the caps are run-wide.
 * Held in-process, which is correct for the single-worker deployment we
 * actually ship; a multi-worker deployment would need this in Redis, and that
 * is noted rather than pretended away.
 */
const budgetsByRun = new Map<string, RunBudget>();
function budgetFor(runId: string): RunBudget {
  let b = budgetsByRun.get(runId);
  if (!b) {
    b = new RunBudget(
      {
        maxStepsPerPersona: budgets.SUL_MAX_STEPS_PER_PERSONA,
        maxModelCallsPerRun: budgets.SUL_MAX_MODEL_CALLS_PER_RUN,
        maxWallClockMs: budgets.SUL_MAX_WALL_CLOCK_MS,
        maxCostCents: budgets.SUL_MAX_COST_CENTS,
      },
      (built.config.cacheTtl as "5m" | "1h") ?? "5m",
    );
    budgetsByRun.set(runId, b);
  }
  return b;
}

async function main() {
  if (isStorageConfigured()) await ensureBucket();

  const personaWorker = new Worker<PersonaJobData>(
    PERSONA_QUEUE,
    (job) =>
      processPersonaJob(job, {
        db,
        redis,
        model: built.client,
        budgets,
        browser,
        budgetFor,
      }),
    { connection, concurrency: 3 },
  );

  const aggregateWorker = new Worker<AggregateJobData>(
    AGGREGATE_QUEUE,
    (job) =>
      processAggregateJob(job, {
        db,
        redis,
        model: built.client,
        budgetFor,
        disposeBudget: (runId) => budgetsByRun.delete(runId),
      }),
    { connection, concurrency: 2 },
  );

  for (const [name, w] of [
    ["persona", personaWorker],
    ["aggregate", aggregateWorker],
  ] as const) {
    w.on("failed", (job, err) => {
      console.error(`[${name}] job ${job?.id} failed:`, err?.message);
    });
  }

  console.log(`worker up — provider=${built.config.loopModel} concurrency=3`);
  console.log(`  persona queue   ${PERSONA_QUEUE}`);
  console.log(`  aggregate queue ${AGGREGATE_QUEUE}`);
  console.log(`  publishing to   ${redisChannelForRun("<runId>")}`);

  const shutdown = async () => {
    console.log("shutting down…");
    await Promise.allSettled([personaWorker.close(), aggregateWorker.close()]);
    redis.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
