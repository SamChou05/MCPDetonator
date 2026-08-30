import { z } from "zod";

import {
  executionBoundsV2Schema,
} from "./artifact-reference.js";
import {
  deterministicAssertionV2Schema,
  predictedEffectV2Schema,
} from "./case-components.js";
import {
  V2_CONTRACT_LIMITS,
  addDuplicateIssues,
  boundedJsonValueV2Schema,
  componentIdentityV2Schema,
  descriptionV2Schema,
  identifierV2Schema,
  positiveSafeIntegerV2Schema,
  sha256V2Schema,
  timestampV2Schema,
  toolNameV2Schema,
} from "./common.js";
import {
  syntheticResourceDefinitionV2Schema,
  syntheticResourceReferenceV2Schema,
} from "./synthetic-resources.js";
import {
  approvalClassV2Schema,
  caseKindV2Schema,
  sensorV2Schema,
} from "./vocabulary.js";

function validateReservedCandidateReferences(
  value: unknown,
  ctx: z.RefinementCtx,
): void {
  const stack: Array<{ value: unknown; path: PropertyKey[] }> = [
    { value, path: [] },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((entry, index) => {
        stack.push({ value: entry, path: [...current.path, index] });
      });
      continue;
    }
    if (current.value === null || typeof current.value !== "object") {
      continue;
    }
    const object = current.value as Record<string, unknown>;
    const keys = Object.keys(object);
    const reservedKeys = keys.filter((key) => key.startsWith("$forge"));
    if (reservedKeys.length > 0) {
      const parsedReference = syntheticResourceReferenceV2Schema.safeParse(object);
      if (!parsedReference.success) {
        ctx.addIssue({
          code: "custom",
          message:
            "the only candidate argument reference is an exact {$forgeResource: alias} object",
          path: current.path,
        });
      }
      continue;
    }
    for (const [key, child] of Object.entries(object)) {
      stack.push({ value: child, path: [...current.path, key] });
    }
  }
}

export const auditSpecArgumentV2Schema = boundedJsonValueV2Schema.superRefine(
  validateReservedCandidateReferences,
);

export const targetSelectorV2Schema = z
  .object({
    targetId: identifierV2Schema,
    sourceArtifactSha256: sha256V2Schema,
  })
  .strict();

export const prePlanRequirementsV2Schema = z
  .object({
    acquisition: z.literal("required"),
    scriptsDisabledPreparation: z.literal("required"),
    lifecycleComparison: z.enum(["required", "when_supported"]),
    initializationObservation: z.literal("required"),
    completeCatalogDiscovery: z.literal("required"),
    cleanupVerification: z.literal("required"),
  })
  .strict();

export const prePlanBoundsV2Schema = z
  .object({
    maxRuntimeMs: positiveSafeIntegerV2Schema,
    maxArtifactBytes: positiveSafeIntegerV2Schema,
    maxCatalogPages: positiveSafeIntegerV2Schema.max(1_000),
    maxCatalogTools: positiveSafeIntegerV2Schema.max(10_000),
    maxCatalogBytes: positiveSafeIntegerV2Schema,
  })
  .strict();

export const manualPlanStepV2Schema = z
  .object({
    stepId: identifierV2Schema,
    toolName: toolNameV2Schema,
    arguments: auditSpecArgumentV2Schema,
  })
  .strict();

export const manualAuditCaseV2Schema = z
  .object({
    caseId: identifierV2Schema,
    kind: caseKindV2Schema,
    description: descriptionV2Schema,
    steps: z.array(manualPlanStepV2Schema).min(1).max(64),
    predictedEffects: z.array(predictedEffectV2Schema).min(1).max(128),
    assertions: z.array(deterministicAssertionV2Schema).min(1).max(128),
    minimumApprovalClass: approvalClassV2Schema,
  })
  .strict()
  .superRefine((auditCase, ctx) => {
    addDuplicateIssues(
      auditCase.steps,
      (step) => step.stepId,
      ctx,
      ["steps"],
      "stepId",
    );
    addDuplicateIssues(
      auditCase.predictedEffects,
      (effect) => effect.predictionId,
      ctx,
      ["predictedEffects"],
      "predictionId",
    );
    addDuplicateIssues(
      auditCase.assertions,
      (assertion) => assertion.assertionId,
      ctx,
      ["assertions"],
      "assertionId",
    );
  });

