import { z } from "zod";

import { targetIdentityV2Schema } from "./artifact-reference.js";
import { catalogIdentityV2Schema } from "./catalog.js";
import {
  V2_CONTRACT_LIMITS,
  addDuplicateIssues,
  componentIdentityV2Schema,
  descriptionV2Schema,
  identifierV2Schema,
  jsonPointerV2Schema,
  nonnegativeSafeIntegerV2Schema,
  positiveSafeIntegerV2Schema,
  sha256V2Schema,
  shortTextV2Schema,
  timestampV2Schema,
  toolNameV2Schema,
} from "./common.js";
import {
  capabilityActionV2Schema,
  lifecyclePhaseV2Schema,
  resourceClassV2Schema,
} from "./vocabulary.js";

export const V2_CLAIM_PROFILE_LIMITS = Object.freeze({
  maxEvidenceRows: 4_096,
});

export const claimSelectorV2Schema = z
  .object({
    kind: z.enum([
      "path",
      "path_prefix",
      "destination",
      "port",
      "executable",
      "schema_field",
      "unspecified",
    ]),
    value: shortTextV2Schema,
  })
  .strict();

export const claimEvidenceV2Schema = z
  .object({
    source: z.enum([
      "mcp_name",
      "mcp_title",
      "mcp_description",
      "mcp_input_schema",
      "mcp_output_schema",
      "mcp_annotations",
      "documentation",
      "model_inference",
    ]),
    sourceDigest: sha256V2Schema,
    jsonPointer: jsonPointerV2Schema.optional(),
    excerpt: descriptionV2Schema.optional(),
    inferenceInputReferences: z.array(jsonPointerV2Schema).max(64),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (
      evidence.source === "model_inference" &&
      evidence.inferenceInputReferences.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "model-inferred claim evidence requires bounded input references",
        path: ["inferenceInputReferences"],
      });
    }
    if (
      evidence.source !== "model_inference" &&
      evidence.inferenceInputReferences.length > 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "only model-inferred evidence may carry inferenceInputReferences",
        path: ["inferenceInputReferences"],
      });
    }
  });

export const claimTruncationV2Schema = z
  .object({
    source: z.enum([
      "mcp_name",
      "mcp_title",
      "mcp_description",
      "mcp_input_schema",
      "mcp_output_schema",
      "mcp_annotations",
      "documentation",
      "model_inference",
    ]),
    jsonPointer: jsonPointerV2Schema.optional(),
    omittedCharacters: positiveSafeIntegerV2Schema,
    reason: descriptionV2Schema,
  })
  .strict();

export const capabilityClaimV2Schema = z
  .object({
    claimId: identifierV2Schema,
    toolName: toolNameV2Schema,
    action: capabilityActionV2Schema,
    resourceClass: resourceClassV2Schema,
    selector: claimSelectorV2Schema.optional(),
    phase: lifecyclePhaseV2Schema,
    quantity: z
      .object({
        maximumOperations: positiveSafeIntegerV2Schema.optional(),
        maximumBytes: nonnegativeSafeIntegerV2Schema.optional(),
      })
      .strict()
      .refine(
        (quantity) =>
          quantity.maximumOperations !== undefined || quantity.maximumBytes !== undefined,
        { message: "quantity requires at least one bound" },
      )
      .optional(),
    claimBasis: z.enum([
      "mcp_provided_text",
      "deterministic_extraction",
      "model_inference",
    ]),
    confidence: z.enum(["low", "medium", "high"]),
    evidence: z.array(claimEvidenceV2Schema).min(1).max(64),
    uncertainty: z.array(descriptionV2Schema).max(32),
    limitations: z.array(descriptionV2Schema).max(32),
  })
  .strict()
  .superRefine((claim, ctx) => {
    addDuplicateIssues(
      claim.evidence,
      (evidence) =>
        JSON.stringify([
          evidence.source,
          evidence.sourceDigest,
          evidence.jsonPointer ?? null,
          evidence.excerpt ?? null,
          evidence.inferenceInputReferences,
        ]),
      ctx,
      ["evidence"],
      "claim evidence row",
    );
    if (
      claim.claimBasis === "model_inference" &&
      !claim.evidence.some((evidence) => evidence.source === "model_inference")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "model-inferred claims require model_inference evidence",
        path: ["evidence"],
      });
    }
  });

export const claimProfileV2Schema = z
  .object({
    schema: z.literal("forge.claim-profile/v2"),
    profileId: identifierV2Schema,
    generatedAt: timestampV2Schema,
    target: targetIdentityV2Schema,
    catalog: catalogIdentityV2Schema,
    generator: componentIdentityV2Schema,
    claims: z
      .array(capabilityClaimV2Schema)
      .max(V2_CONTRACT_LIMITS.arrayItems),
    unsupportedDimensions: z.array(shortTextV2Schema).max(64),
    truncations: z.array(claimTruncationV2Schema).max(256),
    limitations: z.array(descriptionV2Schema).max(64),
  })
  .strict()
  .superRefine((profile, ctx) => {
    addDuplicateIssues(
      profile.claims,
      (claim) => claim.claimId,
      ctx,
      ["claims"],
      "claimId",
    );
    const evidenceRows = profile.claims.reduce(
      (total, claim) => total + claim.evidence.length,
      0,
    );
    if (evidenceRows > V2_CLAIM_PROFILE_LIMITS.maxEvidenceRows) {
      ctx.addIssue({
        code: "custom",
        message: `ClaimProfile may contain at most ${V2_CLAIM_PROFILE_LIMITS.maxEvidenceRows} evidence rows`,
        path: ["claims"],
      });
    }
  });

export type ClaimSelectorV2 = z.infer<typeof claimSelectorV2Schema>;
export type ClaimEvidenceV2 = z.infer<typeof claimEvidenceV2Schema>;
export type ClaimTruncationV2 = z.infer<typeof claimTruncationV2Schema>;
export type CapabilityClaimV2 = z.infer<typeof capabilityClaimV2Schema>;
export type ClaimProfileV2 = z.infer<typeof claimProfileV2Schema>;
