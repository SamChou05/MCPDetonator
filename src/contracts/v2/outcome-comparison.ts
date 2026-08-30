import { z } from "zod";

import { executionBoundsV2Schema } from "./artifact-reference.js";
import { catalogIdentityV2Schema } from "./catalog.js";
import {
  predictedEffectV2Schema,
  predictionEvidenceBasisV2Schema,
  predictionOriginV2Schema,
} from "./case-components.js";
import {
  V2_CONTRACT_LIMITS,
  addDuplicateIssues,
  componentIdentityV2Schema,
  descriptionV2Schema,
  identifierV2Schema,
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
  sensorV2Schema,
} from "./vocabulary.js";

/**
 * Experimental, non-authoritative sidecars for Phase 1 research. They are not
 * members of V2_TOP_LEVEL_SCHEMA_IDS and cannot substitute for policy, plan,
 * approval, evidence, coverage, or result artifacts.
 */
export const OUTCOME_HYPOTHESIS_FORMAT =
  "forge.outcome-hypothesis/v1alpha1" as const;
export const AGENT_OUTCOME_HYPOTHESIS_DRAFT_FORMAT =
  "forge.agent-outcome-hypothesis-draft/v1alpha1" as const;
export const OUTCOME_OBSERVATION_FORMAT =
  "forge.outcome-observation/v1alpha1" as const;
export const OUTCOME_COMPARISON_FORMAT =
  "forge.outcome-comparison/v1alpha1" as const;

export const OUTCOME_COMPARISON_LIMITS = Object.freeze({
  maxPredictedEffects: 128,
  maxObservedEffects: 1_024,
  maxContentSignals: 64,
  maxEvidenceReferences: 64,
  maxComparisonRows: 1_024,
});

export const OUTCOME_RESULT_PROJECTION =
  "canonical_mcp_call_tool_result" as const;

export const outcomeProtocolV2Schema = z.enum([
  "success",
  "tool_error",
  "protocol_error",
  "timeout",
  "cancelled",
]);

export const outcomeShapeV2Schema = z.enum([
  "json_object",
  "json_array",
  "string",
  "number",
  "boolean",
  "null",
  "binary",
  "unknown",
]);

export const outcomeContentClassV2Schema = z.enum([
  "plain_text",
  "structured_data",
  "code_like",
  "instruction_like",
  "credential_like",
  "sensitive_data_claim",
  "control_characters",
  "encoded_payload",
  "external_link",
  "unknown",
]);

export const outcomeHazardKindV2Schema = z.enum([
  "instruction_override",
  "secret_request",
  "sensitive_data_claim",
  "credential_pattern",
  "code_execution_payload",
  "control_characters",
  "encoded_payload",
  "external_action_request",
]);

function canonicalSetSchema<T extends z.ZodType<string>>(
  itemSchema: T,
  values: readonly string[],
  maximum: number,
  label: string,
) {
  const rank = new Map(values.map((value, index) => [value, index]));
  return z
    .array(itemSchema)
    .max(maximum)
    .superRefine((entries, ctx) => {
      addDuplicateIssues(entries, (entry) => entry, ctx, [], label);
      for (let index = 1; index < entries.length; index += 1) {
        const previous = entries[index - 1];
        const current = entries[index];
        if (
          previous !== undefined &&
          current !== undefined &&
          (rank.get(previous) ?? Number.MAX_SAFE_INTEGER) >=
            (rank.get(current) ?? Number.MAX_SAFE_INTEGER)
        ) {
          ctx.addIssue({
            code: "custom",
            message: `${label} must use canonical enum ordering`,
            path: [index],
          });
          break;
        }
      }
    });
}

const canonicalProtocolSetV2Schema = canonicalSetSchema(
  outcomeProtocolV2Schema,
  outcomeProtocolV2Schema.options,
  outcomeProtocolV2Schema.options.length,
  "protocol outcome",
).min(1);

const canonicalShapeSetV2Schema = canonicalSetSchema(
  outcomeShapeV2Schema,
  outcomeShapeV2Schema.options,
  outcomeShapeV2Schema.options.length,
  "result shape",
).min(1);

const canonicalContentClassSetV2Schema = canonicalSetSchema(
  outcomeContentClassV2Schema,
  outcomeContentClassV2Schema.options,
  outcomeContentClassV2Schema.options.length,
  "content class",
);

const canonicalSensorSetV2Schema = canonicalSetSchema(
  sensorV2Schema,
  sensorV2Schema.options,
  sensorV2Schema.options.length,
  "sensor",
);

export const outputSchemaExpectationV2Schema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_advertised") }).strict(),
  z
    .object({
      status: z.literal("advertised"),
      outputSchemaDigest: sha256V2Schema,
    })
    .strict(),
]);

/**
 * Provider-facing prediction only. Controller bindings, planned effects, and
 * advertised output-schema identity are deliberately absent and are injected
 * only by the deterministic hypothesis compiler.
 */
