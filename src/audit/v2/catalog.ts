import {
  ListToolsResultSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  catalogIdentityV2Schema,
  type CatalogIdentityV2,
} from "../../contracts/v2/catalog.js";
import { toolNameV2Schema } from "../../contracts/v2/common.js";
import {
  JsonLimitError,
  type JsonTraversalLimits,
  type JsonTraversalMetrics,
} from "../../mcp/json-bounds.js";
import { digestCanonicalJson } from "./canonical.js";
import { deepFreezeJson } from "./freeze.js";
import { cloneStrictBoundedJson } from "./strict-clone.js";

const RAW_DISCOVERY_DOMAIN = "forge.mcp-raw-discovery";
const PLAN_CATALOG_DOMAIN = "forge.mcp-plan-catalog";
const CATALOG_PROJECTION_VERSION = "v2";

export const SUPPLIED_CATALOG_LIMITS = Object.freeze({
  maxTools: 1_024,
  maxPages: 4_096,
  maxDepth: 68,
  maxNodes: 100_000,
  maxObjectKeys: 4_096,
  maxStringCharacters: 1_000_000,
  maxSerializedBytes: 1_000_000,
});

const SUPPLIED_CATALOG_JSON_LIMITS = Object.freeze({
  maxDepth: SUPPLIED_CATALOG_LIMITS.maxDepth,
  maxNodes: SUPPLIED_CATALOG_LIMITS.maxNodes,
  maxObjectKeys: SUPPLIED_CATALOG_LIMITS.maxObjectKeys,
  maxStringCharacters: SUPPLIED_CATALOG_LIMITS.maxStringCharacters,
  maxSerializedBytes: SUPPLIED_CATALOG_LIMITS.maxSerializedBytes,
}) satisfies JsonTraversalLimits;

export interface SuppliedCatalogV2 {
  readonly protocolVersion: string;
  readonly server: {
    readonly name: string;
    readonly version: string;
  };
  readonly acquisition: {
    readonly complete: true;
    readonly pageCount: number;
    readonly listChangedDuringDiscovery: false;
  };
  readonly tools: readonly unknown[];
}

export interface NormalizedCatalogToolV2 {
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly inputSchema: Tool["inputSchema"];
  readonly outputSchema?: Tool["outputSchema"] | undefined;
  readonly annotations?: Tool["annotations"] | undefined;
  readonly execution?: Tool["execution"] | undefined;
  readonly icons?: Tool["icons"] | undefined;
  readonly _meta?: Tool["_meta"] | undefined;
}

export interface NormalizedCatalogV2 {
  readonly protocolVersion: string;
  readonly server: {
    readonly name: string;
    readonly version: string;
  };
  /** Exact-name-sorted tools. Tool names are guaranteed unique. */
  readonly tools: readonly NormalizedCatalogToolV2[];
}

export interface ComputedCatalogV2 {
  readonly catalog: NormalizedCatalogV2;
  readonly identity: CatalogIdentityV2;
  readonly acquisition: SuppliedCatalogV2["acquisition"];
  readonly metrics: JsonTraversalMetrics;
}

export interface CatalogComputationBoundsV2 {
  readonly maxTools?: number;
  readonly maxPages?: number;
  readonly maxSerializedBytes?: number;
}

export type CatalogFreshnessField =
  | "canonicalization"
  | "rawProjection"
  | "planProjection"
  | "rawDiscoveryDigest"
  | "planCatalogDigest"
  | "toolCount";

export class CatalogFreshnessError extends Error {
  public constructor(readonly mismatches: readonly CatalogFreshnessField[]) {
    super(`catalog freshness check failed: ${mismatches.join(", ")} mismatch`);
    this.name = "CatalogFreshnessError";
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const sortedExpected = [...expected].sort(compareCodeUnits);
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(
      `${label} must contain exactly: ${sortedExpected.join(", ")}`,
    );
  }
}

function requiredNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function parseStrictEnvelope(
  value: unknown,
  limits: { readonly maxTools: number; readonly maxPages: number },
): SuppliedCatalogV2 {
  if (!isRecord(value)) {
    throw new Error("supplied catalog must be a JSON object");
  }
  assertExactKeys(
    value,
    ["protocolVersion", "server", "acquisition", "tools"],
    "supplied catalog",
  );

  requiredNonEmptyString(value["protocolVersion"], "protocolVersion");

  const server = value["server"];
  if (!isRecord(server)) {
    throw new Error("server must be a JSON object");
  }
  assertExactKeys(server, ["name", "version"], "server");
  requiredNonEmptyString(server["name"], "server.name");
  requiredNonEmptyString(server["version"], "server.version");

  const acquisition = value["acquisition"];
  if (!isRecord(acquisition)) {
    throw new Error("acquisition must be a JSON object");
  }
  assertExactKeys(
    acquisition,
    ["complete", "pageCount", "listChangedDuringDiscovery"],
    "acquisition",
  );
  if (acquisition["complete"] !== true) {
    throw new Error("supplied catalog acquisition must be complete");
  }
  if (acquisition["listChangedDuringDiscovery"] !== false) {
    throw new Error(
      "supplied catalog was invalidated by tools/list_changed during discovery",
    );
  }
  const pageCount = acquisition["pageCount"];
  if (
    typeof pageCount !== "number" ||
    !Number.isSafeInteger(pageCount) ||
    pageCount < 1 ||
    pageCount > limits.maxPages
  ) {
    throw new Error(
      `acquisition.pageCount must be a safe integer from 1 through ${limits.maxPages}`,
    );
  }

  const tools = value["tools"];
  if (!Array.isArray(tools)) {
    throw new Error("tools must be an array");
  }
  if (tools.length > limits.maxTools) {
    throw new JsonLimitError(
      "tool_limit",
      "/tools",
      limits.maxTools,
      "supplied MCP catalog",
    );
  }

  return {
    protocolVersion: value["protocolVersion"],
    server: {
      name: server["name"],
      version: server["version"],
    },
    acquisition: {
      complete: true,
      pageCount,
      listChangedDuringDiscovery: false,
    },
    tools,
  };
}

