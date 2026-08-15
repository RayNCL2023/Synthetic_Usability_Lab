import { GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import * as z from "zod/v4";
import {
  CATEGORIES,
  DecisionSchema,
  EMPTY_USAGE,
  SEVERITIES,
  type TokenUsage,
} from "@sul/shared";
import type {
  ClusterInput,
  ClusterResult,
  DecideInput,
  DecideResult,
  ModelClient,
  StopReason,
} from "./client.js";
import { zodToGeminiSchema } from "./gemini-schema.js";
import {
  DEFAULT_BACKOFF,
  DailyQuotaExhaustedError,
  TokenBucketLimiter,
  backoffDelayMs,
  classifyRateLimit,
  sleep,
} from "./ratelimit.js";
import { CLUSTER_SYSTEM_PROMPT } from "./anthropic.js";

/**
 * Gemini implementation of ModelClient.
 *
 * Two token-accounting differences from Anthropic that the cost model has to
 * respect, both confirmed against the shipped SDK types:
 *
 *  1. `totalTokenCount` is documented as the SUM of promptTokenCount,
 *     candidatesTokenCount, toolUsePromptTokenCount and thoughtsTokenCount —
 *     so thinking tokens are NOT inside candidatesTokenCount. Anthropic is the
 *     opposite (its output_tokens is inclusive of thinking). Mapping
 *     candidatesTokenCount straight onto our outputTokens would therefore
 *     UNDERCOUNT billable output on every thinking-enabled call.
 *
 *  2. `promptTokenCount` is documented to already include the cached-content
 *     tokens. Adding cachedContentTokenCount as a separate cache-read figure
 *     without subtracting it from the prompt count would DOUBLE-COUNT the
 *     cached prefix.
 *
 * Both are handled in `usageFrom` below.
 */

const ClusterResponseSchema = z.object({
  issues: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      recommendation: z.string(),
      category: z.enum(CATEGORIES),
      severity: z.enum(SEVERITIES),
      observationIds: z.array(z.string()),
    }),
  ),
});

const { schema: DECISION_SCHEMA } = zodToGeminiSchema(DecisionSchema);
const { schema: CLUSTER_SCHEMA } = zodToGeminiSchema(ClusterResponseSchema);

export interface GeminiClientOptions {
  apiKey: string;
  loopModel: string;
  loopMaxTokens: number;
  clusterModel: string;
  clusterMaxTokens: number;
  /**
   * Shared across every persona worker in the process. Three workers running
   * in parallel against a 10 RPM free tier will otherwise burst straight into
   * 429s on the first step of every run.
   */
  limiter: TokenBucketLimiter;
  /** Gemini has no effort parameter; thinking budget is the nearest analogue. */
  thinkingBudget?: number;
}

/**
 * Maps Gemini's finishReason onto the same three-way branch the loop uses for
 * Anthropic's stop_reason, so the agent loop needs no provider awareness.
 *
 *   MAX_TOKENS            -> truncation: raise the budget, do NOT re-prompt
 *   SAFETY / RECITATION   -> refusal: stop this persona, never retry as-is
 *   BLOCKLIST / PROHIBITED_CONTENT / SPII -> refusal, same reasoning
 *   STOP                  -> normal completion
 *   anything else         -> unknown, treated as a parse failure (retryable once)
 */
export function mapFinishReason(raw: string | undefined | null): StopReason {
  switch (raw) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
      return "refusal";
    default:
      return "unknown";
  }
}

export function usageFrom(
  meta: GenerateContentResponse["usageMetadata"] | undefined,
): TokenUsage {
  if (!meta) return { ...EMPTY_USAGE };

  const prompt = meta.promptTokenCount ?? 0;
  const cached = meta.cachedContentTokenCount ?? 0;
  const candidates = meta.candidatesTokenCount ?? 0;
  const thoughts = meta.thoughtsTokenCount ?? 0;

  return {
    // promptTokenCount already includes the cached tokens — subtract so the
    // cached prefix is not billed twice, once at full rate and once at the
    // cache-read rate.
    inputTokens: Math.max(0, prompt - cached),
    // thoughtsTokenCount is a SEPARATE addend in Gemini's total, unlike
    // Anthropic's inclusive output_tokens. Billable output is the sum.
    outputTokens: candidates + thoughts,
    // Gemini's implicit/explicit caching reports reads only; there is no
    // separate cache-write charge to account for.
    cacheWriteTokens: 0,
    cacheReadTokens: cached,
  };
}

function extractText(res: GenerateContentResponse): string | null {
  const parts = res.candidates?.[0]?.content?.parts;
  if (!parts) return null;
  for (const p of parts) {
    if (typeof p.text === "string" && p.text.trim()) return p.text;
  }
  return null;
}

interface HttpishError {
  status?: number;
  message?: string;
  headers?: Record<string, string | undefined>;
}

function statusOf(err: unknown): number | undefined {
  const e = err as HttpishError;
  if (typeof e?.status === "number") return e.status;
  const m = /\b(\d{3})\b/.exec(e?.message ?? "");
  return m?.[1] ? Number(m[1]) : undefined;
}

export class GeminiModelClient implements ModelClient {
  private readonly client: GoogleGenAI;

  constructor(private readonly opts: GeminiClientOptions) {
    this.client = new GoogleGenAI({ apiKey: opts.apiKey });
  }