export const agentOutcomeHypothesisDraftV2Schema = z
  .object({
    format: z.literal(AGENT_OUTCOME_HYPOTHESIS_DRAFT_FORMAT),
    hypothesisId: identifierV2Schema,
    createdAt: timestampV2Schema,
    source: z
      .object({
        origin: z.literal("model_inference"),
        component: componentIdentityV2Schema,
        confidence: z.enum(["low", "medium", "high"]),
        evidenceBasis: z
          .array(
            z
              .object({
                kind: z.literal("model_output"),
                reference: shortTextV2Schema,
              })
              .strict(),
          )
          .min(1)
          .max(32),
      })
      .strict(),
    expected: z
      .object({
        protocolOutcomes: canonicalProtocolSetV2Schema,
        shapes: canonicalShapeSetV2Schema,
        contentClasses: canonicalContentClassSetV2Schema,
        maxReasonableBytes: positiveSafeIntegerV2Schema.max(
          V2_CONTRACT_LIMITS.artifactBytes,
        ),
      })
      .strict(),
    limitations: z.array(descriptionV2Schema).min(1).max(32),
    authority: z
      .object({
        authorizesExecution: z.literal(false),
        grantsApproval: z.literal(false),
        declaresSafety: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((draft, ctx) => {
    addDuplicateIssues(
      draft.source.evidenceBasis,
      (basis) => `${basis.kind}\u0000${basis.reference}`,
      ctx,
      ["source", "evidenceBasis"],
      "draft evidence basis",
    );
  });

export const outcomeHypothesisV2Schema = z
  .object({
    format: z.literal(OUTCOME_HYPOTHESIS_FORMAT),
    hypothesisId: identifierV2Schema,
    createdAt: timestampV2Schema,
    experimentPlanDigest: sha256V2Schema,
    catalog: catalogIdentityV2Schema,
    caseId: identifierV2Schema,
    stepId: identifierV2Schema,
    toolName: toolNameV2Schema,
    source: z
      .object({
        origin: predictionOriginV2Schema,
        component: componentIdentityV2Schema,
        confidence: z.enum(["low", "medium", "high"]),
        evidenceBasis: z.array(predictionEvidenceBasisV2Schema).min(1).max(32),
      })
      .strict(),
    expected: z
      .object({
        protocolOutcomes: canonicalProtocolSetV2Schema,
        shapes: canonicalShapeSetV2Schema,
        contentClasses: canonicalContentClassSetV2Schema,
        maxReasonableBytes: positiveSafeIntegerV2Schema.max(
          V2_CONTRACT_LIMITS.artifactBytes,
        ),
        outputSchema: outputSchemaExpectationV2Schema,
        predictedEffects: z
          .array(predictedEffectV2Schema)
          .min(1)
          .max(OUTCOME_COMPARISON_LIMITS.maxPredictedEffects),
      })
      .strict(),
    limitations: z.array(descriptionV2Schema).min(1).max(32),
    authority: z
      .object({
        authorizesExecution: z.literal(false),
        grantsApproval: z.literal(false),
        declaresSafety: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((hypothesis, ctx) => {
    addDuplicateIssues(
      hypothesis.source.evidenceBasis,
      (basis) => `${basis.kind}\u0000${basis.reference}`,
      ctx,
      ["source", "evidenceBasis"],
      "hypothesis evidence basis",
    );
    addDuplicateIssues(
      hypothesis.expected.predictedEffects,
      (effect) => effect.predictionId,
      ctx,
      ["expected", "predictedEffects"],
      "hypothesis predictionId",
    );
  });

export const outcomeCaptureV2Schema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("complete"),
      projection: z.literal(OUTCOME_RESULT_PROJECTION),
      byteLength: nonnegativeSafeIntegerV2Schema.max(
        V2_CONTRACT_LIMITS.artifactBytes,
      ),
      contentSha256: sha256V2Schema,
    })
    .strict(),
  z
    .object({
      status: z.literal("truncated"),
      projection: z.literal(OUTCOME_RESULT_PROJECTION),
      capturedBytes: nonnegativeSafeIntegerV2Schema.max(
        V2_CONTRACT_LIMITS.artifactBytes,
      ),
      limitBytes: positiveSafeIntegerV2Schema.max(
        V2_CONTRACT_LIMITS.artifactBytes,
      ),
      truncationCause: z.enum([
        "plan_output_limit",
        "transport_limit",
        "upstream_loss",
      ]),
      overflowObserved: z.boolean(),
      observedAtLeastBytes: positiveSafeIntegerV2Schema.max(
        V2_CONTRACT_LIMITS.artifactBytes,
      ),
      capturedPrefixSha256: sha256V2Schema,
      reason: descriptionV2Schema,
    })
    .strict()
    .superRefine((capture, ctx) => {
      if (capture.capturedBytes > capture.limitBytes) {
        ctx.addIssue({
          code: "custom",
          message: "capturedBytes must not exceed limitBytes",
          path: ["capturedBytes"],
        });
      }
      if (capture.observedAtLeastBytes < capture.capturedBytes) {
        ctx.addIssue({
          code: "custom",
          message: "observedAtLeastBytes cannot be smaller than capturedBytes",
          path: ["observedAtLeastBytes"],
        });
      }
      const provedOverflow =
        capture.truncationCause === "plan_output_limit" &&
        capture.observedAtLeastBytes > capture.limitBytes;
      if (capture.overflowObserved !== provedOverflow) {
        ctx.addIssue({
          code: "custom",
          message:
            "overflowObserved must identify a proved plan-output-limit overflow",
          path: ["overflowObserved"],
        });
      }
    }),
  z
    .object({
      status: z.literal("unavailable"),
      projection: z.literal(OUTCOME_RESULT_PROJECTION),
      reason: descriptionV2Schema,
    })
    .strict(),
]);

export const outputSchemaAssessmentV2Schema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_advertised") }).strict(),
  z
    .object({
      status: z.literal("not_assessed"),
      reason: descriptionV2Schema,
    })
    .strict(),
  z
    .object({
      status: z.literal("conforms"),
      outputSchemaDigest: sha256V2Schema,
      assessedValueSha256: sha256V2Schema,
      validator: componentIdentityV2Schema,
      issueCodes: z.array(identifierV2Schema).length(0),
    })
    .strict(),
  z
    .object({
      status: z.literal("violates"),
      outputSchemaDigest: sha256V2Schema,
      assessedValueSha256: sha256V2Schema,
      validator: componentIdentityV2Schema,
      issueCodes: z.array(identifierV2Schema).min(1).max(64),
    })
    .strict()
    .superRefine((assessment, ctx) => {
      addDuplicateIssues(
        assessment.issueCodes,
        (code) => code,
        ctx,
        ["issueCodes"],
        "output-schema issue code",
      );
    }),
]);

export const outcomeContentSignalV2Schema = z
  .object({
    signalId: identifierV2Schema,
    kind: outcomeHazardKindV2Schema,
    detector: componentIdentityV2Schema,
    startByte: nonnegativeSafeIntegerV2Schema.max(
      V2_CONTRACT_LIMITS.artifactBytes,
    ),
    endByteExclusive: positiveSafeIntegerV2Schema.max(
      V2_CONTRACT_LIMITS.artifactBytes,
    ),
    matchedBytesSha256: sha256V2Schema,
    evidenceReference: identifierV2Schema,
  })
  .strict()
  .refine((signal) => signal.endByteExclusive > signal.startByte, {
    message: "endByteExclusive must be greater than startByte",
    path: ["endByteExclusive"],
  });

export const outcomeContentAnalysisV2Schema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("not_assessed"),
      reason: descriptionV2Schema,
    })
    .strict(),
  z
    .object({
      status: z.literal("assessed"),
      analyzer: componentIdentityV2Schema,
      analyzedBytes: nonnegativeSafeIntegerV2Schema.max(
        V2_CONTRACT_LIMITS.artifactBytes,
      ),
      coverage: z.enum(["complete", "prefix"]),
      classes: canonicalContentClassSetV2Schema,
      signals: z
        .array(outcomeContentSignalV2Schema)
        .max(OUTCOME_COMPARISON_LIMITS.maxContentSignals),
      limitations: z.array(descriptionV2Schema).max(16),
    })
    .strict()
    .superRefine((analysis, ctx) => {
      addDuplicateIssues(
        analysis.signals,
        (signal) => signal.signalId,
        ctx,
        ["signals"],
        "content signalId",
      );
    }),
]);

