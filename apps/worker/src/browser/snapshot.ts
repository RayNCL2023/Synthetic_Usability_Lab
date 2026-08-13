import type { Frame, Page } from "playwright";
import type { Snapshot, SnapshotNode } from "@sul/shared";
import { makeRef } from "@sul/shared";

/**
 * The accessibility snapshot builder.
 *
 * This is the grounding substrate: the model may only reference elements that
 * appear here, and the validator enforces that in code. Three properties matter
 * more than completeness:
 *
 *  1. Refs are STEP-NAMESPACED and prior stamps are cleared every step. A bare
 *     `e12` carried over from an earlier step's history would resolve cleanly
 *     against a later DOM to a *different* element — no error, no rejection, a
 *     confident critique pinned to the wrong thing. Namespacing turns that
 *     silent corruption into a loud rejection.
 *
 *  2. Every node records its FRAME. Playwright's CSS engine pierces open shadow
 *     roots but not iframes, so a ref inside an iframe must be resolved against
 *     that frame. Cookie banners and embedded widgets are routinely iframed.
 *
 *  3. Token bounds are a correctness property, not just a cost one. An
 *     unbounded snapshot pushes the screenshot out of the useful context, so
 *     truncation is aggressive and reported rather than hidden.
 */

export const REF_ATTR = "data-sul-ref";

export interface SnapshotOptions {
  /** Hard cap on emitted nodes. */
  maxNodes: number;
  /** Keep at most this many consecutive same-role siblings before collapsing. */
  maxRepeatedSiblings: number;
  /** Drop non-interactive nodes that are outside the viewport. */
  dropOffscreenDecorative: boolean;
}

export const DEFAULT_SNAPSHOT_OPTIONS: SnapshotOptions = {
  maxNodes: 120,
  maxRepeatedSiblings: 3,
  dropOffscreenDecorative: true,
};

/** Shape returned by the in-page walker, before ref assignment. */
interface RawNode {
  role: string;
  name: string;
  detail: string | null;
  visible: boolean;
  inViewport: boolean;
  box: { x: number; y: number; w: number; h: number };
  depth: number;
  interactive: boolean;
  /** Index into the frame's stamped element list, used to re-stamp with the ref. */
  stampIndex: number;
  /** Sibling grouping key, for collapsing repeated list items. */
  groupKey: string;
  /** Set when following same-group siblings were collapsed into this one. */
  collapsedCount?: number;
}

/**
 * Runs inside the page. Must be fully self-contained — no imports, no closure
 * over module scope.
 */
