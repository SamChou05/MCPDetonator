import { z } from "zod";

import {
  identifierV2Schema,
  nonnegativeSafeIntegerV2Schema,
  positiveSafeIntegerV2Schema,
  sha256V2Schema,
} from "./common.js";

export const artifactKindV2Schema = z.enum([
  "source_bundle",
  "runtime_snapshot",
  "synthetic_resource",
  "evidence_manifest",
  "coverage",
  "approval",
]);

export const artifactMediaTypeV2Schema = z.enum([
  "application/json",
  "application/vnd.forge.runtime-tree+json",
  "application/vnd.forge.synthetic-resource+json",
  "text/plain; charset=utf-8",
]);

export const syntheticResourceMediaTypeV2Schema = z.enum([
  "application/json",
  "application/vnd.forge.synthetic-resource+json",
  "text/plain; charset=utf-8",
]);

export const artifactReferenceV2Schema = z
  .object({
    artifactId: identifierV2Schema,
    kind: artifactKindV2Schema,
    mediaType: artifactMediaTypeV2Schema,
    byteLength: nonnegativeSafeIntegerV2Schema.max(1_073_741_824),
    sha256: sha256V2Schema,
  })
  .strict();

export const targetIdentityV2Schema = z
  .object({
    targetId: identifierV2Schema,
    sourceArtifact: artifactReferenceV2Schema,
    runtimeSnapshot: artifactReferenceV2Schema,
    runtimeTreeAlgorithm: z.literal("forge.runtime-tree/v2"),
    runtimeDescriptorDigest: sha256V2Schema,
  })
  .strict()
  .superRefine((target, ctx) => {
    if (target.sourceArtifact.kind !== "source_bundle") {
      ctx.addIssue({
        code: "custom",
        message: "sourceArtifact must have kind source_bundle",
        path: ["sourceArtifact", "kind"],
      });
    }
    if (target.runtimeSnapshot.kind !== "runtime_snapshot") {
      ctx.addIssue({
        code: "custom",
        message: "runtimeSnapshot must have kind runtime_snapshot",
        path: ["runtimeSnapshot", "kind"],
      });
    }
  });

export const executionBoundsV2Schema = z
  .object({
    maxCases: positiveSafeIntegerV2Schema,
    maxStepsPerCase: positiveSafeIntegerV2Schema,
    maxTotalSteps: positiveSafeIntegerV2Schema,
    maxCaseRuntimeMs: positiveSafeIntegerV2Schema,
    maxTotalRuntimeMs: positiveSafeIntegerV2Schema,
    maxArgumentBytes: positiveSafeIntegerV2Schema,
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
  .superRefine((bounds, ctx) => {
    const comparisons: Array<{
      smaller: keyof typeof bounds;
      larger: keyof typeof bounds;
    }> = [
      { smaller: "maxStepsPerCase", larger: "maxTotalSteps" },
      { smaller: "maxCaseRuntimeMs", larger: "maxTotalRuntimeMs" },
      { smaller: "maxOutputBytesPerStep", larger: "maxTotalOutputBytes" },
      { smaller: "maxFileBytes", larger: "maxWritableBytes" },
    ];
    for (const comparison of comparisons) {
      if (bounds[comparison.smaller] > bounds[comparison.larger]) {
        ctx.addIssue({
          code: "custom",
          message: `${comparison.smaller} must not exceed ${comparison.larger}`,
          path: [comparison.smaller],
        });
      }
    }
  });

export type ArtifactKindV2 = z.infer<typeof artifactKindV2Schema>;
export type ArtifactMediaTypeV2 = z.infer<typeof artifactMediaTypeV2Schema>;
export type ArtifactReferenceV2 = z.infer<typeof artifactReferenceV2Schema>;
export type TargetIdentityV2 = z.infer<typeof targetIdentityV2Schema>;
export type ExecutionBoundsV2 = z.infer<typeof executionBoundsV2Schema>;
