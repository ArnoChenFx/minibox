import { z } from "zod";

export type JsonSchema = Record<string, unknown>;

/** A zod schema as a JSON Schema, without the `$schema` marker that only top-level documents carry. */
export function toJsonSchema(schema: z.ZodType, io: "input" | "output" = "input"): JsonSchema {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: "any" });
  return rest;
}