/* c8 ignore start — executes in the browser, covered by integration tests */
function walkDocument(refAttr: string): { nodes: RawNode[]; totalDiscovered: number } {
  const INTERACTIVE_TAGS = new Set([
    "A",
    "BUTTON",
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "SUMMARY",
  ]);
  const LANDMARK_ROLES = new Set([
    "banner",
    "navigation",
    "main",
    "complementary",
    "contentinfo",
    "search",
    "form",
    "region",
  ]);

  function implicitRole(el: Element): string {
    const tag = el.tagName;
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().toLowerCase();

    switch (tag) {
      case "A":
        return el.hasAttribute("href") ? "link" : "generic";
      case "BUTTON":
        return "button";
      case "SUMMARY":
        return "button";
      case "NAV":
        return "navigation";
      case "MAIN":
        return "main";
      case "HEADER":
        return "banner";
      case "FOOTER":
        return "contentinfo";
      case "ASIDE":
        return "complementary";
      case "FORM":
        return "form";
      case "SECTION":
        return "region";
      case "IMG":
        return "img";
      case "SELECT":
        return "combobox";
      case "TEXTAREA":
        return "textbox";
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
        return "heading";
      case "INPUT": {
        const t = (el.getAttribute("type") || "text").toLowerCase();
        if (t === "submit" || t === "button" || t === "reset") return "button";
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        return "textbox";
      }
      default:
        return "generic";
    }
  }

  function labelFor(el: Element): string {
    const id = el.getAttribute("id");
    if (id) {
      const esc =
        (window as unknown as { CSS?: { escape?: (s: string) => string } }).CSS
          ?.escape?.(id) ?? id.replace(/["\\]/g, "\\$&");
      const lbl = document.querySelector(`label[for="${esc}"]`);
      if (lbl && lbl.textContent) return lbl.textContent.trim();
    }
    const wrapper = el.closest("label");
    if (wrapper && wrapper.textContent) return wrapper.textContent.trim();
    return "";
  }

  /**
   * Accessible name — a practical subset of the accname algorithm.
   *
   * Deliberately does NOT fall back to `placeholder`. Real screen readers may
   * announce it, but treating a placeholder as a name would hide exactly the
   * defect we most want surfaced: an input with no label. The placeholder is
   * reported in `detail` instead, so the persona can say "this field has no
   * label, only placeholder text" — which is both true and actionable.
   */
  function accessibleName(el: Element, role: string): string {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((n): n is HTMLElement => !!n)
        .map((n) => (n.textContent || "").trim())
        .filter(Boolean);
      if (parts.length) return parts.join(" ");
    }

    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    if (el.tagName === "IMG") return (el.getAttribute("alt") || "").trim();

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const l = labelFor(el);
      if (l) return l;
      const value = el.getAttribute("value");
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (value && (type === "submit" || type === "button")) return value.trim();
      return "";
    }

    // textContent is only a legitimate name source for elements whose name
    // comes FROM their content: links, buttons, headings. Applying it to a
    // landmark or a container makes its "name" the entire page text, which
    // both misrepresents what a screen reader announces and burns a large
    // share of the snapshot's token budget on duplicated prose.
    const NAME_FROM_CONTENT = new Set([
      "link",
      "button",
      "heading",
      "checkbox",
      "radio",
      "option",
      "menuitem",
      "tab",
      "cell",
      "columnheader",
      "rowheader",
    ]);
    if (NAME_FROM_CONTENT.has(role)) {
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (text) return text.length > 120 ? `${text.slice(0, 117)}...` : text;
    }

    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();

    return "";
  }

  function detailFor(el: Element, role: string): string | null {
    const bits: string[] = [];
    if (role === "heading") {
      const explicit = el.getAttribute("aria-level");
      const m = /^H([1-6])$/.exec(el.tagName);
      const level = explicit || (m ? m[1] : null);
      if (level) bits.push(`level=${level}`);
    }
    if (el.tagName === "INPUT") {
      bits.push(`type=${(el.getAttribute("type") || "text").toLowerCase()}`);
      const ph = el.getAttribute("placeholder");
      // Surfaced explicitly so "no label, only a placeholder" is visible.
      if (ph && ph.trim()) bits.push(`placeholder=${JSON.stringify(ph.trim())}`);
      if (el.hasAttribute("required")) bits.push("required");
    }
    if (el.tagName === "A") {
      const href = el.getAttribute("href");
      if (href) bits.push(`href=${JSON.stringify(href.slice(0, 80))}`);
    }
    if (el.tagName === "IMG") {
      // Distinguish the two: an absent alt is an oversight, an explicitly empty
      // one is a claim that the image is decorative. A persona should be able
      // to say "these are marked decorative but appear to carry meaning",
      // which is a sharper and more actionable finding than "no alt text".
      if (!el.hasAttribute("alt")) bits.push("alt-missing");
      else if (!(el.getAttribute("alt") || "").trim()) bits.push('alt="" (decorative)');
    }
    if (el.getAttribute("aria-hidden") === "true") bits.push("aria-hidden");
    if (el.hasAttribute("disabled")) bits.push("disabled");
    return bits.length ? bits.join(" ") : null;
  }

  function isSemantic(el: Element, role: string, name: string): boolean {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    if (role === "heading") return true;
    if (LANDMARK_ROLES.has(role)) return true;
    if (el.tagName === "IMG") return true;
    if (el.getAttribute("role")) return true;
    // A generic div with an aria-label is carrying meaning.
    if (name && el.hasAttribute("aria-label")) return true;
    return false;
  }

  // Clear stamps from prior steps so a stale ref resolves to nothing.
  document.querySelectorAll(`[${refAttr}]`).forEach((el) => el.removeAttribute(refAttr));

  const stamped: Element[] = [];
  const nodes: RawNode[] = [];
  let totalDiscovered = 0;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let current: Node | null = walker.currentNode;

  while (current) {
    const el = current as Element;
    const role = implicitRole(el);
    const name = accessibleName(el, role);

    if (isSemantic(el, role, name)) {
      totalDiscovered++;

      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0.05 &&
        rect.width > 0 &&
        rect.height > 0;
      const inViewport =
        visible &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < vh &&
        rect.left < vw;

      // Depth measured in semantic ancestors, not raw DOM depth, so the tree
      // reads as an outline rather than reflecting wrapper-div nesting.
      let depth = 0;
      let p: Element | null = el.parentElement;
      while (p && p !== document.body) {
        const pr = implicitRole(p);
        if (isSemantic(p, pr, accessibleName(p, pr))) depth++;
        p = p.parentElement;
      }

      const stampIndex = stamped.length;
      stamped.push(el);

      // Collapsing is for genuinely repetitive content — a 200-row table, a
      // logo strip. Distinct siblings that happen to share a tag (four nav
      // links to four different pages) must NOT collapse, or we would hide
      // exactly the navigation the persona is trying to use. So the group key
      // includes the name: same role AND same name (or both unnamed) collapses;
      // anything else stays.
      const parentSig = el.parentElement ? el.parentElement.tagName : "ROOT";

      nodes.push({
        role,
        name,
        detail: detailFor(el, role),
        visible,
        inViewport,
        box: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
        depth: Math.min(depth, 6),
        interactive: INTERACTIVE_TAGS.has(el.tagName) || !!el.getAttribute("role"),
        stampIndex,
        groupKey: `${parentSig}|${role}|${el.tagName}|${name}`,
      });
    }

    current = walker.nextNode();
  }

  // Expose the stamped list so the caller can apply refs after truncation —
  // only surviving nodes get stamped, so a ref in the DOM always corresponds
  // to a ref in the snapshot the model saw.
  (window as unknown as { __sulStamped?: Element[] }).__sulStamped = stamped;

  return { nodes, totalDiscovered };
}
/* c8 ignore stop */

