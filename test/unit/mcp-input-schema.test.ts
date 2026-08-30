import { describe, expect, it } from "vitest";

import { compileInputSchema } from "../../src/mcp/input-schema.js";

describe("compileInputSchema", () => {
  it.each([
    ["https://json-schema.org/draft/2020-12/schema", "2020-12"],
    ["https://json-schema.org/draft/2020-12/schema#", "2020-12"],
    ["https://json-schema.org/draft/2019-09/schema", "2019-09"],
    ["https://json-schema.org/draft/2019-09/schema#", "2019-09"],
    ["http://json-schema.org/draft-07/schema", "draft-07"],
    ["http://json-schema.org/draft-07/schema#", "draft-07"],
    ["http://json-schema.org/draft-06/schema", "draft-06"],
    ["http://json-schema.org/draft-06/schema#", "draft-06"],
  ] as const)("accepts canonical dialect URI %s", (schemaUri, dialect) => {
    const compiled = compileInputSchema({
      $schema: schemaUri,
      type: "null",
    });

    expect(compiled.dialect).toBe(dialect);
    expect(compiled.validate(null)).toBe(true);
    expect(compiled.validate("not null")).toBe(false);
  });

  it("uses JSON Schema 2020-12 when $schema is absent", () => {
    const compiled = compileInputSchema({
      type: "array",
      prefixItems: [{ const: "first" }],
      items: false,
    });

    expect(compiled.dialect).toBe("2020-12");
    expect(compiled.validate(["first"])).toBe(true);
    expect(compiled.validate(["wrong"])).toBe(false);
    expect(compiled.validate(["first", "extra"])).toBe(false);
  });

  it("uses JSON Schema 2020-12 when explicitly declared", () => {
    const compiled = compileInputSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "array",
      prefixItems: [{ type: "integer" }],
      items: false,
    });

    expect(compiled.dialect).toBe("2020-12");
    expect(compiled.validate([1])).toBe(true);
    expect(compiled.validate(["1"])).toBe(false);
  });

  it("uses JSON Schema 2019-09 for unevaluated properties", () => {
    const compiled = compileInputSchema({
      $schema: "https://json-schema.org/draft/2019-09/schema",
      type: "object",
      properties: {
        name: { type: "string" },
      },
      unevaluatedProperties: false,
    });

    expect(compiled.dialect).toBe("2019-09");
    expect(compiled.validate({ name: "forge" })).toBe(true);
    expect(compiled.validate({ name: "forge", ignored: true })).toBe(false);
  });

  it("uses draft-07 tuple validation for an explicit draft-07 schema", () => {
    const compiled = compileInputSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "array",
      items: [{ const: "first" }],
      additionalItems: false,
    });

    expect(compiled.dialect).toBe("draft-07");
    expect(compiled.validate(["first"])).toBe(true);
    expect(compiled.validate(["wrong"])).toBe(false);
    expect(compiled.validate(["first", "extra"])).toBe(false);
  });

  it("registers and uses an explicit draft-06 schema", () => {
    const compiled = compileInputSchema({
      $schema: "http://json-schema.org/draft-06/schema#",
      type: "array",
      contains: { const: "forge" },
    });

    expect(compiled.dialect).toBe("draft-06");
    expect(compiled.validate(["other", "forge"])).toBe(true);
    expect(compiled.validate(["other"])).toBe(false);
  });

  it("rejects unknown dialects instead of silently choosing a compiler", () => {
    expect(() =>
      compileInputSchema({
        $schema: "https://example.com/custom-schema",
        type: "object",
      }),
    ).toThrow(
      "unsupported JSON Schema dialect 'https://example.com/custom-schema'",
    );
  });

  it.each([
    "http://json-schema.org/draft/2020-12/schema",
    "http://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft-07/schema",
    "https://json-schema.org/draft-06/schema",
  ])("rejects noncanonical dialect alias %s", (schemaUri) => {
    expect(() => compileInputSchema({ $schema: schemaUri, type: "object" })).toThrow(
      `unsupported JSON Schema dialect '${schemaUri}'`,
    );
  });

  it("reports an invalid declared dialect field clearly", () => {
    expect(() => compileInputSchema({ $schema: 202012, type: "object" })).toThrow(
      "input schema $schema must be a string URI",
    );
  });
});
