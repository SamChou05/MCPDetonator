import type {
  ClaimEvidenceV2,
  ClaimProfileV2,
} from "../../contracts/v2/index.js";
import type { ComputedCatalogV2, NormalizedCatalogToolV2 } from "./catalog.js";
import { digestCanonicalJson } from "./canonical.js";
import { V2CompileError } from "./errors.js";

type McpEvidenceSource = Extract<
  ClaimEvidenceV2["source"],
  | "mcp_name"
  | "mcp_title"
  | "mcp_description"
  | "mcp_input_schema"
  | "mcp_output_schema"
  | "mcp_annotations"
>;

const fieldBySource: Readonly<Record<McpEvidenceSource, keyof NormalizedCatalogToolV2>> =
  Object.freeze({
    mcp_name: "name",
    mcp_title: "title",
    mcp_description: "description",
    mcp_input_schema: "inputSchema",
    mcp_output_schema: "outputSchema",
    mcp_annotations: "annotations",
  });

export function digestCatalogClaimEvidence(input: {
  readonly source: McpEvidenceSource;
  readonly jsonPointer: string;
  readonly value: unknown;
}): string {
  return digestCanonicalJson("forge.claim-evidence", "v2", input);
}

export interface ClaimEvidenceBindingMetrics {
  readonly evidenceRows: number;
  readonly digestComputations: number;
}

/**
 * Bind every provider-free MCP evidence reference to the exact normalized
 * catalog field used by the claim. Documentation and model evidence require a
 * separate attached source artifact and are deliberately unsupported in 1A.
 */
export function validateClaimEvidenceBindings(
  profile: ClaimProfileV2,
  catalog: ComputedCatalogV2,
): ClaimEvidenceBindingMetrics {
  const indexByName = new Map(
    catalog.catalog.tools.map((tool, index) => [tool.name, index] as const),
  );
  const digestBySourcePointer = new Map<string, string>();
  let evidenceRows = 0;
  let digestComputations = 0;
  for (const claim of profile.claims) {
    const toolIndex = indexByName.get(claim.toolName);
    if (toolIndex === undefined) {
      throw new V2CompileError(
        "digest_mismatch",
        `ClaimProfile references absent tool '${claim.toolName}'`,
      );
    }
    const tool = catalog.catalog.tools[toolIndex]!;
    for (const evidence of claim.evidence) {
      evidenceRows += 1;
      if (
        evidence.source === "documentation" ||
        evidence.source === "model_inference"
      ) {
        throw new V2CompileError(
          "binding_unsupported",
          `Phase 1A cannot verify '${evidence.source}' claim evidence without an attached source artifact`,
        );
      }
      const source = evidence.source;
      const field = fieldBySource[source];
      const expectedPointer = `/tools/${toolIndex}/${field}`;
      if (evidence.jsonPointer !== expectedPointer) {
        throw new V2CompileError(
          "digest_mismatch",
          `claim evidence for '${claim.toolName}' does not reference its exact catalog field`,
        );
      }
      const value = tool[field];
      if (value === undefined) {
        throw new V2CompileError(
          "digest_mismatch",
          `claim evidence references absent catalog field '${String(field)}'`,
        );
      }
      const cacheKey = `${source}\0${expectedPointer}`;
      let digest = digestBySourcePointer.get(cacheKey);
      if (digest === undefined) {
        digest = digestCatalogClaimEvidence({
          source,
          jsonPointer: expectedPointer,
          value,
        });
        digestBySourcePointer.set(cacheKey, digest);
        digestComputations += 1;
      }
      if (digest !== evidence.sourceDigest) {
        throw new V2CompileError(
          "digest_mismatch",
          `claim evidence digest for '${claim.toolName}' does not match the catalog`,
        );
      }
      if (
        evidence.excerpt !== undefined &&
        (typeof value !== "string" || evidence.excerpt !== value)
      ) {
        throw new V2CompileError(
          "digest_mismatch",
          `claim evidence excerpt for '${claim.toolName}' is not exact`,
        );
      }
    }
  }
  return Object.freeze({ evidenceRows, digestComputations });
}
