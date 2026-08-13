import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { findNode, renderSnapshotTree, stepIndexOfRef } from "@sul/shared";
import { REF_ATTR, buildSnapshot } from "./snapshot.js";

/**
 * These run against real Chromium rather than a DOM shim. The snapshot builder's
 * whole job is to agree with what a browser actually computes — layout,
 * visibility, viewport intersection — so a jsdom test would pass while the real
 * thing was wrong.
 */

let browser: Browser;
let page: Page;

async function load(html: string, viewport = { width: 1280, height: 800 }) {
  await page.setViewportSize(viewport);
  await page.setContent(html, { waitUntil: "domcontentloaded" });
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript({
    content: "globalThis.__name = globalThis.__name || function (f) { return f; };",
  });
  page = await ctx.newPage();
});

afterAll(async () => {
  await browser?.close();
});

describe("node collection", () => {
  it("collects links, buttons, headings, landmarks, and images", async () => {
    await load(`
      <header><nav><a href="/a">Alpha</a></nav></header>
      <main>
        <h1>Title</h1>
        <button>Go</button>
        <img src="x.png" alt="A cat">
      </main>
    `);
    const snap = await buildSnapshot(page, 0);
    const roles = snap.nodes.map((n) => n.role);
    expect(roles).toContain("banner");
    expect(roles).toContain("navigation");
    expect(roles).toContain("link");
    expect(roles).toContain("heading");
    expect(roles).toContain("button");
    expect(roles).toContain("img");
  });

  it("records heading level in detail", async () => {
    await load(`<main><h1>One</h1><h3>Three</h3></main>`);
    const snap = await buildSnapshot(page, 0);
    const h1 = snap.nodes.find((n) => n.name === "One");
    const h3 = snap.nodes.find((n) => n.name === "Three");
    expect(h1?.detail).toContain("level=1");
    expect(h3?.detail).toContain("level=3");
  });
});

describe("accessible name", () => {
  it("prefers aria-label over content", async () => {
    await load(`<main><button aria-label="Close dialog">x</button></main>`);
    const snap = await buildSnapshot(page, 0);
    expect(snap.nodes.find((n) => n.role === "button")?.name).toBe("Close dialog");
  });

  it("resolves a label element for an input", async () => {
    await load(
      `<main><label for="e">Work email</label><input id="e" type="email"></main>`,
    );
    const snap = await buildSnapshot(page, 0);
    const input = snap.nodes.find((n) => n.role === "textbox");
    expect(input?.name).toBe("Work email");
  });

  it("does NOT treat a placeholder as an accessible name", async () => {
    // The planted unlabelled-input defect depends on this. Falling back to the
    // placeholder would give the field a name and hide the defect entirely.
    await load(`<main><input type="email" placeholder="Work email"></main>`);
    const snap = await buildSnapshot(page, 0);
    const input = snap.nodes.find((n) => n.role === "textbox");
    expect(input?.name).toBe("");
    expect(input?.detail).toContain("placeholder");
  });

  it("does not use page text as a landmark's name", async () => {
    // Otherwise a landmark's "name" becomes the whole document, which both
    // misreports what a screen reader announces and wastes the token budget.
    await load(`<main><p>${"lorem ipsum ".repeat(50)}</p><h1>Real title</h1></main>`);
    const snap = await buildSnapshot(page, 0);
    const main = snap.nodes.find((n) => n.role === "main");
    expect(main?.name).toBe("");
  });

  it("distinguishes a missing alt from an explicitly empty one", async () => {
    await load(`<main><img src="a.png"><img src="b.png" alt=""></main>`);
    const snap = await buildSnapshot(page, 0);
    const imgs = snap.nodes.filter((n) => n.role === "img");
    expect(imgs[0]?.detail).toContain("alt-missing");
    expect(imgs[1]?.detail).toContain("decorative");
  });
});

