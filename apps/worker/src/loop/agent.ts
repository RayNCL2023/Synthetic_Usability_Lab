import type { Page } from "playwright";
import type { AbortReason } from "@sul/shared";
import {
  buildSystemPrompt,
  renderSnapshotTree,
  type Decision,
  type ModelObservation,
  type Persona,
  type PersonaOutcome,
  type Snapshot,
} from "@sul/shared";
import { buildSnapshot } from "../browser/snapshot.js";
import { actionLabel, executeAction } from "../browser/actions.js";
import type { ModelClient } from "../model/client.js";
import {
  emptyGroundingStats,
  validateDecision,
  type GroundingStats,
} from "./validator.js";
import { RunBudget } from "./budget.js";
import { detectBotWall, type BotWallVerdict } from "../browser/botwall.js";
import { dismissConsent } from "../browser/consent.js";

/**
 * The per-persona agent loop: observe, decide, validate, act, record.
 *
 * The validation step sits between decide and act deliberately. Nothing the
 * model says reaches the browser or the report until its refs have been checked
 * against the snapshot for THIS step.
 */

export interface StepRecord {
  index: number;
  url: string;
  screenshot: Buffer | null;
  snapshot: Snapshot;
  decision: Decision;
  observations: ModelObservation[];
  narration: string;
  reasoning: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number };
  stopReason: string;
  modelId: string;
  costCents: number;
  actionLabel: string;
  /** Set when the action failed to execute; surfaced to the next step. */
  actionError?: string;
}

export interface AgentRunResult {
  outcome: PersonaOutcome;
  blockedReason: string | null;
  steps: StepRecord[];
  grounding: GroundingStats;
}