function normalizedTool(tool: Tool): NormalizedCatalogToolV2 {
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: tool.outputSchema }),
    ...(tool.annotations === undefined
      ? {}
      : { annotations: tool.annotations }),
    ...(tool.execution === undefined ? {} : { execution: tool.execution }),
    ...(tool.icons === undefined ? {} : { icons: tool.icons }),
    ...(tool._meta === undefined ? {} : { _meta: tool._meta }),
  };
}

function rejectDuplicateToolNames(tools: readonly Tool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    toolNameV2Schema.parse(tool.name);
    if (seen.has(tool.name)) {
      throw new Error(`duplicate MCP tool name '${tool.name}'`);
    }
    seen.add(tool.name);
  }
}

/**
 * Validate a controller-supplied, already-complete catalog and compute its two
 * V2 identities. This performs an iterative byte/node/depth preflight and a
 * detached JSON clone before invoking the recursive MCP SDK schema.
 */
export function computeCatalogIdentity(
  input: unknown,
  requestedBounds: CatalogComputationBoundsV2 = {},
): ComputedCatalogV2 {
  const maxTools = Math.min(
    SUPPLIED_CATALOG_LIMITS.maxTools,
    requestedBounds.maxTools ?? SUPPLIED_CATALOG_LIMITS.maxTools,
  );
  const maxPages = Math.min(
    SUPPLIED_CATALOG_LIMITS.maxPages,
    requestedBounds.maxPages ?? SUPPLIED_CATALOG_LIMITS.maxPages,
  );
  const maxSerializedBytes = Math.min(
    SUPPLIED_CATALOG_LIMITS.maxSerializedBytes,
    requestedBounds.maxSerializedBytes ??
      SUPPLIED_CATALOG_LIMITS.maxSerializedBytes,
  );
  for (const [name, bound] of Object.entries({
    maxTools,
    maxPages,
    maxSerializedBytes,
  })) {
    if (!Number.isSafeInteger(bound) || bound < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  const { clone, metrics } = cloneStrictBoundedJson(
    input,
    { ...SUPPLIED_CATALOG_JSON_LIMITS, maxSerializedBytes },
    "supplied MCP catalog",
  );
  const supplied = parseStrictEnvelope(clone, { maxTools, maxPages });

  // Hash this detached projection, not the SDK result: the SDK deliberately
  // strips unknown descriptor extensions. Acquisition/page evidence is
  // validated above but omitted because it is not cross-session identity.
  const rawProjection = {
    protocolVersion: supplied.protocolVersion,
    server: supplied.server,
    tools: supplied.tools,
  };

  const parsedTools = ListToolsResultSchema.parse({
    tools: supplied.tools,
  }).tools;
  rejectDuplicateToolNames(parsedTools);

  const catalog: NormalizedCatalogV2 = {
    protocolVersion: supplied.protocolVersion,
    server: supplied.server,
    tools: parsedTools.map(normalizedTool).sort((left, right) =>
      compareCodeUnits(left.name, right.name),
    ),
  };
  const identity = catalogIdentityV2Schema.parse({
    canonicalization: "rfc8785-jcs",
    rawProjection: "forge.mcp-raw-discovery/v2",
    planProjection: "forge.mcp-plan-catalog/v2",
    rawDiscoveryDigest: digestCanonicalJson(
      RAW_DISCOVERY_DOMAIN,
      CATALOG_PROJECTION_VERSION,
      rawProjection,
    ),
    planCatalogDigest: digestCanonicalJson(
      PLAN_CATALOG_DOMAIN,
      CATALOG_PROJECTION_VERSION,
      catalog,
    ),
    toolCount: catalog.tools.length,
  });

  return Object.freeze({
    catalog: deepFreezeJson(catalog),
    identity: deepFreezeJson(identity),
    acquisition: deepFreezeJson(supplied.acquisition),
    metrics: deepFreezeJson(metrics),
  });
}

/** Recompute both identities from a fresh complete catalog or fail closed. */
export function verifyCatalogFreshness(
  expectedValue: CatalogIdentityV2,
  input: unknown,
): ComputedCatalogV2 {
  const expected = catalogIdentityV2Schema.parse(
    cloneStrictBoundedJson(
      expectedValue,
      SUPPLIED_CATALOG_JSON_LIMITS,
      "expected V2 catalog identity",
    ).clone,
  );
  const computed = computeCatalogIdentity(input);
  const mismatches: CatalogFreshnessField[] = [];
  for (const field of [
    "canonicalization",
    "rawProjection",
    "planProjection",
    "rawDiscoveryDigest",
    "planCatalogDigest",
    "toolCount",
  ] as const) {
    if (expected[field] !== computed.identity[field]) {
      mismatches.push(field);
    }
  }
  if (mismatches.length > 0) {
    throw new CatalogFreshnessError(mismatches);
  }
  return computed;
}
