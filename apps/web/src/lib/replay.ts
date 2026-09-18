/**
 * How long each event holds the screen during a replay.
 *
 * The original clock advanced one event every fixed interval, which spends the
 * viewer's attention in proportion to how talkative the pipeline is rather than
 * to how much each event is worth watching. Across the four recorded demos,
 * 59–68% of every log is `persona.status` — so most of each replay went to a
 * one-line label while the screenshots and findings got the same slice.
 *
 * These are the durations at 1×; the replay speed divides them. A floor keeps
 * a frame from appearing and vanishing inside a single repaint at high speeds,
 * which reads as a glitch rather than as speed.
 */

const MIN_DWELL_MS = 16;

/** Base dwell at 1×, in ms. */
const DWELL = {
  /** A new plate to actually look at. */
  stepWithScreenshot: 2200,
  /** Still a narration beat — the screen-reader persona's whole journey. */
  stepWithoutScreenshot: 1400,
  /** A finding, and a pin dropping onto the plate. */
  observation: 1800,
  /** A lane changing state is a structural moment. */
  personaFinished: 1200,
  /** Terminal events: let the report tab land rather than snapping to it. */
  runTerminal: 900,
  /** Openers. */
  runStarted: 500,
  /** A label tick. Perceptible as activity, not as a beat. */
  status: 250,
  /** Anything unrecognised still has to pass at a sane pace. */
  fallback: 600,
  /** Before the first event has been revealed. */
  leadIn: 400,
} as const;

function baseDwellMs(event: Record<string, unknown> | null): number {
  if (event === null) return DWELL.leadIn;

  switch (event["type"]) {
    case "persona.step":
      return typeof event["screenshotUrl"] === "string" && event["screenshotUrl"]
        ? DWELL.stepWithScreenshot
        : DWELL.stepWithoutScreenshot;
    case "persona.observation":
      return DWELL.observation;
    case "persona.finished":
      return DWELL.personaFinished;
    case "persona.status":
      return DWELL.status;
    case "run.started":
      return DWELL.runStarted;
    case "run.issues":
    case "run.finished":
    case "run.error":
      return DWELL.runTerminal;
    default:
      return DWELL.fallback;
  }
}

/**
 * Dwell for the event that was most recently revealed, at the given speed.
 * Pass null for the moment before anything has been shown.
 */
export function eventDwellMs(
  event: Record<string, unknown> | null,
  replaySpeed: number,
): number {
  const speed = replaySpeed > 0 ? replaySpeed : 1;
  return Math.max(MIN_DWELL_MS, baseDwellMs(event) / speed);
}