export interface AgentLoopOptions {
  persona: Persona;
  goal: string;
  startUrl: string;
  page: Page;
  model: ModelClient;
  budget: RunBudget;
  stepTimeoutMs: number;
  /** Called after each step so the caller can persist and emit events. */
  onStep?: (step: StepRecord) => Promise<void>;
  onStatus?: (label: string) => Promise<void>;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentRunResult> {
  const { persona, goal, page, model, budget } = opts;
  const systemPrompt = buildSystemPrompt(persona);
  const steps: StepRecord[] = [];
  const grounding = emptyGroundingStats();

  let outcome: PersonaOutcome = "gave_up";
  let blockedReason: string | null = null;
  let maxTokensBumps = 0;

  await opts.onStatus?.("opening the page");

  const nav = await gotoWithRetry(page, opts.startUrl);
  if (!nav.ok) {
    return {
      outcome: "error",
      blockedReason: `could not load ${opts.startUrl}: ${nav.error}`,
      steps,
      grounding,
    };
  }

  // Bot walls and challenge pages are the common case, not the edge case.
  // Detect them explicitly so we report "we couldn't get past X" instead of
  // hallucinating a critique of a challenge page.
  const wall = await detectBotWall(page, nav.status);
  if (wall.blocked) {
    return { outcome: "blocked", blockedReason: wall.reason, steps, grounding };
  }

  // One dismissal attempt, most privacy-preserving option, logged as a step.
  // If it fails we continue — a blocking consent wall is legitimate feedback.
  const consent = await dismissConsent(page);
  if (consent.dismissed) {
    await opts.onStatus?.("dismissed a cookie banner");
  }

  const personaStepCap = Math.min(
    persona.harness.maxSteps,
    Number.MAX_SAFE_INTEGER,
  );

  for (let stepIndex = 0; stepIndex < personaStepCap; stepIndex++) {
    const abort = budget.check(steps.length);
    if (abort) {
      outcome = "capped";
      blockedReason = abort;
      break;
    }

    await opts.onStatus?.("reading the page");

    const snapshot = await buildSnapshot(page, stepIndex);
    const screenshot = persona.harness.receivesScreenshot
      ? await page.screenshot({ type: "jpeg", quality: 70 }).catch(() => null)
      : null;

    const affordable = budget.canAffordAnotherCall();
    if (affordable) {
      outcome = "capped";
      blockedReason = affordable;
      break;
    }

    await opts.onStatus?.("thinking");

    const decided = await decideWithValidation({
      model,
      systemPrompt,
      goal,
      snapshot,
      screenshot,
      historySummary: summariseHistory(steps),
      budget,
      onMaxTokens: () => {
        maxTokensBumps++;
      },
    });

    grounding.decisions += decided.attempts;
    grounding.rejectedDecisions += decided.rejections;

    if (!decided.decision) {
      // Three distinct reasons land here and must NOT be conflated:
      //   - budget exhausted        -> "capped"  (our constraint, not the site's fault)
      //   - model refusal           -> "error"
      //   - grounding/parse failure -> "gave_up"
      // Reporting a cost-capped run as "gave up" would tell the user the site
      // confused the persona when in fact we stopped spending.
      if (decided.cappedBy) {
        outcome = "capped";
        blockedReason = decided.cappedBy;
      } else {
        outcome = decided.refused ? "error" : "gave_up";
        blockedReason = decided.failureReason;
      }
      break;
    }

    const decision = decided.decision;
    const validation = validateDecision(decision, snapshot);
    grounding.totalObservations += decision.observations.length;
    grounding.droppedObservations += validation.droppedObservations;

    const label = actionLabel(decision.action, snapshot);
    await opts.onStatus?.(label);

    const result = await executeAction(page, snapshot, decision.action, {
      stepTimeoutMs: opts.stepTimeoutMs,
    });

    const record: StepRecord = {
      index: stepIndex,
      url: snapshot.url,
      screenshot,
      snapshot,
      decision,
      observations: validation.keptObservations,
      narration: decision.narration,
      reasoning: decision.reasoning,
      latencyMs: decided.latencyMs,
      usage: decided.usage,
      stopReason: decided.stopReason,
      modelId: decided.modelId,
      costCents: decided.costCents,
      actionLabel: label,
      actionError: result.ok ? undefined : result.error,
    };
    steps.push(record);
    await opts.onStep?.(record);

    if (decision.action.type === "finish") {
      outcome = decision.action.outcome === "goal_achieved" ? "goal_achieved" : "gave_up";
      break;
    }

    // A navigation may have landed on a challenge page mid-journey.
    if (result.navigated) {
      const midWall = await detectBotWall(page, null);
      if (midWall.blocked) {
        outcome = "blocked";
        blockedReason = midWall.reason;
        break;
      }
    }

    if (steps.length >= personaStepCap) {
      outcome = "capped";
      blockedReason = "step_cap";
    }
  }

  if (steps.length >= personaStepCap && outcome === "gave_up") {
    outcome = "capped";
    blockedReason = blockedReason ?? "step_cap";
  }

  void maxTokensBumps;
  return { outcome, blockedReason, steps, grounding };
}

interface DecideWithValidationArgs {
  model: ModelClient;
  systemPrompt: string;
  goal: string;
  snapshot: Snapshot;
  screenshot: Buffer | null;
  historySummary: string;
  budget: RunBudget;
  onMaxTokens: () => void;
}

/**
 * One decision, with the two-strike grounding retry and the stop_reason branch.
 *
 * The branch matters: a `max_tokens` stop means the object was truncated and the
 * model needs a BIGGER BUDGET, while an unknown ref means it hallucinated and
 * needs a RE-PROMPT. Treating truncation as a grounding failure would re-prompt
 * forever at the same budget; treating a bad ref as truncation would raise
 * max_tokens forever. Both are runaway loops, which is why they are separated
 * here and why stop_reason is persisted per step.
 */
async function decideWithValidation(args: DecideWithValidationArgs): Promise<{
  decision: Decision | null;
  attempts: number;
  rejections: number;
  refused: boolean;
  /** Set when a budget cap, not the model, ended this decision. */
  cappedBy: AbortReason | null;
  failureReason: string | null;
  latencyMs: number;
  usage: StepRecord["usage"];
  stopReason: string;
  modelId: string;
  costCents: number;
}> {
  const snapshotTree = renderSnapshotTree(args.snapshot);
  let retryProblems: string[] | undefined;
  let attempts = 0;
  let rejections = 0;
  let totalLatency = 0;
  let totalCost = 0;
  const totals: StepRecord["usage"] = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
  let lastStopReason = "unknown";
  let lastModelId = "";

  // Two attempts: one honest try, one retry with the errors surfaced. On the
  // second failure we force a give_up step rather than burning further calls.
  for (let attempt = 0; attempt < 2; attempt++) {
    const affordable = args.budget.canAffordAnotherCall();
    if (affordable) {
      return {
        decision: null,
        attempts,
        rejections,
        refused: false,
        cappedBy: affordable,
        failureReason: affordable,
        latencyMs: totalLatency,
        usage: totals,
        stopReason: lastStopReason,
        modelId: lastModelId,
        costCents: totalCost,
      };
    }

    const res = await args.model.decide({
      systemPrompt: args.systemPrompt,
      goal: args.goal,
      snapshotTree,
      screenshotJpeg: args.screenshot,
      historySummary: args.historySummary,
      retryProblems,
    });

    attempts++;
    totalLatency += res.latencyMs;
    totals.inputTokens += res.usage.inputTokens;
    totals.outputTokens += res.usage.outputTokens;
    totals.cacheWriteTokens += res.usage.cacheWriteTokens;
    totals.cacheReadTokens += res.usage.cacheReadTokens;
    lastStopReason = res.stopReason;
    lastModelId = res.modelId;
    totalCost += args.budget.recordModelCall(res.usage, res.modelId);

    if (res.stopReason === "refusal") {
      return {
        decision: null,
        attempts,
        rejections,
        refused: true,
        cappedBy: null,
        failureReason: `the model declined to act on this page (${res.refusalCategory ?? "unspecified"})`,
        latencyMs: totalLatency,
        usage: totals,
        stopReason: res.stopReason,
        modelId: res.modelId,
        costCents: totalCost,
      };
    }

    if (res.stopReason === "max_tokens") {
      // Truncation, not hallucination. Retrying at the same budget would
      // truncate identically, so this is not counted as a grounding rejection.
      args.onMaxTokens();
      return {
        decision: null,
        attempts,
        rejections,
        refused: false,
        cappedBy: null,
        failureReason:
          "the model's response was cut off by the token budget — raise SUL_LOOP_MAX_TOKENS",
        latencyMs: totalLatency,
        usage: totals,
        stopReason: res.stopReason,
        modelId: res.modelId,
        costCents: totalCost,
      };
    }

    if (!res.decision) {
      rejections++;
      retryProblems = [res.parseError ?? "response could not be parsed"];
      continue;
    }

    const validation = validateDecision(res.decision, args.snapshot);
    if (validation.ok) {
      return {
        decision: res.decision,
        attempts,
        rejections,
        refused: false,
        cappedBy: null,
        failureReason: null,
        latencyMs: totalLatency,
        usage: totals,
        stopReason: res.stopReason,
        modelId: res.modelId,
        costCents: totalCost,
      };
    }

    rejections++;
    retryProblems = validation.problems;
  }

  return {
    decision: null,
    attempts,
    rejections,
    refused: false,
    cappedBy: null,
    failureReason:
      "the model referenced elements that were not on the page, twice in a row",
    latencyMs: totalLatency,
    usage: totals,
    stopReason: lastStopReason,
    modelId: lastModelId,
    costCents: totalCost,
  };
}

/** Compact prior-step summary. Keeps context bounded on long journeys. */
export function summariseHistory(steps: StepRecord[]): string {
  if (steps.length === 0) return "";
  return steps
    .slice(-6)
    .map((s) => {
      const err = s.actionError ? ` (failed: ${s.actionError})` : "";
      return `  step ${s.index}: ${s.actionLabel}${err} — you said: ${JSON.stringify(
        truncate(s.narration, 140),
      )}`;
    })
    .join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

async function gotoWithRetry(
  page: Page,
  url: string,
): Promise<{ ok: boolean; status: number | null; error?: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      return { ok: true, status: res?.status() ?? null };
    } catch (err) {
      if (attempt === 1) {
        return {
          ok: false,
          status: null,
          error: err instanceof Error ? err.message.split("\n")[0] : String(err),
        };
      }
    }
  }
  return { ok: false, status: null, error: "unreachable" };
}

export type { BotWallVerdict };