// Both trusted mandatory generators and operator-authored manual cases use the
// same origin-free template. The compiler assigns origin and repetition; the
// untrusted template cannot do so itself.
export const auditCaseTemplateV2Schema = manualAuditCaseV2Schema;
export const mandatoryCaseTemplateV2Schema = auditCaseTemplateV2Schema;

export const auditSpecV2Schema = z
  .object({
    schema: z.literal("forge.audit-spec/v2"),
    specId: identifierV2Schema,
    createdAt: timestampV2Schema,
    targetSelector: targetSelectorV2Schema,
    policyDigest: sha256V2Schema,
    claimProfileDigest: sha256V2Schema,
    mandatorySuiteDigest: sha256V2Schema,
    generator: componentIdentityV2Schema,
    agentProposals: z.literal("disabled"),
    repetitions: positiveSafeIntegerV2Schema.max(64),
    environmentVariants: z.array(identifierV2Schema).min(1).max(32),
    prePlanRequirements: prePlanRequirementsV2Schema,
    prePlanBounds: prePlanBoundsV2Schema,
    executionBounds: executionBoundsV2Schema,
    mandatoryCaseReservation: positiveSafeIntegerV2Schema.max(
      V2_CONTRACT_LIMITS.arrayItems,
    ),
    requiredSensors: z.array(sensorV2Schema).min(1).max(16),
    unsupportedCaseHandling: z.enum(["reject", "record_inconclusive"]),
    syntheticResources: z
      .array(syntheticResourceDefinitionV2Schema)
      .max(V2_CONTRACT_LIMITS.arrayItems),
    manualCases: z.array(manualAuditCaseV2Schema).max(V2_CONTRACT_LIMITS.arrayItems),
  })
  .strict()
  .superRefine((spec, ctx) => {
    addDuplicateIssues(
      spec.environmentVariants,
      (variant) => variant,
      ctx,
      ["environmentVariants"],
      "environment variant",
    );
    addDuplicateIssues(
      spec.requiredSensors,
      (sensor) => sensor,
      ctx,
      ["requiredSensors"],
      "required sensor",
    );
    addDuplicateIssues(
      spec.syntheticResources,
      (resource) => resource.alias,
      ctx,
      ["syntheticResources"],
      "synthetic resource alias",
    );
    addDuplicateIssues(
      spec.manualCases,
      (auditCase) => auditCase.caseId,
      ctx,
      ["manualCases"],
      "manual caseId",
    );
    if (spec.mandatoryCaseReservation > spec.executionBounds.maxCases) {
      ctx.addIssue({
        code: "custom",
        message: "mandatoryCaseReservation exceeds executionBounds.maxCases",
        path: ["mandatoryCaseReservation"],
      });
    }
    const expandedManualCases =
      spec.manualCases.length *
      spec.repetitions *
      spec.environmentVariants.length;
    if (
      spec.mandatoryCaseReservation + expandedManualCases >
      spec.executionBounds.maxCases
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "mandatory reservation plus repeated manual cases exceeds executionBounds.maxCases",
        path: ["manualCases"],
      });
    }
    if (
      spec.mandatoryCaseReservation + expandedManualCases >
      V2_CONTRACT_LIMITS.arrayItems
    ) {
      ctx.addIssue({
        code: "custom",
        message: `expanded cases exceed the V2 plan limit of ${V2_CONTRACT_LIMITS.arrayItems}`,
        path: ["manualCases"],
      });
    }
  });

export type AuditSpecArgumentV2 = z.infer<typeof auditSpecArgumentV2Schema>;
export type TargetSelectorV2 = z.infer<typeof targetSelectorV2Schema>;
export type PrePlanRequirementsV2 = z.infer<typeof prePlanRequirementsV2Schema>;
export type PrePlanBoundsV2 = z.infer<typeof prePlanBoundsV2Schema>;
export type ManualPlanStepV2 = z.infer<typeof manualPlanStepV2Schema>;
export type AuditCaseTemplateV2 = z.infer<typeof auditCaseTemplateV2Schema>;
export type MandatoryCaseTemplateV2 = z.infer<
  typeof mandatoryCaseTemplateV2Schema
>;
export type ManualAuditCaseV2 = z.infer<typeof manualAuditCaseV2Schema>;
export type AuditSpecV2 = z.infer<typeof auditSpecV2Schema>;
