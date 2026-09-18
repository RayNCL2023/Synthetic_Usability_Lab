import type { RunPayload } from "./api";

type Issue = RunPayload["issues"][number];
type Observation = Issue["observations"][number];
type Step = RunPayload["steps"][number];

/**
 * Splitting an issue's evidence into one witness statement per persona.
 *
 * Two constraints drive the shape. First, "2 of 3 personas hit this" is the
 * strongest claim the report can make, and it is only credible if each of those
 * personas shows its own screenshot and its own words rather than being folded
 * into whichever one happened to be observed first.
 *
 * Second — and this is a correctness rule, not a presentational one — a
 * bounding box is measured against one step of one persona, in that persona's
 * viewport. A box from a 1440×900 procurement step plotted on a 390×844 mobile
 * screenshot points at nothing. So pins are restricted to the exact step whose
 * plate is being rendered, and the quotes that cannot be pinned are still
 * reported, unpinned, rather than being drawn in the wrong place.
 */

/**
 * A plain capture of a page, held alongside a run for context only.
 *
 * The screen-reader persona's findings are real and permanently unillustrated:
 * it navigates by the accessibility tree and never receives an image, so a run
 * whose only findings come from it gives the reader nothing to look at. A
 * reference view fills that gap without ever pretending to be evidence — it is
 * captured separately, carries its own date, and never takes a pin.
 */
export interface ReferenceView {
  url: string;
  capturedAt: string;
  screenshotUrl: string;
}

/**
 * The reference view for a witness that has no plate of its own.
 *
 * Deliberately strict. It returns nothing when the persona already has a real
 * screenshot — actual evidence must never be displaced by context — and
 * nothing when no capture matches the exact page the finding is on, because a
 * picture of a different page is worse than no picture at all.
 */
export function findReference(
  witness: Pick<PersonaEvidence, "step">,
  references: ReferenceView[] | undefined,
): ReferenceView | null {
  if (!references?.length) return null;
  if (!witness.step) return null;
  if (witness.step.screenshotUrl) return null;

  return references.find((r) => r.url === witness.step!.url) ?? null;
}

export interface PersonaEvidence {
  personaKey: string;
  /** The step whose plate represents this persona. Null if it is missing. */
  step: Step | null;
  /** Observations measured on `step` — the only ones it is valid to pin. */
  pins: Observation[];
  /** Everything this persona said about the issue, pinnable or not. */
  observations: Observation[];
}

export function groupEvidenceByPersona(
  observations: Observation[],
  stepsById: Map<string, Step>,
): PersonaEvidence[] {
  // First-appearance order, which follows the ranked order the clusterer
  // produced rather than an alphabetical one that means nothing.
  const byPersona = new Map<string, Observation[]>();
  for (const o of observations) {
    const list = byPersona.get(o.personaKey);
    if (list) list.push(o);
    else byPersona.set(o.personaKey, [o]);
  }

  return [...byPersona.entries()].map(([personaKey, own]) => {
    // A step with an image is worth more than an earlier one without, since
    // the plate is the point. Falling back to the first keeps the screen-reader
    // persona — which never has an image — in the report.
    const withScreenshot = own
      .map((o) => stepsById.get(o.stepId))
      .find((s) => s?.screenshotUrl);
    const step = withScreenshot ?? stepsById.get(own[0]!.stepId) ?? null;

    return {
      personaKey,
      step,
      // A pin is a mark drawn on an image. Without an image there is nothing to
      // mark, so a boxed observation on a screenshot-less step stays a quote —
      // citing "pin 1" against a plate that renders no pins sends the reader
      // looking for evidence that was never drawn.
      pins:
        step?.screenshotUrl != null
          ? own.filter((o) => o.stepId === step.id && o.box)
          : [],
      observations: own,
    };
  });
}
