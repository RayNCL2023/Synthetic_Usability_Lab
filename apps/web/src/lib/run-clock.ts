/**
 * How long the run has taken, derived from the log rather than from a clock.
 *
 * The readout used to be wall-clock since mount, driven by a setInterval with
 * no stop condition — so it kept climbing after every persona had finished, and
 * it measured how long you had been watching rather than how long the run took.
 * A 2m17s run displayed as 0:14.
 *
 * Reading it off the revealed events fixes both faults structurally: during a
 * replay it advances in step with what is being shown, it lands on the true
 * total, and it cannot keep counting once the log runs out because there is no
 * timer to stop. Live runs work through the same path, since events carry real
 * timestamps.
 */
export function elapsedMsFromEvents(events: Array<Record<string, unknown>>): number {
  let first: number | null = null;
  let last: number | null = null;

  for (const event of events) {
    const ts = event["ts"];
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (first === null || ts < first) first = ts;
    if (last === null || ts > last) last = ts;
  }

  if (first === null || last === null) return 0;
  return last - first;
}
