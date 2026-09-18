import type { RunPayload, Severity } from "./api";
import { buildHeroTrack, type HeroTrack } from "./hero-reel";

/**
 * Seeded runs, loaded straight from the committed JSON fixtures.
 *
 * The demo has ZERO runtime dependency on the API, the worker, Postgres, Redis,
 * or S3. It reads a file that is in the repository. That is the whole point: a
 * demo that needs a live service is not a fallback, it is one more thing that
 * can be down — and this is the artifact that has to survive everything else
 * slipping.
 *
 * Imports are dynamic and per-slug so Next code-splits them: a visitor to one
 * replay does not download the other three.
 *
 * Adding a run is two lines here plus the committed fixture. The order of
 * SEEDED_SLUGS is the order they appear on the landing page.
 */

/** Ordered deliberately. Hacker News leads — it is the run that sells the product. */
export const SEEDED_SLUGS = [
  "hacker-news",
  "fixture-badsite",
  "gnu-org",
  "cern-info",
] as const;

export type SeededSlug = (typeof SEEDED_SLUGS)[number];

export function isSeededSlug(s: string): s is SeededSlug {
  return (SEEDED_SLUGS as readonly string[]).includes(s);
}

interface RawSeed {
  slug: string;
  capturedAt: string;
  run: Record<string, unknown>;
  personaRuns: Array<Record<string, unknown>>;
  steps: Array<Record<string, unknown>>;
  observations: Array<Record<string, unknown>>;
  issues: Array<Record<string, unknown>>;
  issueObservations: Array<{ issueId: string; observationId: string }>;
  events: Array<Record<string, unknown>>;
  references?: Array<{ url: string; capturedAt: string; screenshotUrl: string }>;
}

async function loadRaw(slug: SeededSlug): Promise<RawSeed> {
  switch (slug) {
    case "hacker-news":
      return (await import("../../../../fixtures/seeded-runs/hacker-news.json"))
        .default as unknown as RawSeed;
    case "fixture-badsite":
      return (
        await import("../../../../fixtures/seeded-runs/fixture-badsite.json")
      ).default as unknown as RawSeed;
    case "gnu-org":
      return (await import("../../../../fixtures/seeded-runs/gnu-org.json"))
        .default as unknown as RawSeed;
    case "cern-info":
      return (await import("../../../../fixtures/seeded-runs/cern-info.json"))
        .default as unknown as RawSeed;
  }
}

/**
 * Rebuilds the shape the API would have returned.
 *
 * The joins the API does in SQL are done here in memory. Keeping the output
 * shape identical is what lets the same components render a seeded replay and a
 * live run — the demo cannot drift from the real thing because it is the same
 * renderer fed the same structure.
 */