export const observedOutcomeEffectV2Schema = z
  .object({
    effectId: identifierV2Schema,
    action: capabilityActionV2Schema,
    resourceClass: resourceClassV2Schema,
    phase: lifecyclePhaseV2Schema,
    selector: shortTextV2Schema.optional(),
    outcome: z.enum(["attempted", "succeeded", "failed"]),
    operationCount: positiveSafeIntegerV2Schema,
    byteCount: nonnegativeSafeIntegerV2Schema,
    runtimeMs: nonnegativeSafeIntegerV2Schema,
    sensor: sensorV2Schema,
    evidenceReferences: z
      .array(identifierV2Schema)
      .min(1)
      .max(OUTCOME_COMPARISON_LIMITS.maxEvidenceReferences),
  })
  .strict()
  .superRefine((effect, ctx) => {
    addDuplicateIssues(
      effect.evidenceReferences,
      (reference) => reference,
      ctx,
      ["evidenceReferences"],
      "effect evidence reference",
    );
  });

export const outcomeSensorRecordV2Schema = z
  .object({
    sensor: sensorV2Schema,
    status: z.enum(["complete", "truncated", "unavailable"]),
    evidenceReferences: z
      .array(identifierV2Schema)
      .max(OUTCOME_COMPARISON_LIMITS.maxEvidenceReferences),
    limitations: z.array(descriptionV2Schema).max(16),
  })
  .strict()
  .superRefine((sensor, ctx) => {
    if (
      sensor.status === "complete" &&
      sensor.evidenceReferences.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "a complete sensor requires at least one evidence reference",
        path: ["evidenceReferences"],
      });
    }
    if (sensor.status !== "complete" && sensor.limitations.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "an incomplete sensor must explain at least one limitation",
        path: ["limitations"],
      });
    }
    addDuplicateIssues(
      sensor.evidenceReferences,
      (reference) => reference,
      ctx,
      ["evidenceReferences"],
      "sensor evidence reference",
    );
  });

