import { z } from "zod";

import {
  addDuplicateIssues,
  boundedJsonValueV2Schema,
  descriptionV2Schema,
  identifierV2Schema,
  jsonPointerV2Schema,
  positiveSafeIntegerV2Schema,
  sha256V2Schema,
  shortTextV2Schema,
  timestampV2Schema,
  toolNameV2Schema,
} from "./common.js";
import {
  approvalClassV2Schema,
  capabilityActionV2Schema,
  caseOriginV2Schema,
  lifecyclePhaseV2Schema,
  resourceClassV2Schema,
  sensorV2Schema,
} from "./vocabulary.js";

export const policySubjectV2Schema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("exact_target"),
      targetId: identifierV2Schema,
      targetIdentityDigest: sha256V2Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reusable_class"),
      classId: identifierV2Schema,
      description: descriptionV2Schema,
    })
    .strict(),
]);

const ruleLimitsV2Schema = z
  .object({
    maxOperations: positiveSafeIntegerV2Schema,
    maxBytes: positiveSafeIntegerV2Schema,
    maxRuntimeMs: positiveSafeIntegerV2Schema,
  })
  .strict();

export const subjectBehaviorRuleV2Schema = z
  .object({
    ruleId: identifierV2Schema,
    decision: z.enum(["allow", "deny", "review_required"]),
    toolNames: z.array(toolNameV2Schema).min(1).max(256),
    actions: z.array(capabilityActionV2Schema).min(1).max(16),
    resourceClasses: z.array(resourceClassV2Schema).min(1).max(32),
    phases: z.array(lifecyclePhaseV2Schema).min(1).max(16),
    selectors: z.array(shortTextV2Schema).max(64),
    limits: ruleLimitsV2Schema,
    rationale: descriptionV2Schema,
  })
  .strict();

export const subjectBehaviorRulesV2Schema = z
  .object({
    defaultDecision: z.enum(["deny", "review_required"]),
    rules: z.array(subjectBehaviorRuleV2Schema).max(512),
  })
  .strict()
  .superRefine((rules, ctx) => {
    addDuplicateIssues(
      rules.rules,
      (rule) => rule.ruleId,
      ctx,
      ["rules"],
      "subject behavior ruleId",
    );
  });

const exactArgumentRuleV2Schema = z
  .object({
    jsonPointer: jsonPointerV2Schema,
    operator: z.literal("equals"),
    value: boundedJsonValueV2Schema,
  })
  .strict();

const prefixArgumentRuleV2Schema = z
  .object({
    jsonPointer: jsonPointerV2Schema,
    operator: z.literal("string_prefix"),
    prefix: shortTextV2Schema,
  })
  .strict();

const oneOfArgumentRuleV2Schema = z
  .object({
    jsonPointer: jsonPointerV2Schema,
    operator: z.literal("one_of"),
    values: z.array(boundedJsonValueV2Schema).min(1).max(64),
  })
  .strict();

export const dispatchArgumentRuleV2Schema = z.discriminatedUnion("operator", [
  exactArgumentRuleV2Schema,
  prefixArgumentRuleV2Schema,
  oneOfArgumentRuleV2Schema,
]);

export const allowedDataFlowV2Schema = z
  .object({
    source: resourceClassV2Schema,
    sinkAction: capabilityActionV2Schema,
    sink: resourceClassV2Schema,
  })
  .strict();

export const dispatchRuleLimitsV2Schema = z
  .object({
    maxCases: positiveSafeIntegerV2Schema,
    maxStepsPerCase: positiveSafeIntegerV2Schema,
    maxSteps: positiveSafeIntegerV2Schema,
    maxArgumentBytes: positiveSafeIntegerV2Schema,
    maxRuntimeMs: positiveSafeIntegerV2Schema,
    maxTotalRuntimeMs: positiveSafeIntegerV2Schema,
    maxOutputBytesPerStep: positiveSafeIntegerV2Schema,
    maxTotalOutputBytes: positiveSafeIntegerV2Schema,
    maxWritableBytes: positiveSafeIntegerV2Schema,
    maxWritableFiles: positiveSafeIntegerV2Schema,
    maxFileBytes: positiveSafeIntegerV2Schema,
    maxProcesses: positiveSafeIntegerV2Schema,
    maxMemoryMb: positiveSafeIntegerV2Schema,
    maxCpuMs: positiveSafeIntegerV2Schema,
    maxOpenFiles: positiveSafeIntegerV2Schema,
  })
  .strict()
  .superRefine((limits, ctx) => {
    for (const [smaller, larger] of [
      ["maxStepsPerCase", "maxSteps"],
      ["maxRuntimeMs", "maxTotalRuntimeMs"],
      ["maxOutputBytesPerStep", "maxTotalOutputBytes"],
      ["maxFileBytes", "maxWritableBytes"],
    ] as const) {
      if (limits[smaller] > limits[larger]) {
        ctx.addIssue({
          code: "custom",
          message: `${smaller} must not exceed ${larger}`,
          path: [smaller],
        });
      }
    }
  });

