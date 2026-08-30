import { z } from "zod";

import {
  artifactReferenceV2Schema,
  targetIdentityV2Schema,
} from "./artifact-reference.js";
import { catalogIdentityV2Schema } from "./catalog.js";
import {
  descriptionV2Schema,
  identifierV2Schema,
  sha256V2Schema,
  timestampV2Schema,
} from "./common.js";

export const auditResultDimensionsV2Schema = z
  .object({
    advertised: z
      .object({
        claimProfileDigest: sha256V2Schema,
      })
      .strict(),
    approved: z
      .object({
        policyDigest: sha256V2Schema,
        approvalReceiptDigest: sha256V2Schema,
      })
      .strict(),
    predicted: z
      .object({
        experimentPlanDigest: sha256V2Schema,
      })
      .strict(),
    observed: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("not_observed"),
          reason: descriptionV2Schema,
        })
        .strict(),
      z
        .object({
          status: z.literal("recorded"),
          observationProfileDigest: sha256V2Schema,
          rawEvidenceManifest: artifactReferenceV2Schema,
        })
        .strict(),
    ]),
    risk: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("not_assessed"),
          reason: descriptionV2Schema,
        })
        .strict(),
      z
        .object({
          status: z.literal("assessed"),
          comparisonResultDigest: sha256V2Schema,
          findingsDigest: sha256V2Schema,
        })
        .strict(),
    ]),
    coverage: z
      .object({
        coverageDigest: sha256V2Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((dimensions, ctx) => {
    if (
      dimensions.observed.status === "recorded" &&
      dimensions.observed.rawEvidenceManifest.kind !== "evidence_manifest"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "rawEvidenceManifest must have kind evidence_manifest",
        path: ["observed", "rawEvidenceManifest", "kind"],
      });
    }
  });

export const auditResultV2Schema = z
  .object({
    schema: z.literal("forge.audit-result/v2"),
    resultId: identifierV2Schema,
    completedAt: timestampV2Schema,
    execution: z
      .object({
        mode: z.literal("phase1_contract_compiler"),
        dispatched: z.literal(false),
      })
      .strict(),
    status: z.literal("inconclusive"),
    outcome: z.literal("unknown_or_untested"),
    target: targetIdentityV2Schema,
    catalog: catalogIdentityV2Schema,
    auditSpecDigest: sha256V2Schema,
    dimensions: auditResultDimensionsV2Schema,
    catalogFreshness: z
      .object({
        status: z.literal("not_rechecked"),
      })
      .strict(),
    cleanup: z
      .object({
        status: z.literal("unverified"),
      })
      .strict(),
    limitations: z.array(descriptionV2Schema).max(256),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.dimensions.observed.status !== "not_observed") {
      ctx.addIssue({
        code: "custom",
        message: "Phase 1A cannot claim runtime observations",
        path: ["dimensions", "observed"],
      });
    }
    if (result.dimensions.risk.status !== "not_assessed") {
      ctx.addIssue({
        code: "custom",
        message: "Phase 1A cannot claim a runtime risk assessment",
        path: ["dimensions", "risk"],
      });
    }
  });

export type AuditResultDimensionsV2 = z.infer<
  typeof auditResultDimensionsV2Schema
>;
export type AuditResultV2 = z.infer<typeof auditResultV2Schema>;
