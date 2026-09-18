import type { RunPayload } from "./api";

/**
 * Reconciling the two things a run view knows about its steps.
 *
 * `/runs/:id` is authoritative but arrives in snapshots — once when the page
 * loads and again when the run finishes. The event log arrives continuously and
 * carries its own presigned `screenshotUrl` on every `persona.step`.
 *
 * A live run spends its whole life between those two snapshots, so a view that
 * reads only the payload renders nothing at all until the run ends. Seeded
 * replays hide that completely: they ship a finished payload, so the same code
 * looks correct in the demo and shows a permanently empty plate in production.
 *
 * The event log is therefore what reveals a step, and the payload is what
 * enriches it once it exists.
 */

/**
 * Puts a log into its authoritative order.
 *
 * `seq` is allocated from a single per-run Postgres sequence precisely because
 * three persona workers emit concurrently, which makes it — not array position
 * — the ordering contract. The API honours it; the committed demo fixtures do
 * not, and a live socket can legitimately deliver events out of order across a
 * reconnect. Sorting here is a no-op on an already-ordered log and the
 * difference between a coherent replay and one that jumps backwards.
 */
export function orderEvents(
  events: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return [...events]
    .map((event, position) => ({ event, position }))
    .sort((a, b) => {
      const as = a.event["seq"];
      const bs = b.event["seq"];
      const aHas = typeof as === "number";
      const bHas = typeof bs === "number";
      // An event with no seq cannot be placed, so it keeps its arrival order
      // behind everything that can be.
      if (!aHas && !bHas) return a.position - b.position;
      if (!aHas) return 1;
      if (!bHas) return -1;
      return as - bs || a.position - b.position;
    })
    .map(({ event }) => event);
}

export interface DisplayStep {
  id: string;
  personaKey: string;
  index: number;
  url: string;
  screenshotUrl: string | null;
  narration: string;
}

export interface LaneFrame {
  personaKey: string;
  /** The persona's most recent revealed step. */
  step: DisplayStep;
  /** Its most recent available image, which may predate `step`. */
  screenshotUrl: string | null;
  /** Which step that image came from, so a held frame can say it is held. */
  screenshotStepIndex: number | null;
}

/**
 * The latest state of each lane, so all three personas can be watched at once
 * rather than one hero frame belonging to whichever persona acted last.
 *
 * The image is allowed to lag the step: a persona that has just reported an
 * action whose screenshot is still uploading keeps showing its previous frame
 * instead of blinking empty, and the lane says which step the frame is from.
 */
export function laneFrames(steps: DisplayStep[]): Map<string, LaneFrame> {
  const frames = new Map<string, LaneFrame>();

  for (const step of steps) {
    const held = frames.get(step.personaKey);
    frames.set(step.personaKey, {
      personaKey: step.personaKey,
      step,
      screenshotUrl: step.screenshotUrl ?? held?.screenshotUrl ?? null,
      screenshotStepIndex:
        step.screenshotUrl !== null ? step.index : (held?.screenshotStepIndex ?? null),
    });
  }

  return frames;
}

function keyOf(personaKey: string, index: number): string {
  return `${personaKey}:${index}`;
}

export function mergeSteps(
  persisted: RunPayload["steps"],
  events: Array<Record<string, unknown>>,
): DisplayStep[] {
  // No log at all — a finished run opened cold, or a run whose events were
  // never recorded. The payload is all there is and all of it is revealed.
  if (events.length === 0) return persisted;

  const byKey = new Map(persisted.map((s) => [keyOf(s.personaKey, s.index), s]));

  const out: DisplayStep[] = [];
  const seen = new Set<string>();

  for (const raw of events) {
    if (raw["type"] !== "persona.step") continue;

    const personaKey = raw["personaKey"];
    const index = raw["stepIndex"];
    if (typeof personaKey !== "string" || typeof index !== "number") continue;

    // The server errs towards delivering an event twice across the
    // replay/subscribe handover, so the same step can arrive more than once.
    const key = keyOf(personaKey, index);
    if (seen.has(key)) continue;
    seen.add(key);

    const row = byKey.get(key);
    out.push({
      id: row?.id ?? key,
      personaKey,
      index,
      url: row?.url ?? (typeof raw["url"] === "string" ? raw["url"] : ""),
      // The payload's URL is presigned more recently than the event's, so it
      // wins whenever it exists. Both are null for a persona that gets none.
      screenshotUrl:
        row?.screenshotUrl ??
        (typeof raw["screenshotUrl"] === "string" ? raw["screenshotUrl"] : null),
      narration:
        row?.narration || (typeof raw["narration"] === "string" ? raw["narration"] : ""),
    });
  }

  return out;
}
