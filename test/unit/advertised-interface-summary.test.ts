import { describe, expect, it } from "vitest";

import type { McpInterfaceV1 } from "../../src/contracts/v1.js";
import {
  MCP_CATALOG_HASH_ALGORITHM,
  MCP_CATALOG_LIMITS,
} from "../../src/mcp/catalog.js";
import { summarizeAdvertisedInterfaces } from "../../src/report.js";

function mcpInterface(
  experimentId: string,
  tools: McpInterfaceV1["tools"],
): McpInterfaceV1 {
  return {
    schema: "forge.mcp-interface/v1",
    runId: "run-interface-summary",
    experimentId,
    server: { name: "catalog-server", version: "1.0.0" },
    tools,
  };
}

describe("advertised interface summary", () => {
  it("makes an absent canonical interface explicit", () => {
    expect(summarizeAdvertisedInterfaces([])).toMatchObject({
      selection: "first_observed_interface",
      catalogHashAlgorithm: MCP_CATALOG_HASH_ALGORITHM,
      catalogLimits: MCP_CATALOG_LIMITS,
      catalogConsistency: "not_observed",
      comparedExperimentIds: [],
      catalogFingerprints: [],
      differingExperimentIds: [],
      duplicateToolNames: [],
    });
  });

  it("normalizes object-key and tool order while surfacing real drift and duplicates", () => {
    const read = {
      name: "read_record",
      description: "Read one record.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Record path" } },
      },
    } satisfies McpInterfaceV1["tools"][number];
    const write = {
      name: "write_record",
      inputSchema: { additionalProperties: false, type: "object" },
    } satisfies McpInterfaceV1["tools"][number];
    const source = mcpInterface("z-source", [read, write]);
    const reordered = mcpInterface("a-reordered", [
      {
        ...write,
        inputSchema: { type: "object", additionalProperties: false },
      },
      {
        ...read,
        inputSchema: {
          properties: {
            path: { description: "Record path", type: "string" },
          },
          type: "object",
        },
      },
    ]);
    const drifted = mcpInterface("m-drifted", [
      read,
      { ...read, description: "Read a different record." },
    ]);

    const summary = summarizeAdvertisedInterfaces([source, reordered, drifted]);
    expect(summary).toMatchObject({
      sourceExperimentId: "z-source",
      catalogConsistency: "drift_detected",
      comparedExperimentIds: ["a-reordered", "m-drifted", "z-source"],
      differingExperimentIds: ["m-drifted"],
      duplicateToolNames: [
        { experimentId: "m-drifted", names: ["read_record"] },
      ],
    });
    expect(summary.sourceCatalogSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.sourceOrderedCatalogSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.catalogFingerprints).toHaveLength(3);
    expect(
      summary.catalogFingerprints.find(
        (fingerprint) => fingerprint.experimentId === "a-reordered",
      )?.sha256,
    ).toBe(summary.sourceCatalogSha256);
    expect(
      summary.catalogFingerprints.find(
        (fingerprint) => fingerprint.experimentId === "a-reordered",
      )?.orderedSha256,
    ).not.toBe(summary.sourceOrderedCatalogSha256);
    expect(
      summary.catalogFingerprints.find(
        (fingerprint) => fingerprint.experimentId === "m-drifted",
      )?.sha256,
    ).not.toBe(summary.sourceCatalogSha256);
  });

  it("rejects duplicate experiment identifiers", () => {
    const repeated = mcpInterface("same-experiment", []);
    expect(() => summarizeAdvertisedInterfaces([repeated, repeated])).toThrow(
      "duplicate experiment ID",
    );
  });
});
