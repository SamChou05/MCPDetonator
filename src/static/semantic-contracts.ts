import { z } from "zod";

import { sha256 } from "../evidence-store.js";
import {
  staticCapabilitySchema,
  staticEvidenceReferenceV1Schema,
} from "./contracts.js";
import {
  NODE_SEMANTIC_CATALOG_VERSION,
  NODE_SEMANTIC_SINK_BY_ID,
} from "./node-semantic-catalog.js";

const identifierSchema = z.string().min(1);
const timestampSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const relativeTargetPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/"), "must be relative")
  .refine(
    (value) => !value.split("/").includes(".."),
    "must not contain parent-directory segments",
  );

export const nodeSemanticLimitsV1Schema = z
  .object({
    maxInputFiles: z.number().int().positive(),
    maxInputBytes: z.number().int().positive(),
    maxAstNodes: z.number().int().positive(),
    maxCallsites: z.number().int().positive(),
    maxDiagnostics: z.number().int().positive(),
    maxCallGraphEdges: z.number().int().positive(),
    maxModuleResolutions: z.number().int().positive(),
    maxAliasPasses: z.number().int().positive(),
    maxAliasDepth: z.number().int().positive(),
    maxReachabilityDepth: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    workerMemoryMb: z.number().int().positive(),
  })
  .strict();

const semanticDiagnosticSchema = z
  .object({
    code: z.number().int().nonnegative(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    message: z.string().min(1).max(512),
  })
  .strict();

const semanticFileSchema = z
  .object({
    targetPath: relativeTargetPathSchema,
    sizeBytes: z.number().int().nonnegative(),
    sha256: sha256Schema,
    evidence: staticEvidenceReferenceV1Schema,
    parseStatus: z.enum(["parsed", "syntax_errors", "not_analyzed"]),
    syntaxDiagnosticCount: z.number().int().nonnegative(),
    diagnostics: z.array(semanticDiagnosticSchema),
    diagnosticsTruncated: z.boolean(),
  })
  .strict();

export const semanticHandlerReachabilitySchema = z.literal("not_assessed");

const semanticCallsiteSchema = z
  .object({
    callsiteId: identifierSchema,
    sinkId: identifierSchema,
    capability: staticCapabilitySchema,
    operation: z.enum(["call", "construct", "property_access", "module_load"]),
    api: z
      .object({
        module: z.string().min(1),
        member: z.string().min(1),
      })
      .strict(),
    resolution: z.enum([
      "symbol_resolved",
      "bounded_alias_resolved",
      "syntax_resolved",
    ]),
    aliasDepth: z.number().int().nonnegative(),
    span: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
      })
      .strict()
      .refine((span) => span.end > span.start, "span end must follow start"),
    handlerReachability: semanticHandlerReachabilitySchema,
    callPath: z.array(staticEvidenceReferenceV1Schema).max(0),
    evidence: staticEvidenceReferenceV1Schema,
    excerpt: z.string().min(1).max(240),
  })
  .strict();

const semanticIssueSchema = z
  .object({
    kind: z.enum([
      "unresolved_relative_module",
      "unsupported_binding_flow",
      "analysis_truncated",
      "input_failure",
      "worker_failure",
    ]),
    targetPath: relativeTargetPathSchema.optional(),
    summary: z.string().min(1).max(512),
  })
  .strict();

export const semanticTruncationSchema = z.enum([
  "ast_nodes",
  "callsites",
  "diagnostics",
  "module_resolutions",
  "alias_passes",
  "alias_depth",
  "issues",
]);

const semanticCoverageSchema = z
  .object({
    inputFiles: z.number().int().nonnegative(),
    inputBytes: z.number().int().nonnegative(),
    parsedFiles: z.number().int().nonnegative(),
    filesWithSyntaxErrors: z.number().int().nonnegative(),
    astNodesVisited: z.number().int().nonnegative(),
    callExpressionsVisited: z.number().int().nonnegative(),
    handlerRootsIdentified: z.literal(0),
    localCallGraphEdges: z.literal(0),
    moduleResolutionsAttempted: z.number().int().nonnegative(),
    moduleResolutionsUnresolved: z.number().int().nonnegative(),
    resolutionIncomplete: z.boolean(),
  })
  .strict();

