import { z } from "zod";

import { executionBoundsV2Schema } from "./artifact-reference.js";
import { catalogIdentityV2Schema } from "./catalog.js";
import {
  componentIdentityV2Schema,
  descriptionV2Schema,
  identifierV2Schema,
  nonnegativeSafeIntegerV2Schema,
  sha256V2Schema,
  timestampV2Schema,
  toolNameV2Schema,
} from "./common.js";
import {
  outcomeCaptureV2Schema,
  outcomeProtocolV2Schema,
} from "./outcome-comparison.js";
import { approvalClassV2Schema } from "./vocabulary.js";

/**
 * Experimental controller records. Neither record is a bearer credential;
 * dispatch additionally requires a live, opaque, single-use capability held
 * by the controller process.
 */
export const CONTROLLED_EXECUTION_AUTHORIZATION_FORMAT =
  "forge.controlled-execution-authorization/v1alpha1" as const;
export const CONTROLLED_EXECUTION_ATTEMPT_FORMAT =
  "forge.controlled-execution-attempt/v1alpha1" as const;
export const CONTROLLED_EXECUTION_FAILURE_FORMAT =
  "forge.controlled-execution-failure/v1alpha1" as const;

export const controlledExecutionAuthorizationV2Schema = z
  .object({
    format: z.literal(CONTROLLED_EXECUTION_AUTHORIZATION_FORMAT),
    authorizationId: identifierV2Schema,
    issuedAt: timestampV2Schema,
    expiresAt: timestampV2Schema,
    executionClass: z.literal("controlled_fixture_only"),
    dispatchEligibility: z.literal("requires_live_opaque_capability"),
    controller: z
      .object({
        controllerId: identifierV2Schema,
        authority: componentIdentityV2Schema,
        authenticatedRecord: z.literal(false),
      })
      .strict(),
    review: z
      .object({
        reviewerId: identifierV2Schema,
        approvalClass: approvalClassV2Schema,
        decision: z.literal("approved"),
      })
      .strict(),
    experiment: z
      .object({
        experimentPlanDigest: sha256V2Schema,
        policyDigest: sha256V2Schema,
        catalog: catalogIdentityV2Schema,
        controlledFixtureId: identifierV2Schema,
        targetIdentityDigest: sha256V2Schema,
        runtimeDescriptorDigest: sha256V2Schema,
        preparedTargetTreeSha256: sha256V2Schema,
        syntheticResourceManifestDigest: sha256V2Schema,
        proposalReviewDigest: sha256V2Schema.optional(),
        hypothesisDigest: sha256V2Schema,
        caseId: identifierV2Schema,
        stepId: identifierV2Schema,
        toolName: toolNameV2Schema,
        argumentSha256: sha256V2Schema,
        sequence: z.literal(0),
      })
      .strict(),
    bounds: executionBoundsV2Schema,
    boundary: z
      .object({
        runner: componentIdentityV2Schema,
        sandbox: componentIdentityV2Schema,
        imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
        network: z.literal("none"),
        maxCalls: z.literal(1),
        maxRetries: z.literal(0),
        authorizesFollowup: z.literal(false),
        resultExposure: z.literal("local_quarantine_only"),
      })
      .strict(),
    limitations: z.array(descriptionV2Schema).min(1).max(16),
  })
  .strict()
  .superRefine((authorization, ctx) => {
    if (
      Date.parse(authorization.expiresAt) <= Date.parse(authorization.issuedAt)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "expiresAt must follow issuedAt",
        path: ["expiresAt"],
      });
    }
  });

export const controlledExecutionAttemptV2Schema = z
  .object({
    format: z.literal(CONTROLLED_EXECUTION_ATTEMPT_FORMAT),
    recordId: identifierV2Schema,
    authorizationId: identifierV2Schema,
    authorizationDigest: sha256V2Schema,
    startedAt: timestampV2Schema,
    endedAt: timestampV2Schema,
    experimentPlanDigest: sha256V2Schema,
    proposalReviewDigest: sha256V2Schema.optional(),
    hypothesisDigest: sha256V2Schema,
    caseId: identifierV2Schema,
    stepId: identifierV2Schema,
    toolName: toolNameV2Schema,
    argumentSha256: sha256V2Schema,
    targetTreeSha256: sha256V2Schema,
    liveCatalog: catalogIdentityV2Schema,
    permit: z
      .object({
        consumed: z.literal(true),
        consumedAt: timestampV2Schema,
        persistedRecordIsBearerCredential: z.literal(false),
      })
      .strict(),
    dispatch: z
      .object({
        sequence: z.literal(0),
        requestedCalls: z.literal(1),
        sentCalls: z.literal(1),
        retries: z.literal(0),
        followupCalls: z.literal(0),
      })
      .strict(),
    protocolOutcome: outcomeProtocolV2Schema,
    resultCapture: outcomeCaptureV2Schema,
    rawResult: z
      .object({
        evidenceReference: identifierV2Schema,
        exposure: z.literal("local_quarantine_only"),
        exposedToPlanner: z.literal(false),
        exposedToAuthority: z.literal(false),
        usedForFollowup: z.literal(false),
      })
      .strict(),
    observationDigest: sha256V2Schema,
    comparisonDigest: sha256V2Schema,
    cleanup: z
      .object({
        status: z.enum(["verified", "failed"]),
        evidenceReference: identifierV2Schema,
        limitations: z.array(descriptionV2Schema).max(8),
      })
      .strict()
      .superRefine((cleanup, ctx) => {
        if (cleanup.status === "failed" && cleanup.limitations.length === 0) {
          ctx.addIssue({
            code: "custom",
            message: "failed cleanup must retain a limitation",
            path: ["limitations"],
          });
        }
      }),
    authority: z
      .object({
        grantsApproval: z.literal(false),
        authorizesFollowup: z.literal(false),
        declaresSafety: z.literal(false),
      })
      .strict(),
    limitations: z.array(descriptionV2Schema).min(1).max(16),
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if (Date.parse(attempt.endedAt) < Date.parse(attempt.startedAt)) {
      ctx.addIssue({
        code: "custom",
        message: "endedAt must not precede startedAt",
        path: ["endedAt"],
      });
    }
    if (Date.parse(attempt.startedAt) < Date.parse(attempt.permit.consumedAt)) {
      ctx.addIssue({
        code: "custom",
        message: "the permit must be consumed before execution starts",
        path: ["permit", "consumedAt"],
      });
    }
  });

