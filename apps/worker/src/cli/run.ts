import {
  BudgetEnv,
  BrowserEnv,
  DataEnv,
  ModelEnv,
  formatCents,
  getPersona,
  loadEnv,
  PERSONA_KEYS,
  totalTokens,
  type ModelConfig,
} from "@sul/shared";
import { getDb, closeDb } from "@sul/shared/db";
import { BrowserDriver } from "../browser/driver.js";
import { AnthropicModelClient } from "../model/anthropic.js";
import { HeuristicModelClient } from "../model/heuristic.js";
import type { ModelClient } from "../model/client.js";
import { RunBudget, describeAbort } from "../loop/budget.js";
import { runAgentLoop } from "../loop/agent.js";
import { groundingRejectionRate } from "../loop/validator.js";
import {
  createPersonaRun,
  createRun,
  finishRun,
  persistStep,
  setRunStatus,
  updatePersonaRun,
} from "../persistence/repository.js";
import {
  ensureBucket,
  isStorageConfigured,
  screenshotKey,
  uploadScreenshot,
} from "../storage/s3.js";
import { startFixtureServer } from "./fixture.js";

/**
 * `pnpm run:cli [url] --goal="..." --persona=key`
 *
 * Checkpoint A acceptance: runs one persona end to end against the fixture
 * site, persists the full trace, and prints the real cost.
 */

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=");
}

