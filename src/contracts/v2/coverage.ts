import { z } from "zod";

import { targetIdentityV2Schema } from "./artifact-reference.js";
import { catalogIdentityV2Schema } from "./catalog.js";
import {
  addDuplicateIssues,
  descriptionV2Schema,
  identifierV2Schema,
  jsonPointerV2Schema,
  nonnegativeSafeIntegerV2Schema,
  sha256V2Schema,
  shortTextV2Schema,
  timestampV2Schema,
  toolNameV2Schema,
} from "./common.js";
import {
  coverageStatusV2Schema,
  lifecyclePhaseV2Schema,
  sensorV2Schema,
} from "./vocabulary.js";

export const inputPartitionV2Schema = z.enum([
  "nominal",
  "boundary",
  "enum",
  "nullability",
  "required_missing",
  "malformed",
  "format_pattern",
  "size",
  "combination",
]);

export const schemaPartitionCoverageV2Schema = z
  .object({
    toolName: toolNameV2Schema,
    jsonPointer: jsonPointerV2Schema,
    partition: inputPartitionV2Schema,
    status: coverageStatusV2Schema,
    caseIds: z.array(identifierV2Schema).max(1_024),
  })
  .strict()
  .superRefine((coverage, ctx) => {
    addDuplicateIssues(
      coverage.caseIds,
      (caseId) => caseId,
      ctx,
      ["caseIds"],
      "schema partition caseId",
    );
    if (coverage.status === "covered" && coverage.caseIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "covered schema partitions must identify at least one caseId",
        path: ["caseIds"],
      });
    }
  });

export const workflowEdgeCoverageV2Schema = z
  .object({
    edgeId: identifierV2Schema,
    producerToolName: toolNameV2Schema,
    consumerToolName: toolNameV2Schema,
    bindingPointer: jsonPointerV2Schema,
    status: coverageStatusV2Schema,
    caseIds: z.array(identifierV2Schema).max(1_024),
  })
  .strict()
  .superRefine((coverage, ctx) => {
    addDuplicateIssues(
      coverage.caseIds,
      (caseId) => caseId,
      ctx,
      ["caseIds"],
      "workflow edge caseId",
    );
    if (coverage.status === "covered" && coverage.caseIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "covered workflow edges must identify at least one caseId",
        path: ["caseIds"],
      });
    }
  });

export const sensorCoverageV2Schema = z
  .object({
    sensor: sensorV2Schema,
    status: coverageStatusV2Schema,
    gaps: z.array(descriptionV2Schema).max(64),
  })
  .strict()
  .superRefine((coverage, ctx) => {
    if (coverage.status === "covered" && coverage.gaps.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "covered sensors must not report coverage gaps",
        path: ["gaps"],
      });
    }
    if (coverage.status !== "covered" && coverage.gaps.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "sensors that are not covered must explain at least one gap",
        path: ["gaps"],
      });
    }
  });

export const coverageCaseAccountingV2Schema = z
  .object({
    generated: nonnegativeSafeIntegerV2Schema,
    rejected: nonnegativeSafeIntegerV2Schema,
    skipped: nonnegativeSafeIntegerV2Schema,
    executed: z.literal(0),
    timedOut: z.literal(0),
    truncated: z.literal(0),
    inconclusive: z.literal(0),
  })
  .strict()
  .superRefine((accounting, ctx) => {
    if (
      accounting.rejected + accounting.skipped + accounting.executed !==
      accounting.generated
    ) {
      ctx.addIssue({
        code: "custom",
        message: "rejected + skipped + executed must equal generated",
      });
    }
  });

export const proposerCoverageV2Schema = z
  .object({ mode: z.literal("disabled") })
  .strict();

