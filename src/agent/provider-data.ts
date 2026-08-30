import { sha256 } from "../evidence-store.js";
import type { AgentToolDefinitionV1 } from "./contracts.js";
import type { ProviderToolDefinition } from "./providers/provider.js";

export interface TargetProviderMetadataProjectionV1 {
  readonly schema: "forge.agent-provider-target-metadata/v1";
  readonly tools: readonly ProviderToolDefinition[];
}

/** The exact fields Agent V1 projects into provider function definitions. */
export function providerToolDefinitions(
  tools: readonly AgentToolDefinitionV1[],
): ProviderToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema,
  }));
}

export function targetProviderMetadataProjection(
  tools: readonly AgentToolDefinitionV1[],
): TargetProviderMetadataProjectionV1 {
  return {
    schema: "forge.agent-provider-target-metadata/v1",
    tools: providerToolDefinitions(
      tools.filter((tool) => tool.source === "target_mcp"),
    ),
  };
}

/**
 * Approval binds both content and tool ordering because ordering is part of the
 * provider-visible presentation and can influence a rollout.
 */
export function targetProviderMetadataSha256(
  tools: readonly AgentToolDefinitionV1[],
): string {
  return sha256(JSON.stringify(targetProviderMetadataProjection(tools)));
}
