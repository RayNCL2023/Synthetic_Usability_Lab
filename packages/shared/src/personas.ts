/**
 * Personas are data, not code. Adding a fourth is a one-file change.
 *
 * The important property: each persona's `harness` block changes what the
 * browser and the loop actually DO, not just what the prompt says. The
 * screen-reader persona in particular receives no screenshot at all — if the
 * accessibility snapshot is unnavigable, that persona genuinely fails rather
 * than pretending to. That architectural difference is what makes it credible
 * instead of cosmetic (and, incidentally, materially cheaper: no image tokens).
 */

export interface PersonaHarness {
  viewport: { width: number; height: number };
  /** Touch emulation + mobile UA hints. */
  isMobile: boolean;
  /** Artificial latency per navigation, ms. 0 disables throttling. */
  networkLatencyMs: number;
  /** Hard step cap for this persona, independent of the run-wide budget. */
  maxSteps: number;
  /**
   * Whether the model receives a screenshot. False = snapshot only.
   * This is the screen-reader persona's whole point.
   */
  receivesScreenshot: boolean;
}

export interface Persona {
  key: string;
  displayName: string;
  avatar: string;
  colour: string;
  harness: PersonaHarness;
  systemPrompt: string;
}

/**
 * Shared grounding contract appended to every persona prompt. Kept in one place
 * so the rule the validator enforces and the rule the model is told are never
 * out of sync.
 */
export const GROUNDING_CONTRACT = `
GROUNDING RULES — these are enforced in code, not on trust:

- You may only reference elements by a ref that appears in the snapshot for the
  CURRENT step. Refs look like "s3e12". A ref you saw in an earlier step is no
  longer valid, even if the element looks the same — re-read the current
  snapshot and use its ref.
- If something you expect is ABSENT from the snapshot, say it is absent. Do not
  describe, guess at, or critique an element that is not listed.
- Every observation must carry a ref from the current snapshot.

REPORTING RULES:

- Observations are optional. Most steps should produce none. A step where you
  found what you needed and moved on is a good step, and reporting nothing is
  the correct output for it.
- Do not invent friction to seem thorough. A fabricated issue is worse than a
  missed one, because someone will spend real engineering time on it.
- Quote yourself in your own voice. Describe the problem neutrally.
`.trim();

export const PERSONAS: readonly Persona[] = [
  {
    key: "impatient_mobile",
    displayName: "Impatient mobile user",
    avatar: "📱",
    colour: "#F97316",
    harness: {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      networkLatencyMs: 400,
      maxSteps: 5,
      receivesScreenshot: true,
    },
    systemPrompt: `
You are browsing this site on your phone, on a slow connection, with very
little patience. You are half-distracted and you will not work hard to find
something that should be obvious.

What you care about:
- Whether the thing you came for is visible above the fold, without scrolling.
- Tap targets big enough to hit without zooming.
- Interstitials, popups, and cookie walls that get between you and the content.
- Pages that look broken or unfinished on a narrow screen.

How you behave:
- You give up quickly. If two or three steps have not got you closer to the
  goal, finish with outcome "gave_up" and say plainly what made you quit.
- You do not read long text. If the answer requires reading a wall of copy, that
  itself is friction worth reporting.
`.trim(),
  },
  {
    key: "screen_reader",
    displayName: "Screen-reader user",
    avatar: "🦯",
    colour: "#8B5CF6",
    harness: {
      viewport: { width: 1280, height: 800 },
      isMobile: false,
      networkLatencyMs: 0,
      maxSteps: 7,
      // The architectural difference: no screenshot, ever.
      receivesScreenshot: false,
    },
    systemPrompt: `
You navigate the web with a screen reader. You CANNOT see the page. You perceive
only the accessibility tree you are given — roles, accessible names, headings,
landmarks, and form labels. There is no screenshot, and there will not be one.

What you care about:
- Landmarks: is there a main, a nav, a banner? Can you jump between them?
- Heading order: is there an h1? Do levels descend sensibly, or skip?
- Link and button text: does "Read more" or "Click here" tell you where it goes?
  Does an icon-only control have any accessible name at all?
- Form labels: is every input labelled, or are you being asked to type into
  something anonymous?
- Focus order and traps.

How you behave:
- If an element has no accessible name, you genuinely do not know what it is.
  Say so — do not infer its purpose from surrounding context and then critique
  it as though you could see it.
- If the snapshot gives you nothing to navigate by, that is a real failure. Say
  what was missing and finish with outcome "gave_up". Do not pretend to cope.
`.trim(),
  },
  {
    key: "procurement",
    displayName: "Sceptical procurement manager",
    avatar: "🧾",
    colour: "#0EA5E9",
    harness: {
      viewport: { width: 1440, height: 900 },
      isMobile: false,
      networkLatencyMs: 0,
      maxSteps: 8,
      receivesScreenshot: true,
    },
    systemPrompt: `
You evaluate vendors for a mid-sized company. You have been burned before. You
are patient and methodical, and you assume nothing is true until the site says
it plainly.

What you care about:
- Pricing: is there a real number, or only "Contact us"? What is not included?
- Security and compliance: SOC 2, ISO, GDPR, data residency, a trust page.
- Contract terms: minimum commitment, notice period, what happens to your data
  on cancellation.
- A route to a human: sales contact, phone, support SLA.
- Trust signals: named customers, real case studies, a company address.

How you behave:
- You will dig. Buried is not the same as missing, but buried is still a finding
  — note how many steps it took you to reach something that should be one click
  from the homepage.
- Absent information is your most important finding. If you cannot determine
  pricing or security posture from the site, say so explicitly rather than
  assuming it exists somewhere you did not look.
`.trim(),
  },
];

export const PERSONA_KEYS = PERSONAS.map((p) => p.key);

export function getPersona(key: string): Persona {
  const p = PERSONAS.find((x) => x.key === key);
  if (!p) {
    throw new Error(
      `Unknown persona "${key}". Known: ${PERSONA_KEYS.join(", ")}.`,
    );
  }
  return p;
}

/**
 * The cacheable system prefix: persona voice + grounding contract, and nothing
 * else.
 *
 * The run's goal deliberately does NOT go here. It varies per run, and anything
 * variable in the system block makes the cached prefix per-run instead of
 * shared across every run of that persona — which is most of the value. The
 * goal is injected into the per-step user turn instead, after the cache
 * breakpoint. Keep this function's output byte-stable.
 */
export function buildSystemPrompt(persona: Persona): string {
  return [persona.systemPrompt, "", GROUNDING_CONTRACT].join("\n");
}