async function main() {
  const personaKey = arg("persona") ?? "impatient_mobile";
  if (!PERSONA_KEYS.includes(personaKey)) {
    console.error(
      `Unknown persona "${personaKey}". Known: ${PERSONA_KEYS.join(", ")}`,
    );
    process.exit(1);
  }
  const persona = getPersona(personaKey);
  const goal = arg("goal") ?? "Find pricing and start a trial";

  // --mock swaps in the offline heuristic walker. It proves everything except
  // the HTTP call to Anthropic — snapshot, grounding validation, action
  // execution, persistence, and cost accounting all run for real — which is
  // what makes the pipeline verifiable without spending money or a key.
  const mock = process.argv.includes("--mock");

  const data = loadEnv(DataEnv);
  // Only the API key is relaxed in mock mode — model ids, effort, and cache TTL
  // still come from config so the printed cost reflects the real settings.
  const modelEnv = mock
    ? {
        ...loadEnv(ModelEnv.omit({ ANTHROPIC_API_KEY: true })),
        ANTHROPIC_API_KEY: "",
      }
    : loadEnv(ModelEnv);
  const budgetEnv = loadEnv(BudgetEnv);
  const browserEnv = loadEnv(BrowserEnv);

  const positional = process.argv.slice(2).find((a) => !a.startsWith("--"));
  let target = positional;
  let stopFixture: (() => Promise<void>) | null = null;

  if (!target) {
    const fixture = await startFixtureServer();
    target = fixture.url;
    stopFixture = fixture.close;
    console.log(
      `(no URL given — started the bundled fixture site at ${target})`,
    );
  }

  const modelConfig: ModelConfig = {
    loopModel: modelEnv.SUL_LOOP_MODEL,
    loopEffort: modelEnv.SUL_LOOP_EFFORT,
    clusterModel: modelEnv.SUL_CLUSTER_MODEL,
    clusterEffort: modelEnv.SUL_CLUSTER_EFFORT,
    cacheTtl: modelEnv.SUL_CACHE_TTL,
  };

  const db = getDb(data.DATABASE_URL);
  const storage = isStorageConfigured();
  if (storage) await ensureBucket();

  const runId = await createRun(db, { url: target, goal, modelConfig });
  const personaRunId = await createPersonaRun(db, runId, persona.key);
  await setRunStatus(db, runId, "running");
  await updatePersonaRun(db, personaRunId, { status: "running" });

  console.log(`\nrun     ${runId}`);
  console.log(`persona ${persona.displayName}`);
  console.log(`goal    ${goal}`);
  console.log(
    `model   ${modelConfig.loopModel} @ effort=${modelConfig.loopEffort}\n`,
  );

  const budget = new RunBudget(
    {
      maxStepsPerPersona: budgetEnv.SUL_MAX_STEPS_PER_PERSONA,
      maxModelCallsPerRun: budgetEnv.SUL_MAX_MODEL_CALLS_PER_RUN,
      maxWallClockMs: budgetEnv.SUL_MAX_WALL_CLOCK_MS,
      maxCostCents: budgetEnv.SUL_MAX_COST_CENTS,
    },
    modelEnv.SUL_CACHE_TTL,
  );

  const model: ModelClient = mock
    ? new HeuristicModelClient(
        modelEnv.SUL_LOOP_MODEL,
        persona.harness.maxSteps,
      )
    : new AnthropicModelClient({
        apiKey: modelEnv.ANTHROPIC_API_KEY,
        loopModel: modelEnv.SUL_LOOP_MODEL,
        loopEffort: modelEnv.SUL_LOOP_EFFORT,
        loopMaxTokens: modelEnv.SUL_LOOP_MAX_TOKENS,
        clusterModel: modelEnv.SUL_CLUSTER_MODEL,
        clusterEffort: modelEnv.SUL_CLUSTER_EFFORT,
        clusterMaxTokens: modelEnv.SUL_CLUSTER_MAX_TOKENS,
        cacheTtl: modelEnv.SUL_CACHE_TTL,
      });

  const driver = new BrowserDriver({
    headless: browserEnv.SUL_HEADLESS,
    userAgent: browserEnv.SUL_USER_AGENT,
    navTimeoutMs: browserEnv.SUL_NAV_TIMEOUT_MS,
  });
  await driver.start();
  const session = await driver.createPersonaContext(persona);

  try {
    const result = await runAgentLoop({
      persona,
      goal,
      startUrl: target,
      page: session.page,
      model,
      budget,
      stepTimeoutMs: browserEnv.SUL_STEP_TIMEOUT_MS,
      onStatus: async (label) => {
        await updatePersonaRun(db, personaRunId, { currentActionLabel: label });
      },
      onStep: async (step) => {
        let key: string | null = null;
        if (step.screenshot && storage) {
          key = screenshotKey(runId, persona.key, step.index);
          await uploadScreenshot(key, step.screenshot);
        }
        await persistStep(db, personaRunId, step, key);
        await updatePersonaRun(db, personaRunId, { stepCount: step.index + 1 });

        const obs = step.observations.length;
        console.log(
          `  step ${step.index}  ${step.actionLabel.padEnd(28)} ` +
            `${obs ? `${obs} observation${obs > 1 ? "s" : ""}` : "—"}  ` +
            `${formatCents(step.costCents)}  ${step.latencyMs}ms`,
        );
        if (step.narration) console.log(`          "${step.narration}"`);
        for (const o of step.observations) {
          console.log(
            `          [${o.severity}/${o.category}] ${o.description}`,
          );
        }
        if (step.actionError)
          console.log(`          action failed: ${step.actionError}`);
      },
    });

    await updatePersonaRun(db, personaRunId, {
      status: "finished",
      outcome: result.outcome,
      blockedReason: result.blockedReason,
      currentActionLabel: null,
    });

    const totals = budget.totals;
    const abort =
      result.outcome === "capped" && result.blockedReason
        ? (result.blockedReason as never)
        : null;

    await finishRun(db, runId, {
      status: "finished",
      totalCostCents: totals.costCents,
      totalTokens: totalTokens(totals.usage),
      abortReason: abort,
    });

    console.log(`\noutcome            ${result.outcome}`);
    if (result.blockedReason) {
      const pretty =
        result.outcome === "capped"
          ? describeAbort(result.blockedReason as never)
          : result.blockedReason;
      console.log(`reason             ${pretty}`);
    }
    console.log(`steps              ${result.steps.length}`);
    console.log(`model calls        ${totals.modelCalls}`);
    console.log(
      `tokens             in ${totals.usage.inputTokens}, out ${totals.usage.outputTokens}, ` +
        `cache write ${totals.usage.cacheWriteTokens}, cache read ${totals.usage.cacheReadTokens}`,
    );
    console.log(
      `grounding rejects  ${(groundingRejectionRate(result.grounding) * 100).toFixed(1)}% ` +
        `(${result.grounding.rejectedDecisions}/${result.grounding.decisions} decisions)`,
    );
    console.log(
      `observations       ${result.grounding.totalObservations} produced, ` +
        `${result.grounding.droppedObservations} dropped as ungrounded`,
    );
    console.log(`cost               ${formatCents(totals.costCents)}`);
    console.log(`\ntrace persisted. run id: ${runId}`);
  } finally {
    await session.close();
    await driver.stop();
    if (stopFixture) await stopFixture();
    await closeDb();
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
