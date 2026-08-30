import { z } from "zod";

import {
  artifactReferenceV2Schema,
  syntheticResourceMediaTypeV2Schema,
} from "./artifact-reference.js";
import {
  V2_CONTRACT_LIMITS,
  addDuplicateIssues,
  identifierV2Schema,
  positiveSafeIntegerV2Schema,
} from "./common.js";
import { resourceClassV2Schema } from "./vocabulary.js";

export const syntheticResourceDefinitionV2Schema = z
  .object({
    alias: identifierV2Schema,
    resourceClass: resourceClassV2Schema,
    mediaType: syntheticResourceMediaTypeV2Schema,
    content: z.string().min(1).max(V2_CONTRACT_LIMITS.contentCharacters),
  })
  .strict();

export const syntheticResourceReferenceV2Schema = z
  .object({
    $forgeResource: identifierV2Schema,
  })
  .strict();

const syntheticContainerPathV2Schema = z
  .string()
  .min(18)
  .max(512)
  .startsWith("/forge/synthetic/")
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes("//") &&
      !value.split("/").some((segment) => segment === "." || segment === "..") &&
      !/[\u0000-\u001f\u007f]/.test(value),
    { message: "containerPath must remain beneath /forge/synthetic" },
  );

export const syntheticResourceInstanceV2Schema = z
  .object({
    resourceId: identifierV2Schema,
    caseId: identifierV2Schema,
    alias: identifierV2Schema,
    repetition: positiveSafeIntegerV2Schema.max(64),
    resourceClass: resourceClassV2Schema,
    artifact: artifactReferenceV2Schema,
    containerPath: syntheticContainerPathV2Schema,
  })
  .strict()
  .superRefine((instance, ctx) => {
    if (instance.artifact.kind !== "synthetic_resource") {
      ctx.addIssue({
        code: "custom",
        message: "synthetic resource artifacts must have kind synthetic_resource",
        path: ["artifact", "kind"],
      });
    }
  });

export const syntheticResourceManifestV2Schema = z
  .object({
    format: z.literal("forge.synthetic-resource-manifest/v2"),
    manifestId: identifierV2Schema,
    instances: z
      .array(syntheticResourceInstanceV2Schema)
      .max(V2_CONTRACT_LIMITS.arrayItems),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    addDuplicateIssues(
      manifest.instances,
      (instance) => instance.resourceId,
      ctx,
      ["instances"],
      "resourceId",
    );
    addDuplicateIssues(
      manifest.instances,
      (instance) => instance.artifact.artifactId,
      ctx,
      ["instances"],
      "artifactId",
    );
    addDuplicateIssues(
      manifest.instances,
      (instance) => instance.containerPath,
      ctx,
      ["instances"],
      "containerPath",
    );
    addDuplicateIssues(
      manifest.instances,
      (instance) =>
        `${instance.caseId}\u0000${instance.alias}\u0000${instance.repetition}`,
      ctx,
      ["instances"],
      "case/alias/repetition",
    );
  });

export type SyntheticResourceDefinitionV2 = z.infer<
  typeof syntheticResourceDefinitionV2Schema
>;
export type SyntheticResourceReferenceV2 = z.infer<
  typeof syntheticResourceReferenceV2Schema
>;
export type SyntheticResourceInstanceV2 = z.infer<
  typeof syntheticResourceInstanceV2Schema
>;
export type SyntheticResourceManifestV2 = z.infer<
  typeof syntheticResourceManifestV2Schema
>;
