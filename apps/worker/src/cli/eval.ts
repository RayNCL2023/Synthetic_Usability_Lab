/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  BrowserEnv,
  BudgetEnv,
  DataEnv,
  formatCents,
  getPersona,
  loadEnv,
  PERSONA_KEYS,
  totalTokens,
  type Severity,
} from "@sul/shared";
import { closeDb, getDb, issues, observations, personaRuns } from "@sul/shared/db";
import { BrowserDriver } from "../browser/driver.js";
import { runAgentLoop } from "../loop/agent.js";
import { RunBudget } from "../loop/budget.js";
import {
  groundingRejectionRate,
  schemaRejectionRate,
  type GroundingStats,
} from "../loop/validator.js";
import { buildModelClient } from "../model/factory.js";
import { createPersonaRun, createRun, finishRun, persistStep } from "../persistence/repository.js";
import { startFixtureServer } from "./fixture.js";
import type { ClusterObservationInput } from "../model/client.js";

/**
 * `pnpm eval` — the golden evaluation harness.
 *
 * Runs the full pipeline against the bundled fixture site and scores it against
 * the planted-defect manifest, sweeping the model and snapshot node-cap axes.
 *
 * THIS MUST RUN IN THE PINNED LINUX PLAYWRIGHT IMAGE (docker/eval.Dockerfile).
 * Host Chromium and container Chromium render differently — font stacks
 * especially — which moves bounding boxes and therefore pin coordinates and
 * recall. Every committed number has to come from one environment or the
 * diffs mean nothing. The harness refuses to write results outside it unless
 * explicitly forced.
 *
 * Results are written to eval/results.json so regressions show up in a diff.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../../..");
const MANIFEST = path.join(ROOT, "fixtures/badsite/defects.json");
const OUT_DIR = path.join(ROOT, "eval");
const RESULTS = path.join(OUT_DIR, "results.json");
const ADJUDICATIONS = path.join(OUT_DIR, "adjudications.json");

interface Defect {
  id: string;
  title: string;
  category: string;
  expectedSeverity: Severity;
  detectableBy: string[];
  notes: string;
}

/**
 * Matching a reported issue to a planted defect.
 *
 * Deliberately keyword-based and deliberately conservative. An LLM judge would
 * score its own family's output, and a fuzzy string match would inflate recall
 * by rewarding vocabulary overlap. Each defect gets an explicit set of terms
 * that a genuine detection would have to contain; a miss here is a real miss.
 */
const DEFECT_MATCHERS: Record<string, RegExp[]> = {
  "pricing-buried": [/pricing|price/i, /(buried|clicks?|navigation|not (visible|reachable|present)|hidden|deep)/i],
  "icon-nav-unlabelled": [/(nav|navigation|menu|icon)/i, /(label|accessible name|descriptive|symbol|unicode|glyph|unlabel)/i],
  "low-contrast-cta": [/(contrast|legib|readab)/i],
  "unlabelled-email-input": [/(input|field|email|form)/i, /(label|accessible name|unlabel|placeholder)/i],
  "focus-trapping-modal": [/(modal|dialog|popup|interstitial|overlay|newsletter)/i],
  "carousel-no-alt": [/(image|img|logo|carousel)/i, /(alt|alternative text|decorative)/i],
  "no-security-info": [/(security|compliance|soc 2|iso|gdpr|certification|trust)/i],
  "contact-is-dead-end": [/contact/i, /(no |lacks|missing|absent|without|dead end|unable)/i],
};

function matchesDefect(defectId: string, text: string): boolean {
  const matchers = DEFECT_MATCHERS[defectId];
  if (!matchers) return false;
  return matchers.every((m) => m.test(text));
}

interface SweepCell {
  loopModel: string;
  maxNodes: number;
}

interface CellResult extends SweepCell {
  runId: string;
  recall: number;
  matchedDefects: string[];
  missedDefects: string[];
  unmatchedIssues: Array<{ title: string; severity: string; verdict: string }>;
  falsePositiveRate: number;
  groundingRejectionRate: number;
  schemaRejectionRate: number;
  issueCount: number;
  observationCount: number;
  stepCount: number;
  totalTokens: number;
  costCents: number;
  notionalCost: boolean;
  wallClockMs: number;
}

class SweepAborted extends Error {}

function loadAdjudications(): Record<string, "real" | "false_positive"> {
  if (!fs.existsSync(ADJUDICATIONS)) return {};
  return JSON.parse(fs.readFileSync(ADJUDICATIONS, "utf8"));
}

function inEvalContainer(): boolean {
  return process.env.SUL_EVAL_CONTAINER === "true";
}