  /**
   * Every provider call goes through here: acquire a token from the shared
   * bucket, then retry per-minute 429s with jittered backoff while failing
   * fast on a daily cap.
   */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      await this.opts.limiter.acquire();
      try {
        return await fn();
      } catch (err) {
        const status = statusOf(err);

        // 503 UNAVAILABLE ("high demand") and the other transient 5xx are
        // common on a free tier and are exactly as recoverable as a
        // per-minute 429 — observed killing a real run at step 1. Retrying
        // only 429 leaves the run at the mercy of ordinary provider load.
        const transient5xx =
          status !== undefined && status >= 500 && status < 600;

        if (status !== 429 && !transient5xx) throw err;

        let wait: number;
        if (status === 429) {
          const e = err as HttpishError;
          const cls = classifyRateLimit(429, e.message ?? "", e.headers);
          if (cls.kind === "daily") {
            // Backoff cannot recover a daily cap. Retrying would spend the
            // run's entire wall-clock budget and still fail.
            throw new DailyQuotaExhaustedError(cls.detail);
          }
          attempt++;
          if (attempt >= DEFAULT_BACKOFF.maxAttempts) throw err;
          wait = cls.retryAfterMs ?? backoffDelayMs(attempt);
        } else {
          attempt++;
          if (attempt >= DEFAULT_BACKOFF.maxAttempts) throw err;
          wait = backoffDelayMs(attempt);
        }

        // Stop the whole bucket, not just this caller — the other persona
        // workers are about to fire into a provider we already know is
        // refusing traffic.
        this.opts.limiter.penalise(wait);
        await sleep(wait);
      }
    }
  }

  async decide(input: DecideInput): Promise<DecideResult> {
    const started = Date.now();

    const parts: Array<Record<string, unknown>> = [];
    if (input.screenshotJpeg) {
      parts.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: input.screenshotJpeg.toString("base64"),
        },
      });
    }
    parts.push({
      text: [
        `GOAL: ${input.goal}`,
        "",
        input.historySummary
          ? `WHAT YOU HAVE DONE SO FAR:\n${input.historySummary}`
          : "This is your first step.",
        "",
        "SNAPSHOT OF THE CURRENT PAGE:",
        input.snapshotTree,
        "",
        input.screenshotJpeg
          ? "A screenshot of the current viewport is attached."
          : "You have no screenshot. The snapshot above is everything you perceive.",
        "",
        "Decide your next action.",
      ].join("\n"),
    });

    if (input.retryProblems?.length) {
      parts.push({
        text: [
          "Your previous response could not be used:",
          ...input.retryProblems.map((p) => `  - ${p}`),
          "",
          "Respond again using only refs from the snapshot above.",
        ].join("\n"),
      });
    }

    const res = await this.call(() =>
      this.client.models.generateContent({
        model: this.opts.loopModel,
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction: input.systemPrompt,
          maxOutputTokens: this.opts.loopMaxTokens,
          responseMimeType: "application/json",
          responseSchema: DECISION_SCHEMA,
          ...(this.opts.thinkingBudget !== undefined
            ? { thinkingConfig: { thinkingBudget: this.opts.thinkingBudget } }
            : {}),
        },
      }),
    );

    const finish = res.candidates?.[0]?.finishReason;
    const stopReason = mapFinishReason(finish);
    const usage = usageFrom(res.usageMetadata);
    const base = {
      stopReason,
      usage,
      modelId: this.opts.loopModel,
      latencyMs: Date.now() - started,
    };

    if (stopReason === "refusal") {
      return { ...base, decision: null, refusalCategory: finish ?? null };
    }
    if (stopReason === "max_tokens") {
      return { ...base, decision: null, parseError: "response truncated" };
    }

    const text = extractText(res);
    if (!text) {
      return { ...base, decision: null, parseError: "no text part in response" };
    }

    const parsed = DecisionSchema.safeParse(safeJson(text));
    if (!parsed.success) {
      return {
        ...base,
        decision: null,
        parseError: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      };
    }

    return { ...base, decision: parsed.data };
  }

  async cluster(input: ClusterInput): Promise<ClusterResult> {
    const started = Date.now();

    const lines = input.observations.map(
      (o) =>
        `[${o.observationId}] persona=${o.personaName} step=${o.stepIndex} ` +
        `severity=${o.severity} category=${o.category}\n` +
        `  element: ${o.elementDescription}\n` +
        `  said: ${JSON.stringify(o.quote)}\n` +
        `  issue: ${o.description}`,
    );

    const res = await this.call(() =>
      this.client.models.generateContent({
        model: this.opts.clusterModel,
        contents: [
          {
            role: "user",
            parts: [
              {
                text: [
                  `SITE: ${input.url}`,
                  `GOAL THE PERSONAS WERE PURSUING: ${input.goal}`,
                  "",
                  `OBSERVATIONS (${input.observations.length}):`,
                  ...lines,
                ].join("\n"),
              },
            ],
          },
        ],
        config: {
          systemInstruction: CLUSTER_SYSTEM_PROMPT,
          maxOutputTokens: this.opts.clusterMaxTokens,
          responseMimeType: "application/json",
          responseSchema: CLUSTER_SCHEMA,
        },
      }),
    );

    const stopReason = mapFinishReason(res.candidates?.[0]?.finishReason);
    const base = {
      stopReason,
      usage: usageFrom(res.usageMetadata),
      modelId: this.opts.clusterModel,
      latencyMs: Date.now() - started,
    };

    const text = extractText(res);
    if (!text) return { ...base, issues: [] };

    const parsed = ClusterResponseSchema.safeParse(safeJson(text));
    if (!parsed.success) return { ...base, issues: [] };

    // Drop invented ids — the report's citations must resolve or the "exact
    // screenshot and quote" promise breaks.
    const known = new Set(input.observations.map((o) => o.observationId));
    const issues = parsed.data.issues
      .map((i) => ({
        ...i,
        observationIds: i.observationIds.filter((id) => known.has(id)),
      }))
      .filter((i) => i.observationIds.length > 0);

    return { ...base, issues };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}
