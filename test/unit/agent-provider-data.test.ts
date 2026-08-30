import { describe, expect, it } from "vitest";

import { agentToolDefinitionV1Schema } from "../../src/agent/contracts.js";
import {
  targetProviderMetadataProjection,
  targetProviderMetadataSha256,
} from "../../src/agent/provider-data.js";

function target(description: string, title = "Local-only title") {
  return agentToolDefinitionV1Schema.parse({
    schema: "forge.agent-tool-definition/v1",
    name: "candidate_tool",
    title,
    description,
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    source: "target_mcp",
    metadataTrust: "untrusted",
  });
}

const controlled = agentToolDefinitionV1Schema.parse({
  schema: "forge.agent-tool-definition/v1",
  name: "forge_read_file",
  description: "Controller-defined",
  inputSchema: { type: "object", properties: {} },
  source: "forge_controlled",
  metadataTrust: "controller_defined",
});

describe("provider-bound target metadata", () => {
  it("hashes exactly the provider-visible target projection", () => {
    const projection = targetProviderMetadataProjection([
      target("approved description"),
      controlled,
    ]);

    expect(projection).toEqual({
      schema: "forge.agent-provider-target-metadata/v1",
      tools: [
        {
          name: "candidate_tool",
          description: "approved description",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    expect(
      targetProviderMetadataSha256([target("approved description"), controlled]),
    ).toBe(
      targetProviderMetadataSha256([
        target("approved description", "Changed local-only title"),
        controlled,
      ]),
    );
    expect(
      targetProviderMetadataSha256([target("approved description"), controlled]),
    ).not.toBe(
      targetProviderMetadataSha256([target("poisoned drift"), controlled]),
    );
  });
});