async function runCell(
  cell: SweepCell,
  fixtureUrl: string,
  defects: Defect[],
  adjudications: Record<string, string>,
): Promise<CellResult> {
  const started = Date.now();
  const data = loadEnv(DataEnv);
  const budgetEnv = loadEnv(BudgetEnv);
  const browserEnv = loadEnv(BrowserEnv);
  const db = getDb(data.DATABASE_URL);

  // The sweep axis is applied through env so the factory and snapshot builder
  // stay unaware they are being swept.
  process.env.SUL_GEMINI_LOOP_MODEL = cell.loopModel;
  const built = buildModelClient();

  const goal =
    "Find the price of a mid-tier paid plan, then confirm what is NOT included " +
    "and what happens if you stop paying. Report anything you cannot determine.";

  const runId = await createRun(db, {
    url: fixtureUrl,
    goal,
    modelConfig: built.config,
  });

  const budget = new RunBudget(
    {
      maxStepsPerPersona: budgetEnv.SUL_MAX_STEPS_PER_PERSONA,
      maxModelCallsPerRun: budgetEnv.SUL_MAX_MODEL_CALLS_PER_RUN,
      maxWallClockMs: budgetEnv.SUL_MAX_WALL_CLOCK_MS,
      maxCostCents: budgetEnv.SUL_MAX_COST_CENTS,
    },
    (built.config.cacheTtl as "5m" | "1h") ?? "5m",
  );

  const grounding: GroundingStats = {
    decisions: 0,
    rejectedDecisions: 0,
    schemaRejections: 0,
    droppedObservations: 0,
    totalObservations: 0,
  };

  const driver = new BrowserDriver({
    headless: true,
    userAgent: browserEnv.SUL_USER_AGENT,
    navTimeoutMs: browserEnv.SUL_NAV_TIMEOUT_MS,
  });
  await driver.start();

  const clusterInputs: ClusterObservationInput[] = [];
  let stepCount = 0;

  try {
    // Personas run sequentially here, not in parallel: the eval is measuring
    // detection quality, and serialising removes rate-limiter queueing from the
    // wall-clock figure so the number reflects the pipeline rather than the
    // free-tier budget.
    for (const key of PERSONA_KEYS) {
      const persona = getPersona(key);
      const personaRunId = await createPersonaRun(db, runId, key);
      const session = await driver.createPersonaContext(persona);
      try {
        const result = await runAgentLoop({
          persona,
          goal,
          startUrl: fixtureUrl,
          page: session.page,
          model: built.client,
          budget,
          stepTimeoutMs: browserEnv.SUL_STEP_TIMEOUT_MS,
          snapshotMaxNodes: cell.maxNodes,
          onStep: async (step) => {
            const { observationIds } = await persistStep(db, personaRunId, step, null);
            stepCount++;
            step.observations.forEach((o, i) => {
              const node = step.snapshot.nodes.find((n) => n.ref === o.ref);
              clusterInputs.push({
                observationId: observationIds[i] ?? `${key}-${step.index}-${i}`,
                personaKey: key,
                personaName: persona.displayName,
                severity: o.severity,
                category: o.category,
                elementDescription: node
                  ? `${node.role}${node.name ? ` "${node.name}"` : ""}`
                  : o.ref,
                quote: o.quote,
                description: o.description,
                stepIndex: step.index,
              });
            });
          },
        });
        grounding.decisions += result.grounding.decisions;
        grounding.rejectedDecisions += result.grounding.rejectedDecisions;
        grounding.schemaRejections += result.grounding.schemaRejections;
        grounding.droppedObservations += result.grounding.droppedObservations;
        grounding.totalObservations += result.grounding.totalObservations;
      } finally {
        await session.close();
      }
    }
  } finally {
    await driver.stop();
  }

  // Cluster whatever was found.
  let clustered: Awaited<ReturnType<typeof built.client.cluster>> | null = null;
  if (clusterInputs.length > 0) {
    clustered = await built.client.cluster({
      url: fixtureUrl,
      goal,
      observations: clusterInputs,
    });
    budget.recordModelCall(clustered.usage, clustered.modelId);
  }

  const reported = (clustered?.issues ?? []).map((i) => ({
    title: i.title,
    description: i.description,
    severity: i.severity as string,
    text: `${i.title} ${i.description} ${i.recommendation}`,
  }));

  // Recall against the manifest.
  const matched: string[] = [];
  const claimedBy = new Map<string, number>();
  for (const d of defects) {
    const idx = reported.findIndex((r) => matchesDefect(d.id, r.text));
    if (idx >= 0) {
      matched.push(d.id);
      claimedBy.set(d.id, idx);
    }
  }
  const missed = defects.filter((d) => !matched.includes(d.id)).map((d) => d.id);

  // Anything not matching a planted defect is a candidate false positive.
  // Adjudicated once by hand, then cached — an unadjudicated issue is reported
  // as `unadjudicated` rather than silently counted either way.
  const claimedIdx = new Set(claimedBy.values());
  const unmatched = reported
    .map((r, i) => ({ r, i }))
    .filter(({ i }) => !claimedIdx.has(i))
    .map(({ r }) => ({
      title: r.title,
      severity: r.severity,
      verdict: adjudications[r.title] ?? "unadjudicated",
    }));

  const confirmedFalse = unmatched.filter((u) => u.verdict === "false_positive").length;
  const totals = budget.totals;

  await finishRun(db, runId, {
    status: "finished",
    totalCostCents: totals.costCents,
    totalTokens: totalTokens(totals.usage),
    abortReason: null,
  });

  return {
    ...cell,
    runId,
    recall: defects.length ? matched.length / defects.length : 0,
    matchedDefects: matched,
    missedDefects: missed,
    unmatchedIssues: unmatched,
    falsePositiveRate: reported.length ? confirmedFalse / reported.length : 0,
    groundingRejectionRate: groundingRejectionRate(grounding),
    schemaRejectionRate: schemaRejectionRate(grounding),
    issueCount: reported.length,
    observationCount: clusterInputs.length,
    stepCount,
    totalTokens: totalTokens(totals.usage),
    costCents: totals.costCents,
    notionalCost: built.notional,
    wallClockMs: Date.now() - started,
  };
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as {
    defects: Defect[];
  };
  const adjudications = loadAdjudications();

  const models = (process.env.SUL_EVAL_MODELS ?? "gemini-3.1-flash-lite")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const nodeCaps = (process.env.SUL_EVAL_NODE_CAPS ?? "120")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

  const fixture = await startFixtureServer();
  console.log(`fixture site at ${fixture.url}`);
  console.log(`sweeping ${models.length} model(s) x ${nodeCaps.length} node cap(s)\n`);

  const cells: CellResult[] = [];
  let abortedBy: string | null = null;

  try {
    for (const loopModel of models) {
      for (const maxNodes of nodeCaps) {
        process.stdout.write(`  ${loopModel} @ ${maxNodes} nodes … `);
        try {
          const r = await runCell(
            { loopModel, maxNodes },
            fixture.url,
            manifest.defects,
            adjudications,
          );
          cells.push(r);
          console.log(
            `recall ${(r.recall * 100).toFixed(0)}% ` +
              `(${r.matchedDefects.length}/${manifest.defects.length}) · ` +
              `ground ${(r.groundingRejectionRate * 100).toFixed(0)}% · ` +
              `schema ${(r.schemaRejectionRate * 100).toFixed(0)}% · ` +
              `${formatCents(r.costCents)} · ${Math.round(r.wallClockMs / 1000)}s`,
          );
        } catch (err) {
          // A sweep is expensive and long. Losing every completed cell because
          // the last one hit a provider quota is the wrong trade — observed
          // live, when the daily cap fired on cell 3 of 4 and discarded two
          // hours of measurement. Record what happened and keep the results
          // gathered so far.
          abortedBy = err instanceof Error ? err.message : String(err);
          console.log(`ABORTED — ${abortedBy.split("\n")[0]}`);
          if (/quota|rate/i.test(abortedBy)) {
            console.log(
              "  remaining cells skipped: a provider quota is not something the\n" +
                "  next cell will survive either.",
            );
          }
          throw new SweepAborted(abortedBy);
        }
      }
    }
  } catch (err) {
    if (!(err instanceof SweepAborted)) throw err;
  } finally {
    await fixture.close();
    await closeDb();
  }

  const payload = {
    ranAt: new Date().toISOString(),
    complete: abortedBy === null,
    abortedBy,
    plannedCells: models.length * nodeCaps.length,
    completedCells: cells.length,
    environment: inEvalContainer() ? "linux-playwright-container" : "HOST (untrusted)",
    trustworthy: inEvalContainer(),
    note: inEvalContainer()
      ? "Produced in the pinned Linux Playwright image. Comparable across commits."
      : "PRODUCED ON A HOST, NOT IN THE PINNED IMAGE. Chromium renders differently " +
        "across platforms, which moves bounding boxes and can move recall. These " +
        "numbers are indicative only and must not be compared against container runs.",
    defectCount: manifest.defects.length,
    unadjudicatedCount: cells.reduce(
      (n, c) => n + c.unmatchedIssues.filter((u) => u.verdict === "unadjudicated").length,
      0,
    ),
    cells,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(RESULTS, JSON.stringify(payload, null, 2));

  console.log(`\nwrote ${path.relative(ROOT, RESULTS)}`);
  if (!inEvalContainer()) {
    console.log(
      "\n⚠  Ran on the HOST, not in the pinned Linux image. Results are marked\n" +
        "   untrustworthy in the JSON. Use `docker build -f docker/eval.Dockerfile`\n" +
        "   for numbers you intend to commit or compare.",
    );
  }
  if (payload.unadjudicatedCount > 0) {
    console.log(
      `\n${payload.unadjudicatedCount} issue(s) did not match a planted defect and have not\n` +
        `been adjudicated. Add a verdict to eval/adjudications.json to fix the\n` +
        `false-positive rate — until then it is a floor, not a measurement.`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