export const auditCoverageV2Schema = z
  .object({
    schema: z.literal("forge.audit-coverage/v2"),
    coverageId: identifierV2Schema,
    recordedAt: timestampV2Schema,
    execution: z
      .object({
        mode: z.literal("phase1_contract_compiler"),
        dispatched: z.literal(false),
      })
      .strict(),
    target: targetIdentityV2Schema,
    catalog: catalogIdentityV2Schema,
    experimentPlanDigest: sha256V2Schema,
    approvalReceiptDigest: sha256V2Schema,
    toolCoverage: z
      .object({
        discoveredToolNames: z.array(toolNameV2Schema).max(10_000),
        executedToolNames: z.array(toolNameV2Schema).length(0),
        catalogFreshness: z
          .object({
            status: z.literal("not_rechecked"),
          })
          .strict(),
      })
      .strict(),
    schemaCoverage: z
      .object({
        dialect: shortTextV2Schema,
        supportedKeywords: z.array(shortTextV2Schema).max(256),
        unsupportedKeywords: z.array(shortTextV2Schema).max(256),
        partitions: z.array(schemaPartitionCoverageV2Schema).max(10_000),
      })
      .strict(),
    workflowCoverage: z
      .object({
        attemptedEdges: z.array(workflowEdgeCoverageV2Schema).max(10_000),
        unsupportedBindings: z.array(descriptionV2Schema).max(256),
      })
      .strict(),
    phaseCoverage: z
      .array(
        z
          .object({
            phase: lifecyclePhaseV2Schema,
            status: coverageStatusV2Schema,
            observationWindowMs: nonnegativeSafeIntegerV2Schema.optional(),
          })
          .strict(),
      )
      .max(16),
    securityProbeCoverage: z
      .array(
        z
          .object({
            probeId: identifierV2Schema,
            status: coverageStatusV2Schema,
            caseIds: z.array(identifierV2Schema).max(1_024),
          })
          .strict()
          .superRefine((coverage, ctx) => {
            addDuplicateIssues(
              coverage.caseIds,
              (caseId) => caseId,
              ctx,
              ["caseIds"],
              "security probe caseId",
            );
            if (coverage.status === "covered" && coverage.caseIds.length === 0) {
              ctx.addIssue({
                code: "custom",
                message:
                  "covered security probes must identify at least one caseId",
                path: ["caseIds"],
              });
            }
          }),
      )
      .max(1_024),
    environmentVariantCoverage: z
      .array(
        z
          .object({
            variantId: identifierV2Schema,
            status: coverageStatusV2Schema,
            caseIds: z.array(identifierV2Schema).max(1_024),
          })
          .strict()
          .superRefine((coverage, ctx) => {
            addDuplicateIssues(
              coverage.caseIds,
              (caseId) => caseId,
              ctx,
              ["caseIds"],
              "environment variant caseId",
            );
            if (coverage.status === "covered" && coverage.caseIds.length === 0) {
              ctx.addIssue({
                code: "custom",
                message:
                  "covered environment variants must identify at least one caseId",
                path: ["caseIds"],
              });
            }
          }),
      )
      .max(256),
    sensorCoverage: z.array(sensorCoverageV2Schema).max(16),
    caseAccounting: coverageCaseAccountingV2Schema,
    budget: z
      .object({
        exhausted: z.boolean(),
        exhaustedDimensions: z
          .array(z.enum(["cases", "steps", "runtime", "output", "storage", "processes"]))
          .max(16),
        samplingStrategy: descriptionV2Schema,
      })
      .strict(),
    proposer: proposerCoverageV2Schema,
    limitations: z.array(descriptionV2Schema).max(256),
  })
  .strict()
  .superRefine((coverage, ctx) => {
    const toolCoverage = coverage.toolCoverage;
    addDuplicateIssues(
      coverage.schemaCoverage.supportedKeywords,
      (keyword) => keyword,
      ctx,
      ["schemaCoverage", "supportedKeywords"],
      "supported schema keyword",
    );
    addDuplicateIssues(
      coverage.schemaCoverage.unsupportedKeywords,
      (keyword) => keyword,
      ctx,
      ["schemaCoverage", "unsupportedKeywords"],
      "unsupported schema keyword",
    );
    const supportedKeywords = new Set(
      coverage.schemaCoverage.supportedKeywords,
    );
    coverage.schemaCoverage.unsupportedKeywords.forEach((keyword, index) => {
      if (supportedKeywords.has(keyword)) {
        ctx.addIssue({
          code: "custom",
          message: "schema keywords cannot be both supported and unsupported",
          path: ["schemaCoverage", "unsupportedKeywords", index],
        });
      }
    });
    addDuplicateIssues(
      coverage.schemaCoverage.partitions,
      (partition) =>
        `${partition.toolName}\u0000${partition.jsonPointer}\u0000${partition.partition}`,
      ctx,
      ["schemaCoverage", "partitions"],
      "schema partition",
    );
    addDuplicateIssues(
      toolCoverage.discoveredToolNames,
      (name) => name,
      ctx,
      ["toolCoverage", "discoveredToolNames"],
      "discovered tool name",
    );
    addDuplicateIssues(
      toolCoverage.executedToolNames,
      (name) => name,
      ctx,
      ["toolCoverage", "executedToolNames"],
      "executed tool name",
    );
    if (toolCoverage.discoveredToolNames.length !== coverage.catalog.toolCount) {
      ctx.addIssue({
        code: "custom",
        message: "discoveredToolNames must account for catalog.toolCount",
        path: ["toolCoverage", "discoveredToolNames"],
      });
    }
    const discovered = new Set(toolCoverage.discoveredToolNames);
    toolCoverage.executedToolNames.forEach((name, index) => {
      if (!discovered.has(name)) {
        ctx.addIssue({
          code: "custom",
          message: "executed tools must be present in the discovered catalog",
          path: ["toolCoverage", "executedToolNames", index],
        });
      }
    });
    addDuplicateIssues(
      coverage.workflowCoverage.attemptedEdges,
      (edge) => edge.edgeId,
      ctx,
      ["workflowCoverage", "attemptedEdges"],
      "workflow edgeId",
    );
    addDuplicateIssues(
      coverage.phaseCoverage,
      (phase) => phase.phase,
      ctx,
      ["phaseCoverage"],
      "lifecycle phase",
    );
    addDuplicateIssues(
      coverage.securityProbeCoverage,
      (probe) => probe.probeId,
      ctx,
      ["securityProbeCoverage"],
      "security probeId",
    );
    addDuplicateIssues(
      coverage.environmentVariantCoverage,
      (variant) => variant.variantId,
      ctx,
      ["environmentVariantCoverage"],
      "environment variantId",
    );
    addDuplicateIssues(
      coverage.sensorCoverage,
      (sensor) => sensor.sensor,
      ctx,
      ["sensorCoverage"],
      "sensor coverage",
    );
    addDuplicateIssues(
      coverage.budget.exhaustedDimensions,
      (dimension) => dimension,
      ctx,
      ["budget", "exhaustedDimensions"],
      "exhausted budget dimension",
    );
    const hasExhaustedDimensions =
      coverage.budget.exhaustedDimensions.length > 0;
    if (coverage.budget.exhausted !== hasExhaustedDimensions) {
      ctx.addIssue({
        code: "custom",
        message:
          "budget.exhausted must be true if and only if exhaustedDimensions is non-empty",
        path: ["budget", "exhausted"],
      });
    }
    const statusRows = [
      ...coverage.schemaCoverage.partitions,
      ...coverage.workflowCoverage.attemptedEdges,
      ...coverage.phaseCoverage,
      ...coverage.securityProbeCoverage,
      ...coverage.environmentVariantCoverage,
      ...coverage.sensorCoverage,
    ];
    if (statusRows.some((row) => row.status === "covered")) {
      ctx.addIssue({
        code: "custom",
        message: "Phase 1A cannot claim executed coverage",
      });
    }
  });

export const coverageRecordV2Schema = auditCoverageV2Schema;

export type InputPartitionV2 = z.infer<typeof inputPartitionV2Schema>;
export type SchemaPartitionCoverageV2 = z.infer<
  typeof schemaPartitionCoverageV2Schema
>;
export type WorkflowEdgeCoverageV2 = z.infer<
  typeof workflowEdgeCoverageV2Schema
>;
export type SensorCoverageV2 = z.infer<typeof sensorCoverageV2Schema>;
export type CoverageCaseAccountingV2 = z.infer<
  typeof coverageCaseAccountingV2Schema
>;
export type ProposerCoverageV2 = z.infer<typeof proposerCoverageV2Schema>;
export type AuditCoverageV2 = z.infer<typeof auditCoverageV2Schema>;
export type CoverageRecordV2 = AuditCoverageV2;
