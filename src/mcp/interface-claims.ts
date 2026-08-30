import { z } from "zod";

import type { McpInterfaceV1 } from "../contracts/v1.js";
import { assertMcpCatalogWithinLimits } from "./catalog.js";

const capabilities = [
  "filesystem_access",
  "network_access",
  "process_execution",
] as const;

const evidenceBases = [
  "name",
  "title",
  "description",
  "schema",
  "annotation",
] as const;

const standardAnnotationNames = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

const capabilitySchema = z.enum(capabilities);
const evidenceBasisSchema = z.enum(evidenceBases);
const standardAnnotationNameSchema = z.enum(standardAnnotationNames);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const extractionLimitsSchema = z
  .object({
    maxTools: z.number().int().positive(),
    maxFieldCharacters: z.number().int().positive(),
    maxSchemaDepth: z.number().int().nonnegative(),
    maxSchemaNodesPerTool: z.number().int().positive(),
    maxSchemaTextCharactersPerTool: z.number().int().positive(),
    maxSchemaKeyCharacters: z.number().int().positive(),
    maxEvidencePerCapability: z.number().int().positive(),
    maxExcerptCharacters: z.number().int().min(16),
    maxTruncationsPerInterface: z.number().int().positive(),
  })
  .strict();

function extractionLimitsEqual(
  left: z.infer<typeof extractionLimitsSchema>,
  right: z.infer<typeof extractionLimitsSchema>,
): boolean {
  return (
    left.maxTools === right.maxTools &&
    left.maxFieldCharacters === right.maxFieldCharacters &&
    left.maxSchemaDepth === right.maxSchemaDepth &&
    left.maxSchemaNodesPerTool === right.maxSchemaNodesPerTool &&
    left.maxSchemaTextCharactersPerTool ===
      right.maxSchemaTextCharactersPerTool &&
    left.maxSchemaKeyCharacters === right.maxSchemaKeyCharacters &&
    left.maxEvidencePerCapability === right.maxEvidencePerCapability &&
    left.maxExcerptCharacters === right.maxExcerptCharacters &&
    left.maxTruncationsPerInterface === right.maxTruncationsPerInterface
  );
}

const claimEvidenceSchema = z
  .object({
    evidenceId: z.string().min(1),
    basis: evidenceBasisSchema,
    pointer: z.string().startsWith("/"),
    source: z.enum(["field_value", "schema_key", "schema_value"]),
    excerpt: z.string().min(1),
    matchedTerms: z.array(z.string().min(1)).min(1),
  })
  .strict();

const capabilityAssessmentSchema = z
  .object({
    experimentId: z.string().min(1),
    toolIndex: z.number().int().nonnegative(),
    toolName: z.string().min(1),
    capability: capabilitySchema,
    status: z.enum(["claim_identified", "no_bounded_claim_identified"]),
    evidence: z.array(claimEvidenceSchema),
  })
  .strict()
  .superRefine((assessment, context) => {
    if (
      assessment.status === "claim_identified" &&
      assessment.evidence.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "claim_identified requires at least one evidence item",
        path: ["evidence"],
      });
    }
    if (
      assessment.status === "no_bounded_claim_identified" &&
      assessment.evidence.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: "no_bounded_claim_identified cannot include evidence",
        path: ["evidence"],
      });
    }
  });

const annotationEvidenceSchema = z
  .object({
    evidenceId: z.string().min(1),
    experimentId: z.string().min(1),
    toolIndex: z.number().int().nonnegative(),
    toolName: z.string().min(1),
    annotation: standardAnnotationNameSchema,
    value: z.boolean(),
    basis: z.literal("annotation"),
    pointer: z.string().startsWith("/"),
  })
  .strict();

const annotationIssueSchema = z
  .object({
    experimentId: z.string().min(1),
    toolIndex: z.number().int().nonnegative(),
    toolName: z.string().min(1),
    pointer: z.string().startsWith("/"),
    annotation: standardAnnotationNameSchema.optional(),
    reason: z.enum(["annotations_not_object", "annotation_not_boolean"]),
  })
  .strict();

const extractionTruncationSchema = z
  .object({
    experimentId: z.string().min(1),
    pointer: z.string().startsWith("/"),
    toolIndex: z.number().int().nonnegative().optional(),
    toolName: z.string().min(1).optional(),
    reason: z.enum([
      "tool_limit",
      "field_character_limit",
      "schema_depth_limit",
      "schema_node_limit",
      "schema_text_character_limit",
      "schema_key_character_limit",
      "evidence_limit",
    ]),
    limit: z.number().int().nonnegative(),
  })
  .strict();

