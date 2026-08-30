import { z } from "zod";

import {
  identifierV2Schema,
  nonnegativeSafeIntegerV2Schema,
  sha256V2Schema,
  timestampV2Schema,
} from "./common.js";
import {
  APPROVAL_CLASS_RANK,
  approvalClassV2Schema,
  caseKindV2Schema,
} from "./vocabulary.js";

/**
 * This is an experimental, non-authoritative review record. It deliberately
 * is not a V2 top-level artifact and cannot substitute for an ApprovalReceipt.
 */
export const CONTROLLED_PROPOSAL_REVIEW_FORMAT =
  "forge.controlled-proposal-review/v1alpha1" as const;

export const CONTROLLED_PROPOSAL_REVIEW_MAX_LIFETIME_MS = 5 * 60 * 1_000;

export const controlledProposalReviewRecordV2AlphaSchema = z
  .object({
    format: z.literal(CONTROLLED_PROPOSAL_REVIEW_FORMAT),
    proposalEvidence: z
      .object({
        contextDigest: sha256V2Schema,
        submissionDigest: sha256V2Schema,
        comparisonDigest: sha256V2Schema,
        selectedProposalId: identifierV2Schema,
        selectedProposalDigest: sha256V2Schema,
        selectedCaseId: identifierV2Schema,
        selectedCaseKind: caseKindV2Schema,
        selectedCandidateIndex: nonnegativeSafeIntegerV2Schema,
        selectedCaseSemanticDigest: sha256V2Schema,
      })
      .strict(),
    adoption: z
      .object({
        adoptedCaseId: identifierV2Schema,
        adoptedCaseKind: caseKindV2Schema,
        adoptedCaseSemanticDigest: sha256V2Schema,
        adoptedCaseTemplateDigest: sha256V2Schema,
        adoptedPredictionOrigin: z.literal("operator"),
        independentOperatorPredictionsConfirmed: z.literal(true),
        proposalPredictionsImported: z.literal(false),
        proposalRationaleImported: z.literal(false),
      })
      .strict(),
    finalCompilation: z
      .object({
        auditSpecDigest: sha256V2Schema,
        experimentPlanDigest: sha256V2Schema,
        auditSpecCreatedAt: timestampV2Schema,
        planCompiledAt: timestampV2Schema,
        policyExpiresAt: timestampV2Schema.optional(),
      })
      .strict(),
    review: z
      .object({
        reviewId: identifierV2Schema,
        reviewerId: identifierV2Schema,
        reviewedAt: timestampV2Schema,
        approvalClass: approvalClassV2Schema,
        requiredApprovalClass: approvalClassV2Schema,
        capabilityExpiresAt: timestampV2Schema,
      })
      .strict(),
    authority: z
      .object({
        recordAuthorizesExecution: z.literal(false),
        recordGrantsApproval: z.literal(false),
        serializedRecordIsBearerAuthority: z.literal(false),
        serializedCapabilityExists: z.literal(false),
        proposalPredictionsAreAuthority: z.literal(false),
        proposalRationaleIsAuthority: z.literal(false),
        requiredNextStep: z.literal(
          "consume_opaque_single_use_review_capability",
        ),
      })
      .strict(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (
      record.proposalEvidence.selectedCaseSemanticDigest !==
      record.adoption.adoptedCaseSemanticDigest
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "selected and adopted tool-and-symbolic-argument semantics must match",
        path: ["adoption", "adoptedCaseSemanticDigest"],
      });
    }
    if (
      record.proposalEvidence.selectedCaseKind !==
      record.adoption.adoptedCaseKind
    ) {
      ctx.addIssue({
        code: "custom",
        message: "selected and adopted case kinds must match",
        path: ["adoption", "adoptedCaseKind"],
      });
    }

    const specCreatedAt = Date.parse(
      record.finalCompilation.auditSpecCreatedAt,
    );
    const planCompiledAt = Date.parse(record.finalCompilation.planCompiledAt);
    const reviewedAt = Date.parse(record.review.reviewedAt);
    const capabilityExpiresAt = Date.parse(record.review.capabilityExpiresAt);
    if (specCreatedAt > planCompiledAt) {
      ctx.addIssue({
        code: "custom",
        message: "final AuditSpec creation must not follow plan compilation",
        path: ["finalCompilation", "auditSpecCreatedAt"],
      });
    }
    if (reviewedAt < planCompiledAt) {
      ctx.addIssue({
        code: "custom",
        message: "operator review must not predate the freshly compiled plan",
        path: ["review", "reviewedAt"],
      });
    }
    if (
      capabilityExpiresAt <= reviewedAt ||
      capabilityExpiresAt - reviewedAt >
        CONTROLLED_PROPOSAL_REVIEW_MAX_LIFETIME_MS
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "review capability expiration must follow review by at most five minutes",
        path: ["review", "capabilityExpiresAt"],
      });
    }
    const policyExpiresAt = record.finalCompilation.policyExpiresAt;
    if (
      policyExpiresAt !== undefined &&
      (reviewedAt >= Date.parse(policyExpiresAt) ||
        capabilityExpiresAt > Date.parse(policyExpiresAt))
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "review and capability lifetime must remain inside the compiled policy lifetime",
        path: ["review", "capabilityExpiresAt"],
      });
    }
    if (
      APPROVAL_CLASS_RANK[record.review.approvalClass] <
      APPROVAL_CLASS_RANK[record.review.requiredApprovalClass]
    ) {
      ctx.addIssue({
        code: "custom",
        message: "operator review class is below the deterministic requirement",
        path: ["review", "approvalClass"],
      });
    }
  });

export type ControlledProposalReviewRecordV2Alpha = z.infer<
  typeof controlledProposalReviewRecordV2AlphaSchema
>;
