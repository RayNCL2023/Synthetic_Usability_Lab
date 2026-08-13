import { EMPTY_USAGE, type Decision } from "@sul/shared";
import type {
  ClusterInput,
  ClusterResult,
  DecideInput,
  DecideResult,
  ModelClient,
} from "./client.js";

/**
 * An offline stand-in for the model, used by `--mock` on the CLI and by the
 * seeded demo run.
 *
 * This is NOT a persona and makes no claim to be one — it is a deterministic
 * keyword walker that produces a structurally valid, grounded journey so the
 * rest of the pipeline (snapshot -> validate -> act -> persist -> cost) can be
 * exercised without an API key. Its "observations" are canned.
 *
 * It reports realistic token counts so cost accounting runs through the real
 * pricing table rather than being skipped in offline mode.
 */

/**
 * Ordered by priority, not alphabetically. A real persona pursuing "find
 * pricing and start a trial" explores toward the price first and only then
 * converts — going straight for the trial link would skip the journey the goal
 * describes and produce a one-step run that tests nothing.
 */
const GOAL_KEYWORDS = [
  "pricing",
  "price",
  "rate",
  "plan",
  "compare",
  "product",
  "trial",
  "sign up",
  "get started",
];

function keywordRank(name: string): number {
  const lower = name.toLowerCase();
  const i = GOAL_KEYWORDS.findIndex((k) => lower.includes(k));
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

interface ParsedRef {
  ref: string;
  role: string;
  name: string;
}

/** Reads back the rendered tree so the mock is grounded by construction. */
function parseTree(tree: string): ParsedRef[] {
  const out: ParsedRef[] = [];
  for (const line of tree.split("\n")) {
    const m = /^\s*(s\d+e\d+)\s+(\S+)(?:\s+"([^"]*)")?/.exec(line);
    if (m && m[1] && m[2]) out.push({ ref: m[1], role: m[2], name: m[3] ?? "" });
  }
  return out;
}

export class HeuristicModelClient implements ModelClient {
  private stepsTaken = 0;
  private visited = new Set<string>();
  private recovered = false;

  constructor(
    private readonly modelId = "claude-sonnet-5",
    private readonly maxSteps = 5,
  ) {}

  async decide(input: DecideInput): Promise<DecideResult> {
    const nodes = parseTree(input.snapshotTree);
    const usage = {
      ...EMPTY_USAGE,
      // Sized to resemble a real step so the printed cost is representative:
      // snapshot + history + persona prefix in, a compact object out.
      inputTokens: 1800 + Math.round(input.snapshotTree.length / 4),
      outputTokens: 220,
      cacheReadTokens: this.stepsTaken === 0 ? 0 : 640,
      cacheWriteTokens: this.stepsTaken === 0 ? 640 : 0,
    };

    const base = {
      stopReason: "end_turn" as const,
      usage,
      modelId: this.modelId,
      latencyMs: 40,
    };

    this.stepsTaken++;

    const candidate = nodes
      .filter(
        (n) =>
          n.role === "link" &&
          n.name &&
          !this.visited.has(n.name.toLowerCase()) &&
          keywordRank(n.name) !== Number.MAX_SAFE_INTEGER,
      )
      .sort((a, b) => keywordRank(a.name) - keywordRank(b.name))[0];

    // Reached a page that states prices. That satisfies half the goal — the
    // walker keeps going if there is still a trial route to follow, so the
    // journey resembles the one the goal describes rather than stopping at the
    // first price it sees.
    const looksLikePricing = /\$\d|per seat|per month/i.test(input.snapshotTree);

    // If the last action failed — typically a click blocked by a modal overlay
    // — try scrolling once before concluding there is nowhere left to go. A
    // real persona reacts to being blocked rather than immediately quitting,
    // and the retry is what surfaces the overlay as friction rather than as a
    // dead end.
    const lastFailed = /failed:/.test(input.historySummary);
    if (lastFailed && !this.recovered && this.stepsTaken < this.maxSteps) {
      this.recovered = true;
      return {
        ...base,
        decision: {
          narration: "Something is covering the page — let me scroll and look again.",
          reasoning: "offline heuristic walker: recovering from a blocked action",
          action: {
            type: "scroll",
            ref: null,
            text: null,
            direction: "down",
            outcome: null,
          },
          observations: [],
        },
      };
    }

    if (!candidate || this.stepsTaken >= this.maxSteps) {
      const observation = nodes.find((n) => n.role === "link" || n.role === "heading");
      const decision: Decision = {
        narration: looksLikePricing
          ? "Found the numbers, but it took four pages to get here."
          : "I have run out of obvious places to look.",
        reasoning: "offline heuristic walker",
        action: {
          type: "finish",
          ref: null,
          text: null,
          direction: null,
          outcome: looksLikePricing ? "goal_achieved" : "gave_up",
        },
        observations: observation
          ? [
              {
                severity: "major" as const,
                category: "navigation" as const,
                ref: observation.ref,
                quote: "It took me four pages to find a price.",
                description:
                  "Pricing is not reachable from the primary navigation and requires " +
                  "three intermediate pages.",
              },
            ]
          : [],
      };
      return { ...base, decision };
    }

    this.visited.add(candidate.name.toLowerCase());
    return {
      ...base,
      decision: {
        narration: `Trying "${candidate.name}" — that looks like the way to pricing.`,
        reasoning: "offline heuristic walker",
        action: {
          type: "click",
          ref: candidate.ref,
          text: null,
          direction: null,
          outcome: null,
        },
        observations: [],
      },
    };
  }

  async cluster(input: ClusterInput): Promise<ClusterResult> {
    const byCategory = new Map<string, typeof input.observations>();
    for (const o of input.observations) {
      const list = byCategory.get(o.category) ?? [];
      list.push(o);
      byCategory.set(o.category, list);
    }

    return {
      issues: [...byCategory.entries()].map(([category, obs]) => ({
        title: obs[0]?.description.slice(0, 70) ?? category,
        description: obs[0]?.description ?? "",
        recommendation:
          "Surface this directly in the primary navigation rather than behind " +
          "intermediate pages.",
        category: category as ClusterResult["issues"][number]["category"],
        severity: obs[0]?.severity ?? "minor",
        observationIds: obs.map((o) => o.observationId),
      })),
      stopReason: "end_turn",
      usage: { ...EMPTY_USAGE, inputTokens: 900, outputTokens: 300 },
      modelId: this.modelId,
      latencyMs: 30,
    };
  }
}
