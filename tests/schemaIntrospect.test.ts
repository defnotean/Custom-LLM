import { describe, expect, it } from "vitest";
import { z } from "zod";
import { requiredArgKeys } from "../src/tools/schemaIntrospect";

describe("schemaIntrospect", () => {
  it("distinguishes required args from optional and defaulted args", () => {
    const schema = z.object({
      requiredText: z.string(),
      optionalText: z.string().optional(),
      defaultedCount: z.number().default(1),
      nullableButRequired: z.string().nullable(),
    });

    expect(requiredArgKeys(schema)).toEqual(["requiredText", "nullableButRequired"]);
  });
});