export const experimentDispatchRuleV2Schema = z
  .object({
    ruleId: identifierV2Schema,
    decision: z.enum(["allow", "deny", "approval_required"]),
    toolNames: z.array(toolNameV2Schema).min(1).max(256),
    allowedOrigins: z.array(caseOriginV2Schema).min(1).max(16),
    argumentRules: z.array(dispatchArgumentRuleV2Schema).max(64),
    allowedResourceClasses: z.array(resourceClassV2Schema).min(1).max(32),
    allowedDataFlows: z.array(allowedDataFlowV2Schema).max(64),
    limits: dispatchRuleLimitsV2Schema,
    minimumApprovalClass: approvalClassV2Schema,
    rationale: descriptionV2Schema,
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (
      rule.decision === "approval_required" &&
      rule.minimumApprovalClass === "automatic"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "approval_required rules require operator_review or security_review",
        path: ["minimumApprovalClass"],
      });
    }
    if (
      rule.decision !== "approval_required" &&
      rule.minimumApprovalClass !== "automatic"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "allow and deny rules use the automatic approval class",
        path: ["minimumApprovalClass"],
      });
    }
    addDuplicateIssues(
      rule.toolNames,
      (name) => name,
      ctx,
      ["toolNames"],
      "tool name",
    );
    addDuplicateIssues(
      rule.allowedOrigins,
      (origin) => origin,
      ctx,
      ["allowedOrigins"],
      "allowed origin",
    );
    addDuplicateIssues(
      rule.allowedResourceClasses,
      (resourceClass) => resourceClass,
      ctx,
      ["allowedResourceClasses"],
      "allowed resource class",
    );
  });

export const experimentDispatchRulesV2Schema = z
  .object({
    defaultDecision: z.literal("deny"),
    rules: z.array(experimentDispatchRuleV2Schema).max(512),
  })
  .strict()
  .superRefine((rules, ctx) => {
    addDuplicateIssues(
      rules.rules,
      (rule) => rule.ruleId,
      ctx,
      ["rules"],
      "experiment dispatch ruleId",
    );
  });

export const minimumCoverageV2Schema = z
  .object({
    minimumToolCoveragePercent: z.number().int().min(0).max(100),
    requiredPartitions: z
      .array(
        z.enum([
          "nominal",
          "boundary",
          "enum",
          "nullability",
          "required_missing",
          "malformed",
          "format_pattern",
          "size",
          "combination",
        ]),
      )
      .max(32),
    requiredPhases: z.array(lifecyclePhaseV2Schema).max(16),
    requiredSensors: z.array(sensorV2Schema).max(16),
  })
  .strict()
  .superRefine((coverage, ctx) => {
    addDuplicateIssues(
      coverage.requiredPartitions,
      (partition) => partition,
      ctx,
      ["requiredPartitions"],
      "required partition",
    );
    addDuplicateIssues(
      coverage.requiredPhases,
      (phase) => phase,
      ctx,
      ["requiredPhases"],
      "required phase",
    );
    addDuplicateIssues(
      coverage.requiredSensors,
      (sensor) => sensor,
      ctx,
      ["requiredSensors"],
      "required sensor",
    );
  });

export const approvedPolicyV2Schema = z
  .object({
    schema: z.literal("forge.audit-policy/v2"),
    policyId: identifierV2Schema,
    version: shortTextV2Schema,
    owner: shortTextV2Schema,
    createdAt: timestampV2Schema,
    reviewedAt: timestampV2Schema,
    expiresAt: timestampV2Schema.optional(),
    subject: policySubjectV2Schema,
    subjectBehaviorRules: subjectBehaviorRulesV2Schema,
    experimentDispatchRules: experimentDispatchRulesV2Schema,
    requiredMandatoryCaseIds: z.array(identifierV2Schema).max(256),
    minimumCoverage: minimumCoverageV2Schema,
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (Date.parse(policy.reviewedAt) < Date.parse(policy.createdAt)) {
      ctx.addIssue({
        code: "custom",
        message: "reviewedAt must not precede createdAt",
        path: ["reviewedAt"],
      });
    }
    if (
      policy.expiresAt !== undefined &&
      Date.parse(policy.expiresAt) <= Date.parse(policy.reviewedAt)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "expiresAt must follow reviewedAt",
        path: ["expiresAt"],
      });
    }
    addDuplicateIssues(
      policy.requiredMandatoryCaseIds,
      (caseId) => caseId,
      ctx,
      ["requiredMandatoryCaseIds"],
      "required mandatory caseId",
    );
  });

export type PolicySubjectV2 = z.infer<typeof policySubjectV2Schema>;
export type SubjectBehaviorRuleV2 = z.infer<typeof subjectBehaviorRuleV2Schema>;
export type SubjectBehaviorRulesV2 = z.infer<typeof subjectBehaviorRulesV2Schema>;
export type DispatchArgumentRuleV2 = z.infer<typeof dispatchArgumentRuleV2Schema>;
export type AllowedDataFlowV2 = z.infer<typeof allowedDataFlowV2Schema>;
export type DispatchRuleLimitsV2 = z.infer<typeof dispatchRuleLimitsV2Schema>;
export type ExperimentDispatchRuleV2 = z.infer<
  typeof experimentDispatchRuleV2Schema
>;
export type ExperimentDispatchRulesV2 = z.infer<
  typeof experimentDispatchRulesV2Schema
>;
export type MinimumCoverageV2 = z.infer<typeof minimumCoverageV2Schema>;
export type ApprovedPolicyV2 = z.infer<typeof approvedPolicyV2Schema>;
