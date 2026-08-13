import type { Frame, Page } from "playwright";
import type { ModelAction, Snapshot } from "@sul/shared";
import { findNode } from "@sul/shared";
import { REF_ATTR, frameLabel } from "./snapshot.js";

/**
 * Executes a validated action against a stamped ref.
 *
 * Resolution goes through a locator, never a held ElementHandle. Handles go
 * stale the moment the page navigates or a subtree re-renders, and this loop
 * navigates constantly — a stale handle fails in ways that are hard to
 * distinguish from a hallucinated ref. A locator re-resolves on use and fails
 * with "ref no longer present", which is exactly the signal the validator
 * wants.
 */

export interface ActionResult {
  ok: boolean;
  /** Set when the action could not be carried out. Surfaced to the model. */
  error?: string;
  /** True when the action caused a navigation. */
  navigated: boolean;
}

/** Finds the frame a ref lives in. Refs carry frame identity for this reason. */
function resolveFrame(page: Page, frameId: string | null): Frame | null {
  if (frameId === null) return page.mainFrame();
  return page.frames().find((f) => frameLabel(f) === frameId) ?? null;
}

export async function executeAction(
  page: Page,
  snapshot: Snapshot,
  action: ModelAction,
  opts: { stepTimeoutMs: number },
): Promise<ActionResult> {
  const urlBefore = page.url();

  const withNav = (ok: boolean, error?: string): ActionResult => ({
    ok,
    error,
    navigated: page.url() !== urlBefore,
  });

  switch (action.type) {
    case "scroll": {
      const dy = action.direction === "up" ? -600 : 600;
      await page.mouse.wheel(0, dy);
      await page.waitForTimeout(350);
      return withNav(true);
    }

    case "go_back": {
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
      return withNav(true);
    }

    case "wait": {
      await page.waitForTimeout(1200);
      return withNav(true);
    }

    case "finish": {
      return withNav(true);
    }

    case "click":
    case "type": {
      const ref = action.ref;
      if (!ref) return withNav(false, `action "${action.type}" arrived without a ref`);

      const node = findNode(snapshot, ref);
      if (!node) {
        return withNav(
          false,
          `ref "${ref}" is not in the current snapshot`,
        );
      }

      const frame = resolveFrame(page, node.frameId);
      if (!frame) {
        return withNav(
          false,
          `the frame containing "${ref}" (${node.frameId}) is no longer attached`,
        );
      }

      const locator = frame.locator(`[${REF_ATTR}="${ref}"]`);
      const count = await locator.count().catch(() => 0);
      if (count === 0) {
        return withNav(
          false,
          `ref "${ref}" no longer resolves — the page changed since the snapshot`,
        );
      }

      // Actionability gets a much tighter budget than the step as a whole.
      // An element covered by a modal overlay never becomes actionable, so
      // waiting the full step timeout burns ~45s per blocked click and can
      // exhaust the run's wall-clock budget on any site with a newsletter
      // popup. Failing fast lets the persona react to the modal — which is
      // the finding we actually want — instead of stalling on it.
      const actionTimeout = Math.min(opts.stepTimeoutMs, 8_000);

      try {
        if (action.type === "click") {
          await locator.first().click({ timeout: actionTimeout });
        } else {
          // Never real data: the text the model supplies is used verbatim and
          // the persona prompts forbid credentials or personal details. We
          // additionally refuse password fields outright.
          const type = (node.detail ?? "").includes("type=password");
          if (type) {
            return withNav(false, "refusing to type into a password field");
          }
          await locator.first().fill(action.text ?? "", { timeout: actionTimeout });
        }
      } catch (err) {
        return withNav(
          false,
          `could not ${action.type} "${ref}": ${
            err instanceof Error ? err.message.split("\n")[0] : String(err)
          }`,
        );
      }

      // Give a navigation or client-side transition a moment to settle so the
      // next snapshot reflects the result of this action rather than the page
      // mid-transition.
      await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
      return withNav(true);
    }
  }
}

/** Short human label for the live status pill. */
export function actionLabel(action: ModelAction, snapshot: Snapshot): string {
  switch (action.type) {
    case "click": {
      const n = action.ref ? findNode(snapshot, action.ref) : undefined;
      return n?.name ? `clicking "${truncate(n.name, 28)}"` : "clicking";
    }
    case "type":
      return "typing";
    case "scroll":
      return action.direction === "up" ? "scrolling up" : "scrolling down";
    case "go_back":
      return "going back";
    case "wait":
      return "waiting";
    case "finish":
      return action.outcome === "goal_achieved" ? "done" : "giving up";
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
