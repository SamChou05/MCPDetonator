import { z } from "zod";

import {
  executionBoundsV2Schema,
  targetIdentityV2Schema,
} from "./artifact-reference.js";
import { catalogIdentityV2Schema } from "./catalog.js";
import {
  addDuplicateIssues,
  componentIdentityV2Schema,
  identifierV2Schema,
  positiveSafeIntegerV2Schema,
  sha256V2Schema,
  timestampV2Schema,
} from "./common.js";
import { approvalClassV2Schema } from "./vocabulary.js";

export const approvalAuthorityV2Schema = z
  .object({
    issuerId: identifierV2Schema,
    authentication: z.literal("unsigned"),
    authenticated: z.literal(false),
  })
  .strict();

export const approvalAudienceV2Schema = z
  .object({
    controllerId: identifierV2Schema,
    environment: z.literal("phase1_contract_compiler"),
  })
  .strict();

export const approvalScopeV2Schema = z
  .object({
    planId: identifierV2Schema,
    approvedCaseIds: z.array(identifierV2Schema).max(1_024),
    repetitions: positiveSafeIntegerV2Schema.max(64),
    maxUses: z.literal(1),
  })
  .strict()
  .superRefine((scope, ctx) => {
    addDuplicateIssues(
      scope.approvedCaseIds,
      (caseId) => caseId,
      ctx,
      ["approvedCaseIds"],
      "approved caseId",
    );
  });

export const approvalCaseDecisionV2Schema = z
  .object({
    caseId: identifierV2Schema,
    decision: z.enum(["approved", "denied"]),
    approvalClass: approvalClassV2Schema,
  })
  .strict();

export const approvalReceiptV2Schema = z
  .object({
    schema: z.literal("forge.audit-approval/v2"),
    receiptId: identifierV2Schema,
    issuedAt: timestampV2Schema,
    expiresAt: timestampV2Schema,
    purpose: z.literal("audit_execution"),
    audience: approvalAudienceV2Schema,
    scope: approvalScopeV2Schema,
    reusePolicy: z.literal("prohibited"),
    authority: approvalAuthorityV2Schema,
    dispatchEligibility: z.literal("non_dispatchable_phase1"),
    target: targetIdentityV2Schema,
    targetIdentityDigest: sha256V2Schema,
    catalog: catalogIdentityV2Schema,
    claimProfileDigest: sha256V2Schema,
    policyDigest: sha256V2Schema,
    policyExpiresAt: timestampV2Schema.optional(),
    auditSpecDigest: sha256V2Schema,
    syntheticResourceManifestDigest: sha256V2Schema,
    experimentPlanDigest: sha256V2Schema,
    executionBounds: executionBoundsV2Schema,
    requiredApprovalClass: approvalClassV2Schema,
    caseDecisions: z.array(approvalCaseDecisionV2Schema).max(1_024),
    canonicalization: z.literal("rfc8785-jcs"),
    compiler: componentIdentityV2Schema,
    executionBoundary: z
      .object({
        runner: z.literal("not_implemented_phase1"),
        sandbox: z.literal("not_approved_phase1"),
      })
      .strict(),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (Date.parse(receipt.expiresAt) <= Date.parse(receipt.issuedAt)) {
      ctx.addIssue({
        code: "custom",
        message: "expiresAt must follow issuedAt",
        path: ["expiresAt"],
      });
    }
    if (
      receipt.policyExpiresAt !== undefined &&
      (Date.parse(receipt.issuedAt) >= Date.parse(receipt.policyExpiresAt) ||
        Date.parse(receipt.expiresAt) > Date.parse(receipt.policyExpiresAt))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "receipt validity must remain within policyExpiresAt",
        path: ["policyExpiresAt"],
      });
    }
    addDuplicateIssues(
      receipt.caseDecisions,
      (decision) => decision.caseId,
      ctx,
      ["caseDecisions"],
      "case decision",
    );
    const approvedDecisions = receipt.caseDecisions
      .filter((decision) => decision.decision === "approved")
      .map((decision) => decision.caseId);
    const scopeCaseIds = new Set(receipt.scope.approvedCaseIds);
    if (
      approvedDecisions.length !== scopeCaseIds.size ||
      approvedDecisions.some((caseId) => !scopeCaseIds.has(caseId))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "scope.approvedCaseIds must exactly match approved case decisions",
        path: ["scope", "approvedCaseIds"],
      });
    }
  });

export const auditApprovalV2Schema = approvalReceiptV2Schema;

export type ApprovalAuthorityV2 = z.infer<typeof approvalAuthorityV2Schema>;
export type ApprovalAudienceV2 = z.infer<typeof approvalAudienceV2Schema>;
export type ApprovalScopeV2 = z.infer<typeof approvalScopeV2Schema>;
export type ApprovalCaseDecisionV2 = z.infer<
  typeof approvalCaseDecisionV2Schema
>;
export type ApprovalReceiptV2 = z.infer<typeof approvalReceiptV2Schema>;
export type AuditApprovalV2 = ApprovalReceiptV2;