const semanticFailureSchema = z
  .object({
    kind: z.enum(["invalid_input", "timeout", "resource_limit", "worker_error"]),
    message: z.string().min(1).max(512),
  })
  .strict();

export const nodeSemanticStaticV1Schema = z
  .object({
    schema: z.literal("forge.node-semantic-static/v1"),
    runId: identifierSchema,
    targetId: identifierSchema,
    generatedAt: timestampSchema,
    status: z.enum(["completed", "partial", "failed"]),
    analyzer: z
      .object({
        engine: z.literal("typescript-compiler-api"),
        package: z.literal("typescript-semantic"),
        version: z.string().min(1),
        catalogVersion: z.literal(NODE_SEMANTIC_CATALOG_VERSION),
      })
      .strict(),
    input: z
      .object({
        lexicalInspectionArtifact: relativeTargetPathSchema,
        lexicalInspectionSha256: sha256Schema,
        sourceSetSha256: sha256Schema,
      })
      .strict(),
    limits: nodeSemanticLimitsV1Schema,
    coverage: semanticCoverageSchema,
    files: z.array(semanticFileSchema),
    callsites: z.array(semanticCallsiteSchema),
    issues: z.array(semanticIssueSchema).max(1_024),
    truncations: z.array(semanticTruncationSchema),
    failure: semanticFailureSchema.optional(),
    limitations: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((analysis, context) => {
    const fileByPath = new Map<string, (typeof analysis.files)[number]>();
    for (const [index, file] of analysis.files.entries()) {
      if (fileByPath.has(file.targetPath)) {
        context.addIssue({
          code: "custom",
          message: "semantic input file paths must be unique",
          path: ["files", index, "targetPath"],
        });
      }
      fileByPath.set(file.targetPath, file);
      if (
        file.evidence.targetPath !== file.targetPath ||
        file.evidence.sha256 !== file.sha256
      ) {
        context.addIssue({
          code: "custom",
          message: "semantic file evidence must identify the same path and bytes",
          path: ["files", index, "evidence"],
        });
      }
      const expectedParseStatus =
        analysis.status === "failed"
          ? "not_analyzed"
          : file.syntaxDiagnosticCount === 0
            ? "parsed"
            : "syntax_errors";
      if (
        file.syntaxDiagnosticCount < file.diagnostics.length ||
        file.diagnosticsTruncated !==
          (file.syntaxDiagnosticCount > file.diagnostics.length) ||
        file.parseStatus !== expectedParseStatus
      ) {
        context.addIssue({
          code: "custom",
          message: "semantic file parse status must exactly reflect diagnostics",
          path: ["files", index],
        });
      }
    }

    const inputBytes = analysis.files.reduce(
      (total, file) => total + file.sizeBytes,
      0,
    );
    const filesWithSyntaxErrors = analysis.files.filter(
      (file) => file.parseStatus === "syntax_errors",
    ).length;
    const retainedDiagnostics = analysis.files.reduce(
      (total, file) => total + file.diagnostics.length,
      0,
    );
    if (
      analysis.coverage.inputFiles !== analysis.files.length ||
      analysis.coverage.inputBytes !== inputBytes ||
      analysis.coverage.parsedFiles !==
        analysis.files.filter((file) => file.parseStatus !== "not_analyzed").length ||
      analysis.coverage.filesWithSyntaxErrors !== filesWithSyntaxErrors
    ) {
      context.addIssue({
        code: "custom",
        message: "semantic coverage must exactly reflect retained input files",
        path: ["coverage"],
      });
    }
    if (
      retainedDiagnostics > analysis.limits.maxDiagnostics ||
      analysis.files.some((file) => file.diagnosticsTruncated) !==
        analysis.truncations.includes("diagnostics")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "semantic diagnostic retention and truncation must match the recorded limit",
        path: ["files"],
      });
    }

    const callsiteIds = new Set<string>();
    for (const [index, callsite] of analysis.callsites.entries()) {
      if (callsiteIds.has(callsite.callsiteId)) {
        context.addIssue({
          code: "custom",
          message: "semantic callsite IDs must be unique",
          path: ["callsites", index, "callsiteId"],
        });
      }
      callsiteIds.add(callsite.callsiteId);
      const catalogSink = NODE_SEMANTIC_SINK_BY_ID.get(callsite.sinkId);
      if (
        catalogSink === undefined ||
        catalogSink.capability !== callsite.capability ||
        catalogSink.module !== callsite.api.module ||
        catalogSink.member !== callsite.api.member ||
        catalogSink.operation !== callsite.operation
      ) {
        context.addIssue({
          code: "custom",
          message: "semantic callsites must exactly match the trusted sink catalog",
          path: ["callsites", index, "sinkId"],
        });
      }
      const expectedCallsiteId = `semantic-callsite-${sha256(
        [
          "forge.node-semantic-callsite/v1",
          callsite.evidence.targetPath,
          callsite.evidence.sha256,
          String(callsite.span.start),
          String(callsite.span.end),
          callsite.sinkId,
          callsite.operation,
          callsite.capability,
        ].join("\0"),
      ).slice(0, 32)}`;
      if (
        callsite.callsiteId !== expectedCallsiteId ||
        callsite.evidence.line === undefined ||
        callsite.evidence.column === undefined
      ) {
        context.addIssue({
          code: "custom",
          message:
            "semantic callsite identity and exact source location must be content-derived",
          path: ["callsites", index, "callsiteId"],
        });
      }
      if (callsite.aliasDepth > analysis.limits.maxAliasDepth) {
        context.addIssue({
          code: "custom",
          message: "semantic alias depth exceeds the recorded controller limit",
          path: ["callsites", index, "aliasDepth"],
        });
      }
      const source = fileByPath.get(callsite.evidence.targetPath);
      if (
        source === undefined ||
        source.sha256 !== callsite.evidence.sha256 ||
        source.evidence.artifactPath !== callsite.evidence.artifactPath ||
        callsite.span.end > source.sizeBytes
      ) {
        context.addIssue({
          code: "custom",
          message: "semantic callsite evidence must resolve to one retained input file",
          path: ["callsites", index, "evidence"],
        });
      }
      for (const [pathIndex, reference] of callsite.callPath.entries()) {
        const pathSource = fileByPath.get(reference.targetPath);
        if (
          pathSource === undefined ||
          pathSource.sha256 !== reference.sha256 ||
          pathSource.evidence.artifactPath !== reference.artifactPath
        ) {
          context.addIssue({
            code: "custom",
            message: "semantic call paths must resolve to retained input files",
            path: ["callsites", index, "callPath", pathIndex],
          });
        }
      }
      if (callsite.callPath.length !== 0) {
        context.addIssue({
          code: "custom",
          message: "semantic call-path evidence must match handler reachability",
          path: ["callsites", index, "callPath"],
        });
      }
    }

    if (analysis.callsites.length > analysis.limits.maxCallsites) {
      context.addIssue({
        code: "custom",
        message: "semantic callsites exceed the recorded controller limit",
        path: ["callsites"],
      });
    }
    if (
      analysis.coverage.astNodesVisited > analysis.limits.maxAstNodes ||
      analysis.coverage.callExpressionsVisited >
        analysis.coverage.astNodesVisited ||
      analysis.coverage.localCallGraphEdges > analysis.limits.maxCallGraphEdges ||
      analysis.coverage.moduleResolutionsAttempted >
        analysis.limits.maxModuleResolutions ||
      analysis.coverage.moduleResolutionsUnresolved >
        analysis.coverage.moduleResolutionsAttempted ||
      (analysis.status !== "failed" &&
        (analysis.coverage.inputFiles > analysis.limits.maxInputFiles ||
          analysis.coverage.inputBytes > analysis.limits.maxInputBytes))
    ) {
      context.addIssue({
        code: "custom",
        message: "semantic coverage counters exceed recorded controller limits",
        path: ["coverage"],
      });
    }
    if (new Set(analysis.truncations).size !== analysis.truncations.length) {
      context.addIssue({
        code: "custom",
        message: "semantic truncation dimensions must be unique",
        path: ["truncations"],
      });
    }
    if (
      (analysis.status !== "failed" && analysis.failure !== undefined) ||
      (analysis.status === "failed" && analysis.failure === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "semantic failure evidence must exactly match analysis status",
        path: ["failure"],
      });
    }
    if (analysis.status === "failed" && analysis.callsites.length !== 0) {
      context.addIssue({
        code: "custom",
        message: "a failed semantic worker cannot publish callsite evidence",
        path: ["callsites"],
      });
    }
    const incomplete =
      analysis.coverage.filesWithSyntaxErrors > 0 ||
      analysis.coverage.resolutionIncomplete ||
      analysis.truncations.length > 0;
    if (
      (analysis.status === "completed" && incomplete) ||
      (analysis.status === "partial" && !incomplete)
    ) {
      context.addIssue({
        code: "custom",
        message: "semantic partial status must exactly reflect incomplete coverage",
        path: ["status"],
      });
    }
  });

