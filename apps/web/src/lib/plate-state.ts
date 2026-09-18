import { personaMeta } from "./api";

/**
 * What an empty plate is allowed to say.
 *
 * The screen-reader persona genuinely has no screenshot, and saying so is one
 * of the more interesting things this product does. But that copy was the ONLY
 * empty state, so every plumbing failure — a live run whose images had not
 * been merged in yet, a run recorded with object storage switched off — also
 * announced that the persona navigates by the accessibility tree. A UI that
 * misreports why evidence is missing is worse than one that shows a grey box.
 */

export type PlateEmptyKind = "waiting" | "by_design" | "pending" | "missing";

export interface PlateEmptyState {
  kind: PlateEmptyKind;
  title: string;
  detail: string;
}

export function plateEmptyState({
  personaKey,
  runFinished,
}: {
  /** null before any step has been revealed. */
  personaKey: string | null;
  runFinished: boolean;
}): PlateEmptyState {
  if (personaKey === null) {
    return {
      kind: "waiting",
      title: "Waiting for the first step",
      detail:
        "Three personas are opening the site in parallel. The first screenshot appears as soon as one of them acts.",
    };
  }

  // Unknown persona keys default to sighted in personaMeta, which is the safe
  // direction: claiming a disability the persona does not have is the failure
  // this whole branch exists to prevent.
  if (!personaMeta(personaKey).sighted) {
    return {
      kind: "by_design",
      title: "No screenshot",
      detail:
        "This persona navigates by the accessibility tree alone. If the page is unusable without sight, it genuinely fails here.",
    };
  }

  if (!runFinished) {
    return {
      kind: "pending",
      title: "Screenshot on its way",
      detail:
        "This step was reported before its image finished uploading. It will appear here without a reload.",
    };
  }

  return {
    kind: "missing",
    title: "Screenshot unavailable",
    detail:
      "This persona does take screenshots, but none was stored for this step — the run was recorded with object storage switched off.",
  };
}
