import { describe, expect, it } from "vitest";
import { PERSONAS } from "@sul/shared";
import { PERSONA_META, runEndpoint } from "./api";

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

/**
 * A deployment with no API configured must not try to fetch one.
 *
 * `API` is the empty string when NEXT_PUBLIC_API_URL is unset, and
 * `fetch("/runs/x")` from a server component throws ERR_INVALID_URL rather
 * than returning a failed response — so the live-run route answered a public
 * visitor with a 500 instead of a 404.
 */
describe("runEndpoint", () => {
  it("builds an absolute URL when an API is configured", () => {
    expect(runEndpoint("https://api.example.com", "abc")).toBe(
      "https://api.example.com/runs/abc",
    );
  });

  it("tolerates a trailing slash on the configured base", () => {
    expect(runEndpoint("https://api.example.com/", "abc")).toBe(
      "https://api.example.com/runs/abc",
    );
  });

  it("returns null when no API is configured, rather than a relative path", () => {
    expect(runEndpoint("", "abc")).toBeNull();
  });

  it("treats whitespace as no configuration at all", () => {
    expect(runEndpoint("   ", "abc")).toBeNull();
  });

  it("encodes the run id so a hostile path cannot escape the route", () => {
    expect(runEndpoint("https://api.example.com", "../../admin")).toBe(
      "https://api.example.com/runs/..%2F..%2Fadmin",
    );
  });
});
