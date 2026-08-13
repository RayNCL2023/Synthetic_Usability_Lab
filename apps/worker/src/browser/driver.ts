import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Persona } from "@sul/shared";

/**
 * One isolated browser context per persona.
 *
 * Screenshot sizing note: rather than resizing captured bytes, we set a
 * fractional deviceScaleFactor so the raster comes out at <= 1024px wide
 * directly. That keeps every bounding box in CSS pixels — which is what the
 * report's pins are drawn from — and avoids a native image dependency that
 * would be one more thing to differ between the Windows dev loop and the Linux
 * eval container.
 */

export const MAX_SCREENSHOT_WIDTH = 1024;
export const SCREENSHOT_QUALITY = 70;

export interface DriverOptions {
  headless: boolean;
  userAgent: string;
  navTimeoutMs: number;
}

export class BrowserDriver {
  private browser: Browser | null = null;

  constructor(private readonly opts: DriverOptions) {}

  async start(): Promise<void> {
    if (this.browser) return;
    this.browser = await chromium.launch({
      headless: this.opts.headless,
      args: ["--disable-dev-shm-usage"],
    });
  }

  async stop(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }

  async createPersonaContext(persona: Persona): Promise<PersonaSession> {
    if (!this.browser) throw new Error("BrowserDriver.start() not called");
    const { viewport, isMobile, networkLatencyMs } = persona.harness;

    // Scale the raster down to the screenshot cap without touching CSS layout.
    const deviceScaleFactor = Math.min(1, MAX_SCREENSHOT_WIDTH / viewport.width);

    const context = await this.browser.newContext({
      viewport,
      deviceScaleFactor,
      isMobile,
      hasTouch: isMobile,
      userAgent: this.opts.userAgent,
      // Never carry credentials or state between personas or runs.
      storageState: undefined,
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
    });

    context.setDefaultNavigationTimeout(this.opts.navTimeoutMs);
    context.setDefaultTimeout(this.opts.navTimeoutMs);

    // The snapshot walker is a named function serialised into the page. Under
    // tsx/esbuild, `keepNames` rewrites named functions to call a `__name`
    // helper that only exists in the bundle, not in the page — so the walker
    // throws ReferenceError on arrival. Passing raw source (not a function)
    // keeps this shim itself immune to the same transform.
    await context.addInitScript({
      content: "globalThis.__name = globalThis.__name || function (f) { return f; };",
    });

    if (networkLatencyMs > 0) {
      await context.route("**/*", async (route) => {
        await new Promise((r) => setTimeout(r, networkLatencyMs));
        await route.continue();
      });
    }

    const page = await context.newPage();
    return new PersonaSession(context, page, persona);
  }
}

export class PersonaSession {
  constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    readonly persona: Persona,
  ) {}

  /** Navigates, retrying once on timeout as the spec requires. */
  async goto(url: string): Promise<{ ok: boolean; status: number | null; error?: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.page.goto(url, { waitUntil: "domcontentloaded" });
        // Give client-rendered pages a chance to paint before snapshotting.
        await this.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        return { ok: true, status: res?.status() ?? null };
      } catch (err) {
        if (attempt === 1) {
          return {
            ok: false,
            status: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }
    return { ok: false, status: null, error: "unreachable" };
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({
      type: "jpeg",
      quality: SCREENSHOT_QUALITY,
      fullPage: false,
    });
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
  }
}
