import { z } from "zod";

import {
  addDuplicateIssues,
  boundedJsonValueV2Schema,
  descriptionV2Schema,
  identifierV2Schema,
  shortTextV2Schema,
} from "./common.js";
import {
  capabilityActionV2Schema,
  lifecyclePhaseV2Schema,
  resourceClassV2Schema,
} from "./vocabulary.js";

export const predictionOriginV2Schema = z.enum([
  "operator",
  "deterministic_generator",
  "model_inference",
]);

export const predictionEvidenceBasisV2Schema = z
  .object({
    kind: z.enum([
      "operator_statement",
      "deterministic_rule",
      "claim_profile",
      "model_output",
    ]),
    reference: shortTextV2Schema,
  })
  .strict();

export const predictedEffectV2Schema = z
  .object({
    predictionId: identifierV2Schema,
    origin: predictionOriginV2Schema,
    action: capabilityActionV2Schema,
    resourceClass: resourceClassV2Schema,
    phase: lifecyclePhaseV2Schema,
    selector: shortTextV2Schema.optional(),
    confidence: z.enum(["low", "medium", "high"]),
    evidenceBasis: z
      .array(predictionEvidenceBasisV2Schema)
      .min(1)
      .max(32)
      .superRefine((entries, ctx) => {
        addDuplicateIssues(
          entries,
          (entry) => `${entry.kind}\u0000${entry.reference}`,
          ctx,
          [],
          "prediction evidence basis",
        );
      }),
    limitations: z.array(descriptionV2Schema).max(32),
  })
  .strict();

export const deterministicAssertionV2Schema = z
  .object({
    assertionId: identifierV2Schema,
    kind: z.enum([
      "tool_status",
      "effect_present",
      "effect_absent",
      "output_schema",
      "resource_integrity",
    ]),
    subject: shortTextV2Schema,
    expected: boundedJsonValueV2Schema,
    required: z.boolean(),
  })
  .strict();

export type PredictionOriginV2 = z.infer<typeof predictionOriginV2Schema>;
export type PredictionEvidenceBasisV2 = z.infer<
  typeof predictionEvidenceBasisV2Schema
>;
export type PredictedEffectV2 = z.infer<typeof predictedEffectV2Schema>;
export type DeterministicAssertionV2 = z.infer<
  typeof deterministicAssertionV2Schema
>;