function toRunPayload(seed: RawSeed): RunPayload {
  const personaByRunId = new Map(
    seed.personaRuns.map((p) => [p["id"] as string, p["personaKey"] as string]),
  );

  const steps = seed.steps.map((s) => ({
    id: s["id"] as string,
    personaKey: personaByRunId.get(s["personaRunId"] as string) ?? "unknown",
    index: s["index"] as number,
    url: s["url"] as string,
    // Screenshots are embedded as data URIs in the fixture, so no bucket and
    // no presigned URL is involved anywhere in this path.
    screenshotUrl:
      (s["screenshotDataUri"] as string | null) ??
      (typeof s["screenshotKey"] === "string" &&
      (s["screenshotKey"] as string).startsWith("data:")
        ? (s["screenshotKey"] as string)
        : null),
    narration: (s["narration"] as string) ?? "",
    action: (s["actionJson"] as { type: string; ref: string | null }) ?? null,
  }));

  const obsById = new Map(seed.observations.map((o) => [o["id"] as string, o]));

  const issues = seed.issues
    .map((i) => {
      const links = seed.issueObservations.filter(
        (l) => l.issueId === (i["id"] as string),
      );
      const observations = links
        .map((l) => obsById.get(l.observationId))
        .filter(Boolean)
        .map((o) => {
          const rec = o as Record<string, unknown>;
          return {
            id: rec["id"] as string,
            severity: rec["severity"] as Severity,
            category: rec["category"] as string,
            quote: rec["quote"] as string,
            elementRef: rec["elementRef"] as string,
            elementDescription: rec["elementDescription"] as string,
            box: (rec["viewportBox"] as RunPayload["issues"][number]["observations"][number]["box"]) ?? null,
            personaKey:
              personaByRunId.get(rec["personaRunId"] as string) ?? "unknown",
            stepId: rec["stepId"] as string,
          };
        });

      return {
        id: i["id"] as string,
        title: i["title"] as string,
        description: i["description"] as string,
        severity: i["severity"] as Severity,
        category: i["category"] as string,
        rank: i["rank"] as number,
        recommendation: i["recommendation"] as string,
        personaKeys: [...new Set(observations.map((o) => o.personaKey))],
        observations,
      };
    })
    .sort((a, b) => a.rank - b.rank);

  const run = seed.run;
  return {
    run: {
      id: run["id"] as string,
      url: run["url"] as string,
      goal: run["goal"] as string,
      status: "finished",
      createdAt: run["createdAt"] as string,
      finishedAt: (run["finishedAt"] as string) ?? null,
      totalCostCents: (run["totalCostCents"] as number) ?? 0,
      totalTokens: (run["totalTokens"] as number) ?? 0,
      abortReason: (run["abortReason"] as string) ?? null,
      modelConfig: (run["modelConfig"] as RunPayload["run"]["modelConfig"]) ?? null,
      slug: seed.slug,
      isDemo: true,
    },
    personaRuns: seed.personaRuns.map((p) => ({
      personaKey: p["personaKey"] as string,
      status: p["status"] as string,
      outcome: (p["outcome"] as string) ?? null,
      stepCount: (p["stepCount"] as number) ?? 0,
      blockedReason: (p["blockedReason"] as string) ?? null,
      currentActionLabel: null,
    })),
    steps,
    issues,
    references: seed.references ?? [],
  };
}

export async function loadSeededRun(
  slug: SeededSlug,
): Promise<{ data: RunPayload; events: Array<Record<string, unknown>> }> {
  const seed = await loadRaw(slug);
  return { data: toRunPayload(seed), events: seed.events };
}

export interface SeededSummary {
  slug: SeededSlug;
  url: string;
  goal: string;
  totalCostCents: number;
  issueCount: number;
  personaCount: number;
  stepCount: number;
}

/** Summaries for the landing page, in SEEDED_SLUGS order. */
export async function loadSeededIndex(): Promise<SeededSummary[]> {
  const out: SeededSummary[] = [];
  for (const slug of SEEDED_SLUGS) {
    const seed = await loadRaw(slug);
    out.push({
      slug,
      url: seed.run["url"] as string,
      goal: seed.run["goal"] as string,
      totalCostCents: (seed.run["totalCostCents"] as number) ?? 0,
      issueCount: seed.issues.length,
      personaCount: seed.personaRuns.length,
      stepCount: seed.steps.length,
    });
  }
  return out;
}

/**
 * The landing-page reel, distilled from a real recorded run.
 *
 * Runs on the server: the fixture it reads is over a megabyte because its
 * screenshots are embedded, and only the few hundred bytes of timings reach
 * the browser. fixture-badsite is the source because it is the busiest run —
 * three personas, fourteen steps and twelve findings — so the animation has
 * something to show rather than three sparse dots.
 */
export async function loadHeroTrack(): Promise<{
  track: HeroTrack;
  caption: string;
}> {
  const seed = await loadRaw("fixture-badsite");
  const track = buildHeroTrack(seed.events);
  const seconds = Math.round(track.durationMs / 1000);
  return {
    track,
    caption: `a real recorded run · ${track.lanes.length} personas · ${track.nodes.filter((n) => n.kind === "step").length} steps · ${track.nodes.filter((n) => n.kind === "finding").length} findings`,
  };
}
