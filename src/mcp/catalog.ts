import { createHash, type Hash } from "node:crypto";

import type { McpInterfaceV1 } from "../contracts/v1.js";

export const MCP_CATALOG_HASH_ALGORITHM =
  "sha256_canonical_json_code_unit_v1" as const;

export const MCP_CATALOG_LIMITS = Object.freeze({
  maxTools: 1_024,
  maxJsonDepth: 64,
  maxJsonNodes: 100_000,
  maxObjectKeys: 4_096,
  maxTotalStringCharacters: 1_000_000,
});

export type McpCatalogLimits = typeof MCP_CATALOG_LIMITS;

export interface McpCatalogFingerprint {
  readonly algorithm: typeof MCP_CATALOG_HASH_ALGORITHM;
  readonly sha256?: string;
  readonly orderedSha256?: string;
  readonly complete: boolean;
  readonly limits: McpCatalogLimits;
  readonly observed: {
    readonly tools: number;
    readonly jsonNodes: number;
    readonly stringCharacters: number;
    readonly maximumDepth: number;
  };
  readonly limitReason?:
    | "tool_limit"
    | "json_depth_limit"
    | "json_node_limit"
    | "object_key_limit"
    | "string_character_limit"
    | "non_json_value"
    | "cyclic_value";
  readonly limitPointer?: string;
}

export interface McpCatalogTool {
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly inputSchema: unknown;
  readonly annotations?: unknown | undefined;
}

export interface McpCatalogServer {
  readonly name: string;
  readonly version: string;
}

interface MutableBudget {
  jsonNodes: number;
  stringCharacters: number;
  maximumDepth: number;
  readonly activeObjects: WeakSet<object>;
}

