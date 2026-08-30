import {
  approvedPolicyV2Schema,
  auditSpecV2Schema,
  claimProfileV2Schema,
  mandatoryCaseTemplateV2Schema,
  targetIdentityV2Schema,
  type ApprovedPolicyV2,
  type AuditSpecV2,
  type ClaimProfileV2,
  type MandatoryCaseTemplateV2,
  type TargetIdentityV2,
} from "../../contracts/v2/index.js";
import { artifactReferenceFromBytes } from "./artifacts.js";
import { computeCatalogIdentity } from "./catalog.js";
import { canonicalizeJson, digestCanonicalJson } from "./canonical.js";
import {
  compileExperimentPlan,
  type CompiledExperimentPlanV2,
  type CompileExperimentPlanInput,
} from "./compile.js";
import {
  runtimeDescriptorV2Schema,
  type RuntimeDescriptorV2,
} from "./target.js";

export const ENROLLED_SINGLE_CALL_BOUNDS = Object.freeze({
  maxCases: 1,
  maxStepsPerCase: 1,
  maxTotalSteps: 1,
  maxCaseRuntimeMs: 10_000,
  maxTotalRuntimeMs: 10_000,
  maxArgumentBytes: 16_384,
  maxOutputBytesPerStep: 65_536,
  maxTotalOutputBytes: 65_536,
  maxWritableBytes: 131_072,
  maxWritableFiles: 16,
  maxFileBytes: 65_536,
  maxProcesses: 32,
  maxMemoryMb: 192,
  maxCpuMs: 10_000,
  maxOpenFiles: 64,
});

/** Discovery ceilings that are part of the enrollment compatibility claim. */
export const ENROLLED_DISCOVERY_CATALOG_BOUNDS = Object.freeze({
  maxPages: 1,
  maxTools: 1_000,
  maxSerializedBytes: 1_000_000,
});

export interface CreateEnrolledExperimentInput {
  readonly identityPrefix: string;
  readonly targetId: string;
  readonly sourceEvidence: unknown;
  readonly runtimeSnapshotEvidence: unknown;
  readonly runtimeDescriptor: unknown;
  readonly catalog: unknown;
  readonly toolName: string;
  readonly arguments: unknown;
  readonly createdAt: string;
  readonly reviewedAt: string;
  readonly expiresAt: string;
}

export interface EnrolledExperimentInputs {
  readonly compileInput: CompileExperimentPlanInput;
  readonly compiled: CompiledExperimentPlanV2;
  readonly target: TargetIdentityV2;
  readonly targetIdentityDigest: string;
  readonly runtimeDescriptor: RuntimeDescriptorV2;
  readonly sourceArtifactBytes: Uint8Array;
  readonly runtimeSnapshotBytes: Uint8Array;
  readonly claimProfile: ClaimProfileV2;
  readonly policy: ApprovedPolicyV2;
  readonly auditSpec: AuditSpecV2;
  readonly mandatoryCase: MandatoryCaseTemplateV2;
  readonly caseId: string;
  readonly stepId: string;
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalizeJson(value), "utf8");
}

/**
 * Build the target-independent, result-channel-only plan used after enrollment.
 * The plan does not claim that hidden filesystem, process, or network behavior
 * was observed. Those effects remain outside this alpha's sensor coverage.
 */
