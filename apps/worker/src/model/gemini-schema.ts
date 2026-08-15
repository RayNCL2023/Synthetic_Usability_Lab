import { Type, type Schema } from "@google/genai";
import * as z from "zod/v4";

/**
 * Converts a Zod schema into Gemini's `Schema` shape for `responseSchema`.
 *
 * The reason this exists rather than passing JSON Schema straight through:
 * Gemini's `Schema` has a FIRST-CLASS `enum` field. Per the shipped SDK docs on
 * that field — "This field can be used to restrict a value to a fixed set of
 * values" — an enum survives as an actual constraint, set alongside
 * `format: "enum"`.
 *
 * That is a real structural difference from the Anthropic path, where
 * `zodOutputFormat` strips `enum` out of the schema and demotes it into the
 * property description as prose (see DEVIATIONS V2). Here the constraint is
 * preserved and handed to the service.
 *
 * We still treat local `safeParse` as the enforcement of record. Whether the
 * service grammar-constrains generation or merely validates afterwards is its
 * business, and the failure mode we care about — a value outside the enum
 * reaching the browser — must be impossible regardless of what any provider
 * promises. `propertyOrdering` is set from the Zod object's key order because
 * Gemini honours it and stable field order makes responses easier to diff.
 */

export interface ConversionNotes {
  /** Enum sites preserved as a real `enum` constraint. */
  enumsPreserved: string[];
  /** Anything we could not express and had to drop. */
  dropped: string[];
}

export function zodToGeminiSchema(
  schema: z.ZodType,
  notes: ConversionNotes = { enumsPreserved: [], dropped: [] },
  path = "",
): { schema: Schema; notes: ConversionNotes } {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod
    .def;
  const kind = def["type"] as string;

  switch (kind) {
    case "object": {
      const shape = (def["shape"] ?? {}) as Record<string, z.ZodType>;
      const properties: Record<string, Schema> = {};
      const required: string[] = [];
      const ordering: string[] = [];

      for (const [key, child] of Object.entries(shape)) {
        const childPath = path ? `${path}.${key}` : key;
        const { schema: childSchema } = zodToGeminiSchema(child, notes, childPath);
        properties[key] = childSchema;
        ordering.push(key);
        if (!isOptional(child)) required.push(key);
      }

      return {
        schema: {
          type: Type.OBJECT,
          properties,
          required,
          propertyOrdering: ordering,
        },
        notes,
      };
    }

    case "array": {
      const element = def["element"] as z.ZodType;
      const { schema: items } = zodToGeminiSchema(element, notes, `${path}[]`);
      return { schema: { type: Type.ARRAY, items }, notes };
    }

    case "enum": {
      // The whole point: preserved as a constraint, not narrated.
      const entries = def["entries"] as Record<string, string>;
      const values = Object.values(entries);
      notes.enumsPreserved.push(`${path} (${values.length} values)`);
      return {
        schema: { type: Type.STRING, format: "enum", enum: values },
        notes,
      };
    }

    case "literal": {
      const values = def["values"] as unknown[];
      const asStrings = values.map((v) => String(v));
      notes.enumsPreserved.push(`${path} (literal)`);
      return {
        schema: { type: Type.STRING, format: "enum", enum: asStrings },
        notes,
      };
    }

    case "nullable": {
      // Gemini expresses nullability with `nullable`, not a union with null.
      const inner = def["innerType"] as z.ZodType;
      const { schema: innerSchema } = zodToGeminiSchema(inner, notes, path);
      return { schema: { ...innerSchema, nullable: true }, notes };
    }

    case "optional":
    case "default": {
      const inner = def["innerType"] as z.ZodType;
      return zodToGeminiSchema(inner, notes, path);
    }

    case "string":
      return { schema: { type: Type.STRING }, notes };

    case "number":
    case "int":
      return { schema: { type: Type.NUMBER }, notes };

    case "boolean":
      return { schema: { type: Type.BOOLEAN }, notes };

    default: {
      notes.dropped.push(`${path}: unsupported zod type "${kind}" — sent as STRING`);
      return { schema: { type: Type.STRING }, notes };
    }
  }
}

function isOptional(schema: z.ZodType): boolean {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod
    .def;
  const kind = def["type"] as string;
  return kind === "optional" || kind === "default";
}
