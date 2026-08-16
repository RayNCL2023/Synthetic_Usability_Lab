/**
 * Goal presets.
 *
 * These were rewritten after measurement. The original presets were
 * single-destination lookups — "find out how to contact support" — and they
 * resolved in one or two steps on any competent site. Across five real
 * fan-out runs, three produced no findings at all: a 60% empty rate.
 *
 * The diagnosis was task difficulty, not detector sensitivity. A persona that
 * reaches its destination immediately has no journey, and friction only shows
 * up in a journey. So the fix is here, in the task, rather than in the
 * observation prompt or the severity threshold — loosening either of those
 * would buy findings by lowering the bar, which is the failure mode this
 * product cannot afford.
 *
 * Every preset now has the same three-part shape:
 *
 *   1. NAVIGATE  — reach a place that is not the landing page
 *   2. EXTRACT   — find a specific fact, not a page
 *   3. VERIFY    — confirm a SECOND fact that qualifies the first
 *
 * The verification hop is what forces a second traversal. "Find the price" is
 * one lookup; "find the price, then confirm what it excludes" requires
 * understanding what was found and going back for the caveat — which is
 * exactly where real sites hide their friction.
 */

export interface GoalPreset {
  /** Short label for the UI. */
  label: string;
  /** The goal text handed to the personas. */
  goal: string;
  /** Which part of a site this is designed to exercise. */
  probes: string;
}

export const GOAL_PRESETS: readonly GoalPreset[] = [
  {
    label: "Price and its caveats",
    goal:
      "Find the price of a mid-tier paid plan, then confirm two things about it: " +
      "what is NOT included at that price, and what happens to your data or " +
      "access if you stop paying. Report anything you cannot determine.",
    probes: "pricing depth, plan comparison, terms, cancellation",
  },
  {
    label: "Reaching a human",
    goal:
      "Find how to get help with a problem that a help article cannot solve, " +
      "then confirm whether a real person is reachable, by what route, and how " +
      "long a reply is supposed to take. Report anything you cannot determine.",
    probes: "support routing, escalation, SLA, contact discoverability",
  },
  {
    label: "Security claims and evidence",
    goal:
      "Find whether this company claims any security or compliance certification, " +
      "then locate the actual evidence for that claim and how you would request " +
      "the underlying report. Report anything you cannot determine.",
    probes: "trust page, compliance evidence, data handling, procurement blockers",
  },
  {
    label: "Sign up and understand the commitment",
    goal:
      "Get as far as you can toward creating an account without submitting " +
      "anything, then confirm what you would be agreeing to: the billing terms " +
      "and how to cancel. Stop before entering any personal detail.",
    probes: "signup friction, form labelling, terms discoverability",
  },
] as const;

export const DEFAULT_GOAL = GOAL_PRESETS[0]!.goal;