describe("step-namespaced refs", () => {
  it("namespaces every ref with the step index", async () => {
    await load(`<main><button>A</button><button>B</button></main>`);
    const snap = await buildSnapshot(page, 7);
    expect(snap.nodes.length).toBeGreaterThan(0);
    for (const n of snap.nodes) {
      expect(stepIndexOfRef(n.ref)).toBe(7);
    }
  });

  it("clears prior stamps so a stale ref resolves to nothing", async () => {
    // The silent-corruption case: without clearing, `s0e1` from step 0 would
    // still be in the DOM at step 1 and resolve cleanly to a DIFFERENT element.
    await load(`<main><button id="first">First</button></main>`);
    const first = await buildSnapshot(page, 0);
    const staleRef = first.nodes.find((n) => n.role === "button")?.ref;
    expect(staleRef).toBe("s0e1");

    await load(`<main><button id="second">Second</button></main>`);
    const second = await buildSnapshot(page, 1);

    // The old ref is gone from both the snapshot and the DOM.
    expect(findNode(second, staleRef!)).toBeUndefined();
    const stillStamped = await page.locator(`[${REF_ATTR}="${staleRef}"]`).count();
    expect(stillStamped).toBe(0);

    // And the new step's refs are namespaced to step 1.
    expect(second.nodes.every((n) => stepIndexOfRef(n.ref) === 1)).toBe(true);
  });

  it("stamps the DOM so every emitted ref is resolvable", async () => {
    await load(`
      <main>
        <a href="/x">Link</a>
        <button>Press</button>
        <input type="text" aria-label="Name">
      </main>
    `);
    const snap = await buildSnapshot(page, 3);
    for (const n of snap.nodes) {
      const count = await page.locator(`[${REF_ATTR}="${n.ref}"]`).count();
      expect(count, `ref ${n.ref} (${n.role}) should resolve to exactly one node`).toBe(1);
    }
  });
});

describe("truncation", () => {
  it("collapses genuinely repeated siblings", async () => {
    const rows = Array.from({ length: 20 }, () => `<img src="l.svg" alt="">`).join("");
    await load(`<main><div>${rows}</div></main>`);
    const snap = await buildSnapshot(page, 0);
    const imgs = snap.nodes.filter((n) => n.role === "img");
    expect(imgs.length).toBeLessThan(20);
    expect(imgs.some((n) => (n.collapsedCount ?? 0) > 0)).toBe(true);
  });

  it("does NOT collapse distinct siblings that share a tag", async () => {
    // Four nav links to four different pages must all survive — collapsing
    // them would hide the navigation the persona is trying to use.
    await load(`
      <nav>
        <a href="/a">Alpha</a><a href="/b">Beta</a>
        <a href="/c">Gamma</a><a href="/d">Delta</a>
      </nav>
    `);
    const snap = await buildSnapshot(page, 0);
    const links = snap.nodes.filter((n) => n.role === "link");
    expect(links).toHaveLength(4);
  });

  it("keeps offscreen images so missing alt text stays detectable", async () => {
    await load(
      `<main><div style="height:3000px"></div><img src="far.png"></main>`,
      { width: 800, height: 600 },
    );
    const snap = await buildSnapshot(page, 0);
    const img = snap.nodes.find((n) => n.role === "img");
    expect(img).toBeDefined();
    expect(img?.inViewport).toBe(false);
  });

  it("reports truncation rather than hiding it", async () => {
    const many = Array.from(
      { length: 300 },
      (_, i) => `<button>Distinct button ${i}</button>`,
    ).join("");
    await load(`<main>${many}</main>`);
    const snap = await buildSnapshot(page, 0);
    expect(snap.truncated).toBe(true);
    expect(snap.nodes.length).toBeLessThanOrEqual(120);
    expect(renderSnapshotTree(snap)).toContain("snapshot truncated");
  });
});

describe("frames", () => {
  it("tags iframe content with a frame id and leaves main-frame nodes null", async () => {
    // Playwright's CSS engine does not pierce iframes, so resolution has to
    // know which frame a ref came from.
    await load(`
      <main>
        <button>Outer</button>
        <iframe name="consent" srcdoc="<button>Accept all</button>"></iframe>
      </main>
    `);
    await page.waitForTimeout(200);
    const snap = await buildSnapshot(page, 0);

    const outer = snap.nodes.find((n) => n.name === "Outer");
    const inner = snap.nodes.find((n) => n.name === "Accept all");

    expect(outer?.frameId).toBeNull();
    expect(inner).toBeDefined();
    expect(inner?.frameId).toBe("consent");
  });
});
