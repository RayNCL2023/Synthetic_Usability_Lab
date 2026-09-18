import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildHeroTrack } from "./hero-reel";

/**
 * The hero animation is abstract, but it is not decorative: every mark in it is
 * a real event from a recorded run. This reduces a fixture's log to the few
 * hundred bytes the animation needs, so the landing page can show the product
 * working without shipping a megabyte of embedded screenshots to do it.
 */

const ev = (over: Record<string, unknown> = {}) => ({
  type: "persona.step",
  personaKey: "impatient_mobile",
  ts: 1_000,
  ...over,
});

describe("buildHeroTrack", () => {
  it("places a node for every step and finding", () => {
    const track = buildHeroTrack([
      ev({ type: "persona.step", ts: 1_000 }),
      ev({ type: "persona.observation", ts: 2_000, severity: "major" }),
    ]);

    expect(track.nodes.map((n) => n.kind)).toEqual(["step", "finding"]);
  });

  it("times every node from the start of the run", () => {
    const track = buildHeroTrack([
      ev({ ts: 10_000 }),
      ev({ ts: 25_000 }),
    ]);

    expect(track.nodes.map((n) => n.at)).toEqual([0, 15_000]);
  });

  it("spans the whole run", () => {
    const track = buildHeroTrack([ev({ ts: 5_000 }), ev({ ts: 56_000 })]);

    expect(track.durationMs).toBe(51_000);
  });

  it("gives each persona its own lane, in the order they first appear", () => {
    const track = buildHeroTrack([
      ev({ personaKey: "screen_reader", ts: 1_000 }),
      ev({ personaKey: "impatient_mobile", ts: 2_000 }),
      ev({ personaKey: "screen_reader", ts: 3_000 }),
    ]);

    expect(track.lanes).toEqual(["screen_reader", "impatient_mobile"]);
    expect(track.nodes.map((n) => n.lane)).toEqual([0, 1, 0]);
  });

  it("carries the severity of a finding so it can be coloured truthfully", () => {
    const track = buildHeroTrack([
      ev({ type: "persona.observation", severity: "blocker" }),
    ]);

    expect(track.nodes[0]?.severity).toBe("blocker");
  });

  it("leaves status chatter out of the picture", () => {
    const track = buildHeroTrack([
      ev({ type: "persona.status", label: "thinking" }),
      ev({ type: "run.started" }),
      ev({ type: "persona.step" }),
    ]);

    expect(track.nodes).toHaveLength(1);
  });

  it("marks where browsing ends and clustering takes over", () => {
    // Half of a run's wall clock can be the aggregation call that ranks the
    // findings, long after the last persona stopped browsing. The animation
    // labels that stretch rather than leaving it looking like dead air.
    const track = buildHeroTrack([
      ev({ ts: 0 }),
      ev({ type: "persona.observation", ts: 96_000, severity: "major" }),
      { type: "persona.finished", personaKey: "impatient_mobile", ts: 96_000 },
      { type: "run.issues", personaKey: null, ts: 183_000 },
    ]);

    expect(track.browsingEndsAt).toBe(96_000);
    expect(track.durationMs).toBe(183_000);
  });

  it("ends browsing with the run when nothing follows it", () => {
    const track = buildHeroTrack([ev({ ts: 0 }), ev({ ts: 50_000 })]);

    expect(track.browsingEndsAt).toBe(50_000);
  });

  it("has nothing to animate for an empty log", () => {
    const track = buildHeroTrack([]);

    expect(track.nodes).toEqual([]);
    expect(track.durationMs).toBe(0);
  });

  it("stays small enough to inline on the landing page", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../../../fixtures/seeded-runs/gnu-org.json", import.meta.url),
        "utf8",
      ),
    ) as { events: Array<Record<string, unknown>> };

    const track = buildHeroTrack(fixture.events);
    const bytes = JSON.stringify(track).length;

    expect(track.lanes).toHaveLength(3);
    expect(track.nodes.length).toBeGreaterThan(0);
    // The fixture it came from is over a megabyte.
    expect(bytes).toBeLessThan(4_000);
  });
});