export const mcpInterfaceClaimAnalysisV1Schema = z
  .object({
    schema: z.literal("forge.mcp-interface-claims/v1"),
    runId: z.string().min(1),
    experimentId: z.string().min(1),
    server: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
      })
      .strict(),
    catalogSha256: sha256Schema,
    orderedCatalogSha256: sha256Schema,
    limits: extractionLimitsSchema,
    advertisedToolCount: z.number().int().nonnegative(),
    analyzedToolCount: z.number().int().nonnegative(),
    capabilityAssessments: z.array(capabilityAssessmentSchema),
    annotations: z.array(annotationEvidenceSchema),
    annotationIssues: z.array(annotationIssueSchema),
    coverage: z
      .object({
        schemaNodesVisited: z.number().int().nonnegative(),
        schemaTextCharactersExamined: z.number().int().nonnegative(),
        truncations: z.array(extractionTruncationSchema),
        truncationsOmitted: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((analysis, context) => {
    const expectedAnalyzedToolCount = Math.min(
      analysis.advertisedToolCount,
      analysis.limits.maxTools,
    );
    if (analysis.analyzedToolCount !== expectedAnalyzedToolCount) {
      context.addIssue({
        code: "custom",
        message:
          "analyzed tool count must equal the bounded advertised tool count",
        path: ["analyzedToolCount"],
      });
    }

    const toolNamesByIndex = new Map<number, string>();
    const assessmentKeys = new Set<string>();
    const evidenceIds = new Set<string>();
    for (const [assessmentIndex, assessment] of
      analysis.capabilityAssessments.entries()) {
      const assessmentPath: PropertyKey[] = [
        "capabilityAssessments",
        assessmentIndex,
      ];
      if (
        assessment.evidence.length > analysis.limits.maxEvidencePerCapability
      ) {
        context.addIssue({
          code: "custom",
          message:
            "assessment evidence exceeds the declared per-capability limit",
          path: [...assessmentPath, "evidence"],
        });
      }
      if (assessment.experimentId !== analysis.experimentId) {
        context.addIssue({
          code: "custom",
          message: "assessment experiment must match its interface",
          path: [...assessmentPath, "experimentId"],
        });
      }
      if (assessment.toolIndex >= analysis.analyzedToolCount) {
        context.addIssue({
          code: "custom",
          message: "assessment tool index must identify an analyzed tool",
          path: [...assessmentPath, "toolIndex"],
        });
      } else {
        const knownToolName = toolNamesByIndex.get(assessment.toolIndex);
        if (knownToolName === undefined) {
          toolNamesByIndex.set(assessment.toolIndex, assessment.toolName);
        } else if (knownToolName !== assessment.toolName) {
          context.addIssue({
            code: "custom",
            message: "all assessments for one tool index must use one tool name",
            path: [...assessmentPath, "toolName"],
          });
        }
      }

      const assessmentKey = `${assessment.toolIndex}\0${assessment.capability}`;
      if (assessmentKeys.has(assessmentKey)) {
        context.addIssue({
          code: "custom",
          message: "each analyzed tool requires one assessment per capability",
          path: assessmentPath,
        });
      }
      assessmentKeys.add(assessmentKey);

      for (const [evidenceIndex, evidence] of assessment.evidence.entries()) {
        const evidencePath: PropertyKey[] = [
          ...assessmentPath,
          "evidence",
          evidenceIndex,
        ];
        const expectedEvidenceId =
          `mcp-claim:${analysis.runId}:${analysis.experimentId}:` +
          `${assessment.toolIndex}:${assessment.capability}:${evidenceIndex + 1}`;
        if (evidence.evidenceId !== expectedEvidenceId) {
          context.addIssue({
            code: "custom",
            message: "claim evidence ID must bind to its run, experiment, tool, capability, and position",
            path: [...evidencePath, "evidenceId"],
          });
        }
        if (evidenceIds.has(evidence.evidenceId)) {
          context.addIssue({
            code: "custom",
            message: "claim and annotation evidence IDs must be unique",
            path: [...evidencePath, "evidenceId"],
          });
        }
        evidenceIds.add(evidence.evidenceId);
        if (evidence.excerpt.length > analysis.limits.maxExcerptCharacters) {
          context.addIssue({
            code: "custom",
            message: "claim excerpt exceeds the declared character limit",
            path: [...evidencePath, "excerpt"],
          });
        }
        if (!evidence.pointer.startsWith(`/tools/${assessment.toolIndex}/`)) {
          context.addIssue({
            code: "custom",
            message: "claim evidence pointer must identify the assessed tool",
            path: [...evidencePath, "pointer"],
          });
        }
      }
    }

    if (
      analysis.capabilityAssessments.length !==
        analysis.analyzedToolCount * capabilities.length ||
      assessmentKeys.size !== analysis.capabilityAssessments.length ||
      toolNamesByIndex.size !== analysis.analyzedToolCount
    ) {
      context.addIssue({
        code: "custom",
        message:
          "each analyzed tool requires exactly one assessment for every capability",
        path: ["capabilityAssessments"],
      });
    }

    const annotationKeys = new Set<string>();
    for (const [annotationIndex, annotation] of analysis.annotations.entries()) {
      const annotationPath: PropertyKey[] = ["annotations", annotationIndex];
      if (annotation.experimentId !== analysis.experimentId) {
        context.addIssue({
          code: "custom",
          message: "annotation experiment must match its interface",
          path: [...annotationPath, "experimentId"],
        });
      }
      const knownToolName = toolNamesByIndex.get(annotation.toolIndex);
      if (
        annotation.toolIndex >= analysis.analyzedToolCount ||
        knownToolName === undefined ||
        annotation.toolName !== knownToolName
      ) {
        context.addIssue({
          code: "custom",
          message: "annotation must identify the same analyzed tool as its assessments",
          path: [...annotationPath, "toolName"],
        });
      }
      const annotationKey = `${annotation.toolIndex}\0${annotation.annotation}`;
      if (annotationKeys.has(annotationKey)) {
        context.addIssue({
          code: "custom",
          message: "standard annotations must be unique per analyzed tool",
          path: annotationPath,
        });
      }
      annotationKeys.add(annotationKey);
      const expectedPointer =
        `/tools/${annotation.toolIndex}/annotations/${annotation.annotation}`;
      if (annotation.pointer !== expectedPointer) {
        context.addIssue({
          code: "custom",
          message: "annotation pointer must identify its exact tool annotation",
          path: [...annotationPath, "pointer"],
        });
      }
      const expectedEvidenceId =
        `mcp-annotation:${analysis.runId}:${analysis.experimentId}:` +
        `${annotation.toolIndex}:${annotation.annotation}`;
      if (annotation.evidenceId !== expectedEvidenceId) {
        context.addIssue({
          code: "custom",
          message: "annotation evidence ID must bind to its run, experiment, tool, and annotation",
          path: [...annotationPath, "evidenceId"],
        });
      }
      if (evidenceIds.has(annotation.evidenceId)) {
        context.addIssue({
          code: "custom",
          message: "claim and annotation evidence IDs must be unique",
          path: [...annotationPath, "evidenceId"],
        });
      }
      evidenceIds.add(annotation.evidenceId);
    }

    const annotationIssueKeys = new Set<string>();
    for (const [issueIndex, issue] of analysis.annotationIssues.entries()) {
      const issuePath: PropertyKey[] = ["annotationIssues", issueIndex];
      if (issue.experimentId !== analysis.experimentId) {
        context.addIssue({
          code: "custom",
          message: "annotation issue experiment must match its interface",
          path: [...issuePath, "experimentId"],
        });
      }
      const knownToolName = toolNamesByIndex.get(issue.toolIndex);
      if (
        issue.toolIndex >= analysis.analyzedToolCount ||
        knownToolName === undefined ||
        issue.toolName !== knownToolName
      ) {
        context.addIssue({
          code: "custom",
          message: "annotation issue must identify the same analyzed tool as its assessments",
          path: [...issuePath, "toolName"],
        });
      }
      const expectedPointer =
        issue.reason === "annotations_not_object"
          ? `/tools/${issue.toolIndex}/annotations`
          : issue.annotation === undefined
            ? undefined
            : `/tools/${issue.toolIndex}/annotations/${issue.annotation}`;
      if (
        expectedPointer === undefined ||
        issue.pointer !== expectedPointer ||
        (issue.reason === "annotations_not_object" &&
          issue.annotation !== undefined) ||
        (issue.reason === "annotation_not_boolean" &&
          issue.annotation === undefined)
      ) {
        context.addIssue({
          code: "custom",
          message: "annotation issue reason, annotation, and pointer must agree",
          path: issuePath,
        });
      }
      const issueKey =
        `${issue.toolIndex}\0${issue.annotation ?? ""}\0${issue.reason}`;
      if (annotationIssueKeys.has(issueKey)) {
        context.addIssue({
          code: "custom",
          message: "annotation issues must be unique",
          path: issuePath,
        });
      }
      annotationIssueKeys.add(issueKey);
    }

    const truncationKeys = new Set<string>();
    let toolLimitTruncationCount = 0;
    for (const [truncationIndex, truncation] of
      analysis.coverage.truncations.entries()) {
      const truncationPath: PropertyKey[] = [
        "coverage",
        "truncations",
        truncationIndex,
      ];
      if (truncation.experimentId !== analysis.experimentId) {
        context.addIssue({
          code: "custom",
          message: "truncation experiment must match its interface",
          path: [...truncationPath, "experimentId"],
        });
      }
      const truncationKey = `${truncation.reason}\0${truncation.pointer}`;
      if (truncationKeys.has(truncationKey)) {
        context.addIssue({
          code: "custom",
          message: "truncation reason and pointer pairs must be unique",
          path: truncationPath,
        });
      }
      truncationKeys.add(truncationKey);

      let expectedLimit: number;
      switch (truncation.reason) {
        case "tool_limit":
          expectedLimit = analysis.limits.maxTools;
          break;
        case "field_character_limit":
          expectedLimit = analysis.limits.maxFieldCharacters;
          break;
        case "schema_depth_limit":
          expectedLimit = analysis.limits.maxSchemaDepth;
          break;
        case "schema_node_limit":
          expectedLimit = analysis.limits.maxSchemaNodesPerTool;
          break;
        case "schema_text_character_limit":
          expectedLimit = analysis.limits.maxSchemaTextCharactersPerTool;
          break;
        case "schema_key_character_limit":
          expectedLimit = analysis.limits.maxSchemaKeyCharacters;
          break;
        case "evidence_limit":
          expectedLimit = analysis.limits.maxEvidencePerCapability;
          break;
      }
      if (truncation.limit !== expectedLimit) {
        context.addIssue({
          code: "custom",
          message: "truncation limit must match the applicable extraction limit",
          path: [...truncationPath, "limit"],
        });
      }

      if (truncation.reason === "tool_limit") {
        toolLimitTruncationCount += 1;
        if (
          truncation.toolIndex !== undefined ||
          truncation.toolName !== undefined ||
          truncation.pointer !== `/tools/${analysis.analyzedToolCount}`
        ) {
          context.addIssue({
            code: "custom",
            message: "tool-limit truncation must identify the first omitted catalog entry",
            path: truncationPath,
          });
        }
        continue;
      }

      const toolIndex = truncation.toolIndex;
      const knownToolName =
        toolIndex === undefined ? undefined : toolNamesByIndex.get(toolIndex);
      if (
        toolIndex === undefined ||
        truncation.toolName === undefined ||
        toolIndex >= analysis.analyzedToolCount ||
        knownToolName === undefined ||
        truncation.toolName !== knownToolName ||
        !truncation.pointer.startsWith(`/tools/${toolIndex}/`)
      ) {
        context.addIssue({
          code: "custom",
          message: "tool truncation must identify the same analyzed tool as its assessments",
          path: truncationPath,
        });
      }
    }

    const catalogWasTruncated =
      analysis.advertisedToolCount > analysis.analyzedToolCount;
    if (toolLimitTruncationCount !== (catalogWasTruncated ? 1 : 0)) {
      context.addIssue({
        code: "custom",
        message: "tool-limit truncation must exactly reflect omitted advertised tools",
        path: ["coverage", "truncations"],
      });
    }
    if (
      analysis.coverage.truncations.length >
      analysis.limits.maxTruncationsPerInterface
    ) {
      context.addIssue({
        code: "custom",
        message: "stored truncations exceed the interface truncation limit",
        path: ["coverage", "truncations"],
      });
    }
    if (
      analysis.coverage.truncationsOmitted > 0 &&
      analysis.coverage.truncations.length !==
        analysis.limits.maxTruncationsPerInterface
    ) {
      context.addIssue({
        code: "custom",
        message: "omitted truncations require a full stored truncation budget",
        path: ["coverage", "truncationsOmitted"],
      });
    }
    if (
      analysis.coverage.schemaNodesVisited >
      analysis.analyzedToolCount * analysis.limits.maxSchemaNodesPerTool
    ) {
      context.addIssue({
        code: "custom",
        message: "schema node coverage exceeds the per-tool extraction budget",
        path: ["coverage", "schemaNodesVisited"],
      });
    }
    if (
      analysis.coverage.schemaTextCharactersExamined >
      analysis.analyzedToolCount *
        analysis.limits.maxSchemaTextCharactersPerTool
    ) {
      context.addIssue({
        code: "custom",
        message: "schema text coverage exceeds the per-tool extraction budget",
        path: ["coverage", "schemaTextCharactersExamined"],
      });
    }
  });

export const mcpAdvertisedClaimsV1Schema = z
  .object({
    schema: z.literal("forge.mcp-advertised-claims/v1"),
    runId: z.string().min(1),
    limits: extractionLimitsSchema,
    absenceInterpretation: z.string().min(1),
    interfaces: z.array(mcpInterfaceClaimAnalysisV1Schema),
    limitations: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((artifact, context) => {
    const experimentIds = new Set<string>();
    for (const [interfaceIndex, analysis] of artifact.interfaces.entries()) {
      const interfacePath: PropertyKey[] = ["interfaces", interfaceIndex];
      if (analysis.runId !== artifact.runId) {
        context.addIssue({
          code: "custom",
          message: "interface claim run must match the advertised-claims envelope",
          path: [...interfacePath, "runId"],
        });
      }
      if (!extractionLimitsEqual(analysis.limits, artifact.limits)) {
        context.addIssue({
          code: "custom",
          message: "interface extraction limits must match the advertised-claims envelope",
          path: [...interfacePath, "limits"],
        });
      }
      if (experimentIds.has(analysis.experimentId)) {
        context.addIssue({
          code: "custom",
          message: "advertised-claims interfaces require unique experiment IDs",
          path: [...interfacePath, "experimentId"],
        });
      }
      experimentIds.add(analysis.experimentId);
    }
  });

export type McpInterfaceClaimCapability = (typeof capabilities)[number];
export type McpInterfaceEvidenceBasis = (typeof evidenceBases)[number];
export type McpInterfaceClaimExtractionLimits = z.infer<
  typeof extractionLimitsSchema
>;
export type McpInterfaceClaimAnalysisV1 = z.infer<
  typeof mcpInterfaceClaimAnalysisV1Schema
>;
export type McpAdvertisedClaimsV1 = z.infer<
  typeof mcpAdvertisedClaimsV1Schema
>;

export const defaultMcpInterfaceClaimExtractionLimits = {
  maxTools: 128,
  maxFieldCharacters: 4_096,
  maxSchemaDepth: 8,
  maxSchemaNodesPerTool: 512,
  maxSchemaTextCharactersPerTool: 32_768,
  maxSchemaKeyCharacters: 256,
  maxEvidencePerCapability: 16,
  maxExcerptCharacters: 192,
  maxTruncationsPerInterface: 256,
} as const satisfies McpInterfaceClaimExtractionLimits;

export const noBoundedClaimInterpretation =
  "no_bounded_claim_identified means only that this bounded extractor found no positive interface signal; it is not a denial of capability, an authorization boundary, or a runtime guarantee.";

const artifactLimitations = [
  "Advertised MCP names, titles, descriptions, schemas, and annotations are untrusted claims, not authorization or proof of runtime behavior.",
  "Capability extraction is a bounded lexical classification of filesystem, network, and process-execution signals; it is not semantic proof and can miss euphemisms or unusual wording.",
  "Valid standard MCP annotation booleans are preserved separately and do not independently imply filesystem, network, or process-execution capability.",
  noBoundedClaimInterpretation,
] as const;

const basisOrder = new Map<McpInterfaceEvidenceBasis, number>(
  evidenceBases.map((basis, index) => [basis, index]),
);

const negationTerms = new Set([
  "cannot",
  "never",
  "neither",
  "no",
  "nor",
  "not",
  "without",
]);

const contrastTerms = new Set([
  "although",
  "but",
  "except",
  "however",
  "instead",
  "yet",
]);

const filesystemTerms = new Set([
  "directory",
  "directories",
  "dirpath",
  "file",
  "filepath",
  "filename",
  "files",
  "filesystem",
  "folder",
  "folders",
  "path",
  "paths",
]);

const networkTerms = new Set([
  "endpoint",
  "http",
  "https",
  "internet",
  "network",
  "socket",
  "uri",
  "url",
  "webhook",
]);

const processTerms = new Set([
  "command",
  "commands",
  "exec",
  "executable",
  "shell",
  "spawn",
  "subprocess",
  "subprocesses",
]);

const processNouns = new Set([
  "process",
  "processes",
  "program",
  "programs",
  "script",
  "scripts",
]);

const processActions = new Set([
  "execute",
  "executes",
  "executing",
  "launch",
  "launches",
  "launching",
  "run",
  "runs",
  "running",
  "spawn",
  "spawns",
  "spawning",
  "start",
  "starts",
  "starting",
]);

const schemaStructuralKeys = new Set([
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "contentEncoding",
  "contentMediaType",
  "default",
  "definitions",
  "dependentRequired",
  "dependentSchemas",
  "deprecated",
  "description",
  "else",
  "enum",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "if",
  "items",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "properties",
  "propertyNames",
  "readOnly",
  "required",
  "then",
  "title",
  "type",
  "unevaluatedItems",
  "unevaluatedProperties",
  "uniqueItems",
  "writeOnly",
]);

const ignoredSchemaStringValueKeys = new Set([
  "$id",
  "$ref",
  "$schema",
  "pattern",
  "type",
]);

interface MutableEvidence {
  readonly basis: McpInterfaceEvidenceBasis;
  readonly pointer: string;
  readonly source: "field_value" | "schema_key" | "schema_value";
  readonly segmentIndex: number;
  readonly windowIndex: number;
  readonly excerpt: string;
  readonly matchedTerms: Set<string>;
}

interface ToolScanState {
  readonly runId: string;
  readonly experimentId: string;
  readonly toolIndex: number;
  readonly toolName: string;
  readonly limits: McpInterfaceClaimExtractionLimits;
  readonly evidence: Map<
    McpInterfaceClaimCapability,
    Map<string, MutableEvidence>
  >;
  schemaNodesVisited: number;
  schemaTextCharactersExamined: number;
}

interface InterfaceScanState {
  readonly experimentId: string;
  readonly limits: McpInterfaceClaimExtractionLimits;
  readonly truncations: McpInterfaceClaimAnalysisV1["coverage"]["truncations"];
  readonly truncationKeys: Set<string>;
  truncationsOmitted: number;
}

interface SegmentMatch {
  readonly matchedTerms: readonly string[];
  readonly anchor: string;
}

function normalizeLimits(
  overrides: Partial<McpInterfaceClaimExtractionLimits>,
): McpInterfaceClaimExtractionLimits {
  return extractionLimitsSchema.parse({
    ...defaultMcpInterfaceClaimExtractionLimits,
    ...overrides,
  });
}

function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPointer(pointer: string, segment: string | number): string {
  return `${pointer}/${escapeJsonPointerSegment(String(segment))}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedSortedObjectEntries(
  value: Record<string, unknown>,
  maxEntries: number,
): {
  readonly entries: readonly (readonly [string, unknown])[];
  readonly truncated: boolean;
} {
  const keys: string[] = [];
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    if (keys.length >= maxEntries) {
      return { entries: [], truncated: true };
    }
    keys.push(key);
  }
  keys.sort(compareStrings);
  return {
    entries: keys.map((key) => [key, value[key]] as const),
    truncated: false,
  };
}

function normalizedTokens(text: string): string[] {
  return text
    .replace(/\b(can(?:no|['’])t)\b/giu, " cannot ")
    .replace(/\bwon['’]t\b/giu, " will not ")
    .replace(/\b(does|do|did|is|are|was|were|will|would|should|could)n['’]?t\b/giu, "$1 not")
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9]+/gu) ?? [];
}

function isNegated(tokens: readonly string[], signalIndex: number): boolean {
  let latestNegation = -1;
  let latestContrast = -1;

  for (let index = 0; index < signalIndex; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    if (contrastTerms.has(token)) {
      latestContrast = index;
    }
    if (negationTerms.has(token)) {
      if (token === "not" && tokens[index + 1] === "only") {
        continue;
      }
      latestNegation = index;
    }
  }

  return latestNegation > latestContrast;
}

function firstPositiveIndex(
  tokens: readonly string[],
  terms: ReadonlySet<string>,
): number | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token !== undefined && terms.has(token) && !isNegated(tokens, index)) {
      return index;
    }
  }
  return undefined;
}

function positiveTermMatches(
  tokens: readonly string[],
  terms: ReadonlySet<string>,
): { readonly index: number; readonly token: string }[] {
  const matches: { readonly index: number; readonly token: string }[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token !== undefined && terms.has(token) && !isNegated(tokens, index)) {
      matches.push({ index, token });
    }
  }
  return matches;
}

function classifySegment(
  segment: string,
): Map<McpInterfaceClaimCapability, SegmentMatch> {
  const tokens = normalizedTokens(segment);
  const matches = new Map<McpInterfaceClaimCapability, SegmentMatch>();

  const filesystemMatches = positiveTermMatches(tokens, filesystemTerms);
  const firstFilesystemMatch = filesystemMatches[0];
  if (firstFilesystemMatch !== undefined) {
    matches.set("filesystem_access", {
      matchedTerms: [...new Set(filesystemMatches.map((match) => match.token))],
      anchor: firstFilesystemMatch.token,
    });
  } else {
    const documentIndex = tokens.findIndex(
      (token, index) =>
        (token === "document" || token === "documents") &&
        !isNegated(tokens, index),
    );
    const workspaceIndex = tokens.findIndex(
      (token, index) =>
        (token === "workspace" || token === "local") &&
        !isNegated(tokens, index),
    );
    if (documentIndex >= 0 && workspaceIndex >= 0) {
      matches.set("filesystem_access", {
        matchedTerms: [
          tokens[workspaceIndex] ?? "workspace",
          tokens[documentIndex] ?? "document",
        ],
        anchor: tokens[documentIndex] ?? "document",
      });
    }
  }

  const networkMatches = positiveTermMatches(tokens, networkTerms);
  const firstNetworkMatch = networkMatches[0];
  if (firstNetworkMatch !== undefined) {
    matches.set("network_access", {
      matchedTerms: [...new Set(networkMatches.map((match) => match.token))],
      anchor: firstNetworkMatch.token,
    });
  }

  const processMatches = positiveTermMatches(tokens, processTerms);
  const firstProcessMatch = processMatches[0];
  if (firstProcessMatch !== undefined) {
    matches.set("process_execution", {
      matchedTerms: [...new Set(processMatches.map((match) => match.token))],
      anchor: firstProcessMatch.token,
    });
  } else {
    const processNounIndex = firstPositiveIndex(tokens, processNouns);
    const processActionIndex = firstPositiveIndex(tokens, processActions);
    if (processNounIndex !== undefined && processActionIndex !== undefined) {
      const signalIndex = Math.max(processNounIndex, processActionIndex);
      if (!isNegated(tokens, signalIndex)) {
        const noun = tokens[processNounIndex] ?? "process";
        const action = tokens[processActionIndex] ?? "execute";
        matches.set("process_execution", {
          matchedTerms: [action, noun],
          anchor: noun,
        });
      }
    }
  }

  return matches;
}

function boundedExcerpt(
  text: string,
  anchor: string,
  maxCharacters: number,
): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= maxCharacters) {
    return collapsed || anchor;
  }

  const anchorIndex = findTokenStart(collapsed, anchor);
  const desiredStart = Math.max(
    0,
    anchorIndex < 0 ? 0 : anchorIndex - Math.floor(maxCharacters / 3),
  );
  const prefix = desiredStart > 0 ? "…" : "";
  const available = maxCharacters - prefix.length;
  const needsSuffix = desiredStart + available < collapsed.length;
  const bodyLength = Math.max(1, available - (needsSuffix ? 1 : 0));
  const body = collapsed.slice(desiredStart, desiredStart + bodyLength);
  return `${prefix}${body}${needsSuffix ? "…" : ""}`;
}

function isAsciiAlphaNumeric(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isAsciiUppercase(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }
  const code = character.charCodeAt(0);
  return code >= 65 && code <= 90;
}

function isAsciiLowercaseOrDigit(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
}

function findTokenStart(text: string, term: string): number {
  const lowered = text.toLowerCase();
  let searchFrom = 0;
  while (searchFrom < lowered.length) {
    const index = lowered.indexOf(term, searchFrom);
    if (index < 0) {
      return -1;
    }
    const end = index + term.length;
    const before = text[index - 1];
    const first = text[index];
    const last = text[end - 1];
    const after = text[end];
    const startsAtBoundary =
      !isAsciiAlphaNumeric(before) ||
      (isAsciiLowercaseOrDigit(before) && isAsciiUppercase(first));
    const endsAtBoundary =
      !isAsciiAlphaNumeric(after) ||
      (isAsciiLowercaseOrDigit(last) && isAsciiUppercase(after));
    if (startsAtBoundary && endsAtBoundary) {
      return index;
    }
    searchFrom = index + 1;
  }
  return -1;
}

function completeTokenPrefix(text: string, allowedCharacters: number): string {
  const prefix = text.slice(0, allowedCharacters);
  if (allowedCharacters >= text.length || allowedCharacters === 0) {
    return prefix;
  }

  const previous = text[allowedCharacters - 1];
  const next = text[allowedCharacters];
  if (
    !isAsciiAlphaNumeric(previous) ||
    !isAsciiAlphaNumeric(next) ||
    (isAsciiLowercaseOrDigit(previous) && isAsciiUppercase(next))
  ) {
    return prefix;
  }

  let completeLength = prefix.length;
  while (
    completeLength > 0 &&
    isAsciiAlphaNumeric(prefix[completeLength - 1])
  ) {
    completeLength -= 1;
  }
  return prefix.slice(0, completeLength);
}

function evidenceWindows(
  segment: string,
  match: SegmentMatch,
  maxCharacters: number,
): { readonly excerpt: string; readonly matchedTerms: readonly string[] }[] {
  const remaining = [
    match.anchor,
    ...match.matchedTerms
      .filter((term) => term !== match.anchor)
      .sort(compareStrings),
  ];
  const windows: {
    readonly excerpt: string;
    readonly matchedTerms: readonly string[];
  }[] = [];

  while (remaining.length > 0) {
    const anchor = remaining[0];
    if (anchor === undefined) {
      break;
    }
    const excerpt = boundedExcerpt(segment, anchor, maxCharacters);
    const excerptTokens = new Set(normalizedTokens(excerpt));
    const visibleTerms = remaining
      .filter((term) => excerptTokens.has(term))
      .sort(compareStrings);
    if (visibleTerms.length === 0) {
      remaining.shift();
      continue;
    }
    windows.push({ excerpt, matchedTerms: visibleTerms });
    const visible = new Set(visibleTerms);
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const term = remaining[index];
      if (term !== undefined && visible.has(term)) {
        remaining.splice(index, 1);
      }
    }
  }

  return windows;
}

function addTruncation(
  interfaceState: InterfaceScanState,
  truncation: McpInterfaceClaimAnalysisV1["coverage"]["truncations"][number],
): void {
  const key = `${truncation.reason}\0${truncation.pointer}`;
  if (interfaceState.truncationKeys.has(key)) {
    return;
  }
  interfaceState.truncationKeys.add(key);

  if (
    interfaceState.truncations.length >=
    interfaceState.limits.maxTruncationsPerInterface
  ) {
    interfaceState.truncationsOmitted += 1;
    return;
  }
  interfaceState.truncations.push(truncation);
}

function addToolTruncation(
  interfaceState: InterfaceScanState,
  toolState: ToolScanState,
  pointer: string,
  reason: McpInterfaceClaimAnalysisV1["coverage"]["truncations"][number]["reason"],
  limit: number,
): void {
  addTruncation(interfaceState, {
    experimentId: toolState.experimentId,
    toolIndex: toolState.toolIndex,
    toolName: toolState.toolName,
    pointer,
    reason,
    limit,
  });
}

function addEvidence(
  interfaceState: InterfaceScanState,
  toolState: ToolScanState,
  capability: McpInterfaceClaimCapability,
  basis: McpInterfaceEvidenceBasis,
  pointer: string,
  source: MutableEvidence["source"],
  segmentIndex: number,
  windowIndex: number,
  excerpt: string,
  matchedTerms: readonly string[],
): void {
  const evidenceForCapability = toolState.evidence.get(capability);
  if (evidenceForCapability === undefined) {
    throw new Error(`missing evidence bucket for ${capability}`);
  }
  const key = `${basis}\0${pointer}\0${source}\0${segmentIndex}\0${windowIndex}`;
  const existing = evidenceForCapability.get(key);
  if (existing !== undefined) {
    for (const term of matchedTerms) {
      existing.matchedTerms.add(term);
    }
    return;
  }

  if (
    evidenceForCapability.size >= toolState.limits.maxEvidencePerCapability
  ) {
    addToolTruncation(
      interfaceState,
      toolState,
      pointer,
      "evidence_limit",
      toolState.limits.maxEvidencePerCapability,
    );
    return;
  }

  evidenceForCapability.set(key, {
    basis,
    pointer,
    source,
    segmentIndex,
    windowIndex,
    excerpt,
    matchedTerms: new Set(matchedTerms),
  });
}

function scanText(
  interfaceState: InterfaceScanState,
  toolState: ToolScanState,
  input: string,
  basis: Exclude<McpInterfaceEvidenceBasis, "annotation">,
  pointer: string,
  source: MutableEvidence["source"],
  schemaText: boolean,
): void {
  let allowedCharacters = Math.min(
    input.length,
    toolState.limits.maxFieldCharacters,
  );
  if (schemaText) {
    const remainingSchemaCharacters = Math.max(
      0,
      toolState.limits.maxSchemaTextCharactersPerTool -
        toolState.schemaTextCharactersExamined,
    );
    allowedCharacters = Math.min(allowedCharacters, remainingSchemaCharacters);
    toolState.schemaTextCharactersExamined += allowedCharacters;
  }

  if (allowedCharacters < input.length) {
    const exhaustedSchemaBudget =
      schemaText &&
      toolState.schemaTextCharactersExamined >=
        toolState.limits.maxSchemaTextCharactersPerTool &&
      allowedCharacters <
        Math.min(input.length, toolState.limits.maxFieldCharacters);
    addToolTruncation(
      interfaceState,
      toolState,
      pointer,
      exhaustedSchemaBudget
        ? "schema_text_character_limit"
        : "field_character_limit",
      exhaustedSchemaBudget
        ? toolState.limits.maxSchemaTextCharactersPerTool
        : toolState.limits.maxFieldCharacters,
    );
  }

  if (allowedCharacters === 0) {
    return;
  }

  const examined = completeTokenPrefix(input, allowedCharacters);
  if (examined.length === 0) {
    return;
  }
  const segments = examined.split(/[.!?;\n\r]+/gu);
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    if (segment === undefined) {
      continue;
    }
    const segmentMatches = classifySegment(segment);
    for (const [capability, match] of segmentMatches) {
      const windows = evidenceWindows(
        segment,
        match,
        toolState.limits.maxExcerptCharacters,
      );
      for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
        const window = windows[windowIndex];
        if (window === undefined) {
          continue;
        }
        addEvidence(
          interfaceState,
          toolState,
          capability,
          basis,
          pointer,
          source,
          segmentIndex,
          windowIndex,
          window.excerpt,
          window.matchedTerms,
        );
      }
    }
  }
}

function scanSchema(
  interfaceState: InterfaceScanState,
  toolState: ToolScanState,
  value: unknown,
  pointer: string,
  depth: number,
  parentKey?: string,
): void {
  if (depth > toolState.limits.maxSchemaDepth) {
    addToolTruncation(
      interfaceState,
      toolState,
      pointer,
      "schema_depth_limit",
      toolState.limits.maxSchemaDepth,
    );
    return;
  }
  if (toolState.schemaNodesVisited >= toolState.limits.maxSchemaNodesPerTool) {
    addToolTruncation(
      interfaceState,
      toolState,
      pointer,
      "schema_node_limit",
      toolState.limits.maxSchemaNodesPerTool,
    );
    return;
  }
  toolState.schemaNodesVisited += 1;

  if (typeof value === "string") {
    if (parentKey === undefined || !ignoredSchemaStringValueKeys.has(parentKey)) {
      scanText(
        interfaceState,
        toolState,
        value,
        "schema",
        pointer,
        "schema_value",
        true,
      );
    }
    return;
  }

  if (
    depth >= toolState.limits.maxSchemaDepth &&
    (Array.isArray(value) || (value !== null && typeof value === "object"))
  ) {
    addToolTruncation(
      interfaceState,
      toolState,
      pointer,
      "schema_depth_limit",
      toolState.limits.maxSchemaDepth,
    );
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const itemPointer = childPointer(pointer, index);
      if (
        toolState.schemaNodesVisited >= toolState.limits.maxSchemaNodesPerTool
      ) {
        addToolTruncation(
          interfaceState,
          toolState,
          itemPointer,
          "schema_node_limit",
          toolState.limits.maxSchemaNodesPerTool,
        );
        break;
      }
      scanSchema(
        interfaceState,
        toolState,
        value[index],
        itemPointer,
        depth + 1,
        parentKey,
      );
    }
    return;
  }

  if (value === null || typeof value !== "object") {
    return;
  }

  const remainingNodeBudget =
    toolState.limits.maxSchemaNodesPerTool - toolState.schemaNodesVisited;
  const boundedEntries = boundedSortedObjectEntries(
    value as Record<string, unknown>,
    remainingNodeBudget,
  );
  if (boundedEntries.truncated) {
    addToolTruncation(
      interfaceState,
      toolState,
      pointer,
      "schema_node_limit",
      toolState.limits.maxSchemaNodesPerTool,
    );
    return;
  }
  for (const [key, child] of boundedEntries.entries) {
    const keyIsBounded = key.length <= toolState.limits.maxSchemaKeyCharacters;
    const valuePointer = keyIsBounded
      ? childPointer(pointer, key)
      : pointer;
    if (!keyIsBounded) {
      addToolTruncation(
        interfaceState,
        toolState,
        pointer,
        "schema_key_character_limit",
        toolState.limits.maxSchemaKeyCharacters,
      );
      continue;
    }

    if (!schemaStructuralKeys.has(key)) {
      scanText(
        interfaceState,
        toolState,
        key,
        "schema",
        valuePointer,
        "schema_key",
        true,
      );
    }

    if (toolState.schemaNodesVisited >= toolState.limits.maxSchemaNodesPerTool) {
      addToolTruncation(
        interfaceState,
        toolState,
        valuePointer,
        "schema_node_limit",
        toolState.limits.maxSchemaNodesPerTool,
      );
      break;
    }
    scanSchema(
      interfaceState,
      toolState,
      child,
      valuePointer,
      depth + 1,
      key,
    );
  }
}

function scanAnnotations(
  tool: McpInterfaceV1["tools"][number],
  toolState: ToolScanState,
): {
  readonly evidence: McpInterfaceClaimAnalysisV1["annotations"];
  readonly issues: McpInterfaceClaimAnalysisV1["annotationIssues"];
} {
  const evidence: McpInterfaceClaimAnalysisV1["annotations"] = [];
  const issues: McpInterfaceClaimAnalysisV1["annotationIssues"] = [];
  if (tool.annotations === undefined) {
    return { evidence, issues };
  }

  const annotationsPointer = `/tools/${toolState.toolIndex}/annotations`;
  if (
    tool.annotations === null ||
    Array.isArray(tool.annotations) ||
    typeof tool.annotations !== "object"
  ) {
    issues.push({
      experimentId: toolState.experimentId,
      toolIndex: toolState.toolIndex,
      toolName: toolState.toolName,
      pointer: annotationsPointer,
      reason: "annotations_not_object",
    });
    return { evidence, issues };
  }

  const annotationRecord = tool.annotations as Record<string, unknown>;
  for (const annotation of standardAnnotationNames) {
    const value = annotationRecord[annotation];
    if (value === undefined) {
      continue;
    }
    const pointer = childPointer(annotationsPointer, annotation);
    if (typeof value !== "boolean") {
      issues.push({
        experimentId: toolState.experimentId,
        toolIndex: toolState.toolIndex,
        toolName: toolState.toolName,
        pointer,
        annotation,
        reason: "annotation_not_boolean",
      });
      continue;
    }
    evidence.push({
      evidenceId: `mcp-annotation:${toolState.runId}:${toolState.experimentId}:${toolState.toolIndex}:${annotation}`,
      experimentId: toolState.experimentId,
      toolIndex: toolState.toolIndex,
      toolName: toolState.toolName,
      annotation,
      value,
      basis: "annotation",
      pointer,
    });
  }
  return { evidence, issues };
}

function materializeEvidence(
  toolState: ToolScanState,
  capability: McpInterfaceClaimCapability,
  evidence: ReadonlyMap<string, MutableEvidence>,
): McpInterfaceClaimAnalysisV1["capabilityAssessments"][number]["evidence"] {
  return [...evidence.values()]
    .sort((left, right) => {
      const basisComparison =
        (basisOrder.get(left.basis) ?? Number.MAX_SAFE_INTEGER) -
        (basisOrder.get(right.basis) ?? Number.MAX_SAFE_INTEGER);
      if (basisComparison !== 0) {
        return basisComparison;
      }
      const pointerComparison = compareStrings(left.pointer, right.pointer);
      if (pointerComparison !== 0) {
        return pointerComparison;
      }
      const sourceComparison = compareStrings(left.source, right.source);
      if (sourceComparison !== 0) {
        return sourceComparison;
      }
      const segmentComparison = left.segmentIndex - right.segmentIndex;
      if (segmentComparison !== 0) {
        return segmentComparison;
      }
      return left.windowIndex - right.windowIndex;
    })
    .map((item, index) => ({
      evidenceId: `mcp-claim:${toolState.runId}:${toolState.experimentId}:${toolState.toolIndex}:${capability}:${index + 1}`,
      basis: item.basis,
      pointer: item.pointer,
      source: item.source,
      excerpt: item.excerpt,
      matchedTerms: [...item.matchedTerms].sort(compareStrings),
    }));
}

export function extractMcpInterfaceClaims(
  mcpInterface: McpInterfaceV1,
  limitOverrides: Partial<McpInterfaceClaimExtractionLimits> = {},
): McpInterfaceClaimAnalysisV1 {
  const limits = normalizeLimits(limitOverrides);
  const catalogFingerprint = assertMcpCatalogWithinLimits(
    mcpInterface.server,
    mcpInterface.tools,
  );
  const interfaceState: InterfaceScanState = {
    experimentId: mcpInterface.experimentId,
    limits,
    truncations: [],
    truncationKeys: new Set(),
    truncationsOmitted: 0,
  };
  const capabilityAssessments: McpInterfaceClaimAnalysisV1["capabilityAssessments"] = [];
  const annotations: McpInterfaceClaimAnalysisV1["annotations"] = [];
  const annotationIssues: McpInterfaceClaimAnalysisV1["annotationIssues"] = [];
  let schemaNodesVisited = 0;
  let schemaTextCharactersExamined = 0;
  const analyzedTools = mcpInterface.tools.slice(0, limits.maxTools);

  if (mcpInterface.tools.length > analyzedTools.length) {
    addTruncation(interfaceState, {
      experimentId: mcpInterface.experimentId,
      pointer: `/tools/${analyzedTools.length}`,
      reason: "tool_limit",
      limit: limits.maxTools,
    });
  }

  for (let toolIndex = 0; toolIndex < analyzedTools.length; toolIndex += 1) {
    const tool = analyzedTools[toolIndex];
    if (tool === undefined) {
      continue;
    }
    const evidence = new Map<
      McpInterfaceClaimCapability,
      Map<string, MutableEvidence>
    >(capabilities.map((capability) => [capability, new Map()]));
    const toolState: ToolScanState = {
      runId: mcpInterface.runId,
      experimentId: mcpInterface.experimentId,
      toolIndex,
      toolName: tool.name,
      limits,
      evidence,
      schemaNodesVisited: 0,
      schemaTextCharactersExamined: 0,
    };

    scanText(
      interfaceState,
      toolState,
      tool.name,
      "name",
      `/tools/${toolIndex}/name`,
      "field_value",
      false,
    );
    if (tool.title !== undefined) {
      scanText(
        interfaceState,
        toolState,
        tool.title,
        "title",
        `/tools/${toolIndex}/title`,
        "field_value",
        false,
      );
    }
    if (tool.description !== undefined) {
      scanText(
        interfaceState,
        toolState,
        tool.description,
        "description",
        `/tools/${toolIndex}/description`,
        "field_value",
        false,
      );
    }
    scanSchema(
      interfaceState,
      toolState,
      tool.inputSchema,
      `/tools/${toolIndex}/inputSchema`,
      0,
    );

    const annotationScan = scanAnnotations(tool, toolState);
    annotations.push(...annotationScan.evidence);
    annotationIssues.push(...annotationScan.issues);

    for (const capability of capabilities) {
      const capabilityEvidence = materializeEvidence(
        toolState,
        capability,
        evidence.get(capability) ?? new Map(),
      );
      capabilityAssessments.push({
        experimentId: mcpInterface.experimentId,
        toolIndex,
        toolName: tool.name,
        capability,
        status:
          capabilityEvidence.length === 0
            ? "no_bounded_claim_identified"
            : "claim_identified",
        evidence: capabilityEvidence,
      });
    }

    schemaNodesVisited += toolState.schemaNodesVisited;
    schemaTextCharactersExamined += toolState.schemaTextCharactersExamined;
  }

  return mcpInterfaceClaimAnalysisV1Schema.parse({
    schema: "forge.mcp-interface-claims/v1",
    runId: mcpInterface.runId,
    experimentId: mcpInterface.experimentId,
    server: mcpInterface.server,
    catalogSha256: catalogFingerprint.sha256,
    orderedCatalogSha256: catalogFingerprint.orderedSha256,
    limits,
    advertisedToolCount: mcpInterface.tools.length,
    analyzedToolCount: analyzedTools.length,
    capabilityAssessments,
    annotations,
    annotationIssues,
    coverage: {
      schemaNodesVisited,
      schemaTextCharactersExamined,
      truncations: interfaceState.truncations,
      truncationsOmitted: interfaceState.truncationsOmitted,
    },
  });
}

export function extractMcpAdvertisedClaims(
  runId: string,
  interfaces: readonly McpInterfaceV1[],
  limitOverrides: Partial<McpInterfaceClaimExtractionLimits> = {},
): McpAdvertisedClaimsV1 {
  const limits = normalizeLimits(limitOverrides);
  const analyses = interfaces.map((mcpInterface) => {
    if (mcpInterface.runId !== runId) {
      throw new Error(
        `MCP interface run '${mcpInterface.runId}' does not match advertised-claims run '${runId}'`,
      );
    }
    return extractMcpInterfaceClaims(mcpInterface, limits);
  });

  return mcpAdvertisedClaimsV1Schema.parse({
    schema: "forge.mcp-advertised-claims/v1",
    runId,
    limits,
    absenceInterpretation: noBoundedClaimInterpretation,
    interfaces: analyses,
    limitations: [...artifactLimitations],
  });
}