export const outcomeObservationV2Schema = z
  .object({
    format: z.literal(OUTCOME_OBSERVATION_FORMAT),
    observationId: identifierV2Schema,
    recordedAt: timestampV2Schema,
    hypothesisDigest: sha256V2Schema,
    experimentPlanDigest: sha256V2Schema,
    policyDigest: sha256V2Schema,
    catalog: catalogIdentityV2Schema,
    caseId: identifierV2Schema,
    stepId: identifierV2Schema,
    toolName: toolNameV2Schema,
    authorizationEvidence: z
      .object({
        status: z.literal("not_verified"),
        reason: descriptionV2Schema,
      })
      .strict(),
    protocolOutcome: outcomeProtocolV2Schema,
    shape: outcomeShapeV2Schema,
    capture: outcomeCaptureV2Schema,
    outputSchemaAssessment: outputSchemaAssessmentV2Schema,
    contentAnalysis: outcomeContentAnalysisV2Schema,
    effects: z
      .array(observedOutcomeEffectV2Schema)
      .max(OUTCOME_COMPARISON_LIMITS.maxObservedEffects),
    sensors: z.array(outcomeSensorRecordV2Schema).min(1).max(16),
    authority: z
      .object({
        grantsApproval: z.literal(false),
        expandsPolicy: z.literal(false),
        authorizesFollowup: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((observation, ctx) => {
    addDuplicateIssues(
      observation.effects,
      (effect) => effect.effectId,
      ctx,
      ["effects"],
      "observed effectId",
    );
    addDuplicateIssues(
      observation.sensors,
      (sensor) => sensor.sensor,
      ctx,
      ["sensors"],
      "outcome sensor",
    );
    if (
      !observation.sensors.some((sensor) => sensor.sensor === "mcp_transcript")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "outcome observations require an mcp_transcript sensor record",
        path: ["sensors"],
      });
    }

    const retainedEvidence = new Set(
      observation.sensors.flatMap((sensor) => sensor.evidenceReferences),
    );
    observation.effects.forEach((effect, effectIndex) => {
      const compatibleSensor = {
        read: "filesystem",
        write: "filesystem",
        create: "filesystem",
        delete: "filesystem",
        execute: "process",
        connect: "network",
        send: "network",
        receive: "mcp_transcript",
      } as const;
      if (effect.sensor !== compatibleSensor[effect.action]) {
        ctx.addIssue({
          code: "custom",
          message: `effect action '${effect.action}' requires '${compatibleSensor[effect.action]}' sensor provenance`,
          path: ["effects", effectIndex, "sensor"],
        });
      }
      const sensorEvidence = observation.sensors.find(
        (sensor) => sensor.sensor === effect.sensor,
      )?.evidenceReferences;
      effect.evidenceReferences.forEach((reference, referenceIndex) => {
        if (!retainedEvidence.has(reference)) {
          ctx.addIssue({
            code: "custom",
            message: "effect evidence reference is not retained by any sensor",
            path: [
              "effects",
              effectIndex,
              "evidenceReferences",
              referenceIndex,
            ],
          });
        }
        if (!sensorEvidence?.includes(reference)) {
          ctx.addIssue({
            code: "custom",
            message:
              "effect evidence reference is not retained by its declared sensor",
            path: [
              "effects",
              effectIndex,
              "evidenceReferences",
              referenceIndex,
            ],
          });
        }
      });
    });

    const capturedBytes =
      observation.capture.status === "complete"
        ? observation.capture.byteLength
        : observation.capture.status === "truncated"
          ? observation.capture.capturedBytes
          : undefined;
    if (capturedBytes === undefined) {
      if (observation.shape !== "unknown") {
        ctx.addIssue({
          code: "custom",
          message: "an unavailable result capture must use unknown shape",
          path: ["shape"],
        });
      }
      if (observation.contentAnalysis.status !== "not_assessed") {
        ctx.addIssue({
          code: "custom",
          message: "unavailable result bytes cannot have content analysis",
          path: ["contentAnalysis"],
        });
      }
      if (
        observation.outputSchemaAssessment.status !== "not_assessed" &&
        observation.outputSchemaAssessment.status !== "not_advertised"
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "unavailable result bytes cannot have output-schema assessment",
          path: ["outputSchemaAssessment"],
        });
      }
    } else if (observation.contentAnalysis.status === "assessed") {
      const analysis = observation.contentAnalysis;
      if (
        observation.capture.status === "truncated" &&
        analysis.coverage !== "prefix"
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "a truncated result capture can have only prefix content coverage",
          path: ["contentAnalysis", "coverage"],
        });
      }
      if (analysis.analyzedBytes > capturedBytes) {
        ctx.addIssue({
          code: "custom",
          message:
            "content analysis cannot cover more bytes than were captured",
          path: ["contentAnalysis", "analyzedBytes"],
        });
      }
      if (
        analysis.coverage === "complete" &&
        analysis.analyzedBytes !== capturedBytes
      ) {
        ctx.addIssue({
          code: "custom",
          message: "complete content analysis must cover every captured byte",
          path: ["contentAnalysis", "analyzedBytes"],
        });
      }
      analysis.signals.forEach((signal, index) => {
        if (signal.endByteExclusive > analysis.analyzedBytes) {
          ctx.addIssue({
            code: "custom",
            message: "content signal range exceeds analyzed bytes",
            path: ["contentAnalysis", "signals", index, "endByteExclusive"],
          });
        }
        const transcriptEvidence = observation.sensors.find(
          (sensor) => sensor.sensor === "mcp_transcript",
        )?.evidenceReferences;
        if (!transcriptEvidence?.includes(signal.evidenceReference)) {
          ctx.addIssue({
            code: "custom",
            message:
              "content signal must reference retained MCP transcript evidence",
            path: ["contentAnalysis", "signals", index, "evidenceReference"],
          });
        }
      });

      const requiredClassesBySignal = {
        instruction_override: ["instruction_like"],
        secret_request: ["instruction_like", "credential_like"],
        sensitive_data_claim: ["sensitive_data_claim"],
        credential_pattern: ["credential_like"],
        code_execution_payload: ["code_like"],
        control_characters: ["control_characters"],
        encoded_payload: ["encoded_payload"],
        external_action_request: ["instruction_like", "external_link"],
      } as const;
      analysis.signals.forEach((signal, index) => {
        for (const requiredClass of requiredClassesBySignal[signal.kind]) {
          if (!analysis.classes.includes(requiredClass)) {
            ctx.addIssue({
              code: "custom",
              message: `content signal '${signal.kind}' requires class '${requiredClass}'`,
              path: ["contentAnalysis", "signals", index, "kind"],
            });
          }
        }
        if (
          signal.detector.id !== analysis.analyzer.id ||
          signal.detector.version !== analysis.analyzer.version
        ) {
          ctx.addIssue({
            code: "custom",
            message:
              "content signal detector must equal the analysis component",
            path: ["contentAnalysis", "signals", index, "detector"],
          });
        }
      });
    }
    if (
      observation.capture.status === "truncated" &&
      observation.outputSchemaAssessment.status !== "not_assessed" &&
      observation.outputSchemaAssessment.status !== "not_advertised"
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "a truncated result capture cannot claim a complete output-schema assessment",
        path: ["outputSchemaAssessment"],
      });
    }
  });

