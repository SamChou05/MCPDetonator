import { createHash } from "node:crypto";

import {
  approvedPolicyV2Schema,
  outcomeHypothesisV2Schema,
  outcomeObservationV2Schema,
  type OutcomeCaptureV2,
  type OutcomeObservationV2,
  type OutcomeProtocolV2,
  type OutcomeShapeV2,
  type SensorV2,
} from "../../contracts/v2/index.js";
import { MAX_MCP_JSONRPC_MESSAGE_BYTES } from "../../mcp/stdio.js";
import { computeCatalogIdentity } from "./catalog.js";
import { canonicalizeJson, digestCanonicalJson } from "./canonical.js";
import {
  type ExperimentPlanEnvelopeV2,
  verifyExperimentPlanEnvelope,
} from "./envelope.js";
import { deepFreezeJson } from "./freeze.js";
import { assessOutputSchema } from "./outcome-comparison.js";
import {
  analyzeResultContent,
  RESULT_CONTENT_ANALYSIS_LIMITS,
} from "./result-content.js";
import {
  cloneStrictBoundedJson,
  V2_ARTIFACT_CLONE_LIMITS,
} from "./strict-clone.js";

export const CONTROLLED_RUNTIME_OBSERVER_IDENTITY = Object.freeze({
  id: "forge-controlled-runtime-observer",
  version: "1alpha1",
});

const SENSOR_ORDER: readonly SensorV2[] = [
  "process",
  "filesystem",
  "network",
  "mcp_transcript",
  "stdout",
  "stderr",
  "runtime_tree",
  "cleanup",
];

export interface ConsumedOutcomeExecutionBinding {
  readonly consumedAt: string;
  /** Present for an authority-issued dispatch receipt. */
  readonly checkedAt?: string;
  readonly sequence?: 0;
  readonly authorization: {
    readonly expiresAt: string;
    readonly experiment: {
      readonly experimentPlanDigest: string;
      readonly policyDigest: string;
      readonly hypothesisDigest: string;
      readonly caseId: string;
      readonly stepId: string;
      readonly toolName: string;
    };
  };
}

export interface BuildOutcomeObservationInput {
  readonly observationId: string;
  readonly recordedAt: string;
  readonly envelope: ExperimentPlanEnvelopeV2;
  /** Complete, detached catalog discovered in the target session. */
  readonly catalog: unknown;
  readonly policy: unknown;
  readonly hypothesis: unknown;
  /** Produced inside the controller by consumption or exact dispatch revalidation. */
  readonly consumed: ConsumedOutcomeExecutionBinding;
  /** Detached MCP CallToolResult. Omit only when no result was returned. */
  readonly result?: unknown;
  readonly protocolOutcome: OutcomeProtocolV2;
  readonly runtimeMs: number;
  readonly transcriptEvidenceReference: string;
  readonly cleanup: {
    readonly status: "verified" | "failed";
    readonly evidenceReference: string;
    readonly limitation?: string;
  };
}

export type BuildControlledOutcomeObservationInput =
  BuildOutcomeObservationInput;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertCanonicalEqual(
  label: string,
  actual: unknown,
  expected: unknown,
): void {
  if (canonicalizeJson(actual) !== canonicalizeJson(expected)) {
    throw new Error(`outcome observation rejected: ${label} does not match`);
  }
}

function shapeOf(value: unknown): OutcomeShapeV2 {
  if (value === null) return "null";
  if (Array.isArray(value)) return "json_array";
  switch (typeof value) {
    case "object":
      return "json_object";
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "unknown";
  }
}

function ownDataProperty(
  value: unknown,
  property: string,
): { readonly found: boolean; readonly value?: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { found: false };
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    !descriptor.enumerable
  ) {
    return { found: false };
  }
  return { found: true, value: descriptor.value };
}

function buildCapture(
  bytes: Uint8Array,
  maximum: number,
): {
  readonly capture: OutcomeCaptureV2;
  readonly retained: Uint8Array;
} {
  if (bytes.byteLength <= maximum) {
    return {
      capture: {
        status: "complete",
        projection: "canonical_mcp_call_tool_result",
        byteLength: bytes.byteLength,
        contentSha256: sha256(bytes),
      },
      retained: bytes,
    };
  }
  const retained = Uint8Array.prototype.slice.call(
    bytes,
    0,
    maximum,
  ) as Uint8Array;
  return {
    capture: {
      status: "truncated",
      projection: "canonical_mcp_call_tool_result",
      capturedBytes: retained.byteLength,
      limitBytes: maximum,
      truncationCause: "plan_output_limit",
      overflowObserved: true,
      observedAtLeastBytes: bytes.byteLength,
      capturedPrefixSha256: sha256(retained),
      reason:
        "The complete canonical MCP CallToolResult exceeded the approved per-step output bound.",
    },
    retained,
  };
}

