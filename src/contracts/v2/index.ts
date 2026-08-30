import { z } from "zod";

import { approvalReceiptV2Schema } from "./approval.js";
import { auditResultV2Schema } from "./audit-result.js";
import { auditSpecV2Schema } from "./audit-spec.js";
import { claimProfileV2Schema } from "./claims.js";
import { auditCoverageV2Schema } from "./coverage.js";
import { experimentPlanV2Schema } from "./experiment-plan.js";
import { approvedPolicyV2Schema } from "./policy.js";

export * from "./approval.js";
export * from "./agent-proposal.js";
export * from "./artifact-reference.js";
export * from "./audit-result.js";
export * from "./audit-spec.js";
export * from "./case-components.js";
export * from "./catalog.js";
export * from "./claims.js";
export * from "./common.js";
export * from "./coverage.js";
export * from "./experiment-plan.js";
export * from "./policy.js";
export * from "./synthetic-resources.js";
export * from "./vocabulary.js";

export const V2_TOP_LEVEL_SCHEMA_IDS = [
  "forge.claim-profile/v2",
  "forge.audit-policy/v2",
  "forge.audit-spec/v2",
  "forge.experiment-plan/v2",
  "forge.audit-approval/v2",
  "forge.audit-coverage/v2",
  "forge.audit-result/v2",
] as const;

export const v2TopLevelSchemas = {
  "forge.claim-profile/v2": claimProfileV2Schema,
  "forge.audit-policy/v2": approvedPolicyV2Schema,
  "forge.audit-spec/v2": auditSpecV2Schema,
  "forge.experiment-plan/v2": experimentPlanV2Schema,
  "forge.audit-approval/v2": approvalReceiptV2Schema,
  "forge.audit-coverage/v2": auditCoverageV2Schema,
  "forge.audit-result/v2": auditResultV2Schema,
} as const;

export const v2TopLevelArtifactSchema = z.union([
  claimProfileV2Schema,
  approvedPolicyV2Schema,
  auditSpecV2Schema,
  experimentPlanV2Schema,
  approvalReceiptV2Schema,
  auditCoverageV2Schema,
  auditResultV2Schema,
]);

export type V2TopLevelSchemaId = (typeof V2_TOP_LEVEL_SCHEMA_IDS)[number];
export type V2TopLevelArtifact = z.infer<typeof v2TopLevelArtifactSchema>;
