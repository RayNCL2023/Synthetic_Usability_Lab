/**
 * A recorded run, reduced to the few hundred bytes an animation needs.
 *
 * The landing page wants to show the product working, and the honest way to do
 * that is with a real run rather than an invented one. But the fixtures embed
 * their screenshots as data URIs and run past a megabyte each, which is far too
 * much to put on a front door.
 *
 * So the log is distilled on the server — when each step and each finding
 * happened, and which persona it belonged to — and only that travels to the
 * client. Abstract marks, real timings.
 */

export interface HeroNode {
  /** Milliseconds since the run started. */
  at: number;
  /** Index into `lanes`. */
  lane: number;
  kind: "step" | "finding";
  severity?: string;
}

export interface HeroTrack {
  durationMs: number;
  /**
   * When the last persona stopped browsing. Everything after it is the
   * aggregation call that clusters observations into ranked issues — which on
   * a real run can be half the wall clock, and is worth labelling rather than
   * leaving as an unexplained gap.
   */
  browsingEndsAt: number;
  /** Persona keys, in the order they first act. */
  lanes: string[];
  nodes: HeroNode[];
}

export function buildHeroTrack(
  events: Array<Record<string, unknown>>,
): HeroTrack {
  let first: number | null = null;
  let last: number | null = null;
  for (const e of events) {
    const ts = e["ts"];
    if (typeof ts !== "number") continue;
    if (first === null || ts < first) first = ts;
    if (last === null || ts > last) last = ts;
  }
  if (first === null || last === null) {
    return { durationMs: 0, browsingEndsAt: 0, lanes: [], nodes: [] };
  }

  const lanes: string[] = [];
  const nodes: HeroNode[] = [];

  for (const event of events) {
    const type = event["type"];
    // Status chatter is two thirds of a log and says nothing visually.
    if (type !== "persona.step" && type !== "persona.observation") continue;

    const personaKey = event["personaKey"];
    const ts = event["ts"];
    if (typeof personaKey !== "string" || typeof ts !== "number") continue;

    let lane = lanes.indexOf(personaKey);
    if (lane === -1) lane = lanes.push(personaKey) - 1;

    nodes.push({
      at: ts - first,
      lane,
      kind: type === "persona.step" ? "step" : "finding",
      ...(type === "persona.observation" && typeof event["severity"] === "string"
        ? { severity: event["severity"] }
        : {}),
    });
  }

  const browsingEndsAt = nodes.reduce((max, n) => (n.at > max ? n.at : max), 0);

  return { durationMs: last - first, browsingEndsAt, lanes, nodes };
}
