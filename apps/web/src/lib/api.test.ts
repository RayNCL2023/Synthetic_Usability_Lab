import { describe, expect, it } from "vitest";
import { PERSONAS } from "@sul/shared";
import { PERSONA_META } from "./api";

/**
 * The client deliberately carries its own copy of the persona metadata so the
 * recorded-run routes work with no backend at all. The cost of that choice is
 * drift, and the viewport is the field where drift is silent and expensive:
 * pins are plotted as a percentage of the viewport the boxes were measured in,
 * so a stale number here moves every pin in the report without any error.
 */
describe("PERSONA_META", () => {
  it("covers every persona the harness can run", () => {
    for (const persona of PERSONAS) {
      expect(PERSONA_META[persona.key]).toBeDefined();
    }
  });

  it("keeps the viewports in step with the harness definitions", () => {
    for (const persona of PERSONAS) {
      expect(PERSONA_META[persona.key]?.viewport).toEqual(persona.harness.viewport);
    }
  });

  it("agrees with the harness about which personas receive a screenshot", () => {
    for (const persona of PERSONAS) {
      expect(PERSONA_META[persona.key]?.sighted).toBe(
        persona.harness.receivesScreenshot,
      );
    }
  });
});
