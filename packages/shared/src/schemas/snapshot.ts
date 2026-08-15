import { z } from "zod/v4";

/**
 * The accessibility snapshot — the grounding substrate.
 *
 * Every claim the model makes must reference a ref present in the snapshot for
 * the CURRENT step. Refs are step-namespaced (`s3e12`) because a bare `e12`
 * quoted from an earlier step's history resolves cleanly against a later DOM to
 * a *different element*: no error, no rejection, a confident critique pinned to
 * the wrong thing. That is the one failure mode that would corrupt the exact
 * artifact this product sells, so it is made loud by construction.
 */

export const BoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type Box = z.infer<typeof BoxSchema>;

export const SnapshotNodeSchema = z.object({
  /** Step-namespaced: `s{stepIndex}e{elementIndex}`. */
  ref: z.string(),
  role: z.string(),
  name: z.string(),
  /** Extra semantics worth spending tokens on: heading level, input type, etc. */
  detail: z.string().nullable(),
  visible: z.boolean(),
  inViewport: z.boolean(),
  box: BoxSchema,
  /**
   * Which frame this element lives in. Playwright's CSS engine pierces open
   * shadow roots but NOT iframes, so a ref inside an iframe must be resolved
   * against its own frame. Cookie banners and embedded checkout widgets are
   * routinely iframed — this is the common case, not an edge case.
   * `null` means the main frame.
   */
  frameId: z.string().nullable(),
  /** Depth in the emitted tree, for indentation only. */
  depth: z.number(),
  /** Set when repeated siblings were collapsed: "and 14 more like this". */
  collapsedCount: z.number().nullable(),
});
export type SnapshotNode = z.infer<typeof SnapshotNodeSchema>;

export const SnapshotSchema = z.object({
  stepIndex: z.number(),
  url: z.string(),
  title: z.string(),
  viewport: z.object({ width: z.number(), height: z.number() }),
  nodes: z.array(SnapshotNodeSchema),
  /** True when the node cap or collapsing dropped content. */
  truncated: z.boolean(),
  /** Nodes discovered before truncation, for the debug view. */
  totalDiscovered: z.number(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** Renders the compact indented text tree the model actually sees. */
export function renderSnapshotTree(snapshot: Snapshot): string {
  const lines = snapshot.nodes.map((n) => {
    const indent = "  ".repeat(n.depth);
    const flags: string[] = [];
    if (n.visible) flags.push("visible");
    else flags.push("hidden");
    if (n.inViewport) flags.push("in-viewport");
    if (n.frameId) flags.push(`iframe:${n.frameId}`);

    const name = n.name ? ` ${JSON.stringify(n.name)}` : "";
    const detail = n.detail ? ` ${n.detail}` : "";
    const collapsed =
      n.collapsedCount && n.collapsedCount > 0
        ? ` (+${n.collapsedCount} similar collapsed)`
        : "";

    return `${indent}${n.ref} ${n.role}${name}${detail} [${flags.join(", ")}]${collapsed}`;
  });

  if (snapshot.truncated) {
    lines.push(
      `... snapshot truncated: showing ${snapshot.nodes.length} of ${snapshot.totalDiscovered} elements`,
    );
  }
  return lines.join("\n");
}

/** Fast membership test used by the grounding validator. */
export function snapshotRefs(snapshot: Snapshot): Set<string> {
  return new Set(snapshot.nodes.map((n) => n.ref));
}

export function findNode(snapshot: Snapshot, ref: string): SnapshotNode | undefined {
  return snapshot.nodes.find((n) => n.ref === ref);
}

/** `s3e12` -> 3. Returns null when the ref is not well-formed. */
export function stepIndexOfRef(ref: string): number | null {
  const m = /^s(\d+)e\d+$/.exec(ref);
  return m && m[1] !== undefined ? Number(m[1]) : null;
}

export function makeRef(stepIndex: number, elementIndex: number): string {
  return `s${stepIndex}e${elementIndex}`;
}
