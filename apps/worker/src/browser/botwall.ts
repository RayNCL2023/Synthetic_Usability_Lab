import type { Page } from "playwright";

/**
 * Bot-wall and challenge detection.
 *
 * Bot walls, Cloudflare interstitials, and CAPTCHA pages are the common case
 * when pointing a headless browser at real sites — not an edge case. Detecting
 * them explicitly is what lets the product say "we couldn't get past
 * Cloudflare" instead of confidently critiquing the usability of a challenge
 * page, which would be both useless and a credibility hole.
 *
 * We never attempt to solve a challenge.
 */

export interface BotWallVerdict {
  blocked: boolean;
  reason: string;
}

const CHALLENGE_SELECTORS: Array<{ selector: string; label: string }> = [
  { selector: "#challenge-running", label: "a Cloudflare challenge" },
  { selector: "#cf-challenge-running", label: "a Cloudflare challenge" },
  { selector: "#cf-wrapper", label: "a Cloudflare interstitial" },
  { selector: 'iframe[src*="challenges.cloudflare.com"]', label: "a Cloudflare Turnstile challenge" },
  { selector: ".cf-turnstile", label: "a Cloudflare Turnstile challenge" },
  { selector: 'iframe[src*="hcaptcha.com"]', label: "an hCaptcha challenge" },
  { selector: ".h-captcha", label: "an hCaptcha challenge" },
  { selector: 'iframe[src*="recaptcha"]', label: "a reCAPTCHA challenge" },
  { selector: ".g-recaptcha", label: "a reCAPTCHA challenge" },
  { selector: "#px-captcha", label: "a PerimeterX challenge" },
  { selector: '[data-testid="challenge"]', label: "a bot challenge" },
];

const TITLE_MARKERS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /just a moment/i, label: "a Cloudflare interstitial" },
  { pattern: /attention required/i, label: "a Cloudflare block page" },
  { pattern: /access denied/i, label: "an access-denied page" },
  { pattern: /are you a (human|robot)/i, label: "a bot check" },
  { pattern: /security check/i, label: "a security check" },
  { pattern: /verify you are human/i, label: "a human-verification page" },
];

export async function detectBotWall(
  page: Page,
  status: number | null,
): Promise<BotWallVerdict> {
  // 1. HTTP status. 403 and 429 on the first load are near-certain blocks.
  if (status === 403) {
    return { blocked: true, reason: "the site returned 403 Forbidden to our browser" };
  }
  if (status === 429) {
    return { blocked: true, reason: "the site rate-limited us with 429 Too Many Requests" };
  }
  if (status === 503) {
    return {
      blocked: true,
      reason: "the site returned 503, which usually means an anti-bot interstitial",
    };
  }

  // 2. Known challenge markers.
  for (const { selector, label } of CHALLENGE_SELECTORS) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) {
      return { blocked: true, reason: `we hit ${label} and did not attempt to solve it` };
    }
  }

  // 3. Title markers.
  const title = await page.title().catch(() => "");
  for (const { pattern, label } of TITLE_MARKERS) {
    if (pattern.test(title)) {
      return { blocked: true, reason: `we hit ${label} ("${title}")` };
    }
  }

  // 4. A near-empty body. Checked last and conservatively, because a genuinely
  //    minimal landing page is not a block — requiring BOTH almost no text and
  //    no links keeps false positives down.
  const shape = await page
    .evaluate(() => ({
      textLength: (document.body?.innerText ?? "").trim().length,
      links: document.querySelectorAll("a[href]").length,
      inputs: document.querySelectorAll("input, button").length,
    }))
    .catch(() => null);

  if (shape && shape.textLength < 120 && shape.links === 0 && shape.inputs <= 1) {
    return {
      blocked: true,
      reason:
        "the page came back essentially empty, which usually means our browser was blocked",
    };
  }

  return { blocked: false, reason: "" };
}