export function createEnrolledSingleCallExperiment(
  input: CreateEnrolledExperimentInput,
): EnrolledExperimentInputs {
  const runtimeDescriptor = runtimeDescriptorV2Schema.parse(
    input.runtimeDescriptor,
  );
  const sourceArtifactBytes = jsonBytes(input.sourceEvidence);
  const runtimeSnapshotBytes = jsonBytes(input.runtimeSnapshotEvidence);
  const target = targetIdentityV2Schema.parse({
    targetId: input.targetId,
    sourceArtifact: artifactReferenceFromBytes(
      {
        artifactId: `${input.identityPrefix}-source`,
        kind: "source_bundle",
        mediaType: "application/json",
      },
      sourceArtifactBytes,
    ),
    runtimeSnapshot: artifactReferenceFromBytes(
      {
        artifactId: `${input.identityPrefix}-runtime`,
        kind: "runtime_snapshot",
        mediaType: "application/vnd.forge.runtime-tree+json",
      },
      runtimeSnapshotBytes,
    ),
    runtimeTreeAlgorithm: "forge.runtime-tree/v2",
    runtimeDescriptorDigest: digestCanonicalJson(
      "forge.runtime-descriptor",
      "v2",
      runtimeDescriptor,
    ),
  });
  const targetIdentityDigest = digestCanonicalJson(
    "forge.target-identity",
    "v2",
    target,
  );
  const catalogIdentity = computeCatalogIdentity(
    input.catalog,
    ENROLLED_DISCOVERY_CATALOG_BOUNDS,
  );
  const claimProfile = claimProfileV2Schema.parse({
    schema: "forge.claim-profile/v2",
    profileId: `${input.identityPrefix}-claims`,
    generatedAt: input.createdAt,
    target,
    catalog: catalogIdentity.identity,
    generator: {
      id: "forge-enrollment-controller",
      version: "1alpha1",
    },
    claims: [],
    unsupportedDimensions: [
      "Enrollment does not infer trusted capability claims from untrusted MCP metadata.",
      "Filesystem, process, and network behavior are not assessed by the result-channel-only alpha.",
    ],
    truncations: [],
    limitations: [
      "An empty trusted-claim set does not mean the enrolled target has no capabilities.",
    ],
  });
  const caseId = `${input.identityPrefix}-call`;
  const stepId = `${input.identityPrefix}-step`;
  const policy = approvedPolicyV2Schema.parse({
    schema: "forge.audit-policy/v2",
    policyId: `${input.identityPrefix}-policy`,
    version: "1alpha1",
    owner: "forge-enrollment-controller",
    createdAt: input.createdAt,
    reviewedAt: input.reviewedAt,
    expiresAt: input.expiresAt,
    subject: {
      kind: "exact_target",
      targetId: target.targetId,
      targetIdentityDigest,
    },
    subjectBehaviorRules: {
      defaultDecision: "deny",
      rules: [
        {
          ruleId: `${input.identityPrefix}-receive`,
          decision: "allow",
          toolNames: [input.toolName],
          actions: ["receive"],
          resourceClasses: ["structured_data"],
          phases: ["post_return"],
          selectors: [],
          limits: {
            maxOperations: 1,
            maxBytes: ENROLLED_SINGLE_CALL_BOUNDS.maxOutputBytesPerStep,
            maxRuntimeMs: ENROLLED_SINGLE_CALL_BOUNDS.maxCaseRuntimeMs,
          },
          rationale:
            "Allow one manually reviewed result to enter local quarantine.",
        },
      ],
    },
    experimentDispatchRules: {
      defaultDecision: "deny",
      rules: [
        {
          ruleId: `${input.identityPrefix}-dispatch`,
          decision: "approval_required",
          toolNames: [input.toolName],
          allowedOrigins: ["mandatory"],
          argumentRules: [],
          // Literal arguments have no synthetic-resource provenance, so the
          // compiler conservatively adds `unknown` alongside the predicted
          // quarantined result class. Exact arguments are narrowed again by
          // the independent review and dispatch capabilities.
          allowedResourceClasses: ["structured_data", "unknown"],
          allowedDataFlows: [],
          limits: {
            maxCases: ENROLLED_SINGLE_CALL_BOUNDS.maxCases,
            maxStepsPerCase: ENROLLED_SINGLE_CALL_BOUNDS.maxStepsPerCase,
            maxSteps: ENROLLED_SINGLE_CALL_BOUNDS.maxTotalSteps,
            maxArgumentBytes: ENROLLED_SINGLE_CALL_BOUNDS.maxArgumentBytes,
            maxRuntimeMs: ENROLLED_SINGLE_CALL_BOUNDS.maxCaseRuntimeMs,
            maxTotalRuntimeMs:
              ENROLLED_SINGLE_CALL_BOUNDS.maxTotalRuntimeMs,
            maxOutputBytesPerStep:
              ENROLLED_SINGLE_CALL_BOUNDS.maxOutputBytesPerStep,
            maxTotalOutputBytes:
              ENROLLED_SINGLE_CALL_BOUNDS.maxTotalOutputBytes,
            maxWritableBytes: ENROLLED_SINGLE_CALL_BOUNDS.maxWritableBytes,
            maxWritableFiles: ENROLLED_SINGLE_CALL_BOUNDS.maxWritableFiles,
            maxFileBytes: ENROLLED_SINGLE_CALL_BOUNDS.maxFileBytes,
            maxProcesses: ENROLLED_SINGLE_CALL_BOUNDS.maxProcesses,
            maxMemoryMb: ENROLLED_SINGLE_CALL_BOUNDS.maxMemoryMb,
            maxCpuMs: ENROLLED_SINGLE_CALL_BOUNDS.maxCpuMs,
            maxOpenFiles: ENROLLED_SINGLE_CALL_BOUNDS.maxOpenFiles,
          },
          minimumApprovalClass: "operator_review",
          rationale:
            "Dispatch requires a separate exact-call review capability.",
        },
      ],
    },
    requiredMandatoryCaseIds: [caseId],
    minimumCoverage: {
      minimumToolCoveragePercent: 0,
      requiredPartitions: ["nominal"],
      requiredPhases: ["post_return"],
      requiredSensors: [
        "process",
        "filesystem",
        "network",
        "mcp_transcript",
        "cleanup",
      ],
    },
  });
  const mandatoryCase = mandatoryCaseTemplateV2Schema.parse({
    caseId,
    kind: "tool_call",
    description:
      "Issue one exact manually reviewed call against the retained enrolled snapshot.",
    steps: [
      {
        stepId,
        toolName: input.toolName,
        arguments: input.arguments,
      },
    ],
    predictedEffects: [
      {
        predictionId: `${input.identityPrefix}-receive-prediction`,
        origin: "deterministic_generator",
        action: "receive",
        resourceClass: "structured_data",
        phase: "post_return",
        confidence: "medium",
        evidenceBasis: [
          {
            kind: "deterministic_rule",
            reference:
              "A completed MCP tools/call returns a locally quarantined result.",
          },
        ],
        limitations: [
          "This predicts only the result channel and is not a claim about other target behavior.",
        ],
      },
    ],
    assertions: [
      {
        assertionId: `${input.identityPrefix}-status`,
        kind: "tool_status",
        subject: input.toolName,
        expected: "succeeded",
        required: true,
      },
    ],
    minimumApprovalClass: "operator_review",
  });
  const claimProfileDigest = digestCanonicalJson(
    "forge.claim-profile",
    "v2",
    claimProfile,
  );
  const policyDigest = digestCanonicalJson("forge.audit-policy", "v2", policy);
  const mandatoryCases = [mandatoryCase];
  const auditSpec = auditSpecV2Schema.parse({
    schema: "forge.audit-spec/v2",
    specId: `${input.identityPrefix}-spec`,
    createdAt: input.reviewedAt,
    targetSelector: {
      targetId: target.targetId,
      sourceArtifactSha256: target.sourceArtifact.sha256,
    },
    policyDigest,
    claimProfileDigest,
    mandatorySuiteDigest: digestCanonicalJson(
      "forge.mandatory-case-suite",
      "v2",
      mandatoryCases,
    ),
    generator: {
      id: "forge-enrollment-controller",
      version: "1alpha1",
    },
    agentProposals: "disabled",
    repetitions: 1,
    environmentVariants: ["default"],
    prePlanRequirements: {
      acquisition: "required",
      scriptsDisabledPreparation: "required",
      lifecycleComparison: "when_supported",
      initializationObservation: "required",
      completeCatalogDiscovery: "required",
      cleanupVerification: "required",
    },
    prePlanBounds: {
      maxRuntimeMs: 30_000,
      maxArtifactBytes: 4_194_304,
      maxCatalogPages: 1,
      maxCatalogTools: 1_000,
      maxCatalogBytes: 1_000_000,
    },
    executionBounds: ENROLLED_SINGLE_CALL_BOUNDS,
    mandatoryCaseReservation: 1,
    requiredSensors: [
      "process",
      "filesystem",
      "network",
      "mcp_transcript",
      "cleanup",
    ],
    unsupportedCaseHandling: "reject",
    syntheticResources: [],
    manualCases: [],
  });
  const compileInput: CompileExperimentPlanInput = {
    planId: `${input.identityPrefix}-plan`,
    manifestId: `${input.identityPrefix}-resources`,
    compiledAt: input.reviewedAt,
    target: {
      identity: target,
      sourceArtifactBytes,
      runtimeSnapshotBytes,
      runtimeDescriptor,
    },
    catalog: input.catalog,
    claimProfile,
    policy,
    auditSpec,
    mandatoryCases,
  };
  const compiled = compileExperimentPlan(compileInput);
  return Object.freeze({
    compileInput,
    compiled,
    target,
    targetIdentityDigest,
    runtimeDescriptor,
    sourceArtifactBytes,
    runtimeSnapshotBytes,
    claimProfile,
    policy,
    auditSpec,
    mandatoryCase,
    caseId,
    stepId,
  });
}
