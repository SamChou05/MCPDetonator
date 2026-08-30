import {
  V2_TOP_LEVEL_SCHEMA_IDS,
  v2TopLevelSchemas,
  type V2TopLevelArtifact,
  type V2TopLevelSchemaId,
} from "../../contracts/v2/index.js";
import type { JsonTraversalLimits } from "../../mcp/json-bounds.js";
import { parseStrictJson, type StrictJsonLimits } from "./strict-json.js";
import { cloneStrictBoundedJson } from "./strict-clone.js";

export const V2_ARTIFACT_JSON_LIMITS: StrictJsonLimits = Object.freeze({
  maxBytes: 4_000_000,
  maxDepth: 64,
  maxNodes: 100_000,
  maxTotalStringCharacters: 2_000_000,
  maxKeyCharacters: 512,
  maxArrayItems: 10_000,
  maxObjectKeys: 2_048,
});

const V2_ARTIFACT_VALUE_LIMITS: JsonTraversalLimits = Object.freeze({
  maxDepth: V2_ARTIFACT_JSON_LIMITS.maxDepth,
  maxNodes: V2_ARTIFACT_JSON_LIMITS.maxNodes,
  maxObjectKeys: V2_ARTIFACT_JSON_LIMITS.maxObjectKeys,
  maxStringCharacters: V2_ARTIFACT_JSON_LIMITS.maxTotalStringCharacters,
  maxSerializedBytes: V2_ARTIFACT_JSON_LIMITS.maxBytes,
});

const schemaIds = new Set<string>(V2_TOP_LEVEL_SCHEMA_IDS);

function parseSelectedArtifact(value: unknown): V2TopLevelArtifact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("V2 artifact must be a JSON object");
  }
  const schemaId = (value as Record<string, unknown>)["schema"];
  if (typeof schemaId !== "string" || !schemaIds.has(schemaId)) {
    throw new TypeError("unknown or missing V2 artifact schema identifier");
  }
  const schema = v2TopLevelSchemas[schemaId as V2TopLevelSchemaId];
  return schema.parse(value) as V2TopLevelArtifact;
}

/** Parse raw bytes/text before Zod so duplicate keys cannot be erased. */
export function parseV2ArtifactJson(
  input: string | Uint8Array,
): V2TopLevelArtifact {
  return parseSelectedArtifact(parseStrictJson(input, V2_ARTIFACT_JSON_LIMITS));
}

/** Bound, detach, and validate an already-decoded controller value. */
export function parseV2ArtifactValue(value: unknown): V2TopLevelArtifact {
  const detached = cloneStrictBoundedJson(
    value,
    V2_ARTIFACT_VALUE_LIMITS,
    "V2 top-level artifact",
  ).clone;
  return parseSelectedArtifact(detached);
}
