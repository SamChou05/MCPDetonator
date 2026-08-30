import { z } from "zod";

import {
  executionBoundsV2Schema,
  targetIdentityV2Schema,
} from "./artifact-reference.js";
import { catalogIdentityV2Schema } from "./catalog.js";
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
import { syntheticResourceManifestV2Schema } from "./synthetic-resources.js";
import { minimumCoverageV2Schema } from "./policy.js";
import {
  APPROVAL_CLASS_RANK,
  approvalClassV2Schema,
  caseOriginV2Schema,
  sensorV2Schema,
} from "./vocabulary.js";

export const experimentPlanStepV2Schema = z
  .object({
    stepId: identifierV2Schema,
    toolName: toolNameV2Schema,
    arguments: boundedJsonValueV2Schema,
    argumentSha256: sha256V2Schema,
  })
  .strict();

const executableExperimentCaseKindV2Schema = z.enum([
  "tool_call",
  "security_probe",
]);

export const experimentPlanCaseV2Schema = z
  .object({
    caseId: identifierV2Schema,
    origin: caseOriginV2Schema,
    kind: executableExperimentCaseKindV2Schema,
    repetition: positiveSafeIntegerV2Schema.max(64),
    environmentVariant: identifierV2Schema,
    description: descriptionV2Schema,
    steps: z.array(experimentPlanStepV2Schema).min(1).max(64),
    predictedEffects: z.array(predictedEffectV2Schema).min(1).max(128),
    assertions: z.array(deterministicAssertionV2Schema).min(1).max(128),
    requiredApprovalClass: approvalClassV2Schema,
  })
  .strict()
  .superRefine((experimentCase, ctx) => {
    if (experimentCase.kind === "tool_call" && experimentCase.steps.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Phase 1A tool_call cases contain exactly one step",
        path: ["steps"],
      });
    }
    addDuplicateIssues(
      experimentCase.steps,
      (step) => step.stepId,
      ctx,
      ["steps"],
      "stepId",
    );
    addDuplicateIssues(
      experimentCase.predictedEffects,
      (prediction) => prediction.predictionId,
      ctx,
      ["predictedEffects"],
      "predictionId",
    );
    addDuplicateIssues(
      experimentCase.assertions,
      (assertion) => assertion.assertionId,
      ctx,
      ["assertions"],
      "assertionId",
    );
  });

export const caseBudgetReservationV2Schema = z
  .object({
    mandatory: positiveSafeIntegerV2Schema,
    manual: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    total: positiveSafeIntegerV2Schema,
  })
  .strict()
  .refine((reservation) => reservation.total === reservation.mandatory + reservation.manual, {
    message: "total must equal mandatory plus manual",
    path: ["total"],
  });

export const experimentPlanV2Schema = z
  .object({
    schema: z.literal("forge.experiment-plan/v2"),
    planId: identifierV2Schema,
    compiledAt: timestampV2Schema,
    compiler: componentIdentityV2Schema,
    policyExpiresAt: timestampV2Schema.optional(),
    target: targetIdentityV2Schema,
    catalog: catalogIdentityV2Schema,
    claimProfileDigest: sha256V2Schema,
    policyDigest: sha256V2Schema,
    auditSpecDigest: sha256V2Schema,
    syntheticResourceManifest: syntheticResourceManifestV2Schema,
    syntheticResourceManifestDigest: sha256V2Schema,
    caseBudgetReservation: caseBudgetReservationV2Schema,
    bounds: executionBoundsV2Schema,
    requiredSensors: z.array(sensorV2Schema).min(1).max(16),
    unsupportedSensors: z.array(sensorV2Schema).max(16),
    coverageRequirements: minimumCoverageV2Schema,
    cases: z.array(experimentPlanCaseV2Schema).min(1).max(V2_CONTRACT_LIMITS.arrayItems),
    requiredApprovalClass: approvalClassV2Schema,
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (
      plan.policyExpiresAt !== undefined &&
      Date.parse(plan.policyExpiresAt) <= Date.parse(plan.compiledAt)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "policyExpiresAt must follow compiledAt",
        path: ["policyExpiresAt"],
      });
    }
    addDuplicateIssues(
      plan.cases,
      (experimentCase) => experimentCase.caseId,
      ctx,
      ["cases"],
      "caseId",
    );
    addDuplicateIssues(
      plan.requiredSensors,
      (sensor) => sensor,
      ctx,
      ["requiredSensors"],
      "required sensor",
    );
    addDuplicateIssues(
      plan.unsupportedSensors,
      (sensor) => sensor,
      ctx,
      ["unsupportedSensors"],
      "unsupported sensor",
    );
    const required = new Set(plan.requiredSensors);
    plan.unsupportedSensors.forEach((sensor, index) => {
      if (required.has(sensor)) {
        ctx.addIssue({
          code: "custom",
          message: "a sensor cannot be both required and unsupported",
          path: ["unsupportedSensors", index],
        });
      }
    });

    const mandatoryCount = plan.cases.filter(
      (experimentCase) => experimentCase.origin === "mandatory",
    ).length;
    if (mandatoryCount !== plan.caseBudgetReservation.mandatory) {
      ctx.addIssue({
        code: "custom",
        message: "mandatory reservation must equal the number of mandatory cases",
        path: ["caseBudgetReservation", "mandatory"],
      });
    }
    if (plan.cases.length - mandatoryCount !== plan.caseBudgetReservation.manual) {
      ctx.addIssue({
        code: "custom",
        message: "manual reservation must equal all non-mandatory Phase 1 cases",
        path: ["caseBudgetReservation", "manual"],
      });
    }
    if (plan.cases.length !== plan.caseBudgetReservation.total) {
      ctx.addIssue({
        code: "custom",
        message: "total reservation must equal cases.length",
        path: ["caseBudgetReservation", "total"],
      });
    }
    if (plan.cases.length > plan.bounds.maxCases) {
      ctx.addIssue({
        code: "custom",
        message: "cases exceed bounds.maxCases",
        path: ["cases"],
      });
    }
    let totalSteps = 0;
    plan.cases.forEach((experimentCase, caseIndex) => {
      totalSteps += experimentCase.steps.length;
      if (experimentCase.steps.length > plan.bounds.maxStepsPerCase) {
        ctx.addIssue({
          code: "custom",
          message: "case steps exceed bounds.maxStepsPerCase",
          path: ["cases", caseIndex, "steps"],
        });
      }
    });
    if (totalSteps > plan.bounds.maxTotalSteps) {
      ctx.addIssue({
        code: "custom",
        message: "plan steps exceed bounds.maxTotalSteps",
        path: ["cases"],
      });
    }

    const requiredRank = plan.cases.reduce(
      (rank, experimentCase) =>
        Math.max(rank, APPROVAL_CLASS_RANK[experimentCase.requiredApprovalClass]),
      0,
    );
    if (APPROVAL_CLASS_RANK[plan.requiredApprovalClass] !== requiredRank) {
      ctx.addIssue({
        code: "custom",
        message: "requiredApprovalClass must equal the strictest case requirement",
        path: ["requiredApprovalClass"],
      });
    }
  });

export type ExperimentPlanStepV2 = z.infer<typeof experimentPlanStepV2Schema>;
export type ExperimentPlanCaseV2 = z.infer<typeof experimentPlanCaseV2Schema>;
export type CaseBudgetReservationV2 = z.infer<
  typeof caseBudgetReservationV2Schema
>;
export type ExperimentPlanV2 = z.infer<typeof experimentPlanV2Schema>;