export const controlledExecutionFailureV2Schema = z
  .object({
    format: z.literal(CONTROLLED_EXECUTION_FAILURE_FORMAT),
    recordId: identifierV2Schema,
    authorizationId: identifierV2Schema,
    authorizationDigest: sha256V2Schema,
    consumedAt: timestampV2Schema,
    failedAt: timestampV2Schema,
    experimentPlanDigest: sha256V2Schema,
    proposalReviewDigest: sha256V2Schema.optional(),
    hypothesisDigest: sha256V2Schema,
    caseId: identifierV2Schema,
    stepId: identifierV2Schema,
    toolName: toolNameV2Schema,
    argumentSha256: sha256V2Schema,
    stage: z.enum([
      "session_before_monitor",
      "pre_dispatch_monitor",
      "transport_before_send",
      "runtime_or_protocol",
      "post_return_verification",
      "cleanup_verification",
    ]),
    dispatch: z
      .object({
        requestedCalls: z.literal(1),
        sentCalls: z.union([z.literal(0), z.literal(1)]),
        transcriptCallRecords: nonnegativeSafeIntegerV2Schema,
        retries: z.literal(0),
        followupCalls: z.literal(0),
      })
      .strict(),
    transcript: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("available"),
          evidenceReference: identifierV2Schema,
          sha256: sha256V2Schema,
          toolsListRequests: nonnegativeSafeIntegerV2Schema,
        })
        .strict(),
      z
        .object({
          status: z.literal("unavailable"),
          reason: descriptionV2Schema,
        })
        .strict(),
    ]),
    cleanup: z
      .object({
        status: z.enum(["verified", "failed"]),
        evidenceReference: identifierV2Schema,
        limitations: z.array(descriptionV2Schema).max(8),
      })
      .strict()
      .superRefine((cleanup, ctx) => {
        if (cleanup.status === "failed" && cleanup.limitations.length === 0) {
          ctx.addIssue({
            code: "custom",
            message: "failed cleanup must retain a limitation",
            path: ["limitations"],
          });
        }
      }),
    rawResult: z
      .object({
        exposure: z.literal("local_quarantine_only"),
        exposedToPlanner: z.literal(false),
        exposedToAuthority: z.literal(false),
        usedForFollowup: z.literal(false),
      })
      .strict(),
    authority: z
      .object({
        grantsApproval: z.literal(false),
        authorizesRetry: z.literal(false),
        authorizesFollowup: z.literal(false),
        declaresSafety: z.literal(false),
      })
      .strict(),
    limitations: z.array(descriptionV2Schema).min(1).max(16),
  })
  .strict()
  .superRefine((failure, ctx) => {
    if (Date.parse(failure.failedAt) < Date.parse(failure.consumedAt)) {
      ctx.addIssue({
        code: "custom",
        message: "failedAt must not precede consumedAt",
        path: ["failedAt"],
      });
    }
    if (
      (failure.stage === "session_before_monitor" ||
        failure.stage === "pre_dispatch_monitor" ||
        failure.stage === "transport_before_send") &&
      failure.dispatch.sentCalls !== 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "a pre-send failure stage cannot claim a sent call",
        path: ["dispatch", "sentCalls"],
      });
    }
  });

export type ControlledExecutionAuthorizationV2 = z.infer<
  typeof controlledExecutionAuthorizationV2Schema
>;
export type ControlledExecutionAttemptV2 = z.infer<
  typeof controlledExecutionAttemptV2Schema
>;
export type ControlledExecutionFailureV2 = z.infer<
  typeof controlledExecutionFailureV2Schema
>;