export const outcomeExpectationStatusV2Schema = z.enum([
  "matches",
  "deviates",
  "inconclusive",
]);

export const outcomePolicyDecisionV2Schema = z.enum([
  "allowed",
  "denied",
  "review_required",
]);

export const outcomeComparisonV2Schema = z
  .object({
    format: z.literal(OUTCOME_COMPARISON_FORMAT),
    comparisonId: identifierV2Schema,
    comparedAt: timestampV2Schema,
    experimentPlanDigest: sha256V2Schema,
    policyDigest: sha256V2Schema,
    catalog: catalogIdentityV2Schema,
    caseId: identifierV2Schema,
    stepId: identifierV2Schema,
    toolName: toolNameV2Schema,
    hypothesisDigest: sha256V2Schema,
    observationDigest: sha256V2Schema,
    executionBounds: executionBoundsV2Schema,
    coverage: z
      .object({
        resultProjection: z.literal(OUTCOME_RESULT_PROJECTION),
        captureStatus: z.enum(["complete", "truncated", "unavailable"]),
        truncationCause: z
          .enum(["plan_output_limit", "transport_limit", "upstream_loss"])
          .optional(),
        overflowObserved: z.boolean(),
        observedAtLeastBytes: nonnegativeSafeIntegerV2Schema
          .max(V2_CONTRACT_LIMITS.artifactBytes)
          .optional(),
        contentAnalysisStatus: z.enum(["assessed", "not_assessed"]),
        contentCoverage: z.enum(["complete", "prefix"]).optional(),
        requiredSensors: canonicalSensorSetV2Schema.min(1),
        completeSensors: canonicalSensorSetV2Schema,
        incompleteSensors: canonicalSensorSetV2Schema,
      })
      .strict(),
    protocol: z
      .object({
        expected: canonicalProtocolSetV2Schema,
        observed: outcomeProtocolV2Schema,
        status: outcomeExpectationStatusV2Schema,
      })
      .strict(),
    shape: z
      .object({
        expected: canonicalShapeSetV2Schema,
        observed: outcomeShapeV2Schema,
        status: outcomeExpectationStatusV2Schema,
      })
      .strict(),
    outputSchema: z
      .object({
        expected: outputSchemaExpectationV2Schema,
        observed: outputSchemaAssessmentV2Schema,
        status: outcomeExpectationStatusV2Schema,
      })
      .strict(),
    size: z
      .object({
        capturedBytes: nonnegativeSafeIntegerV2Schema
          .max(V2_CONTRACT_LIMITS.artifactBytes)
          .optional(),
        maxReasonableBytes: positiveSafeIntegerV2Schema,
        approvedMaxBytes: positiveSafeIntegerV2Schema,
        reasonableStatus: outcomeExpectationStatusV2Schema,
        approvedStatus: outcomeExpectationStatusV2Schema,
      })
      .strict(),
    content: z
      .object({
        expectedClasses: canonicalContentClassSetV2Schema,
        observedClasses: canonicalContentClassSetV2Schema,
        unexpectedClasses: canonicalContentClassSetV2Schema,
        missingClasses: canonicalContentClassSetV2Schema,
        hazardSignalIds: z
          .array(identifierV2Schema)
          .max(OUTCOME_COMPARISON_LIMITS.maxContentSignals),
        status: outcomeExpectationStatusV2Schema,
      })
      .strict(),
    predictedEffects: z
      .array(
        z
          .object({
            predictionId: identifierV2Schema,
            observedEffectIds: z
              .array(identifierV2Schema)
              .max(OUTCOME_COMPARISON_LIMITS.maxObservedEffects),
            status: z.enum(["observed", "not_observed"]),
          })
          .strict(),
      )
      .max(OUTCOME_COMPARISON_LIMITS.maxPredictedEffects),
    observedEffects: z
      .array(
        z
          .object({
            effectId: identifierV2Schema,
            predictionIds: z
              .array(identifierV2Schema)
              .max(OUTCOME_COMPARISON_LIMITS.maxPredictedEffects),
            expectation: z.enum(["expected", "unexpected"]),
            policyDecision: outcomePolicyDecisionV2Schema,
            policyBasis: z.enum([
              "matching_rule",
              "default_decision",
              "rule_limits_exceeded",
            ]),
            policyRuleIds: z.array(identifierV2Schema).max(512),
          })
          .strict(),
      )
      .max(OUTCOME_COMPARISON_LIMITS.maxComparisonRows),
    summary: z
      .object({
        expectation: outcomeExpectationStatusV2Schema,
        policy: z.enum([
          "within_policy",
          "policy_deviation",
          "review_required",
          "inconclusive",
        ]),
        intrinsicRisk: z.enum([
          "signals_observed",
          "no_signal_observed",
          "inconclusive",
        ]),
        outcome: z.enum([
          "policy_deviation",
          "intrinsic_hazard_evidence",
          "review_required",
          "unexpected_behavior",
          "expected_within_policy",
          "inconclusive",
        ]),
      })
      .strict(),
    authority: z
      .object({
        authorizesExecution: z.literal(false),
        authorizesFollowup: z.literal(false),
        safetyVerdict: z.literal("not_produced"),
      })
      .strict(),
    limitations: z.array(descriptionV2Schema).min(1).max(32),
  })
  .strict()
  .superRefine((comparison, ctx) => {
    const issue = (message: string, path: PropertyKey[]) => {
      ctx.addIssue({ code: "custom", message, path });
    };
    const completeSensors = new Set(comparison.coverage.completeSensors);
    const incompleteSensors = new Set(comparison.coverage.incompleteSensors);
    if (
      comparison.coverage.requiredSensors.some(
        (sensor) =>
          completeSensors.has(sensor) === incompleteSensors.has(sensor),
      ) ||
      comparison.coverage.completeSensors.some(
        (sensor) => !comparison.coverage.requiredSensors.includes(sensor),
      ) ||
      comparison.coverage.incompleteSensors.some(
        (sensor) => !comparison.coverage.requiredSensors.includes(sensor),
      )
    ) {
      issue(
        "completeSensors and incompleteSensors must exactly partition requiredSensors",
        ["coverage"],
      );
    }
    if (
      comparison.coverage.contentAnalysisStatus === "not_assessed" &&
      comparison.coverage.contentCoverage !== undefined
    ) {
      issue("unassessed content cannot claim analysis coverage", [
        "coverage",
        "contentCoverage",
      ]);
    }
    if (
      comparison.coverage.contentAnalysisStatus === "assessed" &&
      comparison.coverage.contentCoverage === undefined
    ) {
      issue("assessed content must declare analysis coverage", [
        "coverage",
        "contentCoverage",
      ]);
    }
    if (
      (comparison.coverage.captureStatus === "unavailable") !==
      (comparison.size.capturedBytes === undefined)
    ) {
      issue("capture status and captured byte availability must agree", [
        "coverage",
        "captureStatus",
      ]);
    }
    if (comparison.coverage.captureStatus === "complete") {
      if (
        comparison.coverage.truncationCause !== undefined ||
        comparison.coverage.overflowObserved ||
        comparison.coverage.observedAtLeastBytes !==
          comparison.size.capturedBytes
      ) {
        issue("complete capture coverage fields are inconsistent", [
          "coverage",
        ]);
      }
    } else if (comparison.coverage.captureStatus === "truncated") {
      if (
        comparison.coverage.truncationCause === undefined ||
        comparison.coverage.observedAtLeastBytes === undefined ||
        comparison.size.capturedBytes === undefined ||
        comparison.coverage.observedAtLeastBytes <
          comparison.size.capturedBytes ||
        comparison.coverage.overflowObserved !==
          (comparison.coverage.truncationCause === "plan_output_limit" &&
            comparison.coverage.observedAtLeastBytes >
              comparison.size.approvedMaxBytes)
      ) {
        issue("truncated capture coverage fields are inconsistent", [
          "coverage",
        ]);
      }
    } else if (
      comparison.coverage.truncationCause !== undefined ||
      comparison.coverage.overflowObserved ||
      comparison.coverage.observedAtLeastBytes !== undefined
    ) {
      issue("unavailable capture cannot claim truncation or observed bytes", [
        "coverage",
      ]);
    }
    if (comparison.coverage.contentAnalysisStatus === "not_assessed") {
      if (
        comparison.content.observedClasses.length > 0 ||
        comparison.content.unexpectedClasses.length > 0 ||
        comparison.content.missingClasses.length > 0 ||
        comparison.content.hazardSignalIds.length > 0 ||
        comparison.content.status !== "inconclusive"
      ) {
        issue(
          "unassessed content must remain an empty inconclusive comparison",
          ["content"],
        );
      }
    }
    addDuplicateIssues(
      comparison.content.hazardSignalIds,
      (signalId) => signalId,
      ctx,
      ["content", "hazardSignalIds"],
      "hazard signalId",
    );
    addDuplicateIssues(
      comparison.predictedEffects,
      (row) => row.predictionId,
      ctx,
      ["predictedEffects"],
      "prediction comparison row",
    );
    comparison.predictedEffects.forEach((row, index) => {
      addDuplicateIssues(
        row.observedEffectIds,
        (effectId) => effectId,
        ctx,
        ["predictedEffects", index, "observedEffectIds"],
        "predicted-effect observation",
      );
      if (row.observedEffectIds.length > 0 !== (row.status === "observed")) {
        ctx.addIssue({
          code: "custom",
          message: "prediction status must reflect observedEffectIds",
          path: ["predictedEffects", index, "status"],
        });
      }
    });
    addDuplicateIssues(
      comparison.observedEffects,
      (row) => row.effectId,
      ctx,
      ["observedEffects"],
      "observed-effect comparison row",
    );
    comparison.observedEffects.forEach((row, index) => {
      addDuplicateIssues(
        row.predictionIds,
        (predictionId) => predictionId,
        ctx,
        ["observedEffects", index, "predictionIds"],
        "observed-effect prediction",
      );
      addDuplicateIssues(
        row.policyRuleIds,
        (ruleId) => ruleId,
        ctx,
        ["observedEffects", index, "policyRuleIds"],
        "observed-effect policy rule",
      );
      if (row.predictionIds.length > 0 !== (row.expectation === "expected")) {
        ctx.addIssue({
          code: "custom",
          message: "effect expectation must reflect predictionIds",
          path: ["observedEffects", index, "expectation"],
        });
      }
      if (
        (row.policyBasis === "default_decision" &&
          row.policyRuleIds.length !== 0) ||
        (row.policyBasis !== "default_decision" &&
          row.policyRuleIds.length === 0)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "policyBasis and policyRuleIds disagree",
          path: ["observedEffects", index, "policyRuleIds"],
        });
      }
    });

    const expectedProtocolStatus = comparison.protocol.expected.includes(
      comparison.protocol.observed,
    )
      ? "matches"
      : "deviates";
    if (comparison.protocol.status !== expectedProtocolStatus) {
      issue("protocol status must reflect expected and observed outcomes", [
        "protocol",
        "status",
      ]);
    }

    const expectedShapeStatus =
      comparison.size.capturedBytes === undefined ||
      comparison.shape.expected.includes("unknown")
        ? "inconclusive"
        : comparison.shape.expected.includes(comparison.shape.observed)
          ? "matches"
          : "deviates";
    if (comparison.shape.status !== expectedShapeStatus) {
      issue("shape status must reflect expected and observed shapes", [
        "shape",
        "status",
      ]);
    }

    const expectedSchemaStatus = (() => {
      const expected = comparison.outputSchema.expected;
      const observed = comparison.outputSchema.observed;
      if (expected.status === "not_advertised") {
        return observed.status === "not_advertised" ? "matches" : "deviates";
      }
      if (observed.status === "not_assessed") return "inconclusive";
      if (observed.status === "not_advertised") return "deviates";
      if (observed.outputSchemaDigest !== expected.outputSchemaDigest) {
        return "deviates";
      }
      return observed.status === "conforms" ? "matches" : "deviates";
    })();
    if (comparison.outputSchema.status !== expectedSchemaStatus) {
      issue("output-schema status must reflect the bound assessment", [
        "outputSchema",
        "status",
      ]);
    }

    for (const [field, maximum] of [
      ["reasonableStatus", comparison.size.maxReasonableBytes],
      ["approvedStatus", comparison.size.approvedMaxBytes],
    ] as const) {
      const status = comparison.size[field];
      const provedOverflow =
        comparison.coverage.overflowObserved &&
        comparison.coverage.observedAtLeastBytes !== undefined &&
        comparison.coverage.observedAtLeastBytes > maximum;
      const expectedStatus =
        comparison.size.capturedBytes === undefined
          ? "inconclusive"
          : comparison.size.capturedBytes > maximum || provedOverflow
            ? "deviates"
            : comparison.coverage.captureStatus === "complete"
              ? "matches"
              : "inconclusive";
      if (status !== expectedStatus) {
        issue(`${field} must reflect capture coverage and its byte bound`, [
          "size",
          field,
        ]);
      }
    }

    const expectedContentDifference = comparison.content.observedClasses.filter(
      (value) => !comparison.content.expectedClasses.includes(value),
    );
    const missingContentDifference = comparison.content.expectedClasses.filter(
      (value) => !comparison.content.observedClasses.includes(value),
    );
    if (
      comparison.content.observedClasses.length > 0 ||
      comparison.content.status !== "inconclusive"
    ) {
      if (
        JSON.stringify(comparison.content.unexpectedClasses) !==
          JSON.stringify(expectedContentDifference) ||
        JSON.stringify(comparison.content.missingClasses) !==
          JSON.stringify(missingContentDifference)
      ) {
        issue("content differences must be exact set differences", ["content"]);
      }
    }
    const expectedContentStatus =
      comparison.coverage.contentAnalysisStatus === "not_assessed" ||
      comparison.content.expectedClasses.length === 0
        ? "inconclusive"
        : comparison.coverage.contentCoverage === "prefix"
          ? comparison.content.hazardSignalIds.length > 0
            ? "deviates"
            : "inconclusive"
          : comparison.content.unexpectedClasses.length > 0
            ? "deviates"
            : comparison.content.missingClasses.length > 0
              ? "deviates"
              : "matches";
    if (comparison.content.status !== expectedContentStatus) {
      issue("content status must reflect differences and analysis coverage", [
        "content",
        "status",
      ]);
    }

    const predictionRows = new Map(
      comparison.predictedEffects.map((row) => [row.predictionId, row]),
    );
    const effectRows = new Map(
      comparison.observedEffects.map((row) => [row.effectId, row]),
    );
    comparison.predictedEffects.forEach((row, predictionIndex) => {
      row.observedEffectIds.forEach((effectId, effectIndex) => {
        const effect = effectRows.get(effectId);
        if (effect === undefined) {
          issue("prediction references an unknown observed effect", [
            "predictedEffects",
            predictionIndex,
            "observedEffectIds",
            effectIndex,
          ]);
        } else if (!effect.predictionIds.includes(row.predictionId)) {
          issue("prediction/effect reverse references disagree", [
            "predictedEffects",
            predictionIndex,
            "observedEffectIds",
            effectIndex,
          ]);
        }
      });
    });
    comparison.observedEffects.forEach((row, effectIndex) => {
      row.predictionIds.forEach((predictionId, predictionIndex) => {
        const prediction = predictionRows.get(predictionId);
        if (prediction === undefined) {
          issue("observed effect references an unknown prediction", [
            "observedEffects",
            effectIndex,
            "predictionIds",
            predictionIndex,
          ]);
        } else if (!prediction.observedEffectIds.includes(row.effectId)) {
          issue("effect/prediction reverse references disagree", [
            "observedEffects",
            effectIndex,
            "predictionIds",
            predictionIndex,
          ]);
        }
      });
    });

    const definiteExpectationStatuses = [
      comparison.protocol.status,
      comparison.shape.status,
      comparison.outputSchema.status,
      comparison.size.reasonableStatus,
      comparison.content.status,
      ...(comparison.observedEffects.some(
        (row) => row.expectation === "unexpected",
      )
        ? (["deviates"] as const)
        : []),
    ];
    const missingPrediction = comparison.predictedEffects.some(
      (row) => row.status === "not_observed",
    );
    const allowedExpectationSummaries: Array<
      "matches" | "deviates" | "inconclusive"
    > = definiteExpectationStatuses.includes("deviates")
      ? ["deviates"]
      : definiteExpectationStatuses.includes("inconclusive")
        ? ["inconclusive"]
        : missingPrediction
          ? ["deviates", "inconclusive"]
          : ["matches"];
    if (!allowedExpectationSummaries.includes(comparison.summary.expectation)) {
      issue("summary expectation does not follow its compared dimensions", [
        "summary",
        "expectation",
      ]);
    }

    const hasDeniedEffect = comparison.observedEffects.some(
      (row) => row.policyDecision === "denied",
    );
    const hasReviewEffect = comparison.observedEffects.some(
      (row) => row.policyDecision === "review_required",
    );
    if (
      (hasDeniedEffect || comparison.size.approvedStatus === "deviates") &&
      comparison.summary.policy !== "policy_deviation"
    ) {
      issue("policy summary must retain a deterministic deviation", [
        "summary",
        "policy",
      ]);
    } else if (
      !hasDeniedEffect &&
      comparison.size.approvedStatus !== "deviates" &&
      hasReviewEffect &&
      comparison.summary.policy !== "review_required"
    ) {
      issue("policy summary must retain a review requirement", [
        "summary",
        "policy",
      ]);
    } else if (
      !hasDeniedEffect &&
      !hasReviewEffect &&
      comparison.size.approvedStatus !== "deviates" &&
      (comparison.summary.policy === "policy_deviation" ||
        comparison.summary.policy === "review_required")
    ) {
      issue("policy summary claims an unsupported deviation or review", [
        "summary",
        "policy",
      ]);
    }
    if (
      comparison.size.approvedStatus === "inconclusive" &&
      comparison.summary.policy === "within_policy"
    ) {
      issue(
        "policy summary cannot be within policy with inconclusive output size",
        ["summary", "policy"],
      );
    }
    if (
      comparison.coverage.incompleteSensors.length > 0 &&
      comparison.summary.policy === "within_policy"
    ) {
      issue("policy summary cannot be within policy with incomplete sensors", [
        "summary",
        "policy",
      ]);
    }

    if (
      comparison.content.hazardSignalIds.length > 0 &&
      comparison.summary.intrinsicRisk !== "signals_observed"
    ) {
      issue("intrinsic-risk summary must retain observed content signals", [
        "summary",
        "intrinsicRisk",
      ]);
    } else if (
      comparison.content.hazardSignalIds.length === 0 &&
      comparison.summary.intrinsicRisk === "signals_observed"
    ) {
      issue("intrinsic-risk summary references no retained content signal", [
        "summary",
        "intrinsicRisk",
      ]);
    }
    if (
      comparison.summary.intrinsicRisk === "no_signal_observed" &&
      (comparison.coverage.captureStatus !== "complete" ||
        comparison.coverage.contentAnalysisStatus !== "assessed" ||
        comparison.coverage.contentCoverage !== "complete")
    ) {
      issue(
        "no-signal intrinsic-risk summary requires complete capture and content coverage",
        ["summary", "intrinsicRisk"],
      );
    }
    const expectedOutcome =
      comparison.summary.policy === "policy_deviation"
        ? "policy_deviation"
        : comparison.summary.intrinsicRisk === "signals_observed"
          ? "intrinsic_hazard_evidence"
          : comparison.summary.policy === "review_required"
            ? "review_required"
            : comparison.summary.expectation === "deviates"
              ? "unexpected_behavior"
              : comparison.summary.expectation === "matches" &&
                  comparison.summary.policy === "within_policy" &&
                  comparison.summary.intrinsicRisk === "no_signal_observed"
                ? "expected_within_policy"
                : "inconclusive";
    if (comparison.summary.outcome !== expectedOutcome) {
      issue("summary outcome must reflect the independent dimensions", [
        "summary",
        "outcome",
      ]);
    }
  });

