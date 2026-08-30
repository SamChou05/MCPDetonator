import { describe, expect, it } from "vitest";

import {
  CatalogFreshnessError,
  computeCatalogIdentity,
  SUPPLIED_CATALOG_LIMITS,
  verifyCatalogFreshness,
} from "../../src/audit/v2/catalog.js";
import { JsonLimitError } from "../../src/mcp/json-bounds.js";

function catalogWith(tools: readonly unknown[]) {
  return {
    protocolVersion: "2025-06-18",
    server: { name: "catalog-fixture", version: "1.2.3" },
    acquisition: {
      complete: true,
      pageCount: 1,
      listChangedDuringDiscovery: false,
    },
    tools,
  };
}

function alphaTool() {
  return {
    name: "alpha",
    title: "Alpha",
    description: "Reads a synthetic value",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        count: { type: "integer" },
      },
      required: ["path"],
    },
    outputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    annotations: { readOnlyHint: true },
  };
}

function betaTool() {
  return {
    name: "beta",
    inputSchema: { type: "object", additionalProperties: false },
  };
}

function expectFreshnessMismatches(
  expected: Parameters<typeof verifyCatalogFreshness>[0],
  current: unknown,
  fields: readonly string[],
): void {
  try {
    verifyCatalogFreshness(expected, current);
    throw new Error("expected catalog freshness verification to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogFreshnessError);
    expect((error as CatalogFreshnessError).mismatches).toEqual(fields);
  }
}

describe("Evidence-First V2 catalog identity", () => {
  it("is stable under JSON object-key reordering", () => {
    const left = catalogWith([alphaTool(), betaTool()]);
    const reorderedKeys = {
      tools: [
        {
          annotations: { readOnlyHint: true },
          outputSchema: {
            required: ["value"],
            properties: { value: { type: "string" } },
            type: "object",
          },
          inputSchema: {
            required: ["path"],
            properties: {
              count: { type: "integer" },
              path: { type: "string" },
            },
            type: "object",
          },
          description: "Reads a synthetic value",
          title: "Alpha",
          name: "alpha",
        },
        { inputSchema: { additionalProperties: false, type: "object" }, name: "beta" },
      ],
      acquisition: {
        listChangedDuringDiscovery: false,
        pageCount: 1,
        complete: true,
      },
      server: { version: "1.2.3", name: "catalog-fixture" },
      protocolVersion: "2025-06-18",
    };

    const first = computeCatalogIdentity(left);
    const second = computeCatalogIdentity(reorderedKeys);

    expect(second.identity).toEqual(first.identity);
    expect(second.catalog).toEqual(first.catalog);
  });

  it("keeps raw order/extensions while sorting the planning projection", () => {
    const original = computeCatalogIdentity(
      catalogWith([betaTool(), alphaTool()]),
    );
    const reordered = computeCatalogIdentity(
      catalogWith([alphaTool(), betaTool()]),
    );
    const extendedAlpha = { ...alphaTool(), "x-forge-test": { retained: true } };
    const extended = computeCatalogIdentity(
      catalogWith([betaTool(), extendedAlpha]),
    );

    expect(original.catalog.tools.map((tool) => tool.name)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(reordered.identity.rawDiscoveryDigest).not.toBe(
      original.identity.rawDiscoveryDigest,
    );
    expect(reordered.identity.planCatalogDigest).toBe(
      original.identity.planCatalogDigest,
    );
    expect(extended.identity.rawDiscoveryDigest).not.toBe(
      original.identity.rawDiscoveryDigest,
    );
    expect(extended.identity.planCatalogDigest).toBe(
      original.identity.planCatalogDigest,
    );
    expect(extended.catalog.tools[0]).not.toHaveProperty("x-forge-test");
  });

  it("always retains outputSchema and binds its changes into both digests", () => {
    const original = computeCatalogIdentity(catalogWith([alphaTool()]));
    const changed = computeCatalogIdentity(
      catalogWith([
        {
          ...alphaTool(),
          outputSchema: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
        },
      ]),
    );

    expect(original.catalog.tools[0]?.outputSchema).toEqual(
      alphaTool().outputSchema,
    );
    expect(changed.identity.rawDiscoveryDigest).not.toBe(
      original.identity.rawDiscoveryDigest,
    );
    expect(changed.identity.planCatalogDigest).not.toBe(
      original.identity.planCatalogDigest,
    );
  });

  it("rejects duplicate exact tool names before creating a name-based catalog", () => {
    expect(() =>
      computeCatalogIdentity(
        catalogWith([alphaTool(), { ...betaTool(), name: "alpha" }]),
      ),
    ).toThrow("duplicate MCP tool name 'alpha'");
  });

  it("rejects tool names outside the bounded V2 MCP name grammar", () => {
    for (const invalidName of [
      "contains space",
      "-leading-punctuation",
      "tool?query",
      "a".repeat(129),
    ]) {
      expect(() =>
        computeCatalogIdentity(
          catalogWith([{ ...alphaTool(), name: invalidName }]),
        ),
      ).toThrow();
    }
  });

  it("returns a deeply detached and frozen planning catalog", () => {
    const sourceTool = alphaTool();
    const computed = computeCatalogIdentity(catalogWith([sourceTool]));
    sourceTool.inputSchema.properties.path!.type = "number";

    expect(computed.catalog.tools[0]?.inputSchema).toMatchObject({
      properties: { path: { type: "string" } },
    });
    expect(Object.isFrozen(computed.catalog)).toBe(true);
    expect(Object.isFrozen(computed.catalog.tools)).toBe(true);
    expect(Object.isFrozen(computed.catalog.tools[0]?.inputSchema)).toBe(true);
    expect(() => {
      const schema = computed.catalog.tools[0]!.inputSchema as unknown as {
        properties: { path: { type: string } };
      };
      schema.properties.path.type = "number";
    }).toThrow(TypeError);
  });

  it("rejects accessors without invoking them", () => {
    let getterCalls = 0;
    const tool = alphaTool();
    Object.defineProperty(tool, "description", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must never be observed";
      },
    });

    expect(() => computeCatalogIdentity(catalogWith([tool]))).toThrow(
      "non_json_value",
    );
    expect(getterCalls).toBe(0);
  });

  it("rejects hidden toJSON hooks without executing them", () => {
    let hookCalls = 0;
    const tool = alphaTool();
    Object.defineProperty(tool, "toJSON", {
      configurable: true,
      enumerable: false,
      value() {
        hookCalls += 1;
        return betaTool();
      },
    });

    expect(() => computeCatalogIdentity(catalogWith([tool]))).toThrow(
      "non_json_value",
    );
    expect(hookCalls).toBe(0);
  });

  it("requires an exact, complete, non-invalidated acquisition envelope", () => {
    expect(() =>
      computeCatalogIdentity({
        ...catalogWith([alphaTool()]),
        acquisition: {
          complete: false,
          pageCount: 1,
          listChangedDuringDiscovery: false,
        },
      }),
    ).toThrow("acquisition must be complete");

    expect(() =>
      computeCatalogIdentity({
        ...catalogWith([alphaTool()]),
        acquisition: {
          complete: true,
          pageCount: 1,
          listChangedDuringDiscovery: true,
        },
      }),
    ).toThrow("invalidated by tools/list_changed");

    expect(() =>
      computeCatalogIdentity({
        ...catalogWith([alphaTool()]),
        nextCursor: "not-allowed-in-a-complete-envelope",
      }),
    ).toThrow("supplied catalog must contain exactly");
  });

  it("validates but does not identity-bind page boundaries", () => {
    const onePage = computeCatalogIdentity(catalogWith([alphaTool()]));
    const twoPages = computeCatalogIdentity({
      ...catalogWith([alphaTool()]),
      acquisition: {
        complete: true,
        pageCount: 2,
        listChangedDuringDiscovery: false,
      },
    });

    expect(twoPages.identity).toEqual(onePage.identity);
    expect(() =>
      computeCatalogIdentity({
        ...catalogWith([alphaTool()]),
        acquisition: {
          complete: true,
          pageCount: SUPPLIED_CATALOG_LIMITS.maxPages + 1,
          listChangedDuringDiscovery: false,
        },
      }),
    ).toThrow("acquisition.pageCount must be a safe integer");
  });

  it("recomputes and requires both catalog identities for freshness", () => {
    const originalInput = catalogWith([betaTool(), alphaTool()]);
    const original = computeCatalogIdentity(originalInput);

    expect(
      verifyCatalogFreshness(original.identity, originalInput).identity,
    ).toEqual(original.identity);

    expectFreshnessMismatches(
      original.identity,
      catalogWith([alphaTool(), betaTool()]),
      ["rawDiscoveryDigest"],
    );
    expectFreshnessMismatches(
      {
        ...original.identity,
        planCatalogDigest: "0".repeat(64),
      },
      originalInput,
      ["planCatalogDigest"],
    );
    expectFreshnessMismatches(
      original.identity,
      catalogWith([
        betaTool(),
        {
          ...alphaTool(),
          outputSchema: { type: "object", additionalProperties: false },
        },
      ]),
      ["rawDiscoveryDigest", "planCatalogDigest"],
    );
  });

  it("bounds tool count and nested JSON before SDK schema validation", () => {
    const tooManyTools = Array.from(
      { length: SUPPLIED_CATALOG_LIMITS.maxTools + 1 },
      (_, index) => ({
        name: `tool-${index}`,
        inputSchema: { type: "object" },
      }),
    );
    expect(() => computeCatalogIdentity(catalogWith(tooManyTools))).toThrow(
      JsonLimitError,
    );
    expect(() => computeCatalogIdentity(catalogWith(tooManyTools))).toThrow(
      "tool_limit",
    );

    let nested: unknown = { type: "object" };
    for (let depth = 0; depth <= SUPPLIED_CATALOG_LIMITS.maxDepth; depth += 1) {
      nested = { nested };
    }
    expect(() =>
      computeCatalogIdentity(
        catalogWith([{ name: "too-deep", inputSchema: nested }]),
      ),
    ).toThrow("json_depth_limit");
  });

  it("enforces cumulative serialized-byte bounds", () => {
    expect(() =>
      computeCatalogIdentity(
        catalogWith([
          {
            name: "oversized",
            description: "x".repeat(
              SUPPLIED_CATALOG_LIMITS.maxSerializedBytes - 200,
            ),
            inputSchema: { type: "object" },
          },
        ]),
      ),
    ).toThrow("serialized_byte_limit");
  });
});
