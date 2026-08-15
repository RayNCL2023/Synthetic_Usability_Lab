import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
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

/**
 * Anthropic implementation.
 *
 * Uses structured outputs (output_config.format) rather than forced tool use.
 * The action schema is a response shape, not a side-effecting call, and this
 * way exactly one Zod definition feeds the API, the validator, and the TS
 * types. (Forced tool_choice alongside enabled thinking is rejected on Amazon
 * Bedrock but permitted on the first-party API — noted here because it becomes
 * relevant if this is ever routed through Bedrock.)
 *
 * Both Opus 5 and Sonnet 5 run adaptive thinking by default and default to
 * `high` effort, so effort is set explicitly on every request. Omitting it is
 * not "off" — it is the most expensive setting.
 */

export interface AnthropicClientOptions {
  apiKey: string;
  loopModel: string;
  loopEffort: "low" | "medium" | "high" | "xhigh" | "max";
  loopMaxTokens: number;
  clusterModel: string;
  clusterEffort: "low" | "medium" | "high" | "xhigh" | "max";
  clusterMaxTokens: number;
  cacheTtl: "5m" | "1h";
  maxRetries?: number;
  requestTimeoutMs?: number;
}

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

/**
 * Output formats derived from the shared Zod schemas — one definition feeding
 * the API request, the local validator, and the TS types.
 *
 * VERIFIED BEHAVIOUR, and it matters: `zodOutputFormat` runs the schema through
 * the SDK's `transformJSONSchema`, which keeps only an allowlist of keywords.
 * `enum` is NOT on that allowlist — it is demoted into the property's
 * `description` as prose, e.g.
 *
 *   "type": { "type": "string", "description": "{enum: [\"click\", ...]}" }
 *
 * So the model is TOLD the permitted values but generation is not CONSTRAINED
 * to them. Every enum we rely on — action type, severity, category, direction,
 * outcome — is advisory at the API boundary.
 *
 * The consequence is that `DecisionSchema.safeParse` below is not a belt-and-
 * braces double check; it is the only thing actually enforcing the enums, and
 * the parse-failure retry path is load-bearing rather than theoretical.
 * `.nullable()` likewise becomes `anyOf: [{type:"string"},{type:"null"}]`
 * rather than a `type` array.
 */
const DECISION_FORMAT = zodOutputFormat(DecisionSchema);
const CLUSTER_FORMAT = zodOutputFormat(ClusterResponseSchema);

function toStopReason(raw: string | null | undefined): StopReason {
  switch (raw) {
    case "end_turn":
    case "max_tokens":
    case "refusal":
    case "tool_use":
    case "pause_turn":
      return raw;
    default:
      return "unknown";
  }
}

function usageFrom(u: Anthropic.Usage | undefined): TokenUsage {
  if (!u) return { ...EMPTY_USAGE };
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}

function firstText(content: Anthropic.ContentBlock[]): string | null {
  for (const block of content) {
    if (block.type === "text") return block.text;
  }
  return null;
}

