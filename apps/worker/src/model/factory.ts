import {
  GeminiEnv,
  ModelEnv,
  ProviderEnv,
  loadEnv,
  type ModelConfig,
} from "@sul/shared";
import type { ModelClient } from "./client.js";
import { AnthropicModelClient } from "./anthropic.js";
import { GeminiModelClient } from "./gemini.js";
import { HeuristicModelClient } from "./heuristic.js";
import { TokenBucketLimiter } from "./ratelimit.js";

/**
 * Provider selection.
 *
 * Gemini is the default because it is what the project actually runs on; the
 * Anthropic client stays in place behind `SUL_PROVIDER=anthropic` so the
 * comparison stays cheap to make and the eval sweep can cover both.
 *
 * The rate limiter is created ONCE here and shared by every persona worker in
 * the process. That is the whole point of putting construction behind a
 * factory: three workers each building their own limiter would enforce three
 * times the intended rate, which on a free tier means immediate 429s.
 */

let sharedLimiter: TokenBucketLimiter | null = null;

export interface BuiltModel {
  client: ModelClient;
  config: ModelConfig;
  /** True when costs are computed at published rates but nothing was spent. */
  notional: boolean;
}

export function buildModelClient(opts: { mock?: boolean } = {}): BuiltModel {
  if (opts.mock) {
    return {
      client: new HeuristicModelClient("claude-sonnet-5", 5),
      config: {
        loopModel: "claude-sonnet-5",
        loopEffort: "n/a (mock)",
        clusterModel: "claude-sonnet-5",
        clusterEffort: "n/a (mock)",
        cacheTtl: "5m",
      },
      notional: true,
    };
  }

  const { SUL_PROVIDER } = loadEnv(ProviderEnv);

  if (SUL_PROVIDER === "gemini") {
    const env = loadEnv(GeminiEnv);
    if (!sharedLimiter) {
      sharedLimiter = new TokenBucketLimiter({
        requestsPerMinute: env.SUL_GEMINI_RPM,
        burst: env.SUL_GEMINI_BURST,
      });
    }
    return {
      client: new GeminiModelClient({
        apiKey: env.GEMINI_API_KEY,
        loopModel: env.SUL_GEMINI_LOOP_MODEL,
        loopMaxTokens: loadEnv(ModelEnv.omit({ ANTHROPIC_API_KEY: true }))
          .SUL_LOOP_MAX_TOKENS,
        clusterModel: env.SUL_GEMINI_CLUSTER_MODEL,
        clusterMaxTokens: loadEnv(ModelEnv.omit({ ANTHROPIC_API_KEY: true }))
          .SUL_CLUSTER_MAX_TOKENS,
        limiter: sharedLimiter,
        ...(env.SUL_GEMINI_THINKING_BUDGET >= 0
          ? { thinkingBudget: env.SUL_GEMINI_THINKING_BUDGET }
          : {}),
      }),
      config: {
        loopModel: env.SUL_GEMINI_LOOP_MODEL,
        // Gemini has no effort parameter; thinking budget is the analogue.
        loopEffort: `thinkingBudget=${env.SUL_GEMINI_THINKING_BUDGET}`,
        clusterModel: env.SUL_GEMINI_CLUSTER_MODEL,
        clusterEffort: `thinkingBudget=${env.SUL_GEMINI_THINKING_BUDGET}`,
        cacheTtl: "5m",
      },
      // Free tier: the figures are computed at published paid rates so they
      // are comparable, but no money changed hands.
      notional: true,
    };
  }

  const env = loadEnv(ModelEnv);
  return {
    client: new AnthropicModelClient({
      apiKey: env.ANTHROPIC_API_KEY,
      loopModel: env.SUL_LOOP_MODEL,
      loopEffort: env.SUL_LOOP_EFFORT,
      loopMaxTokens: env.SUL_LOOP_MAX_TOKENS,
      clusterModel: env.SUL_CLUSTER_MODEL,
      clusterEffort: env.SUL_CLUSTER_EFFORT,
      clusterMaxTokens: env.SUL_CLUSTER_MAX_TOKENS,
      cacheTtl: env.SUL_CACHE_TTL,
    }),
    config: {
      loopModel: env.SUL_LOOP_MODEL,
      loopEffort: env.SUL_LOOP_EFFORT,
      clusterModel: env.SUL_CLUSTER_MODEL,
      clusterEffort: env.SUL_CLUSTER_EFFORT,
      cacheTtl: env.SUL_CACHE_TTL,
    },
    notional: false,
  };
}

/** Test seam — lets a suite reset the process-wide limiter between cases. */
export function resetSharedLimiter(): void {
  sharedLimiter = null;
}
