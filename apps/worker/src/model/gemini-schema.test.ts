import { describe, expect, it } from "vitest";
import { DecisionSchema } from "@sul/shared";
import { zodToGeminiSchema } from "./gemini-schema.js";

/**
 * The point of these tests is the enum question.
 *
 * On the Anthropic path, `zodOutputFormat` strips `enum` out of the schema and
 * demotes it into the description as prose, so the API is told the values but
 * generation is not constrained (DEVIATIONS V2). These tests pin the opposite
 * property for Gemini: enums survive as real constraints. If a future SDK
 * version starts stripping them, this fails loudly rather than silently
 * widening what the model may return.
 */

describe("zod -> Gemini responseSchema", () => {
  const { schema, notes } = zodToGeminiSchema(DecisionSchema);

  it("preserves enums as a real constraint, not as description prose", () => {
    const actionType = schema.properties?.["action"]?.properties?.["type"];
    expect(actionType?.enum).toEqual([
      "click",
      "type",
      "scroll",
      "go_back",
      "wait",
      "finish",
    ]);
    expect(actionType?.format).toBe("enum");

    // The Anthropic failure mode, asserted absent.
    const asJson = JSON.stringify(schema);
    expect(asJson).not.toMatch(/\{enum:/);
  });

  it("preserves the nested observation enums too", () => {
    const obs = schema.properties?.["observations"]?.items;
    expect(obs?.properties?.["severity"]?.enum).toEqual([
      "blocker",
      "major",
      "minor",
      "nitpick",
    ]);
    expect(obs?.properties?.["category"]?.enum).toContain("accessibility");
  });

  it("expresses nullable fields with `nullable`, keeping the enum intact", () => {
    const direction = schema.properties?.["action"]?.properties?.["direction"];
    expect(direction?.nullable).toBe(true);
    expect(direction?.enum).toEqual(["down", "up"]);
  });

  it("marks every non-optional field required", () => {
    expect(schema.required).toEqual(
      expect.arrayContaining(["narration", "reasoning", "action", "observations"]),
    );
  });

  it("drops nothing it cannot express", () => {
    expect(notes.dropped).toEqual([]);
    expect(notes.enumsPreserved.length).toBeGreaterThanOrEqual(4);
  });
});
