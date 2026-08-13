import type { AbortReason, CacheTtl, TokenUsage } from "@sul/shared";
import { addUsage, computeCostCents, EMPTY_USAGE } from "@sul/shared";

/**
 * Per-run budget.
 *
 * Exceeding any cap aborts CLEANLY with partial results and a recorded reason —
 * never a hard failure. A capped run still clusters whatever observations exist
 * and still produces a report: a partial answer is the product working as
 * designed under its own constraints, not an error.
 *
 * Retries count against the model-call cap, so a retry storm cannot outrun it.
 */

export interface BudgetLimits {
  maxStepsPerPersona: number;
  maxModelCallsPerRun: number;
  maxWallClockMs: number;
  maxCostCents: number;
}

export class RunBudget {
  private usage: TokenUsage = { ...EMPTY_USAGE };
  private modelCalls = 0;
  private costCents = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly limits: BudgetLimits,
    private readonly cacheTtl: CacheTtl,
    private readonly at: Date = new Date(),
  ) {}

  /** Records a model call and its cost. Returns the incremental cost in cents. */
  recordModelCall(usage: TokenUsage, modelId: string): number {
    this.modelCalls++;
    this.usage = addUsage(this.usage, usage);
    const cents = computeCostCents(usage, modelId, this.cacheTtl, this.at);
    this.costCents += cents;
    return cents;
  }

  get totals(): { usage: TokenUsage; costCents: number; modelCalls: number } {
    return {
      usage: this.usage,
      costCents: this.costCents,
      modelCalls: this.modelCalls,
    };
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Null when there is room to continue; otherwise the reason to abort. */
  check(stepsTakenByPersona: number): AbortReason | null {
    if (stepsTakenByPersona >= this.limits.maxStepsPerPersona) return "step_cap";
    if (this.modelCalls >= this.limits.maxModelCallsPerRun) return "model_call_cap";
    if (this.elapsedMs >= this.limits.maxWallClockMs) return "wall_clock";
    if (this.costCents >= this.limits.maxCostCents) return "cost_cap";
    return null;
  }

  /**
   * Pre-flight check for one more model call, so we stop BEFORE spending rather
   * than after. Without this the cost cap is always exceeded by one call.
   */
  canAffordAnotherCall(): AbortReason | null {
    if (this.modelCalls >= this.limits.maxModelCallsPerRun) return "model_call_cap";
    if (this.elapsedMs >= this.limits.maxWallClockMs) return "wall_clock";
    if (this.costCents >= this.limits.maxCostCents) return "cost_cap";
    return null;
  }
}

export function describeAbort(reason: AbortReason): string {
  switch (reason) {
    case "step_cap":
      return "reached the step limit for this persona";
    case "model_call_cap":
      return "reached the model-call limit for this run";
    case "wall_clock":
      return "reached the time limit for this run";
    case "cost_cap":
      return "reached the cost limit for this run";
    case "preflight_failed":
      return "the site could not be reached or was not testable";
    case "internal_error":
      return "an internal error ended the run early";
  }
}
