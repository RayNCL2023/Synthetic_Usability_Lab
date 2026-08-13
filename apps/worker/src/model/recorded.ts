import { EMPTY_USAGE, type Decision } from "@sul/shared";
import type {
  ClusterInput,
  ClusterResult,
  DecideInput,
  DecideResult,
  ModelClient,
  StopReason,
} from "./client.js";

/**
 * Deterministic model double for unit and integration tests.
 *
 * Everything except `pnpm eval` runs against this. Scripted responses are
 * consumed in order; when the script runs out, the double finishes the run with
 * `gave_up` rather than hanging, so a test that under-scripts fails visibly
 * instead of timing out.
 */

export interface ScriptedDecision {
  decision?: Decision;
  stopReason?: StopReason;
  usage?: Partial<{
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
  }>;
  parseError?: string;
  refusalCategory?: string;
}

export class RecordedModelClient implements ModelClient {
  private index = 0;
  /** Every call is recorded so tests can assert on retry behaviour. */
  readonly calls: DecideInput[] = [];
  readonly clusterCalls: ClusterInput[] = [];

  constructor(
    private readonly script: ScriptedDecision[],
    private readonly clusterResponse: ClusterResult["issues"] = [],
    // Deliberately a REAL model id, not "recorded-model". Cost accounting
    // fails loudly on an unknown model, so a fake id here would either force a
    // test fixture into the production pricing table or push every test around
    // the cost path entirely — and cost accounting is exactly the thing we
    // want exercised on every run through the loop.
    private readonly modelId = "claude-sonnet-5",
  ) {}

  get callCount(): number {
    return this.index;
  }

  async decide(input: DecideInput): Promise<DecideResult> {
    this.calls.push(input);
    const scripted = this.script[this.index];
    this.index++;

    if (!scripted) {
      return {
        decision: giveUp("script exhausted"),
        stopReason: "end_turn",
        usage: { ...EMPTY_USAGE },
        modelId: this.modelId,
        latencyMs: 0,
      };
    }

    return {
      decision: scripted.decision ?? null,
      stopReason: scripted.stopReason ?? "end_turn",
      usage: { ...EMPTY_USAGE, ...scripted.usage },
      modelId: this.modelId,
      latencyMs: 1,
      parseError: scripted.parseError,
      refusalCategory: scripted.refusalCategory ?? null,
    };
  }

  async cluster(input: ClusterInput): Promise<ClusterResult> {
    this.clusterCalls.push(input);
    return {
      issues: this.clusterResponse,
      stopReason: "end_turn",
      usage: { ...EMPTY_USAGE },
      modelId: this.modelId,
      latencyMs: 1,
    };
  }
}

export function giveUp(reason: string): Decision {
  return {
    narration: reason,
    reasoning: reason,
    action: { type: "finish", ref: null, text: null, direction: null, outcome: "gave_up" },
    observations: [],
  };
}

export function clickDecision(ref: string, narration = "Trying this."): Decision {
  return {
    narration,
    reasoning: "next step",
    action: { type: "click", ref, text: null, direction: null, outcome: null },
    observations: [],
  };
}

export function scrollDecision(narration = "Looking further down."): Decision {
  return {
    narration,
    reasoning: "need to see more",
    action: { type: "scroll", ref: null, text: null, direction: "down", outcome: null },
    observations: [],
  };
}
