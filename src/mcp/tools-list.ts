import { ListToolsResultSchema, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

import { MCP_CATALOG_LIMITS } from "./catalog.js";
import {
  JsonLimitError,
  preflightBoundedJson,
  type JsonTraversalLimits,
  type JsonTraversalMetrics,
} from "./json-bounds.js";

export const MAX_MCP_TOOLS_LIST_RESULT_BYTES = 1_000_000;

export const MCP_TOOLS_LIST_RESULT_LIMITS = Object.freeze({
  // The result envelope adds /tools/<index> above each tool. The retained
  // catalog receives its own stricter depth check after MCP shape validation.
  maxDepth: MCP_CATALOG_LIMITS.maxJsonDepth + 4,
  maxNodes: MCP_CATALOG_LIMITS.maxJsonNodes,
  maxObjectKeys: MCP_CATALOG_LIMITS.maxObjectKeys,
  maxStringCharacters: MCP_CATALOG_LIMITS.maxTotalStringCharacters,
  maxSerializedBytes: MAX_MCP_TOOLS_LIST_RESULT_BYTES,
}) satisfies JsonTraversalLimits;

export interface BoundedToolsListResult {
  readonly result: ListToolsResult;
  readonly metrics: JsonTraversalMetrics;
}

function advertisedToolCount(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "tools");
  return descriptor !== undefined && "value" in descriptor && Array.isArray(descriptor.value)
    ? descriptor.value.length
    : undefined;
}

/**
 * Bound the complete untrusted tools/list result, including fields Forge does
 * not retain such as outputSchema, before asking the MCP SDK's recursive Zod
 * schema to validate it. This function deliberately does not compile schemas.
 */
export function parseBoundedToolsListResult(
  value: unknown,
): BoundedToolsListResult {
  const toolCount = advertisedToolCount(value);
  if (toolCount !== undefined && toolCount > MCP_CATALOG_LIMITS.maxTools) {
    throw new JsonLimitError(
      "tool_limit",
      "/tools",
      MCP_CATALOG_LIMITS.maxTools,
      "MCP tools/list result tool count",
    );
  }
  const metrics = preflightBoundedJson(
    value,
    MCP_TOOLS_LIST_RESULT_LIMITS,
    "MCP tools/list result",
  );
  return {
    result: ListToolsResultSchema.parse(value),
    metrics,
  };
}