export const nodeSemanticReportSummaryV1Schema = z
  .object({
    status: z.enum(["completed", "partial", "failed"]),
    artifactPath: relativeTargetPathSchema,
    artifactSha256: sha256Schema,
    analyzer: z
      .object({
        engine: z.literal("typescript-compiler-api"),
        package: z.literal("typescript-semantic"),
        version: z.string().min(1),
        catalogVersion: z.literal(NODE_SEMANTIC_CATALOG_VERSION),
      })
      .strict(),
    sourceSetSha256: sha256Schema,
    coverage: semanticCoverageSchema,
    callsiteCount: z.number().int().nonnegative(),
    capabilityCallsites: z.array(
      z
        .object({
          capability: staticCapabilitySchema,
          count: z.number().int().positive(),
        })
        .strict(),
    ),
    handlerReachability: z
      .object({
        directHandler: z.literal(0),
        boundedCallPath: z.literal(0),
        notIdentified: z.literal(0),
        notAssessed: z.number().int().nonnegative(),
      })
      .strict(),
    truncations: z.array(semanticTruncationSchema),
    failure: semanticFailureSchema.optional(),
    limitations: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((summary, context) => {
    const capabilities = summary.capabilityCallsites.map(
      (entry) => entry.capability,
    );
    const count = summary.capabilityCallsites.reduce(
      (total, entry) => total + entry.count,
      0,
    );
    const reachabilityCount = Object.values(summary.handlerReachability).reduce(
      (total, value) => total + value,
      0,
    );
    if (
      new Set(capabilities).size !== capabilities.length ||
      count !== summary.callsiteCount ||
      reachabilityCount !== summary.callsiteCount
    ) {
      context.addIssue({
        code: "custom",
        message: "semantic report counts must form exact unique partitions",
        path: ["callsiteCount"],
      });
    }
    if (
      (summary.status !== "failed" && summary.failure !== undefined) ||
      (summary.status === "failed" && summary.failure === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "semantic report failure must exactly match status",
        path: ["failure"],
      });
    }
    if (new Set(summary.truncations).size !== summary.truncations.length) {
      context.addIssue({
        code: "custom",
        message: "semantic report truncation dimensions must be unique",
        path: ["truncations"],
      });
    }
    if (
      summary.coverage.parsedFiles > summary.coverage.inputFiles ||
      summary.coverage.filesWithSyntaxErrors > summary.coverage.parsedFiles ||
      summary.coverage.callExpressionsVisited >
        summary.coverage.astNodesVisited ||
      summary.coverage.moduleResolutionsUnresolved >
        summary.coverage.moduleResolutionsAttempted
    ) {
      context.addIssue({
        code: "custom",
        message: "semantic report coverage counters are internally inconsistent",
        path: ["coverage"],
      });
    }
    if (summary.status === "failed" && summary.callsiteCount !== 0) {
      context.addIssue({
        code: "custom",
        message: "a failed semantic summary cannot publish callsite counts",
        path: ["callsiteCount"],
      });
    }
    const incomplete =
      summary.coverage.filesWithSyntaxErrors > 0 ||
      summary.coverage.resolutionIncomplete ||
      summary.truncations.length > 0;
    if (
      (summary.status === "completed" && incomplete) ||
      (summary.status === "partial" && !incomplete)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "semantic report partial status must exactly reflect incomplete coverage",
        path: ["status"],
      });
    }
  });

export type NodeSemanticLimitsV1 = z.infer<typeof nodeSemanticLimitsV1Schema>;
export type NodeSemanticStaticV1 = z.infer<typeof nodeSemanticStaticV1Schema>;
export type NodeSemanticReportSummaryV1 = z.infer<
  typeof nodeSemanticReportSummaryV1Schema
>;
