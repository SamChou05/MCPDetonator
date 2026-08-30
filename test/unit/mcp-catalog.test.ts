import { describe, expect, it } from "vitest";

import {
  assertMcpCatalogWithinLimits,
  fingerprintMcpCatalog,
  MCP_CATALOG_LIMITS,
} from "../../src/mcp/catalog.js";

const server = { name: "catalog-test", version: "1.0.0" };

function tool(name: string, inputSchema: unknown) {
  return { name, inputSchema };
}

describe("bounded MCP catalog fingerprints", () => {
  it("normalizes object-key and tool order while retaining real drift", () => {
    const left = fingerprintMcpCatalog(server, [
      tool("second", {
        type: "object",
        properties: { beta: { type: "string" }, alpha: { type: "number" } },
      }),
      tool("first", { additionalProperties: false, type: "object" }),
    ]);
    const reordered = fingerprintMcpCatalog(server, [
      tool("first", { type: "object", additionalProperties: false }),
      tool("second", {
        properties: { alpha: { type: "number" }, beta: { type: "string" } },
        type: "object",
      }),
    ]);
    const changed = fingerprintMcpCatalog(server, [
      tool("first", { type: "object", additionalProperties: true }),
      tool("second", {
        properties: { alpha: { type: "number" }, beta: { type: "string" } },
        type: "object",
      }),
    ]);

    expect(left.complete).toBe(true);
    expect(reordered).toMatchObject({ complete: true, sha256: left.sha256 });
    expect(reordered.orderedSha256).not.toBe(left.orderedSha256);
    expect(changed.complete).toBe(true);
    expect(changed.sha256).not.toBe(left.sha256);
  });

  it("stops over-deep input without recursive stack exhaustion", () => {
    let inputSchema: unknown = { type: "string" };
    for (let depth = 0; depth <= MCP_CATALOG_LIMITS.maxJsonDepth; depth += 1) {
      inputSchema = { child: inputSchema };
    }

    const result = fingerprintMcpCatalog(server, [tool("deep", inputSchema)]);

    expect(result).toMatchObject({
      complete: false,
      limitReason: "json_depth_limit",
    });
    expect(() =>
      assertMcpCatalogWithinLimits(server, [tool("deep", inputSchema)]),
    ).toThrow("MCP catalog exceeds deterministic json_depth_limit");
  });

  it("bounds tool and object-key breadth before full canonicalization", () => {
    const tooManyTools = Array.from(
      { length: MCP_CATALOG_LIMITS.maxTools + 1 },
      (_, index) => tool(`tool-${index}`, {}),
    );
    const wideSchema = Object.fromEntries(
      Array.from(
        { length: MCP_CATALOG_LIMITS.maxObjectKeys + 1 },
        (_, index) => [`key-${index}`, index],
      ),
    );

    expect(fingerprintMcpCatalog(server, tooManyTools)).toMatchObject({
      complete: false,
      limitReason: "tool_limit",
    });
    expect(
      fingerprintMcpCatalog(server, [tool("wide", wideSchema)]),
    ).toMatchObject({
      complete: false,
      limitReason: "object_key_limit",
    });
  });

  it("rejects aggregate key text before sorting or building an oversized pointer", () => {
    const longKey = "shared-prefix-".repeat(
      Math.ceil(MCP_CATALOG_LIMITS.maxTotalStringCharacters / 14),
    );
    const result = fingerprintMcpCatalog(server, [
      tool("long-key", { [longKey]: true }),
    ]);

    expect(result).toMatchObject({
      complete: false,
      limitReason: "string_character_limit",
      limitPointer: "/tools/0/inputSchema",
    });
    expect(result.limitPointer?.length).toBeLessThan(64);
  });
});