export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicClientOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      // The SDK retries 408/409/429/5xx with backoff. Raised from the default
      // of 2; retries still count against the run's model-call budget so a
      // retry storm cannot outrun the cap.
      maxRetries: opts.maxRetries ?? 4,
      // Milliseconds in the TypeScript SDK (seconds in Python — easy to get
      // wrong when porting).
      timeout: opts.requestTimeoutMs ?? 90_000,
    });
  }

  async decide(input: DecideInput): Promise<DecideResult> {
    const started = Date.now();

    const userContent: Anthropic.ContentBlockParam[] = [];

    if (input.screenshotJpeg) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: input.screenshotJpeg.toString("base64"),
        },
      });
    }

    userContent.push({
      type: "text",
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
      userContent.push({
        type: "text",
        text: [
          "Your previous response could not be used:",
          ...input.retryProblems.map((p) => `  - ${p}`),
          "",
          "Respond again using only refs from the snapshot above.",
        ].join("\n"),
      });
    }

    const response = await this.client.messages.create({
      model: this.opts.loopModel,
      max_tokens: this.opts.loopMaxTokens,
      // Explicit: both current models default to `high` and adaptive thinking.
      output_config: {
        effort: this.opts.loopEffort,
        format: DECISION_FORMAT,
      },
      system: [
        {
          type: "text",
          text: input.systemPrompt,
          // The stable prefix. The goal deliberately lives in the user turn so
          // this block stays byte-identical across every run of this persona.
          cache_control: { type: "ephemeral", ttl: this.opts.cacheTtl },
        },
      ],
      messages: [{ role: "user", content: userContent }],
    });

    const stopReason = toStopReason(response.stop_reason);
    const usage = usageFrom(response.usage);
    const latencyMs = Date.now() - started;
    const base = { stopReason, usage, modelId: response.model, latencyMs };

    // Branch BEFORE reading content — a refusal has empty or partial content
    // and indexing into it blindly is how this crashes on a live site.
    if (stopReason === "refusal") {
      return {
        ...base,
        decision: null,
        refusalCategory:
          (response as { stop_details?: { category?: string } }).stop_details?.category ??
          null,
      };
    }

    // A truncated object is not a hallucination — the model ran out of room.
    // The caller responds by raising max_tokens, not by re-prompting.
    if (stopReason === "max_tokens") {
      return { ...base, decision: null, parseError: "response truncated" };
    }

    const text = firstText(response.content);
    if (!text) {
      return { ...base, decision: null, parseError: "no text block in response" };
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

    const response = await this.client.messages.create({
      model: this.opts.clusterModel,
      max_tokens: this.opts.clusterMaxTokens,
      output_config: {
        effort: this.opts.clusterEffort,
        format: CLUSTER_FORMAT,
      },
      system: [
        {
          type: "text",
          text: CLUSTER_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral", ttl: this.opts.cacheTtl },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            `SITE: ${input.url}`,
            `GOAL THE PERSONAS WERE PURSUING: ${input.goal}`,
            "",
            `OBSERVATIONS (${input.observations.length}):`,
            ...lines,
          ].join("\n"),
        },
      ],
    });

    const stopReason = toStopReason(response.stop_reason);
    const usage = usageFrom(response.usage);
    const base = {
      stopReason,
      usage,
      modelId: response.model,
      latencyMs: Date.now() - started,
    };

    if (stopReason === "refusal") return { ...base, issues: [] };

    const text = firstText(response.content);
    if (!text) return { ...base, issues: [] };

    const parsed = ClusterResponseSchema.safeParse(safeJson(text));
    if (!parsed.success) return { ...base, issues: [] };

    // Drop any observation id the model invented — the report's citations must
    // resolve, or the "exact screenshot and quote" promise breaks.
    const known = new Set(input.observations.map((o) => o.observationId));
    const issues = parsed.data.issues
      .map((i) => ({ ...i, observationIds: i.observationIds.filter((id) => known.has(id)) }))
      .filter((i) => i.observationIds.length > 0);

    return { ...base, issues };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Structured outputs should make this unreachable, but a stray code fence
    // is a cheap thing to survive.
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

export const CLUSTER_SYSTEM_PROMPT = `
You are consolidating usability observations from several AI personas who each
browsed the same site pursuing the same goal.

Your job is to group observations that describe THE SAME underlying problem into
a single issue, and to leave genuinely distinct problems separate.

Rules:
- Two observations belong together when fixing one would fix the other. Two
  personas complaining about the same unlabelled control is one issue. A missing
  label and a missing price are two issues, even if both are on the same page.
- Write the title as the problem, not the symptom: "Pricing requires three
  clicks from the homepage", not "User was confused".
- The description must be neutral and specific. No adjectives about the user's
  emotional state.
- The recommendation must be something a developer could act on this week. Not
  "improve the CTA" — say what to change.
- Every issue must cite the observation ids it came from. Never invent an id.
- Do not merge aggressively to produce a tidy list. Two issues that share a page
  but not a cause are two issues.
- If an observation is too vague to act on, leave it out rather than inflating a
  cluster with it.

Severity: use the highest severity among an issue's observations, and raise it
one level when two or more DISTINCT personas reported it — cross-persona
agreement is the strongest signal available.
`.trim();