/**
 * Derive an observation from controller-held result bytes. Capture hashes,
 * shape, output-schema assessment, lexical indicators, effects, and sensor
 * coverage are computed here rather than accepted from an agent or fixture.
 * The returned artifact intentionally contains no raw MCP result text.
 */
export function buildOutcomeObservation(
  input: BuildOutcomeObservationInput,
): Readonly<OutcomeObservationV2> {
  const envelope = verifyExperimentPlanEnvelope(input.envelope);
  const catalog = computeCatalogIdentity(input.catalog);
  assertCanonicalEqual(
    "live catalog identity",
    catalog.identity,
    envelope.plan.catalog,
  );
  const policy = approvedPolicyV2Schema.parse(
    cloneStrictBoundedJson(
      input.policy,
      V2_ARTIFACT_CLONE_LIMITS,
      "controlled observation policy",
    ).clone,
  );
  const policyDigest = digestCanonicalJson("forge.audit-policy", "v2", policy);
  if (policyDigest !== envelope.plan.policyDigest) {
    throw new Error("outcome observation rejected: policy digest changed");
  }
  const hypothesis = outcomeHypothesisV2Schema.parse(
    cloneStrictBoundedJson(
      input.hypothesis,
      V2_ARTIFACT_CLONE_LIMITS,
      "controlled observation hypothesis",
    ).clone,
  );
  const hypothesisDigest = digestCanonicalJson(
    "forge.outcome-hypothesis",
    "v1alpha1",
    hypothesis,
  );
  const authorization = input.consumed.authorization;
  if (
    authorization.experiment.experimentPlanDigest !==
      envelope.experimentPlanDigest ||
    authorization.experiment.policyDigest !== policyDigest ||
    authorization.experiment.hypothesisDigest !== hypothesisDigest ||
    authorization.experiment.caseId !== hypothesis.caseId ||
    authorization.experiment.stepId !== hypothesis.stepId ||
    authorization.experiment.toolName !== hypothesis.toolName
  ) {
    throw new Error(
      "outcome observation rejected: consumed authorization bindings changed",
    );
  }
  if (input.consumed.checkedAt === undefined) {
    if (
      Date.parse(input.recordedAt) < Date.parse(input.consumed.consumedAt) ||
      Date.parse(input.recordedAt) >= Date.parse(authorization.expiresAt)
    ) {
      throw new Error(
        "outcome observation rejected: observation time is outside the authorization window",
      );
    }
  } else if (
    input.consumed.sequence !== 0 ||
    Date.parse(input.consumed.checkedAt) <
      Date.parse(input.consumed.consumedAt) ||
    Date.parse(input.consumed.checkedAt) >=
      Date.parse(authorization.expiresAt) ||
    Date.parse(input.recordedAt) < Date.parse(input.consumed.checkedAt)
  ) {
    throw new Error(
      "outcome observation rejected: dispatch receipt chronology is invalid",
    );
  }
  if (!Number.isSafeInteger(input.runtimeMs) || input.runtimeMs < 0) {
    throw new RangeError("runtimeMs must be a non-negative safe integer");
  }
  if (
    (input.result === undefined &&
      (input.protocolOutcome === "success" ||
        input.protocolOutcome === "tool_error")) ||
    (input.result !== undefined &&
      input.protocolOutcome !== "success" &&
      input.protocolOutcome !== "tool_error")
  ) {
    throw new Error(
      "outcome observation rejected: protocol outcome and result availability disagree",
    );
  }

  const selectedCase = envelope.plan.cases.find(
    (candidate) => candidate.caseId === hypothesis.caseId,
  );
  const step = selectedCase?.steps.find(
    (candidate) => candidate.stepId === hypothesis.stepId,
  );
  const tool = catalog.catalog.tools.find(
    (candidate) => candidate.name === hypothesis.toolName,
  );
  if (selectedCase === undefined || step === undefined || tool === undefined) {
    throw new Error(
      "outcome observation rejected: selected plan step is unavailable",
    );
  }

  let shape: OutcomeShapeV2 = "unknown";
  let capture: OutcomeCaptureV2 = {
    status: "unavailable",
    projection: "canonical_mcp_call_tool_result",
    reason:
      "No complete MCP CallToolResult was returned by the controlled session.",
  };
  let contentAnalysis: OutcomeObservationV2["contentAnalysis"] = {
    status: "not_assessed",
    reason: "No result projection was available for content analysis.",
  };
  let outputSchemaAssessment: OutcomeObservationV2["outputSchemaAssessment"] =
    tool.outputSchema === undefined
      ? { status: "not_advertised" }
      : {
          status: "not_assessed",
          reason: "No complete structured result was available for validation.",
        };
  let observedByteLength = 0;

  if (input.result !== undefined) {
    const detachedResult = cloneStrictBoundedJson(
      input.result,
      {
        ...V2_ARTIFACT_CLONE_LIMITS,
        maxSerializedBytes: MAX_MCP_JSONRPC_MESSAGE_BYTES,
      },
      "controlled MCP CallToolResult",
    ).clone;
    const canonicalBytes = Buffer.from(
      canonicalizeJson(detachedResult),
      "utf8",
    );
    observedByteLength = canonicalBytes.byteLength;
    shape = shapeOf(detachedResult);
    const retained = buildCapture(
      canonicalBytes,
      envelope.plan.bounds.maxOutputBytesPerStep,
    );
    capture = retained.capture;
    contentAnalysis = analyzeResultContent({
      content: retained.retained,
      evidenceReference: input.transcriptEvidenceReference,
      sourceStatus:
        retained.capture.status === "complete" ? "complete" : "truncated",
      maxBytes: Math.min(
        Math.max(retained.retained.byteLength, 1),
        RESULT_CONTENT_ANALYSIS_LIMITS.hardMaxBytes,
      ),
    });
    if (retained.capture.status === "complete") {
      const structured = ownDataProperty(detachedResult, "structuredContent");
      outputSchemaAssessment = structured.found
        ? assessOutputSchema({
            tool,
            value: structured.value,
            maxOutputBytes: envelope.plan.bounds.maxOutputBytesPerStep,
          })
        : tool.outputSchema === undefined
          ? { status: "not_advertised" }
          : {
              status: "not_assessed",
              reason:
                "The tool advertised outputSchema but returned no structuredContent value.",
            };
    }
  }

  const sensorRecords = new Map<
    SensorV2,
    OutcomeObservationV2["sensors"][number]
  >();
  sensorRecords.set("mcp_transcript", {
    sensor: "mcp_transcript",
    status: "complete",
    evidenceReferences: [input.transcriptEvidenceReference],
    limitations: [],
  });
  sensorRecords.set("cleanup", {
    sensor: "cleanup",
    status: input.cleanup.status === "verified" ? "complete" : "unavailable",
    evidenceReferences:
      input.cleanup.status === "verified"
        ? [input.cleanup.evidenceReference]
        : [],
    limitations:
      input.cleanup.status === "verified"
        ? []
        : [
            input.cleanup.limitation ??
              "Controlled sandbox cleanup could not be verified.",
          ],
  });
  for (const required of envelope.plan.requiredSensors) {
    if (!sensorRecords.has(required)) {
      sensorRecords.set(required, {
        sensor: required,
        status: "unavailable",
        evidenceReferences: [],
        limitations: [
          `The result-channel observer does not implement the required '${required}' sensor.`,
        ],
      });
    }
  }
  const sensors = [...sensorRecords.values()].sort(
    (left, right) =>
      SENSOR_ORDER.indexOf(left.sensor) - SENSOR_ORDER.indexOf(right.sensor),
  );
  const effects: OutcomeObservationV2["effects"] =
    input.result === undefined
      ? []
      : [
          {
            effectId: `effect-receive-${hypothesis.stepId}`,
            action: "receive",
            resourceClass: "structured_data",
            phase: "post_return",
            outcome:
              input.protocolOutcome === "success" ? "succeeded" : "failed",
            operationCount: 1,
            byteCount: observedByteLength,
            runtimeMs: input.runtimeMs,
            sensor: "mcp_transcript",
            evidenceReferences: [input.transcriptEvidenceReference],
          },
        ];

  const observation = outcomeObservationV2Schema.parse({
    format: "forge.outcome-observation/v1alpha1",
    observationId: input.observationId,
    recordedAt: input.recordedAt,
    hypothesisDigest,
    experimentPlanDigest: envelope.experimentPlanDigest,
    policyDigest,
    catalog: catalog.identity,
    caseId: hypothesis.caseId,
    stepId: hypothesis.stepId,
    toolName: hypothesis.toolName,
    authorizationEvidence: {
      status: "not_verified",
      reason:
        "Dispatch provenance is retained separately in the controlled execution record.",
    },
    protocolOutcome: input.protocolOutcome,
    shape,
    capture,
    outputSchemaAssessment,
    contentAnalysis,
    effects,
    sensors,
    authority: {
      grantsApproval: false,
      expandsPolicy: false,
      authorizesFollowup: false,
    },
  });
  return deepFreezeJson(observation);
}

/** Backwards-compatible controlled-fixture entrypoint. */
export function buildControlledOutcomeObservation(
  input: BuildControlledOutcomeObservationInput,
): Readonly<OutcomeObservationV2> {
  return buildOutcomeObservation(input);
}
