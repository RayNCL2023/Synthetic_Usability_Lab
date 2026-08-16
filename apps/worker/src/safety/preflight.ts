import { chromium } from "playwright";

/**
 * Preflight: a ~3-second, zero-model-spend check run before the run is queued.
 *
 * This is a correctness feature, not an optimisation. Bot walls and dead URLs
 * are the most common failure mode when pointing a browser at arbitrary sites,
 * and without this check three personas each discover the same wall
 * independently, sixty seconds and several model calls later, and the user is
 * told "the personas gave up" rather than "we couldn't get past Cloudflare".
 */

export interface PreflightResult {
  ok: boolean;
  /** User-facing explanation when ok is false. */
  reason: string | null;
  status: number | null;
  finalUrl: string | null;
  redirectChain: string[];
  title: string | null;
  robotsAllowed: boolean;
  elapsedMs: number;
}

export interface PreflightOptions {
  userAgent: string;
  respectRobots: boolean;
  denylist: string[];
  timeoutMs?: number;
}

/** Minimal robots.txt evaluation for our own User-Agent and `*`. */
export function isAllowedByRobots(
  robotsTxt: string,
  path: string,
  userAgent: string,
): boolean {
  const uaToken = userAgent.split("/")[0]?.toLowerCase() ?? "";
  const lines = robotsTxt.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim());

  // Collect rule groups keyed by user-agent.
  const groups: Array<{ agents: string[]; rules: Array<[string, string]> }> = [];
  let current: { agents: string[]; rules: Array<[string, string]> } | null = null;
  let lastWasAgent = false;

  for (const line of lines) {
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === "disallow" || key === "allow") {
      if (current) current.rules.push([key, value]);
      lastWasAgent = false;
    }
  }

  const applicable =
    groups.find((g) => g.agents.some((a) => a !== "*" && uaToken.includes(a))) ??
    groups.find((g) => g.agents.includes("*"));
  if (!applicable) return true;

  // Longest matching rule wins; Allow beats Disallow at equal length.
  let best: { kind: string; len: number } | null = null;
  for (const [kind, pattern] of applicable.rules) {
    if (pattern === "") {
      // `Disallow:` with an empty value means "allow everything".
      if (kind === "disallow" && (best === null || best.len === 0)) {
        best = { kind: "allow", len: 0 };
      }
      continue;
    }
    if (path.startsWith(pattern)) {
      if (!best || pattern.length > best.len || (pattern.length === best.len && kind === "allow")) {
        best = { kind, len: pattern.length };
      }
    }
  }
  return best ? best.kind !== "disallow" : true;
}

const CHALLENGE_TITLES =
  /just a moment|attention required|access denied|verify you are human|security check|are you a robot/i;

export async function preflight(
  rawUrl: string,
  opts: PreflightOptions,
): Promise<PreflightResult> {
  const started = Date.now();
  const base: Omit<PreflightResult, "ok" | "reason"> = {
    status: null,
    finalUrl: null,
    redirectChain: [],
    title: null,
    robotsAllowed: true,
    elapsedMs: 0,
  };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ...base, ok: false, reason: "That does not look like a valid URL.", elapsedMs: Date.now() - started };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ...base, ok: false, reason: "Only http and https URLs can be tested.", elapsedMs: Date.now() - started };
  }

  const host = url.hostname.toLowerCase();
  if (opts.denylist.some((d) => host === d || host.endsWith(`.${d}`))) {
    return {
      ...base,
      ok: false,
      reason: `${host} is on the denylist for this deployment.`,
      elapsedMs: Date.now() - started,
    };
  }

  // robots.txt, fetched directly rather than through the browser so a blocked
  // page does not also hide the robots file.
  let robotsAllowed = true;
  if (opts.respectRobots) {
    try {
      const res = await fetch(new URL("/robots.txt", url).toString(), {
        headers: { "user-agent": opts.userAgent },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        robotsAllowed = isAllowedByRobots(await res.text(), url.pathname, opts.userAgent);
      }
    } catch {
      // No robots.txt, or unreachable — treated as allowed, which is the
      // conventional reading.
    }
    if (!robotsAllowed) {
      return {
        ...base,
        ok: false,
        robotsAllowed: false,
        reason: `${host}/robots.txt disallows automated access to this path. We respect robots.txt by default.`,
        elapsedMs: Date.now() - started,
      };
    }
  }

  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  try {
    const context = await browser.newContext({ userAgent: opts.userAgent });
    const page = await context.newPage();
    const redirectChain: string[] = [];
    page.on("response", (r) => {
      if (r.status() >= 300 && r.status() < 400) redirectChain.push(r.url());
    });

    const response = await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: opts.timeoutMs ?? 15_000,
    });
    const status = response?.status() ?? null;
    const title = await page.title().catch(() => "");
    const finalUrl = page.url();

    const shape = await page
      .evaluate(() => ({
        text: (document.body?.innerText ?? "").trim().length,
        links: document.querySelectorAll("a[href]").length,
      }))
      .catch(() => ({ text: 0, links: 0 }));

    const common = { ...base, status, finalUrl, redirectChain, title, robotsAllowed, elapsedMs: Date.now() - started };

    if (status === 403)
      return { ...common, ok: false, reason: "The site returned 403 Forbidden to our browser — it is blocking automated access." };
    if (status === 429)
      return { ...common, ok: false, reason: "The site rate-limited us before we started." };
    if (status && status >= 500)
      return { ...common, ok: false, reason: `The site returned ${status}. It may be down or serving an interstitial.` };
    if (status === 404)
      return { ...common, ok: false, reason: "That URL returned 404 — check the address." };
    if (CHALLENGE_TITLES.test(title))
      return { ...common, ok: false, reason: `We hit a bot challenge ("${title}") and do not attempt to solve them.` };
    if (shape.text < 120 && shape.links === 0)
      return { ...common, ok: false, reason: "The page came back essentially empty, which usually means our browser was blocked." };

    return { ...common, ok: true, reason: null };
  } catch (err) {
    return {
      ...base,
      ok: false,
      reason: `We could not load that URL: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      elapsedMs: Date.now() - started,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
