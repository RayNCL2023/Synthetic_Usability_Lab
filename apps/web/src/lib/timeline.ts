import type { DisplayStep } from "./steps";

/**
 * The run as a readable record.
 *
 * A persona's reasoning previously existed only in its lane card, which shows
 * the newest two entries clamped to two lines — so most of what the personas
 * said could not be read at all, and there was no way to go back and read it.
 * The timeline is the full text, next to the frame it belongs to and the
 * findings that came out of it.
 *
 * Rows are built from the event log rather than the payload because the log is
 * what reveals progressively, and because it is the only source that carries
 * observations with the step that produced them.
 */

export interface TimelineFinding {
  severity: string;
  description: string;
  quote: string;
}

export interface TimelineRow {
  kind: "step" | "outcome";
  id: string;
  personaKey: string;
  /** Milliseconds since the first event in the run. */
  atMs: number;
  /** The merged step, for its frame and URL. Absent on outcome rows. */
  step?: DisplayStep;
  /** Complete, never clamped — being readable is the point of this view. */
  narration: string;
  findings: TimelineFinding[];
  /** Present on outcome rows only. */
  outcome?: string;
}

function keyOf(personaKey: string, index: number): string {
  return `${personaKey}:${index}`;
}

export function buildTimeline(
  steps: DisplayStep[],
  events: Array<Record<string, unknown>>,
): TimelineRow[] {
  const stepByKey = new Map(steps.map((s) => [keyOf(s.personaKey, s.index), s]));

  let firstTs: number | null = null;
  for (const e of events) {
    const ts = e["ts"];
    if (typeof ts === "number" && (firstTs === null || ts < firstTs)) firstTs = ts;
  }
  const since = (ts: unknown): number =>
    typeof ts === "number" && firstTs !== null ? Math.max(0, ts - firstTs) : 0;

  const rows: TimelineRow[] = [];
  const rowByKey = new Map<string, TimelineRow>();

  for (const event of events) {
    const personaKey = event["personaKey"];
    if (typeof personaKey !== "string") continue;

    if (event["type"] === "persona.step") {
      const index = event["stepIndex"];
      if (typeof index !== "number") continue;
      const key = keyOf(personaKey, index);
      if (rowByKey.has(key)) continue; // the log may deliver a step twice

      const row: TimelineRow = {
        kind: "step",
        id: key,
        personaKey,
        atMs: since(event["ts"]),
        step: stepByKey.get(key),
        narration: typeof event["narration"] === "string" ? event["narration"] : "",
        findings: [],
      };
      rowByKey.set(key, row);
      rows.push(row);
      continue;
    }

    if (event["type"] === "persona.observation") {
      const index = event["stepIndex"];
      if (typeof index !== "number") continue;
      // An observation for a step that has not been revealed yet has nowhere to
      // attach; it arrives with its step on the next tick.
      const row = rowByKey.get(keyOf(personaKey, index));
      if (!row) continue;
      row.findings.push({
        severity: typeof event["severity"] === "string" ? event["severity"] : "minor",
        description:
          typeof event["description"] === "string" ? event["description"] : "",
        quote: typeof event["quote"] === "string" ? event["quote"] : "",
      });
      continue;
    }

    if (event["type"] === "persona.finished") {
      rows.push({
        kind: "outcome",
        id: `${personaKey}:outcome`,
        personaKey,
        atMs: since(event["ts"]),
        narration: "",
        findings: [],
        outcome: typeof event["outcome"] === "string" ? event["outcome"] : undefined,
      });
    }
  }

  return rows;
}
