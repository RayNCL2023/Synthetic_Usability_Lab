import type { Decision, Severity, Category, TokenUsage } from "@sul/shared";

/**
 * The model seam.
 *
 * One real implementation and one recorded double. This exists for two concrete
 * reasons, not for provider-agnosticism: a single choke point for cost
 * accounting, and a deterministic test path. Three call sites use it on day one
 * — the agent loop, clustering, and tests.
 */

export interface DecideInput {
  /** Byte-stable across every step of every run — this is the cached prefix. */
  systemPrompt: string;
  goal: string;
  snapshotTree: string;
  /** Omitted entirely for the screen-reader persona. */
  screenshotJpeg: Buffer | null;
  /** Compact prior-step summary; keeps context bounded on long journeys. */
  historySummary: string;
  /** Set on a retry; carries the validator's problems back to the model. */
  retryProblems?: string[];
}

/**
 * Why a model call ended. The agent loop branches on this because `max_tokens`
 * and a bad ref look similar but need opposite responses: the first needs a
 * bigger budget (the model was not wrong), the second needs a re-prompt (a
 * bigger budget would change nothing). Conflating them is the most likely way
 * to build a runaway retry loop.
 */
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "refusal"
  | "tool_use"
  | "pause_turn"
  | "unknown";

export interface DecideResult {
  decision: Decision | null;
  stopReason: StopReason;
  usage: TokenUsage;
  modelId: string;
  latencyMs: number;
  /** Set when stopReason is "refusal". */
  refusalCategory?: string | null;
  /** Set when the response could not be parsed into a Decision. */
  parseError?: string;
}

export interface ClusterObservationInput {
  observationId: string;
  personaKey: string;
  personaName: string;
  severity: Severity;
  category: Category;
  elementDescription: string;
  quote: string;
  description: string;
  /** Step index, used for the "how early in the journey" ranking tiebreak. */
  stepIndex: number;
}

export interface ClusterInput {
  url: string;
  goal: string;
  observations: ClusterObservationInput[];
}

export interface ClusteredIssue {
  title: string;
  description: string;
  recommendation: string;
  category: Category;
  severity: Severity;
  observationIds: string[];
}

export interface ClusterResult {
  issues: ClusteredIssue[];
  stopReason: StopReason;
  usage: TokenUsage;
  modelId: string;
  latencyMs: number;
}

export interface ModelClient {
  decide(input: DecideInput): Promise<DecideResult>;
  cluster(input: ClusterInput): Promise<ClusterResult>;
}