class CatalogLimitError extends Error {
  public constructor(
    readonly reason: NonNullable<McpCatalogFingerprint["limitReason"]>,
    readonly pointer: string,
  ) {
    super(`${reason} at ${pointer}`);
    this.name = "CatalogLimitError";
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pointerChild(pointer: string, segment: string | number): string {
  const escaped = String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${pointer}/${escaped}`;
}

function recordString(
  value: string,
  pointer: string,
  budget: MutableBudget,
): void {
  budget.stringCharacters += value.length;
  if (
    budget.stringCharacters > MCP_CATALOG_LIMITS.maxTotalStringCharacters
  ) {
    throw new CatalogLimitError("string_character_limit", pointer);
  }
}

function boundedSortedKeys(
  value: Record<string, unknown>,
  pointer: string,
  budget: MutableBudget,
): string[] {
  const keys: string[] = [];
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (keys.length >= MCP_CATALOG_LIMITS.maxObjectKeys) {
      throw new CatalogLimitError("object_key_limit", pointer);
    }
    // Count before retaining/sorting the key and keep the diagnostic at the
    // already-bounded parent pointer. Constructing a child pointer first would
    // itself allocate from an untrusted over-limit key.
    recordString(key, pointer, budget);
    keys.push(key);
  }
  return keys.sort(compareCodeUnits);
}

function hashJsonValue(
  value: unknown,
  pointer: string,
  depth: number,
  budget: MutableBudget,
  hash: Hash,
): void {
  if (depth > MCP_CATALOG_LIMITS.maxJsonDepth) {
    throw new CatalogLimitError("json_depth_limit", pointer);
  }
  budget.maximumDepth = Math.max(budget.maximumDepth, depth);
  budget.jsonNodes += 1;
  if (budget.jsonNodes > MCP_CATALOG_LIMITS.maxJsonNodes) {
    throw new CatalogLimitError("json_node_limit", pointer);
  }

  if (value === null) {
    hash.update("null");
    return;
  }
  if (typeof value === "string") {
    recordString(value, pointer, budget);
    hash.update(JSON.stringify(value));
    return;
  }
  if (typeof value === "boolean") {
    hash.update(value ? "true" : "false");
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    hash.update(JSON.stringify(value));
    return;
  }
  if (typeof value !== "object") {
    throw new CatalogLimitError("non_json_value", pointer);
  }
  if (budget.activeObjects.has(value)) {
    throw new CatalogLimitError("cyclic_value", pointer);
  }
  budget.activeObjects.add(value);
  try {
    if (Array.isArray(value)) {
      hash.update("[");
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) hash.update(",");
        hashJsonValue(
          value[index],
          pointerChild(pointer, index),
          depth + 1,
          budget,
          hash,
        );
      }
      hash.update("]");
      return;
    }

    const record = value as Record<string, unknown>;
    const keys = boundedSortedKeys(record, pointer, budget);
    hash.update("{");
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key === undefined) continue;
      if (index > 0) hash.update(",");
      hash.update(JSON.stringify(key));
      hash.update(":");
      hashJsonValue(
        record[key],
        pointerChild(pointer, key),
        depth + 1,
        budget,
        hash,
      );
    }
    hash.update("}");
  } finally {
    budget.activeObjects.delete(value);
  }
}

function normalizedTool(tool: McpCatalogTool): Record<string, unknown> {
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.annotations === undefined
      ? {}
      : { annotations: tool.annotations }),
  };
}

export function fingerprintMcpCatalog(
  server: McpCatalogServer,
  tools: readonly McpCatalogTool[],
): McpCatalogFingerprint {
  const budget: MutableBudget = {
    jsonNodes: 0,
    stringCharacters: 0,
    maximumDepth: 0,
    activeObjects: new WeakSet(),
  };
  if (tools.length > MCP_CATALOG_LIMITS.maxTools) {
    return {
      algorithm: MCP_CATALOG_HASH_ALGORITHM,
      complete: false,
      limits: MCP_CATALOG_LIMITS,
      observed: {
        tools: tools.length,
        jsonNodes: 0,
        stringCharacters: 0,
        maximumDepth: 0,
      },
      limitReason: "tool_limit",
      limitPointer: `/tools/${MCP_CATALOG_LIMITS.maxTools}`,
    };
  }

  try {
    const serverHash = createHash("sha256");
    hashJsonValue(server, "/server", 0, budget, serverHash);
    const toolDigests: string[] = [];
    for (let index = 0; index < tools.length; index += 1) {
      const toolHash = createHash("sha256");
      hashJsonValue(
        normalizedTool(tools[index]!),
        `/tools/${index}`,
        0,
        budget,
        toolHash,
      );
      toolDigests.push(toolHash.digest("hex"));
    }
    const serverDigest = serverHash.digest("hex");
    const catalogDigest = (
      domain: "ordered" | "order_independent",
      digests: readonly string[],
    ): string => {
      const catalogHash = createHash("sha256");
      catalogHash.update(`${MCP_CATALOG_HASH_ALGORITHM}:${domain}\0`);
      catalogHash.update(serverDigest);
      for (const digest of digests) {
        catalogHash.update("\0");
        catalogHash.update(digest);
      }
      return catalogHash.digest("hex");
    };
    const orderedSha256 = catalogDigest("ordered", toolDigests);
    const sha256 = catalogDigest(
      "order_independent",
      [...toolDigests].sort(compareCodeUnits),
    );
    return {
      algorithm: MCP_CATALOG_HASH_ALGORITHM,
      sha256,
      orderedSha256,
      complete: true,
      limits: MCP_CATALOG_LIMITS,
      observed: {
        tools: tools.length,
        jsonNodes: budget.jsonNodes,
        stringCharacters: budget.stringCharacters,
        maximumDepth: budget.maximumDepth,
      },
    };
  } catch (error) {
    if (!(error instanceof CatalogLimitError)) throw error;
    return {
      algorithm: MCP_CATALOG_HASH_ALGORITHM,
      complete: false,
      limits: MCP_CATALOG_LIMITS,
      observed: {
        tools: tools.length,
        jsonNodes: budget.jsonNodes,
        stringCharacters: budget.stringCharacters,
        maximumDepth: budget.maximumDepth,
      },
      limitReason: error.reason,
      limitPointer: error.pointer,
    };
  }
}

export function assertMcpCatalogWithinLimits(
  server: McpCatalogServer,
  tools: readonly McpCatalogTool[],
): McpCatalogFingerprint & {
  readonly complete: true;
  readonly sha256: string;
  readonly orderedSha256: string;
} {
  const fingerprint = fingerprintMcpCatalog(server, tools);
  if (
    !fingerprint.complete ||
    fingerprint.sha256 === undefined ||
    fingerprint.orderedSha256 === undefined
  ) {
    throw new Error(
      `MCP catalog exceeds deterministic ${fingerprint.limitReason ?? "unknown"} at ${fingerprint.limitPointer ?? "/"}`,
    );
  }
  return fingerprint as McpCatalogFingerprint & {
    readonly complete: true;
    readonly sha256: string;
    readonly orderedSha256: string;
  };
}

export function fingerprintMcpInterface(
  mcpInterface: Pick<McpInterfaceV1, "server" | "tools">,
): McpCatalogFingerprint {
  return fingerprintMcpCatalog(mcpInterface.server, mcpInterface.tools);
}