export type OutcomeProtocolV2 = z.infer<typeof outcomeProtocolV2Schema>;
export type OutcomeShapeV2 = z.infer<typeof outcomeShapeV2Schema>;
export type OutcomeContentClassV2 = z.infer<typeof outcomeContentClassV2Schema>;
export type OutcomeHazardKindV2 = z.infer<typeof outcomeHazardKindV2Schema>;
export type OutputSchemaExpectationV2 = z.infer<
  typeof outputSchemaExpectationV2Schema
>;
export type OutputSchemaAssessmentV2 = z.infer<
  typeof outputSchemaAssessmentV2Schema
>;
export type AgentOutcomeHypothesisDraftV2 = z.infer<
  typeof agentOutcomeHypothesisDraftV2Schema
>;
export type OutcomeHypothesisV2 = z.infer<typeof outcomeHypothesisV2Schema>;
export type OutcomeCaptureV2 = z.infer<typeof outcomeCaptureV2Schema>;
export type OutcomeContentSignalV2 = z.infer<
  typeof outcomeContentSignalV2Schema
>;
export type OutcomeContentAnalysisV2 = z.infer<
  typeof outcomeContentAnalysisV2Schema
>;
export type ObservedOutcomeEffectV2 = z.infer<
  typeof observedOutcomeEffectV2Schema
>;
export type OutcomeObservationV2 = z.infer<typeof outcomeObservationV2Schema>;
export type OutcomeComparisonV2 = z.infer<typeof outcomeComparisonV2Schema>;
