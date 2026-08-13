import type { Page } from "playwright";

/**
 * Cookie / consent banner handling.
 *
 * One attempt, choosing the most privacy-preserving option available, logged so
 * it appears in the trace. If dismissal fails we continue and let the persona
 * react to the banner — a consent wall that blocks the journey is legitimate
 * usability feedback, not a harness failure to be papered over.
 *
 * Ordering matters: reject-all is tried before accept-all, so we never opt a
 * site's visitors into tracking on the user's behalf.
 */

export interface ConsentResult {
  dismissed: boolean;
  how: string | null;
}

/** Most privacy-preserving first. */
const REJECT_PATTERNS = [
  /^reject all$/i,
  /^decline all$/i,
  /^reject$/i,
  /^decline$/i,
  /^refuse all$/i,
  /^only necessary$/i,
  /^necessary only$/i,
  /^essential(?: cookies)? only$/i,
  /^use necessary cookies only$/i,
  /^continue without accepting$/i,
];

const ACCEPT_PATTERNS = [/^accept all$/i, /^accept$/i, /^i agree$/i, /^got it$/i, /^ok$/i];

async function clickFirstMatch(
  page: Page,
  patterns: RegExp[],
): Promise<string | null> {
  for (const pattern of patterns) {
    // Search the page and every frame — consent UIs are very often iframed.
    for (const frame of page.frames()) {
      const candidates = frame.getByRole("button", { name: pattern });
      const count = await candidates.count().catch(() => 0);
      if (count > 0) {
        try {
          await candidates.first().click({ timeout: 3000 });
          return pattern.source;
        } catch {
          continue;
        }
      }

      const links = frame.getByRole("link", { name: pattern });
      const linkCount = await links.count().catch(() => 0);
      if (linkCount > 0) {
        try {
          await links.first().click({ timeout: 3000 });
          return pattern.source;
        } catch {
          continue;
        }
      }
    }
  }
  return null;
}

export async function dismissConsent(page: Page): Promise<ConsentResult> {
  const rejected = await clickFirstMatch(page, REJECT_PATTERNS);
  if (rejected) {
    await page.waitForTimeout(400);
    return { dismissed: true, how: `rejected non-essential cookies (${rejected})` };
  }

  const accepted = await clickFirstMatch(page, ACCEPT_PATTERNS);
  if (accepted) {
    await page.waitForTimeout(400);
    return {
      dismissed: true,
      how: `dismissed a cookie banner with the only option offered (${accepted})`,
    };
  }

  return { dismissed: false, how: null };
}
