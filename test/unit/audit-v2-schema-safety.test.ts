import { describe, expect, it } from "vitest";

import { V2CompileError } from "../../src/audit/v2/errors.js";
import { resolveStaticResourceReferences } from "../../src/audit/v2/references.js";
import {
  assertSafeInputSchema,
  validateSafeToolArguments,
  V2_SCHEMA_COMPLEXITY_LIMITS,
} from "../../src/audit/v2/schema-safety.js";

describe("V2 Phase 1A JSON Schema boundary", () => {
  it("validates bounded literal arguments against the frozen input schema", () => {
    const result = validateSafeToolArguments(
      {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      { path: "/forge/synthetic/resource-1" },
    );

    expect(result.arguments).toEqual({ path: "/forge/synthetic/resource-1" });
    expect(result.dialect).toBe("2020-12");
  });

  it("rejects arguments that do not satisfy the schema", () => {
    expect(() =>
      validateSafeToolArguments(
        {
          type: "object",
          properties: { count: { type: "integer" } },
          required: ["count"],
          additionalProperties: false,
        },
        { count: "1" },
      ),
    ).toThrow("do not satisfy");
  });

  it.each([
    "$async",
    "$ref",
    "$dynamicRef",
    "$recursiveRef",
    "format",
    "pattern",
  ])(
    "rejects hazardous or deferred schema keyword %s",
    (keyword) => {
      expect(() => assertSafeInputSchema({ [keyword]: "#" })).toThrow(keyword);
    },
  );

  it("rejects patternProperties before AJV compilation", () => {
    expect(() =>
      assertSafeInputSchema({
        type: "object",
        patternProperties: { "^(a+)+$": { type: "string" } },
      }),
    ).toThrow("patternProperties");
  });

  it("rejects uniqueItems before AJV compilation", () => {
    expect(() =>
      assertSafeInputSchema({
        type: "array",
        uniqueItems: true,
        items: { type: "string" },
      }),
    ).toThrow("uniqueItems");
  });

  it("rejects unknown schema keywords instead of silently ignoring them", () => {
    expect(() =>
      validateSafeToolArguments(
        {
          type: "string",
          minLenght: 100,
        },
        "short",
      ),
    ).toThrow("strict mode: unknown keyword");
  });

  it("bounds individual and aggregate combinator width", () => {
    const branch = { type: "string" };
    expect(() =>
      assertSafeInputSchema({
        oneOf: Array.from(
          {
            length:
              V2_SCHEMA_COMPLEXITY_LIMITS.maxBranchesPerCombinator + 1,
          },
          () => branch,
        ),
      }),
    ).toThrow("branch limit");

    const aggregate = {
      allOf: Array.from({ length: 5 }, () => ({
        anyOf: Array.from(
          {
            length: V2_SCHEMA_COMPLEXITY_LIMITS.maxBranchesPerCombinator,
          },
          () => branch,
        ),
      })),
    };
    expect(() => assertSafeInputSchema(aggregate)).toThrow(
      "aggregate branch limit",
    );
  });
});

describe("V2 static resource resolution", () => {
  const resources = new Map([
    [
      "profile.document",
      {
        alias: "profile.document",
        containerPath: "/forge/synthetic/resource-1",
      },
    ],
  ]);

  it("resolves only an exact whole-value resource marker", () => {
    expect(
      resolveStaticResourceReferences(
        { path: { $forgeResource: "profile.document" } },
        resources,
      ),
    ).toEqual({ path: "/forge/synthetic/resource-1" });
  });

  it("rejects unknown resources and producer-output bindings", () => {
    expect(() =>
      resolveStaticResourceReferences(
        { path: { $forgeResource: "missing" } },
        resources,
      ),
    ).toThrowError(V2CompileError);
    expect(() =>
      resolveStaticResourceReferences(
        { path: { $forgeOutput: { stepId: "first", pointer: "/path" } } },
        resources,
      ),
    ).toThrow("only a whole-value $forgeResource");
  });

  it.each([
    "../../etc/passwd",
    "%2e%2e%2fetc%2fpasswd",
    "..%2fetc%2fpasswd",
    "．．／etc／passwd",
    "server.js",
    "/Users/operator/.ssh/id_ed25519",
    "C:\\Users\\operator\\.ssh\\id_ed25519",
    "~/.ssh/id_ed25519",
    "https://example.invalid/exfiltrate",
    "data:text/plain,exfiltrate",
    "${SECRET_PATH}",
    "$(touch marker)",
  ])("rejects unsafe literal reference %s", (value) => {
    expect(() =>
      resolveStaticResourceReferences({ path: value }, resources),
    ).toThrowError(V2CompileError);
  });

  it("rejects a marker mixed with authority-like fields", () => {
    expect(() =>
      resolveStaticResourceReferences(
        {
          path: {
            $forgeResource: "profile.document",
            approval: "security_review",
          },
        },
        resources,
      ),
    ).toThrow("only a whole-value $forgeResource");
  });

  it("rejects raw executable and environment-bearing argument fields", () => {
    for (const value of [
      { command: "echo unsafe" },
      { script: "return process.env.SECRET" },
      { environment: { TOKEN: "synthetic" } },
    ]) {
      expect(() => resolveStaticResourceReferences(value, resources)).toThrow(
        "raw executable, script, package, or environment fields",
      );
    }
  });

  it("applies path, URI, interpolation, and traversal checks to object keys", () => {
    for (const key of [
      "../escape",
      "/host/path",
      "https://example.invalid/key",
      "${SECRET_KEY}",
      "$(touch marker)",
    ]) {
      expect(() =>
        resolveStaticResourceReferences({ [key]: "literal" }, resources),
      ).toThrowError(expect.objectContaining({ code: "unsafe_reference" }));
    }
  });
});
