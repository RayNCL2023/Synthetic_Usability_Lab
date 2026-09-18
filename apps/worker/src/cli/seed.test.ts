import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SEED_DIR } from "./seed.js";

/**
 * Integrity of the committed demo fixtures.
 *
 * These four files are the highest-value artifact in the repository — they are
 * what makes /demo/[slug] work with no key, no worker and no database — and
 * nothing else checks them, so a defect in the export tool freezes silently
 * into the showcase and is only noticed by a human watching a replay.
 *
 * That is exactly what happened: the exporter read run_events without an
 * ORDER BY, so every fixture shipped a scrambled log and every replay played
 * its steps out of sequence.
 */

const files = fs
  .readdirSync(SEED_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

interface Seed {
  slug: string;
  steps: Array<Record<string, unknown>>;
  personaRuns: Array<Record<string, unknown>>;
  events: Array<{ seq: number; type: string; personaKey: string | null }>;
}

function load(file: string): Seed {
  return JSON.parse(fs.readFileSync(path.join(SEED_DIR, file), "utf8")) as Seed;
}

describe("committed demo fixtures", () => {
  it("ships the four runs the landing page expects", () => {
    expect(files.length).toBe(4);
  });

  it.each(files)("%s stores its event log in seq order", (file) => {
    const seqs = load(file).events.map((e) => e.seq);

    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it.each(files)("%s has no duplicate or missing seq values", (file) => {
    const seqs = load(file).events.map((e) => e.seq);

    expect(new Set(seqs).size).toBe(seqs.length);
    // The per-run counter is contiguous from 1, so a gap means a lost event.
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  });

  it.each(files)("%s embeds every screenshot rather than a bucket key", (file) => {
    for (const step of load(file).steps) {
      const uri = step["screenshotDataUri"];
      if (uri !== null && uri !== undefined) {
        expect(String(uri).startsWith("data:image/")).toBe(true);
      }
    }
  });

  /**
   * Re-exporting a run that was previously imported used to carry the data URI
   * back out through `screenshotKey` as well, so every round-trip duplicated
   * every image and grew the committed showcase by about a third.
   */
  it.each(files)("%s stores each image once, not in two fields", (file) => {
    for (const step of load(file).steps) {
      const key = step["screenshotKey"];
      if (typeof key === "string") {
        expect(key.startsWith("data:")).toBe(false);
      }
    }
  });

  it.each(files)("%s carries a step event for every persisted step", (file) => {
    const seed = load(file);
    const stepEvents = seed.events.filter((e) => e.type === "persona.step");

    expect(stepEvents.length).toBe(seed.steps.length);
  });
});
