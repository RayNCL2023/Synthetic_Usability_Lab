export const API = process.env.NEXT_PUBLIC_API_URL ?? "";

export type Severity = "blocker" | "major" | "minor" | "nitpick";

export interface RunPayload {
  run: {
    id: string;
    url: string;
    goal: string;
    status: string;
    createdAt: string;
    finishedAt: string | null;
    totalCostCents: number;
    totalTokens: number;
    abortReason: string | null;
    modelConfig: { loopModel?: string; clusterModel?: string } | null;
    slug: string | null;
    isDemo: boolean;
  };
  personaRuns: Array<{
    personaKey: string;
    status: string;
    outcome: string | null;
    stepCount: number;
    blockedReason: string | null;
    currentActionLabel: string | null;
  }>;
  steps: Array<{
    id: string;
    personaKey: string;
    index: number;
    url: string;
    screenshotUrl: string | null;
    narration: string;
    action: { type: string; ref: string | null } | null;
  }>;
  issues: Array<{
    id: string;
    title: string;
    description: string;
    severity: Severity;
    category: string;
    rank: number;
    recommendation: string;
    personaKeys: string[];
    observations: Array<{
      id: string;
      severity: Severity;
      category: string;
      quote: string;
      elementRef: string;
      elementDescription: string;
      box: { x: number; y: number; w: number; h: number } | null;
      personaKey: string;
      stepId: string;
    }>;
  }>;
  /**
   * Plain captures of pages, held for context rather than as evidence. Present
   * only on seeded runs, and only for findings that no sighted persona
   * illustrated — see ReferenceView in ./evidence.
   */
  references?: Array<{ url: string; capturedAt: string; screenshotUrl: string }>;
}

/**
 * `viewport` is the CSS-pixel frame each persona's bounding boxes were measured
 * in, and the report plots pins as a percentage of it. The three personas do
 * NOT share one — a box measured at 1440×900 placed against a 390×844 plate
 * points at nothing — so it travels with the persona rather than defaulting.
 *
 * Mirrors `PERSONAS[].harness` in @sul/shared, duplicated so the recorded-run
 * routes need no backend. api.test.ts fails if the two drift apart.
 */
export const PERSONA_META: Record<
  string,
  {
    name: string;
    short: string;
    avatar: string;
    colour: string;
    sighted: boolean;
    viewport: { width: number; height: number };
  }
> = {
  impatient_mobile: {
    name: "Impatient mobile user",
    short: "Mobile",
    avatar: "▮",
    colour: "#F97316",
    sighted: true,
    viewport: { width: 390, height: 844 },
  },
  screen_reader: {
    name: "Screen-reader user",
    short: "Screen reader",
    avatar: "◎",
    colour: "#8B5CF6",
    sighted: false,
    viewport: { width: 1280, height: 800 },
  },
  procurement: {
    name: "Sceptical procurement manager",
    short: "Procurement",
    avatar: "▤",
    colour: "#0EA5E9",
    sighted: true,
    viewport: { width: 1440, height: 900 },
  },
};

export function personaMeta(key: string) {
  return (
    PERSONA_META[key] ?? {
      name: key,
      short: key,
      avatar: "•",
      colour: "#8894A6",
      sighted: true,
      viewport: { width: 1280, height: 800 },
    }
  );
}

export function formatCents(c: number): string {
  return `${c.toFixed(2)}¢`;
}

export const SEVERITY_RANK: Record<Severity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  nitpick: 3,
};

/**
 * The bundled fixture serves from an ephemeral localhost port, which reads as
 * noise in the gallery. Name it for what it is instead.
 */
export function displayHost(u: string): string {
  try {
    const h = new URL(u).hostname;
    if (h === 'localhost' || /^127./.test(h) || /^0.0.0.0$/.test(h)) {
      return 'bundled fixture site';
    }
    return h.replace(/^www./, '');
  } catch {
    return u;
  }
}
