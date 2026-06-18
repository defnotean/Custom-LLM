import { z } from "zod";
import type { JsonObject, JsonValue } from "../types/common";

/**
 * Lightweight Zod introspection used to render tool argument schemas in
 * prompts (compact), export tool metadata, and generate deterministic sample
 * arguments for synthetic training examples. Covers the subset of Zod used
 * by tool schemas; unknown types degrade to "unknown"/null gracefully.
 */

export function describeZodType(schema: z.ZodTypeAny): string {
  const def = schema._def as { typeName?: z.ZodFirstPartyTypeKind };
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString:
      return "string";
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return "number";
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return "boolean";
    case z.ZodFirstPartyTypeKind.ZodEnum: {
      const values = (schema as z.ZodEnum<[string, ...string[]]>).options;
      return values.map((v) => JSON.stringify(v)).join(" | ");
    }
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return JSON.stringify((schema as z.ZodLiteral<unknown>).value);
    case z.ZodFirstPartyTypeKind.ZodArray:
      return `${describeZodType((schema as z.ZodArray<z.ZodTypeAny>).element)}[]`;
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return `${describeZodType((schema as z.ZodOptional<z.ZodTypeAny>).unwrap())}?`;
    case z.ZodFirstPartyTypeKind.ZodNullable:
      return `${describeZodType((schema as z.ZodNullable<z.ZodTypeAny>).unwrap())} | null`;
    case z.ZodFirstPartyTypeKind.ZodDefault: {
      const inner = (schema._def as unknown as { innerType: z.ZodTypeAny }).innerType;
      return `${describeZodType(inner)}?`;
    }
    case z.ZodFirstPartyTypeKind.ZodObject:
      return "object";
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return "record";
    case z.ZodFirstPartyTypeKind.ZodUnion:
      return (schema as z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>).options
        .map((o) => describeZodType(o))
        .join(" | ");
    default:
      return "unknown";
  }
}

/** { argName: "string", count: "number?" } — compact shape for prompts. */
export function describeArgsSchema(schema: z.ZodTypeAny): Record<string, string> {
  const unwrapped = unwrap(schema);
  const def = unwrapped._def as { typeName?: z.ZodFirstPartyTypeKind };
  if (def.typeName !== z.ZodFirstPartyTypeKind.ZodObject) return {};
  const shape = (unwrapped as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(shape)) {
    out[key] = describeZodType(value);
  }
  return out;
}

export function requiredArgKeys(schema: z.ZodTypeAny): string[] {
  const unwrapped = unwrap(schema);
  const def = unwrapped._def as { typeName?: z.ZodFirstPartyTypeKind };
  if (def.typeName !== z.ZodFirstPartyTypeKind.ZodObject) return [];
  const shape = (unwrapped as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
  return Object.entries(shape)
    .filter(([, value]) => !isOptionalInput(value))
    .map(([key]) => key);
}

/** Deterministic minimal valid-looking sample args (for synthetic examples). */
export function sampleFromSchema(schema: z.ZodTypeAny): JsonValue {
  const unwrapped = unwrap(schema);
  const def = unwrapped._def as { typeName?: z.ZodFirstPartyTypeKind };
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString:
      return "example";
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return 1;
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return true;
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return (unwrapped as z.ZodEnum<[string, ...string[]]>).options[0] ?? "example";
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return ((unwrapped as z.ZodLiteral<unknown>).value ?? null) as JsonValue;
    case z.ZodFirstPartyTypeKind.ZodArray:
      return [sampleFromSchema((unwrapped as z.ZodArray<z.ZodTypeAny>).element)];
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (unwrapped as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      const out: JsonObject = {};
      for (const [key, value] of Object.entries(shape)) {
        // Skip optional keys to keep samples minimal.
        const vDef = value._def as { typeName?: z.ZodFirstPartyTypeKind };
        if (vDef.typeName === z.ZodFirstPartyTypeKind.ZodOptional) continue;
        out[key] = sampleFromSchema(value);
      }
      return out;
    }
    default:
      return null;
  }
}

function isOptionalInput(schema: z.ZodTypeAny): boolean {
  const def = schema._def as { typeName?: z.ZodFirstPartyTypeKind };
  return (
    def.typeName === z.ZodFirstPartyTypeKind.ZodOptional ||
    def.typeName === z.ZodFirstPartyTypeKind.ZodDefault
  );
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (let i = 0; i < 10; i++) {
    const def = current._def as { typeName?: z.ZodFirstPartyTypeKind; innerType?: z.ZodTypeAny };
    if (
      def.typeName === z.ZodFirstPartyTypeKind.ZodDefault ||
      def.typeName === z.ZodFirstPartyTypeKind.ZodOptional ||
      def.typeName === z.ZodFirstPartyTypeKind.ZodNullable
    ) {
      const inner =
        def.innerType ??
        (current as z.ZodOptional<z.ZodTypeAny> | z.ZodNullable<z.ZodTypeAny>).unwrap?.();
      if (!inner) return current;
      current = inner;
      continue;
    }
    return current;
  }
  return current;
}