/** Applies refs to the elements that survived truncation. Runs in the page. */
/* c8 ignore start */
function applyRefs(arg: {
  refAttr: string;
  assignments: Array<[number, string]>;
}): void {
  const stamped = (window as unknown as { __sulStamped?: Element[] }).__sulStamped;
  if (!stamped) return;
  for (const [stampIndex, ref] of arg.assignments) {
    const el = stamped[stampIndex];
    if (el) el.setAttribute(arg.refAttr, ref);
  }
}
/* c8 ignore stop */

/**
 * Truncation, applied to one frame's nodes.
 *
 * Priority when over budget: keep interactive and in-viewport nodes, then
 * headings and landmarks, then everything else. Repeated siblings collapse to
 * a representative plus a count so a 200-row table costs a few tokens rather
 * than blowing the whole context.
 */
export function truncateNodes(
  nodes: RawNode[],
  opts: SnapshotOptions,
): { kept: RawNode[] } {
  // 1. Collapse runs of same-group siblings. The count rides on the surviving
  //    anchor node itself rather than in a side map keyed by position, because
  //    the filter and re-rank below reorder everything.
  const afterCollapse: RawNode[] = [];
  let runKey: string | null = null;
  let runCount = 0;
  let runAnchor: RawNode | null = null;

  for (const n of nodes) {
    if (n.groupKey === runKey) {
      runCount++;
      if (runCount > opts.maxRepeatedSiblings) {
        if (runAnchor) runAnchor.collapsedCount = (runAnchor.collapsedCount ?? 0) + 1;
        continue;
      }
    } else {
      runKey = n.groupKey;
      runCount = 1;
      runAnchor = n;
    }
    afterCollapse.push(n);
  }

  // 2. Drop offscreen decorative content.
  //
  // Images are kept even when offscreen. A missing-alt image is one of the
  // highest-value findings the screen-reader persona can make, and an image
  // strip below the fold is precisely where it tends to live — dropping it
  // here would make the defect undetectable no matter how good the model is.
  let pool = afterCollapse;
  if (opts.dropOffscreenDecorative) {
    pool = pool.filter(
      (n) => n.interactive || n.inViewport || n.role === "heading" || n.role === "img",
    );
  }

  if (pool.length <= opts.maxNodes) return { kept: pool };

  // 3. Still over budget — rank and cut, preserving document order in the result.
  const score = (n: RawNode): number => {
    let s = 0;
    if (n.interactive) s += 4;
    if (n.inViewport) s += 3;
    if (n.role === "heading") s += 2;
    if (n.role === "main" || n.role === "navigation") s += 2;
    if (n.name) s += 1;
    return s;
  };
  const ranked = pool
    .map((n, i) => ({ n, i, s: score(n) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, opts.maxNodes)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.n);

  return { kept: ranked };
}

async function snapshotFrame(
  frame: Frame,
  frameId: string | null,
  stepIndex: number,
  startElementIndex: number,
  opts: SnapshotOptions,
): Promise<{ nodes: SnapshotNode[]; totalDiscovered: number; nextIndex: number }> {
  const raw = await frame.evaluate(walkDocument, REF_ATTR);
  const { kept } = truncateNodes(raw.nodes, opts);

  const assignments: Array<[number, string]> = [];
  const nodes: SnapshotNode[] = kept.map((n, i) => {
    const ref = makeRef(stepIndex, startElementIndex + i);
    assignments.push([n.stampIndex, ref]);
    return {
      ref,
      role: n.role,
      name: n.name,
      detail: n.detail,
      visible: n.visible,
      inViewport: n.inViewport,
      box: n.box,
      frameId,
      depth: n.depth,
      collapsedCount: n.collapsedCount ?? null,
    };
  });

  // Stamp only the nodes that survived truncation, so a ref present in the DOM
  // always corresponds to a ref the model actually saw.
  await frame
    .evaluate(applyRefs, { refAttr: REF_ATTR, assignments })
    .catch(() => undefined);

  return {
    nodes,
    totalDiscovered: raw.totalDiscovered,
    nextIndex: startElementIndex + nodes.length,
  };
}

export async function buildSnapshot(
  page: Page,
  stepIndex: number,
  opts: SnapshotOptions = DEFAULT_SNAPSHOT_OPTIONS,
): Promise<Snapshot> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };

  const allNodes: SnapshotNode[] = [];
  let totalDiscovered = 0;
  let nextIndex = 0;

  // Main frame first, then children.
  //
  // A child frame that navigates or detaches mid-walk is skipped — that is
  // normal on real sites. A failure in the MAIN frame is not normal and must
  // propagate: swallowing it yields an empty snapshot, which the validator
  // would then read as "the model hallucinated every ref" rather than "the
  // snapshot builder broke".
  const frames = page.frames();
  for (const frame of frames) {
    const isMain = frame === page.mainFrame();
    const frameId = isMain ? null : frameLabel(frame);
    try {
      const result = await snapshotFrame(frame, frameId, stepIndex, nextIndex, opts);
      allNodes.push(...result.nodes);
      totalDiscovered += result.totalDiscovered;
      nextIndex = result.nextIndex;
    } catch (err) {
      if (isMain) {
        throw new Error(
          `Snapshot failed on the main frame at ${page.url()}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
      continue;
    }
    if (allNodes.length >= opts.maxNodes) break;
  }

  return {
    stepIndex,
    url: page.url(),
    title: await page.title().catch(() => ""),
    viewport,
    nodes: allNodes,
    truncated: allNodes.length < totalDiscovered,
    totalDiscovered,
  };
}

/** Stable-ish human label for a frame, used in refs' frameId and for resolution. */
export function frameLabel(frame: Frame): string {
  const name = frame.name();
  if (name) return name;
  try {
    const u = new URL(frame.url());
    return `${u.hostname}${u.pathname}`.slice(0, 60);
  } catch {
    return "frame";
  }
}
