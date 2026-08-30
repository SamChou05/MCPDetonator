import { createHash } from "node:crypto";
import { lstat, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import {
  approvedPolicyV2Schema,
  agentOutcomeHypothesisDraftV2Schema,
  auditSpecV2Schema,
  claimProfileV2Schema,
  experimentPlanV2Schema,
  identifierV2Schema,
  mcpEnrollmentRecordV2AlphaSchema,
  mcpEnrollmentRejectionV2AlphaSchema,
  mcpEnrollmentReviewRecordV2AlphaSchema,
  outcomeComparisonV2Schema,
  outcomeHypothesisV2Schema,
  outcomeObservationV2Schema,
  type McpEnrollmentRecordV2Alpha,
  type McpEnrollmentRejectionReasonV2Alpha,
  type McpEnrollmentRejectionStageV2Alpha,
  type McpEnrollmentRejectionV2Alpha,
  type McpEnrollmentReviewRecordV2Alpha,
  type OutcomeComparisonV2,
  type OutcomeHypothesisV2,
  type OutcomeObservationV2,
} from "../../contracts/v2/index.js";
import {
  loadTargetConfig,
  resolveLocalSourcePath,
  type LoadedTargetConfig,
} from "../../config.js";
import { EvidenceStore, sha256, sha256File } from "../../evidence-store.js";
import { runMcpExperiment } from "../../mcp/stdio.js";
import { removeManagedContainer } from "../../sandbox/docker.js";
import {
  NpmAcquisitionError,
  TargetPreparationCleanupError,
  prepareTarget,
  type PreparedTarget,
} from "../../target/prepare.js";
import {
  createEnrolledTargetAuthority,
  type PreparedEnrolledDispatch,
  type RetainedEnrolledResources,
} from "./enrolled-authority.js";
import {
  assertOutputOnlyStringsQuarantined,
  inspectEnrolledTranscript,
  materializeEmptyEnrolledResources,
  type EnrolledTranscriptMetrics,
} from "./enrolled-evidence.js";
import {
  createEnrolledSingleCallExperiment,
  ENROLLED_SINGLE_CALL_BOUNDS,
  ENROLLED_DISCOVERY_CATALOG_BOUNDS,
  type EnrolledExperimentInputs,
} from "./enrolled-experiment.js";
import {
  ENROLLED_NODE_STDIO_SANDBOX_IDENTITY,
  createEnrolledNodeStdioDockerInvocation,
  type EnrolledNodeStdioDockerInvocation,
  type VerifiedV2SandboxImage,
} from "./enrolled-sandbox.js";
import {
  DEFAULT_ENROLLED_APPLICATION_ARGUMENT_LIMITS,
  snapshotPreparedRuntimeTree,
  validateEnrolledNodeRuntime,
  verifyPreparedRuntimeTree,
  type NormalizedEnrolledNodeInvocation,
  type PreparedRuntimeTreeSnapshot,
} from "./enrolled-runtime.js";
import { computeCatalogIdentity } from "./catalog.js";
import type { NormalizedCatalogToolV2 } from "./catalog.js";
import { digestCanonicalJson } from "./canonical.js";
import { verifyPinnedControlledSandboxImage } from "./controlled-sandbox.js";
import {
  compareOutcome,
  compileAgentOutcomeHypothesis,
  verifyOutcomeComparison,
} from "./outcome-comparison.js";
import { buildOutcomeObservation } from "./runtime-observation.js";
import { deepFreezeJson } from "./freeze.js";
import {
  cloneStrictBoundedJson,
  V2_ARTIFACT_CLONE_LIMITS,
} from "./strict-clone.js";

export const ENROLLED_RUN_ATTEMPT_FORMAT =
  "forge.enrolled-one-call-attempt/v1alpha1" as const;
export const ENROLLED_RUN_FAILURE_FORMAT =
  "forge.enrolled-one-call-failure/v1alpha1" as const;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const REVIEW_CALLBACK_TIMEOUT_MS = 30_000;

const reviewedBindingsSchema = z
  .object({
    enrollmentDigest: digestSchema,
    experimentPlanDigest: digestSchema,
    hypothesisDigest: digestSchema,
    caseId: identifierV2Schema,
    stepId: identifierV2Schema,
    toolName: z.string().min(1).max(128),
    argumentSha256: digestSchema,
  })
  .strict();

const enrolledCleanupReceiptSchema = z
  .object({
    format: z.literal("forge.enrolled-cleanup-receipt/v1alpha1"),
    runId: identifierV2Schema,
    phase: z.enum(["discovery", "rejection", "execution", "failure"]),
    container: z
      .object({
        nameSha256: digestSchema,
        absent: z.boolean(),
      })
      .strict(),
    hostInputs: z
      .array(
        z
          .object({
            kind: z.enum(["prepared_target", "synthetic_resources"]),
            rootSha256: digestSchema,
            disposition: z.enum(["retained", "absent", "unverified"]),
          })
          .strict(),
      )
      .max(2),
    verified: z.boolean(),
    verifiedAt: z.string().datetime({ offset: true }),
    limitations: z.array(z.string().min(1).max(1_024)).max(4),
  })
  .strict();

const enrolledDispatchReceiptEvidenceSchema = z
  .object({
    format: z.literal("forge.enrolled-dispatch-receipt/v1alpha1"),
    enrollmentDigest: digestSchema,
    reviewDigest: digestSchema,
    experimentPlanDigest: digestSchema,
    policyDigest: digestSchema,
    hypothesisDigest: digestSchema,
    caseId: identifierV2Schema,
    stepId: identifierV2Schema,
    toolName: z.string().min(1).max(128),
    argumentSha256: digestSchema,
    liveCatalogDigest: digestSchema,
    runtimeInvocationDigest: digestSchema,
    dockerInvocationDigest: digestSchema,
    consumedAt: z.string().datetime({ offset: true }),
    checkedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    sequence: z.literal(0),
    authority: z
      .object({
        opaqueReceiptVerified: z.literal(true),
        serializedReceiptIsBearerAuthority: z.literal(false),
        authorizesRetry: z.literal(false),
        authorizesFollowup: z.literal(false),
      })
      .strict(),
  })
  .strict();

const enrolledEvidenceIndexSchema = z
  .object({
    format: z.literal("forge.enrolled-evidence-index/v1alpha1"),
    runId: identifierV2Schema,
    artifacts: z
      .array(
        z
          .object({
            evidenceId: identifierV2Schema,
            artifactPath: z
              .string()
              .min(1)
              .max(512)
              .refine(
                (value) =>
                  !value.startsWith("/") &&
                  !value.split("/").includes("..") &&
                  !value.includes("\\"),
                "artifact path must remain below the run root",
              ),
            sha256: digestSchema,
            byteLength: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(32)
      .superRefine((artifacts, context) => {
        const ids = new Set<string>();
        const paths = new Set<string>();
        for (const [index, artifact] of artifacts.entries()) {
          if (ids.has(artifact.evidenceId)) {
            context.addIssue({
              code: "custom",
              path: [index, "evidenceId"],
              message: "duplicate evidence ID",
            });
          }
          if (paths.has(artifact.artifactPath)) {
            context.addIssue({
              code: "custom",
              path: [index, "artifactPath"],
              message: "duplicate artifact path",
            });
          }
          ids.add(artifact.evidenceId);
          paths.add(artifact.artifactPath);
        }
      }),
  })
  .strict();

export const enrolledRunAttemptSchema = z
  .object({
    format: z.literal(ENROLLED_RUN_ATTEMPT_FORMAT),
    runId: z.string().min(1).max(128),
    targetId: z.string().min(1).max(128),
    enrollmentDigest: digestSchema,
    reviewDigest: digestSchema,
    experimentPlanDigest: digestSchema,
    hypothesisDigest: digestSchema,
    observationDigest: digestSchema,
    comparisonDigest: digestSchema,
    targetTreeSha256: digestSchema,
    runtimeInvocationDigest: digestSchema,
    sandboxProfileDigest: digestSchema,
    liveCatalogDigest: digestSchema,
    selectedCall: z
      .object({
        caseId: z.string().min(1),
        stepId: z.string().min(1),
        toolName: z.string().min(1),
        argumentSha256: digestSchema,
      })
      .strict(),
    dispatch: z
      .object({
        requestedCalls: z.literal(1),
        sentCalls: z.literal(1),
        retries: z.literal(0),
        followupCalls: z.literal(0),
        monitorChecks: z.literal(1),
        receiptDigest: digestSchema,
        checkedAt: z.string().datetime({ offset: true }),
        runtimeInvocationDigest: digestSchema,
        dockerInvocationDigest: digestSchema,
      })
      .strict(),
    transcript: z
      .object({
        sha256: digestSchema,
        byteLength: z.number().int().positive(),
        toolsListRequests: z.literal(1),
        toolsCallRequests: z.literal(1),
        toolsListChangedNotifications: z.literal(0),
        messageCount: z.number().int().positive(),
        initializeRequests: z.literal(1),
        initializedNotifications: z.literal(1),
        unexpectedServerRequests: z.literal(0),
        unexpectedClientMethods: z.literal(0),
        sequenceContiguous: z.literal(true),
      })
      .strict(),
    comparisonSummary: z
      .object({
        expectation: z.enum(["matches", "deviates", "inconclusive"]),
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
    sensorCoverage: z
      .object({
        complete: z.array(z.string()),
        incomplete: z.array(z.string()),
      })
      .strict(),
    cleanup: z
      .object({
        containerAbsent: z.literal(true),
        hostTemporaryInputsAbsent: z.literal(true),
        verifiedAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    quarantine: z
      .object({
        exposure: z.literal("local_quarantine_only"),
        outputOnlyStringEscapeCheck: z.literal("passed"),
        exposedToPlanner: z.literal(false),
        exposedToProvider: z.literal(false),
        usedForFollowup: z.literal(false),
      })
      .strict(),
    authority: z
      .object({
        recordAuthorizesRetry: z.literal(false),
        recordAuthorizesFollowup: z.literal(false),
        recordDeclaresTargetSafe: z.literal(false),
      })
      .strict(),
    limitations: z.array(z.string().min(1).max(4_096)).min(1).max(16),
  })
  .strict();

export const enrolledRunFailureSchema = z
  .object({
    format: z.literal(ENROLLED_RUN_FAILURE_FORMAT),
    runId: z.string().min(1).max(128),
    targetId: z.string().min(1).max(128),
    failedAt: z.string().datetime({ offset: true }),
    stage: z.enum([
      "review",
      "session_before_monitor",
      "pre_dispatch_monitor",
      "transport_before_send",
      "runtime_or_protocol",
      "post_return_verification",
      "cleanup_verification",
    ]),
    dispatch: z
      .object({
        requestedCalls: z.literal(1),
        sentCalls: z.union([z.literal(0), z.literal(1)]),
        retries: z.literal(0),
        followupCalls: z.literal(0),
      })
      .strict(),
    review: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("not_completed"),
          approvalIssued: z.literal(false),
          reasonCode: z.enum([
            "not_reached",
            "proposal_callback_failed",
            "proposal_callback_timeout",
            "proposal_invalid",
            "manual_callback_failed",
            "manual_callback_timeout",
            "manual_decision_invalid",
            "manual_binding_mismatch",
          ]),
        })
        .strict(),
      z
        .object({
          status: z.literal("declined"),
          approvalIssued: z.literal(false),
          reviewerId: identifierV2Schema,
          decidedAt: z.string().datetime({ offset: true }),
          reviewedBindings: reviewedBindingsSchema,
        })
        .strict(),
      z
        .object({
          status: z.literal("approved"),
          approvalIssued: z.literal(true),
          reviewerId: identifierV2Schema,
          reviewedAt: z.string().datetime({ offset: true }),
          reviewDigest: digestSchema,
          reviewedBindings: reviewedBindingsSchema,
        })
        .strict(),
    ]),
    transcript: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("available"),
          sha256: digestSchema,
          byteLength: z.number().int().positive(),
          toolsListRequests: z.number().int().nonnegative(),
          toolsCallRequests: z.number().int().nonnegative(),
          toolsListChangedNotifications: z.number().int().nonnegative(),
          messageCount: z.number().int().positive(),
          initializeRequests: z.number().int().nonnegative(),
          initializedNotifications: z.number().int().nonnegative(),
          unexpectedServerRequests: z.number().int().nonnegative(),
          unexpectedClientMethods: z.number().int().nonnegative(),
          sequenceContiguous: z.literal(true),
        })
        .strict(),
      z
        .object({
          status: z.literal("unavailable"),
          reason: z.literal("bounded_transcript_unavailable"),
        })
        .strict(),
    ]),
    cleanup: z
      .object({
        status: z.enum(["verified", "failed"]),
        hostInputsRetained: z.boolean(),
        evidenceReference: z.string().min(1).max(256),
      })
      .strict(),
    quarantine: z
      .object({
        exposure: z.literal("local_quarantine_only"),
        exposedToPlanner: z.literal(false),
        exposedToProvider: z.literal(false),
        usedForFollowup: z.literal(false),
      })
      .strict(),
    authority: z
      .object({
        recordAuthorizesRetry: z.literal(false),
        recordAuthorizesFollowup: z.literal(false),
        recordDeclaresTargetSafe: z.literal(false),
      })
      .strict(),
    limitations: z.array(z.string().min(1).max(4_096)).min(1).max(8),
  })
  .strict();

const enrolledManualReviewDecisionSchema = z
  .object({
    decision: z.enum(["approved", "declined"]),
    reviewerId: identifierV2Schema,
    reviewedBindings: reviewedBindingsSchema,
  })
  .strict();

export interface EnrolledHypothesisProposalRequest {
  readonly targetId: string;
  readonly enrollment: Readonly<McpEnrollmentRecordV2Alpha>;
  readonly enrollmentDigest: string;
  readonly experimentPlanDigest: string;
  readonly policyDigest: string;
  readonly exactCall: Readonly<{
    caseId: string;
    stepId: string;
    toolName: string;
    arguments: Readonly<Record<string, unknown>>;
    argumentSha256: string;
  }>;
  /** Bounded but untrusted advertised metadata. It cannot authorize dispatch. */
  readonly advertisedTool: Readonly<NormalizedCatalogToolV2>;
  /** Aborted when the controller's callback deadline expires. */
  readonly signal: AbortSignal;
  readonly authority: Readonly<{
    authorizesExecution: false;
    grantsApproval: false;
    declaresSafety: false;
  }>;
}

export interface EnrolledExactCallReviewRequest
  extends EnrolledHypothesisProposalRequest {
  readonly hypothesis: Readonly<OutcomeHypothesisV2>;
  readonly hypothesisDigest: string;
  /** Full bounded artifacts the operator is being asked to approve. */
  readonly plan: Readonly<z.infer<typeof experimentPlanV2Schema>>;
  readonly policy: Readonly<z.infer<typeof approvedPolicyV2Schema>>;
}

export type EnrolledManualReviewDecision = z.infer<
  typeof enrolledManualReviewDecisionSchema
>;

export interface RunEnrolledOutcomeExperimentOptions {
  readonly targetConfigPath: string;
  readonly outputRoot: string;
  readonly runId: string;
  readonly experimentId?: string;
  /** Optional pre-result proposer. Its output is schema checked and non-authoritative. */
  readonly proposeHypothesis?: (
    request: Readonly<EnrolledHypothesisProposalRequest>,
  ) => unknown | Promise<unknown>;
  /** Required post-plan exact-call review. The echoed bindings fail closed. */
  readonly requestManualReview: (
    request: Readonly<EnrolledExactCallReviewRequest>,
  ) => unknown | Promise<unknown>;
}

export interface CompletedEnrolledOutcomeRun {
  readonly status: "completed";
  readonly runId: string;
  readonly runDirectory: string;
  readonly enrollment: Readonly<McpEnrollmentRecordV2Alpha>;
  readonly enrollmentDigest: string;
  readonly review: Readonly<McpEnrollmentReviewRecordV2Alpha>;
  readonly reviewDigest: string;
  readonly hypothesis: Readonly<OutcomeHypothesisV2>;
  readonly observation: Readonly<OutcomeObservationV2>;
  readonly comparison: Readonly<OutcomeComparisonV2>;
  readonly attempt: z.infer<typeof enrolledRunAttemptSchema>;
}

export interface RejectedEnrolledOutcomeRun {
  readonly status: "rejected";
  readonly runId: string;
  readonly runDirectory: string;
  readonly rejection: Readonly<McpEnrollmentRejectionV2Alpha>;
}

export type EnrolledOutcomeExecutionFailure = z.infer<
  typeof enrolledRunFailureSchema
>;

export interface FailedEnrolledOutcomeRun {
  readonly status: "failed";
  readonly runId: string;
  readonly runDirectory: string;
  readonly failure: Readonly<EnrolledOutcomeExecutionFailure>;
}

export type EnrolledOutcomeRunResult =
  | CompletedEnrolledOutcomeRun
  | RejectedEnrolledOutcomeRun
  | FailedEnrolledOutcomeRun;

function timestamp(): string {
  return new Date().toISOString();
}

function after(timestampValue: string, milliseconds: number): string {
  return new Date(Date.parse(timestampValue) + milliseconds).toISOString();
}

function shortRunHash(runId: string): string {
  return createHash("sha256").update(runId, "utf8").digest("hex").slice(0, 12);
}

function sanitizedFailure(message: string): Error {
  return new Error(
    `enrolled MCP execution failed: ${message}; inspect the local quarantined run evidence`,
  );
}

type FailureReviewOutcome = z.infer<
  typeof enrolledRunFailureSchema
>["review"];

type ReviewFailureReason = Extract<
  FailureReviewOutcome,
  { status: "not_completed" }
>["reasonCode"];

class ReviewStageError extends Error {
  public constructor(readonly reasonCode: ReviewFailureReason) {
    super("bounded enrollment review stage failed");
    this.name = "ReviewStageError";
  }
}

async function invokeCallbackWithinDeadline<TRequest, TResult>(input: {
  readonly callback: (request: Readonly<TRequest>) => TResult | Promise<TResult>;
  readonly request: Omit<TRequest, "signal">;
  readonly timeoutReason: ReviewFailureReason;
  readonly failureReason: ReviewFailureReason;
}): Promise<TResult> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ReviewStageError(input.timeoutReason));
      }, REVIEW_CALLBACK_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() =>
          input.callback(
            Object.freeze({
              ...input.request,
              signal: controller.signal,
            }) as Readonly<TRequest>,
          ),
        ),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof ReviewStageError) throw error;
      throw new ReviewStageError(input.failureReason);
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

class EnrollmentRejectionSignal extends Error {
  public constructor(
    readonly stage: McpEnrollmentRejectionStageV2Alpha,
    readonly reason: McpEnrollmentRejectionReasonV2Alpha,
    message: string,
  ) {
    super(message);
    this.name = "EnrollmentRejectionSignal";
  }
}

function rejectEnrollment(
  stage: McpEnrollmentRejectionStageV2Alpha,
  reason: McpEnrollmentRejectionReasonV2Alpha,
  message: string,
): never {
  throw new EnrollmentRejectionSignal(stage, reason, message);
}

function assertSupportedEnrollmentSource(loaded: LoadedTargetConfig): void {
  const source = loaded.config.target.source;
  if (source.type === "npm") return;
  if (source.type === "local" && source.install === "none") return;
  rejectEnrollment(
    "configuration",
    "unsupported_source",
    "the enrollment alpha accepts only exact npm sources or pre-populated local snapshots without installation",
  );
}

function runtimeDescriptorFromConfig(loaded: LoadedTargetConfig) {
  const runtime = loaded.config.target.runtime;
  return {
    transport: runtime.transport,
    protocol: "mcp" as const,
    command: runtime.command,
    args: runtime.args,
    cwd: runtime.cwd,
    environment: runtime.env,
  };
}

function selectExperiment(
  loaded: LoadedTargetConfig,
  requestedId: string | undefined,
) {
  const candidates = loaded.config.experiments.tools;
  if (requestedId === undefined && candidates.length !== 1) {
    throw new Error(
      "single-call enrollment requires exactly one configured experiment or an explicit experimentId",
    );
  }
  const selected =
    requestedId === undefined
      ? candidates[0]
      : candidates.find((candidate) => candidate.id === requestedId);
  if (selected === undefined) {
    throw new Error("selected enrollment experiment is unavailable");
  }
  return selected;
}

function sourceProvenance(input: {
  readonly loaded: LoadedTargetConfig;
  readonly preparedTarget: PreparedTarget;
  readonly snapshot: Readonly<PreparedRuntimeTreeSnapshot>;
  readonly sourceArtifactSha256: string;
}) {
  const common = {
    sourceTreeSha256: input.snapshot.treeSha256,
    sourceEntryCount: input.snapshot.summary.entryCount,
    sourceRegularFileBytes: input.snapshot.summary.fileBytesHashed,
    sourceArtifactSha256: input.sourceArtifactSha256,
    lifecycleScripts: "disabled" as const,
  };
  const source = input.preparedTarget.provenance.source;
  if (source.type === "npm") {
    if (
      source.resolved === undefined ||
      source.integrity === undefined ||
      input.preparedTarget.provenance.packageLockSha256 === undefined
    ) {
      throw new Error(
        "npm enrollment requires retained tarball, integrity, and lockfile identity",
      );
    }
    return {
      kind: "npm" as const,
      ...common,
      package: source.package,
      requestedVersion: source.requestedVersion,
      resolvedVersion: source.resolvedVersion,
      resolvedTarball: source.resolved,
      integrity: source.integrity,
      packageLockSha256:
        input.preparedTarget.provenance.packageLockSha256,
      acquisitionNetwork: "networked_package_acquisition" as const,
    };
  }
  if (
    input.loaded.config.target.source.type !== "local" ||
    source.type !== "local"
  ) {
    throw new Error("generic enrollment accepts npm or explicit local snapshots only");
  }
  const sourcePath = resolveLocalSourcePath(input.loaded);
  if (sourcePath === undefined) {
    throw new Error("local enrollment source path is unavailable");
  }
  return {
    kind: "local_snapshot" as const,
    ...common,
    configuredPathSha256: sha256(sourcePath),
    installMode: "none" as const,
    ...(input.preparedTarget.provenance.packageLockSha256 === undefined
      ? {}
      : {
          packageLockSha256:
            input.preparedTarget.provenance.packageLockSha256,
        }),
    acquisitionNetwork: "none" as const,
  };
}

function enrollmentRecord(input: {
  readonly enrollmentId: string;
  readonly recordedAt: string;
  readonly loaded: LoadedTargetConfig;
  readonly preparedTarget: PreparedTarget;
  readonly snapshot: Readonly<PreparedRuntimeTreeSnapshot>;
  readonly snapshotCapturedAt: string;
  readonly runtime: Readonly<NormalizedEnrolledNodeInvocation>;
  readonly runtimeValidatedAt: string;
  readonly image: VerifiedV2SandboxImage;
  readonly sandboxVerifiedAt: string;
  readonly discoveryStartedAt: string;
  readonly discoveryCompletedAt: string;
  readonly discoveryCleanupVerifiedAt: string;
  readonly discoveryTranscript: Readonly<EnrolledTranscriptMetrics>;
  readonly discoveryCatalog: unknown;
  readonly discoveryBackendProfileDigest: string;
  readonly experiment: EnrolledExperimentInputs;
}): Readonly<McpEnrollmentRecordV2Alpha> {
  const catalog = computeCatalogIdentity(
    input.discoveryCatalog,
    ENROLLED_DISCOVERY_CATALOG_BOUNDS,
  );
  return mcpEnrollmentRecordV2AlphaSchema.parse({
    format: "forge.mcp-enrollment/v1alpha1",
    enrollmentId: input.enrollmentId,
    recordedAt: input.recordedAt,
    enroller: { id: "forge-node-stdio-enroller", version: "1alpha1" },
    target: {
      identity: input.experiment.target,
      identityDigest: input.experiment.targetIdentityDigest,
    },
    source: {
      acquiredAt: input.preparedTarget.provenance.preparedAt,
      evidenceReference: "target-provenance",
      provenance: sourceProvenance({
        loaded: input.loaded,
        preparedTarget: input.preparedTarget,
        snapshot: input.snapshot,
        sourceArtifactSha256: input.experiment.target.sourceArtifact.sha256,
      }),
    },
    preparedTree: {
      format: input.snapshot.format,
      complete: input.snapshot.complete,
      scope: input.snapshot.scope,
      specialEntriesRejected: input.snapshot.specialEntriesRejected,
      treeSha256: input.snapshot.treeSha256,
      evidenceReference: "prepared-runtime-tree",
      runtimeSnapshotArtifactSha256:
        input.experiment.target.runtimeSnapshot.sha256,
      counters: input.snapshot.summary,
      limits: input.snapshot.limits,
      capturedAt: input.snapshotCapturedAt,
    },
    runtime: {
      runtimeDescriptorDigest:
        input.experiment.target.runtimeDescriptorDigest,
      invocation: input.runtime,
      argumentLimits: DEFAULT_ENROLLED_APPLICATION_ARGUMENT_LIMITS,
      validatedAt: input.runtimeValidatedAt,
    },
    sandbox: {
      profile: ENROLLED_NODE_STDIO_SANDBOX_IDENTITY,
      profileDigest: input.discoveryBackendProfileDigest,
      imageReference: input.image.imageReference,
      imageId: input.image.imageId,
      platform: "linux",
      imageDeclaredVolumes: false,
      network: "none",
      ipc: "none",
      readOnlyRootFilesystem: true,
      readOnlyTargetMount: true,
      readOnlySyntheticResourceMount: true,
      writableHostBinds: false,
      providerAvailable: false,
      maxCalls: 1,
      maxRetries: 0,
      authorizesFollowup: false,
      resultExposure: "local_quarantine_only",
      cleanupVerificationRequired: true,
      executionBounds: input.experiment.compiled.plan.bounds,
      verifiedAt: input.sandboxVerifiedAt,
    },
    discovery: {
      startedAt: input.discoveryStartedAt,
      completedAt: input.discoveryCompletedAt,
      catalog: catalog.identity,
      completeness: {
        complete: true,
        pageCount: 1,
        listChangedDuringDiscovery: false,
      },
      transcript: {
        evidenceReference: "enrollment-discovery-transcript",
        sha256: input.discoveryTranscript.sha256,
        byteLength: input.discoveryTranscript.byteLength,
        toolsListRequests: 1,
        toolsCallRequests: 0,
        toolsListChangedNotifications: 0,
      },
      limits: {
        maxPages: 1,
        maxTools: 1_000,
        maxTranscriptBytes: 2_000_000,
      },
      cleanup: {
        status: "verified_absent",
        containerAbsent: true,
        ephemeralDiscoveryInputsAbsent: true,
        preparedTargetDisposition: "retained_for_review",
        evidenceReference: "enrollment-discovery-cleanup",
        verifiedAt: input.discoveryCleanupVerifiedAt,
      },
    },
    eligibility: {
      status: "eligible_for_manual_review",
      executionClass: "enrolled_node_stdio_single_call",
      assessedAt: input.recordedAt,
      requiredApprovalClass: "operator_review",
      rejectionReasonCodes: [],
    },
    authority: {
      recordAuthorizesEnrollment: false,
      recordAuthorizesExecution: false,
      recordGrantsApproval: false,
      serializedRecordIsBearerAuthority: false,
      serializedCapabilityExists: false,
      requiresManualExactCallReview: true,
    },
    limitations: [
      "Enrollment proves bounded compatibility and exact identity, not benign behavior or target safety.",
      "Npm acquisition may use registry network; discovery and execution use no network or host secrets.",
      "Npm acquisition has no hard bind-mount disk quota and may fetch dependency URLs outside the npm registry; only the retained post-acquisition tree is bounded.",
      "Initialization and tools/list execute target code in each sandbox session before the sole reviewed tools/call.",
      "JavaScript entrypoint validation does not exclude transitive native add-ons, child processes, WebAssembly, or JIT execution inside the container.",
      "The retained target tree is freshly verified but is not a race-free metadata-complete filesystem snapshot.",
      "Filesystem, process, and network behavior remain unassessed in the result-channel-only alpha.",
      "The exact tool and arguments are operator-authored in target YAML; the optional hypothesis proposer predicts output but does not choose the call.",
    ],
  });
}

function classifyRejection(
  stage: McpEnrollmentRejectionStageV2Alpha,
  error: unknown,
): McpEnrollmentRejectionReasonV2Alpha {
  if (
    error instanceof EnrollmentRejectionSignal &&
    error.stage === stage
  ) {
    return error.reason;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  switch (stage) {
    case "configuration":
      return "invalid_target_config";
    case "acquisition":
      return "acquisition_failed";
    case "prepared_tree_snapshot":
      return code === "runtime_tree_limit"
        ? "prepared_tree_limit_exceeded"
        : "prepared_tree_incomplete";
    case "runtime_validation":
      return code === "invalid_descriptor"
        ? "unsupported_runtime"
        : "unsafe_node_invocation";
    case "sandbox_image_validation":
      return "sandbox_image_mismatch";
    case "discovery_startup":
      return "discovery_failed";
    case "catalog_validation":
      return code === "catalog_incomplete"
        ? "catalog_incomplete"
        : "catalog_limit_exceeded";
    case "discovery_cleanup":
      return "cleanup_unverified";
    case "eligibility":
      return code === "schema_unsupported"
        ? "input_schema_unsupported"
        : "no_safe_single_call_candidate";
  }
}

async function writeRejection(input: {
  readonly store: EvidenceStore;
  readonly runId: string;
  readonly startedAt: string;
  readonly targetId?: string;
  readonly configSha256?: string;
  readonly sourceKind?: "npm" | "local_snapshot";
  readonly stage: McpEnrollmentRejectionStageV2Alpha;
  readonly reason: McpEnrollmentRejectionReasonV2Alpha;
  readonly cleanup:
    | { readonly status: "not_started" }
    | { readonly status: "verified_absent"; readonly verifiedAt: string }
    | { readonly status: "verification_failed"; readonly verifiedAt: string };
}): Promise<Readonly<McpEnrollmentRejectionV2Alpha>> {
  const recordedAt = timestamp();
  const cleanup =
    input.cleanup.status === "not_started"
      ? {
          status: "not_started" as const,
          evidenceReferences: [],
          limitations: [],
        }
      : input.cleanup.status === "verified_absent"
        ? {
            status: "verified_absent" as const,
            evidenceReferences: ["enrollment-cleanup"],
            verifiedAt: input.cleanup.verifiedAt,
            limitations: [],
          }
        : {
            status: "verification_failed" as const,
            evidenceReferences: ["enrollment-cleanup"],
            verifiedAt: input.cleanup.verifiedAt,
            limitations: [
              "Container or retained host-input cleanup could not be fully verified.",
            ],
          };
  const rejection = mcpEnrollmentRejectionV2AlphaSchema.parse({
    format: "forge.mcp-enrollment-rejection/v1alpha1",
    rejectionId: `enrollment-rejection-${shortRunHash(input.runId)}`,
    startedAt: input.startedAt,
    recordedAt,
    candidate: {
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      ...(input.configSha256 === undefined
        ? {}
        : { configSha256: input.configSha256 }),
      ...(input.sourceKind === undefined ? {} : { sourceKind: input.sourceKind }),
    },
    stage: input.stage,
    reasonCodes: [input.reason],
    evidenceReferences: [],
    cleanup,
    authority: {
      recordAuthorizesEnrollment: false,
      recordAuthorizesExecution: false,
      recordAuthorizesRetry: false,
      recordGrantsApproval: false,
      serializedRecordIsBearerAuthority: false,
    },
    limitations: [
      "This bounded rejection omits raw target and package error text.",
      "A rejected target received no enrolled tools/call authority.",
    ],
  });
  await input.store.writeJson(
    "v2/enrollment/rejection.json",
    mcpEnrollmentRejectionV2AlphaSchema,
    rejection,
  );
  return rejection;
}

async function writeExecutionFailure(input: {
  readonly store: EvidenceStore;
  readonly runId: string;
  readonly targetId: string;
  readonly experimentId: string;
  readonly stage: z.infer<typeof enrolledRunFailureSchema>["stage"];
  readonly sentCalls: 0 | 1;
  readonly review: FailureReviewOutcome;
  readonly cleanupVerified: boolean;
  readonly cleanupEvidenceReference: string;
}): Promise<Readonly<EnrolledOutcomeExecutionFailure>> {
  let transcript:
    | ({ readonly status: "available" } & EnrolledTranscriptMetrics)
    | { readonly status: "unavailable"; readonly reason: "bounded_transcript_unavailable" };
  try {
    transcript = {
      status: "available",
      ...(await inspectEnrolledTranscript(
        input.store.pathFor(`raw/${input.experimentId}/mcp-transcript.jsonl`),
      )),
    };
  } catch {
    transcript = { status: "unavailable", reason: "bounded_transcript_unavailable" };
  }
  const failure = enrolledRunFailureSchema.parse({
    format: ENROLLED_RUN_FAILURE_FORMAT,
    runId: input.runId,
    targetId: input.targetId,
    failedAt: timestamp(),
    stage: input.stage,
    dispatch: {
      requestedCalls: 1,
      sentCalls: input.sentCalls,
      retries: 0,
      followupCalls: 0,
    },
    review: input.review,
    transcript:
      transcript.status === "available"
        ? {
            status: "available",
            sha256: transcript.sha256,
            byteLength: transcript.byteLength,
            messageCount: transcript.messageCount,
            toolsListRequests: transcript.toolsListRequests,
            toolsCallRequests: transcript.toolsCallRequests,
            toolsListChangedNotifications:
              transcript.toolsListChangedNotifications,
            initializeRequests: transcript.initializeRequests,
            initializedNotifications: transcript.initializedNotifications,
            unexpectedServerRequests: transcript.unexpectedServerRequests,
            unexpectedClientMethods: transcript.unexpectedClientMethods,
            sequenceContiguous: transcript.sequenceContiguous,
          }
        : transcript,
    cleanup: {
      status: input.cleanupVerified ? "verified" : "failed",
      hostInputsRetained: !input.cleanupVerified,
      evidenceReference: input.cleanupEvidenceReference,
    },
    quarantine: {
      exposure: "local_quarantine_only",
      exposedToPlanner: false,
      exposedToProvider: false,
      usedForFollowup: false,
    },
    authority: {
      recordAuthorizesRetry: false,
      recordAuthorizesFollowup: false,
      recordDeclaresTargetSafe: false,
    },
    limitations: [
      "This failure record retains bounded controller facts and no raw target error text.",
      "A sent call proves only guarded transport handoff, not target processing.",
    ],
  });
  await input.store.writeJson(
    "v2/execution/failure.json",
    enrolledRunFailureSchema,
    failure,
  );
  return failure;
}

interface HostCleanupFact {
  readonly kind: "prepared_target" | "synthetic_resources";
  readonly rootSha256: string;
  readonly disposition: "absent" | "unverified";
}

async function pathIsAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    );
  }
}

async function disposeInputs(input: {
  readonly preparedTarget: PreparedTarget | undefined;
  readonly resources: RetainedEnrolledResources | undefined;
}): Promise<Readonly<{ verified: boolean; hostInputs: readonly HostCleanupFact[] }>> {
  const roots = [
    ...(input.preparedTarget === undefined
      ? []
      : [
          {
            kind: "prepared_target" as const,
            root: dirname(input.preparedTarget.hostRoot),
          },
        ]),
    ...(input.resources === undefined
      ? []
      : [
          {
            kind: "synthetic_resources" as const,
            root: dirname(input.resources.hostRoot),
          },
        ]),
  ];
  if (input.resources !== undefined) {
    try {
      await input.resources.dispose();
    } catch {}
  }
  if (input.preparedTarget !== undefined) {
    try {
      await input.preparedTarget.dispose();
    } catch {}
  }
  const hostInputs: HostCleanupFact[] = [];
  for (const root of roots) {
    hostInputs.push({
      kind: root.kind,
      rootSha256: sha256(root.root),
      disposition: (await pathIsAbsent(root.root)) ? "absent" : "unverified",
    });
  }
  return Object.freeze({
    verified: hostInputs.every((entry) => entry.disposition === "absent"),
    hostInputs: Object.freeze(hostInputs),
  });
}

async function writeCleanupReceipt(input: {
  readonly store: EvidenceStore;
  readonly artifactPath: string;
  readonly runId: string;
  readonly phase: "discovery" | "rejection" | "execution" | "failure";
  readonly containerName: string;
  readonly containerAbsent: boolean;
  readonly hostInputs: readonly {
    kind: "prepared_target" | "synthetic_resources";
    rootSha256: string;
    disposition: "retained" | "absent" | "unverified";
  }[];
}): Promise<Readonly<z.infer<typeof enrolledCleanupReceiptSchema>>> {
  const verifiedAt = timestamp();
  const verified =
    input.containerAbsent &&
    input.hostInputs.every((entry) => entry.disposition !== "unverified");
  const receipt = enrolledCleanupReceiptSchema.parse({
    format: "forge.enrolled-cleanup-receipt/v1alpha1",
    runId: input.runId,
    phase: input.phase,
    container: {
      nameSha256: sha256(input.containerName),
      absent: input.containerAbsent,
    },
    hostInputs: input.hostInputs,
    verified,
    verifiedAt,
    limitations: [
      "Container absence is based on label-checked repeated Docker inspection; host absence is an exact post-removal lstat check.",
    ],
  });
  await input.store.writeJson(
    input.artifactPath,
    enrolledCleanupReceiptSchema,
    receipt,
  );
  return Object.freeze(receipt);
}

async function writeEvidenceIndex(input: {
  readonly store: EvidenceStore;
  readonly runId: string;
  readonly entries: readonly {
    evidenceId: string;
    artifactPath: string;
  }[];
}): Promise<void> {
  const artifacts = [];
  for (const entry of [...input.entries].sort((left, right) =>
    left.evidenceId.localeCompare(right.evidenceId),
  )) {
    const path = input.store.pathFor(entry.artifactPath);
    const metadata = await stat(path);
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size)) {
      throw new Error("enrolled evidence index requires regular bounded artifacts");
    }
    artifacts.push({
      evidenceId: entry.evidenceId,
      artifactPath: entry.artifactPath,
      sha256: await sha256File(path),
      byteLength: metadata.size,
    });
  }
  const index = enrolledEvidenceIndexSchema.parse({
    format: "forge.enrolled-evidence-index/v1alpha1",
    runId: input.runId,
    artifacts,
  });
  await input.store.writeJson(
    "v2/evidence-index.json",
    enrolledEvidenceIndexSchema,
    index,
  );
}

async function existingEvidenceEntries(
  store: EvidenceStore,
  candidates: readonly { evidenceId: string; artifactPath: string }[],
): Promise<readonly { evidenceId: string; artifactPath: string }[]> {
  const existing = [];
  for (const candidate of candidates) {
    if (!(await pathIsAbsent(store.pathFor(candidate.artifactPath)))) {
      existing.push(candidate);
    }
  }
  return existing;
}

/**
 * Acquire, discover, review, and execute one unfamiliar exact target. There is
 * no provider callback after result receipt, and no retry/follow-up surface.
 */
export async function runEnrolledOutcomeExperiment(
  options: RunEnrolledOutcomeExperimentOptions,
): Promise<EnrolledOutcomeRunResult> {
  identifierV2Schema.parse(options.runId);
  if (
    typeof options.targetConfigPath !== "string" ||
    options.targetConfigPath.length === 0 ||
    typeof options.outputRoot !== "string" ||
    options.outputRoot.length === 0 ||
    typeof options.requestManualReview !== "function" ||
    (options.proposeHypothesis !== undefined &&
      typeof options.proposeHypothesis !== "function")
  ) {
    throw new TypeError(
      "enrolled runner requires bounded paths and callable review callbacks",
    );
  }
  if (options.experimentId !== undefined) {
    identifierV2Schema.parse(options.experimentId);
  }
  const startedAt = timestamp();
  const store = await EvidenceStore.create(options.outputRoot, options.runId);
  let loaded: LoadedTargetConfig | undefined;
  let preparedTarget: PreparedTarget | undefined;
  let resources: RetainedEnrolledResources | undefined;
  let discoveryInvocation: EnrolledNodeStdioDockerInvocation | undefined;
  let discoveryContainerAbsent = false;
  let enrollmentRegistered = false;
  let executionInvocation: EnrolledNodeStdioDockerInvocation | undefined;
  let executionContainerAbsent = false;
  let executionMonitorChecks = 0;
  let executionMonitorPassed = false;
  let dispatchReceipt: Readonly<PreparedEnrolledDispatch> | undefined;
  let executionSentCalls = 0;
  let executionFailureStage: EnrolledOutcomeExecutionFailure["stage"] =
    "review";
  let reviewOutcome: FailureReviewOutcome = {
    status: "not_completed",
    approvalIssued: false,
    reasonCode: "not_reached",
  };
  let acquisitionCleanupUnverified = false;
  let configSha256: string | undefined;
  let rejectionStage: McpEnrollmentRejectionStageV2Alpha = "configuration";

  try {
    configSha256 = await sha256File(options.targetConfigPath).catch(
      () => undefined,
    );
    loaded = await loadTargetConfig(options.targetConfigPath);
    assertSupportedEnrollmentSource(loaded);
    const selected = selectExperiment(loaded, options.experimentId);
    const identityPrefix = `enroll-${shortRunHash(options.runId)}`;
    const runtimeDescriptor = runtimeDescriptorFromConfig(loaded);

    rejectionStage = "sandbox_image_validation";
    const image = (await verifyPinnedControlledSandboxImage()) as VerifiedV2SandboxImage;
    const sandboxVerifiedAt = timestamp();

    rejectionStage = "acquisition";
    try {
      preparedTarget = await prepareTarget({
        loaded,
        runId: options.runId,
        store,
        image: image.imageId,
      });
    } catch (error) {
      acquisitionCleanupUnverified =
        (error instanceof NpmAcquisitionError && !error.cleanupVerified) ||
        error instanceof TargetPreparationCleanupError;
      throw error;
    }

    rejectionStage = "prepared_tree_snapshot";
    const snapshot = await snapshotPreparedRuntimeTree(preparedTarget.hostRoot);
    const snapshotCapturedAt = timestamp();
    await store.writeJson(
      "raw/enrollment/prepared-runtime-tree.json",
      z.unknown(),
      snapshot,
    );

    rejectionStage = "runtime_validation";
    const runtime = await validateEnrolledNodeRuntime({
      preparedTarget,
      descriptor: runtimeDescriptor,
    });
    const runtimeValidatedAt = timestamp();
    resources = await materializeEmptyEnrolledResources(
      `${identityPrefix}-resources`,
    );

    rejectionStage = "discovery_startup";
    await verifyPreparedRuntimeTree(preparedTarget.hostRoot, snapshot);
    discoveryInvocation = createEnrolledNodeStdioDockerInvocation({
      runId: options.runId,
      experimentId: "enrollment-discovery",
      preparedTarget,
      resources,
      runtime,
      bounds: ENROLLED_SINGLE_CALL_BOUNDS,
      image,
    });
    const discoveryStartedAt = timestamp();
    const discoveryResult = await runMcpExperiment({
      runId: options.runId,
      experimentId: "enrollment-discovery",
      store,
      server: discoveryInvocation.server,
      timeoutMs: ENROLLED_SINGLE_CALL_BOUNDS.maxCaseRuntimeMs,
      cooldownMs: 0,
    });
    const discoveryCompletedAt = timestamp();
    await removeManagedContainer(discoveryInvocation.containerName, options.runId);
    discoveryContainerAbsent = true;
    await verifyPreparedRuntimeTree(preparedTarget.hostRoot, snapshot);
    await resources.verify();
    const discoveryTranscript = await inspectEnrolledTranscript(
      store.pathFor("raw/enrollment-discovery/mcp-transcript.jsonl"),
    );
    rejectionStage = "catalog_validation";
    if (
      discoveryTranscript.toolsListRequests !== 1 ||
      discoveryTranscript.toolsCallRequests !== 0 ||
      discoveryTranscript.followupCalls !== 0 ||
      discoveryTranscript.initializeRequests !== 1 ||
      discoveryTranscript.initializedNotifications !== 1 ||
      discoveryTranscript.unexpectedServerRequests !== 0 ||
      discoveryTranscript.unexpectedClientMethods !== 0 ||
      discoveryTranscript.sequenceContiguous !== true
    ) {
      throw new Error("discovery transcript did not remain zero-call");
    }
    if (discoveryTranscript.toolsListChangedNotifications !== 0) {
      rejectEnrollment(
        "catalog_validation",
        "catalog_changed",
        "the finalized discovery transcript contains a catalog-change notification",
      );
    }

    if (!discoveryResult.discoveredCatalog.acquisition.complete) {
      rejectEnrollment(
        "catalog_validation",
        "catalog_multi_page",
        "catalog discovery returned a continuation cursor",
      );
    }
    if (discoveryResult.discoveredCatalog.acquisition.pageCount !== 1) {
      rejectEnrollment(
        "catalog_validation",
        "catalog_incomplete",
        "catalog discovery did not retain exactly one complete page",
      );
    }
    if (
      discoveryResult.discoveredCatalog.acquisition.listChangedDuringDiscovery
    ) {
      rejectEnrollment(
        "catalog_validation",
        "catalog_changed",
        "the server announced catalog drift during discovery",
      );
    }
    const discoveredIdentity = computeCatalogIdentity(
      discoveryResult.discoveredCatalog,
      ENROLLED_DISCOVERY_CATALOG_BOUNDS,
    );
    if (discoveredIdentity.identity.toolCount < 1) {
      rejectEnrollment(
        "catalog_validation",
        "no_tools",
        "the discovered catalog contained no tools",
      );
    }

    const discoveryCleanupReceipt = await writeCleanupReceipt({
      store,
      artifactPath: "v2/enrollment/discovery-cleanup.json",
      runId: options.runId,
      phase: "discovery",
      containerName: discoveryInvocation.containerName,
      containerAbsent: true,
      hostInputs: [
        {
          kind: "prepared_target",
          rootSha256: sha256(dirname(preparedTarget.hostRoot)),
          disposition: "retained",
        },
        {
          kind: "synthetic_resources",
          rootSha256: sha256(dirname(resources.hostRoot)),
          disposition: "retained",
        },
      ],
    });
    if (!discoveryCleanupReceipt.verified) {
      rejectEnrollment(
        "discovery_cleanup",
        "cleanup_unverified",
        "discovery cleanup receipt was not verified",
      );
    }
    const discoveryCleanupVerifiedAt = discoveryCleanupReceipt.verifiedAt;

    rejectionStage = "eligibility";
    const planCompilationStartedAt = timestamp();
    const experiment = createEnrolledSingleCallExperiment({
      identityPrefix,
      targetId: loaded.config.target.id,
      sourceEvidence: {
        format: "forge.enrolled-source-evidence/v1alpha1",
        provenance: preparedTarget.provenance,
        retainedTreeSha256: snapshot.treeSha256,
      },
      runtimeSnapshotEvidence: snapshot,
      runtimeDescriptor,
      catalog: discoveryResult.discoveredCatalog,
      toolName: selected.tool,
      arguments: selected.input,
      createdAt: startedAt,
      reviewedAt: planCompilationStartedAt,
      expiresAt: after(planCompilationStartedAt, 10 * 60_000),
    });
    if (
      experiment.compiled.plan.syntheticResourceManifestDigest !==
      resources.manifestDigest
    ) {
      throw new Error("empty enrolled resource manifest identity changed");
    }
    const enrollmentRecordedAt = timestamp();
    const record = enrollmentRecord({
      enrollmentId: `${identityPrefix}-candidate`,
      recordedAt: enrollmentRecordedAt,
      loaded,
      preparedTarget,
      snapshot,
      snapshotCapturedAt,
      runtime,
      runtimeValidatedAt,
      image,
      sandboxVerifiedAt,
      discoveryStartedAt,
      discoveryCompletedAt,
      discoveryCleanupVerifiedAt,
      discoveryTranscript,
      discoveryCatalog: discoveryResult.discoveredCatalog,
      discoveryBackendProfileDigest:
        discoveryInvocation.backendProfileDigest,
      experiment,
    });
    const authority = createEnrolledTargetAuthority({
      controllerId: "forge-node-stdio-enroller",
    });
    const registered = authority.registerVerifiedEnrollment({
      record,
      context: {
        preparedTarget,
        resources,
        snapshot,
        runtime,
        catalog: discoveryResult.discoveredCatalog,
        experiment,
        image,
        backendProfileDigest: discoveryInvocation.backendProfileDigest,
        discoveryInvocation,
        discoveryEvidence: {
          startedAt: discoveryStartedAt,
          completedAt: discoveryCompletedAt,
          transcript: discoveryTranscript as EnrolledTranscriptMetrics & {
            toolsListRequests: 1;
            toolsCallRequests: 0;
            toolsListChangedNotifications: 0;
            followupCalls: 0;
            initializeRequests: 1;
            initializedNotifications: 1;
            unexpectedServerRequests: 0;
            unexpectedClientMethods: 0;
            sequenceContiguous: true;
          },
          cleanup: {
            containerName: discoveryInvocation.containerName,
            containerAbsent: true,
            ephemeralDiscoveryInputsAbsent: true,
            verifiedAt: discoveryCleanupVerifiedAt,
          },
        },
      },
    });
    enrollmentRegistered = true;
    await store.writeJson(
      "v2/enrollment/record.json",
      mcpEnrollmentRecordV2AlphaSchema,
      registered.record,
    );

    const experimentCase = experiment.compiled.plan.cases[0];
    const step = experimentCase?.steps[0];
    if (experimentCase === undefined || step === undefined) {
      throw new Error("compiled enrolled call is missing");
    }
    const advertisedTool = discoveredIdentity.catalog.tools.find(
      (candidate) => candidate.name === step.toolName,
    );
    if (advertisedTool === undefined) {
      throw new Error("compiled enrolled tool is missing from the catalog");
    }
    await store.writeJson(
      "v2/enrollment/claim-profile.json",
      claimProfileV2Schema,
      experiment.claimProfile,
    );
    await store.writeJson(
      "v2/enrollment/policy.json",
      approvedPolicyV2Schema,
      experiment.policy,
    );
    await store.writeJson(
      "v2/enrollment/audit-spec.json",
      auditSpecV2Schema,
      experiment.auditSpec,
    );
    await store.writeJson(
      "v2/enrollment/experiment-plan.json",
      experimentPlanV2Schema,
      experiment.compiled.plan,
    );
    const hypothesisCreatedAt = timestamp();
    const defaultDraft = agentOutcomeHypothesisDraftV2Schema.parse({
      format: "forge.agent-outcome-hypothesis-draft/v1alpha1",
      hypothesisId: `${identityPrefix}-hypothesis`,
      createdAt: hypothesisCreatedAt,
      source: {
        origin: "model_inference",
        component: {
          id: "forge-deterministic-enrollment-hypothesis-fixture",
          version: "1alpha1",
        },
        confidence: "medium",
        evidenceBasis: [
          {
            kind: "model_output",
            reference:
              "deterministic provider-shaped default for enrollment verification",
          },
        ],
      },
      expected: {
        protocolOutcomes: ["success"],
        shapes: ["json_object"],
        contentClasses: ["structured_data"],
        maxReasonableBytes: 8_192,
      },
      limitations: [
        "The default is a deterministic provider-shaped fixture, not evidence of live-model prediction quality.",
        "The hypothesis is non-authoritative and predicts only the result channel.",
      ],
      authority: {
        authorizesExecution: false,
        grantsApproval: false,
        declaresSafety: false,
      },
    });
    const proposalRequest = Object.freeze({
      targetId: loaded.config.target.id,
      enrollment: registered.record,
      enrollmentDigest: registered.recordDigest,
      experimentPlanDigest: experiment.compiled.experimentPlanDigest,
      policyDigest: experiment.compiled.plan.policyDigest,
      exactCall: Object.freeze({
        caseId: experimentCase.caseId,
        stepId: step.stepId,
        toolName: step.toolName,
        arguments: step.arguments as Readonly<Record<string, unknown>>,
        argumentSha256: step.argumentSha256,
      }),
      advertisedTool,
      authority: Object.freeze({
        authorizesExecution: false as const,
        grantsApproval: false as const,
        declaresSafety: false as const,
      }),
    }) satisfies Readonly<Omit<EnrolledHypothesisProposalRequest, "signal">>;
    let hypothesisDraft: unknown = defaultDraft;
    if (options.proposeHypothesis !== undefined) {
      try {
        hypothesisDraft = await invokeCallbackWithinDeadline<
          EnrolledHypothesisProposalRequest,
          unknown
        >({
          callback: options.proposeHypothesis,
          request: proposalRequest,
          timeoutReason: "proposal_callback_timeout",
          failureReason: "proposal_callback_failed",
        });
      } catch (error) {
        reviewOutcome = {
          status: "not_completed",
          approvalIssued: false,
          reasonCode:
            error instanceof ReviewStageError
              ? error.reasonCode
              : "proposal_callback_failed",
        };
        throw error;
      }
    }
    let hypothesis: Readonly<OutcomeHypothesisV2>;
    try {
      hypothesis = compileAgentOutcomeHypothesis({
        envelope: experiment.compiled,
        catalog: discoveryResult.discoveredCatalog,
        caseId: experimentCase.caseId,
        stepId: step.stepId,
        draft: hypothesisDraft,
      });
    } catch (error) {
      reviewOutcome = {
        status: "not_completed",
        approvalIssued: false,
        reasonCode: "proposal_invalid",
      };
      throw new ReviewStageError("proposal_invalid");
    }
    const hypothesisDigest = digestCanonicalJson(
      "forge.outcome-hypothesis",
      "v1alpha1",
      hypothesis,
    );
    await store.writeJson(
      "v2/enrollment/hypothesis.json",
      outcomeHypothesisV2Schema,
      hypothesis,
    );
    const planForReview = deepFreezeJson(
      experimentPlanV2Schema.parse(
        cloneStrictBoundedJson(
          experiment.compiled.plan,
          V2_ARTIFACT_CLONE_LIMITS,
          "enrolled review plan",
        ).clone,
      ),
    );
    const policyForReview = deepFreezeJson(
      approvedPolicyV2Schema.parse(
        cloneStrictBoundedJson(
          experiment.policy,
          V2_ARTIFACT_CLONE_LIMITS,
          "enrolled review policy",
        ).clone,
      ),
    );
    const reviewRequest = Object.freeze({
      ...proposalRequest,
      hypothesis,
      hypothesisDigest,
      plan: planForReview,
      policy: policyForReview,
    }) satisfies Readonly<Omit<EnrolledExactCallReviewRequest, "signal">>;
    let manualDecision: EnrolledManualReviewDecision;
    let rawManualDecision: unknown;
    try {
      rawManualDecision = await invokeCallbackWithinDeadline<
        EnrolledExactCallReviewRequest,
        unknown
      >({
        callback: options.requestManualReview,
        request: reviewRequest,
        timeoutReason: "manual_callback_timeout",
        failureReason: "manual_callback_failed",
      });
    } catch (error) {
      reviewOutcome = {
        status: "not_completed",
        approvalIssued: false,
        reasonCode:
          error instanceof ReviewStageError
            ? error.reasonCode
            : "manual_callback_failed",
      };
      throw error;
    }
    try {
      manualDecision = enrolledManualReviewDecisionSchema.parse(
        rawManualDecision,
      );
    } catch {
      reviewOutcome = {
        status: "not_completed",
        approvalIssued: false,
        reasonCode: "manual_decision_invalid",
      };
      throw new ReviewStageError("manual_decision_invalid");
    }
    const expectedReviewBindings = {
      enrollmentDigest: registered.recordDigest,
      experimentPlanDigest: experiment.compiled.experimentPlanDigest,
      hypothesisDigest,
      caseId: experimentCase.caseId,
      stepId: step.stepId,
      toolName: step.toolName,
      argumentSha256: step.argumentSha256,
    };
    for (const key of Object.keys(expectedReviewBindings) as Array<
      keyof typeof expectedReviewBindings
    >) {
      if (
        manualDecision.reviewedBindings[key] !== expectedReviewBindings[key]
      ) {
        reviewOutcome = {
          status: "not_completed",
          approvalIssued: false,
          reasonCode: "manual_binding_mismatch",
        };
        throw new ReviewStageError("manual_binding_mismatch");
      }
    }
    if (manualDecision.decision !== "approved") {
      reviewOutcome = {
        status: "declined",
        approvalIssued: false,
        reviewerId: manualDecision.reviewerId,
        decidedAt: timestamp(),
        reviewedBindings: manualDecision.reviewedBindings,
      };
      throw sanitizedFailure("manual exact-call review was declined");
    }
    const reviewed = authority.approveExactCall({
      capability: registered.capability,
      enrollmentRecord: registered.record,
      enrollmentDigest: registered.recordDigest,
      hypothesis,
      reviewId: `${identityPrefix}-review`,
      reviewerId: manualDecision.reviewerId,
      approvalClass: "operator_review",
    });
    reviewOutcome = {
      status: "approved",
      approvalIssued: true,
      reviewerId: manualDecision.reviewerId,
      reviewedAt: reviewed.record.review.reviewedAt,
      reviewDigest: reviewed.recordDigest,
      reviewedBindings: manualDecision.reviewedBindings,
    };
    await store.writeJson(
      "v2/enrollment/review.json",
      mcpEnrollmentReviewRecordV2AlphaSchema,
      reviewed.record,
    );

    const consumed = authority.consumeExactCallReview({
      capability: reviewed.capability,
      reviewRecord: reviewed.record,
      reviewDigest: reviewed.recordDigest,
    });
    executionFailureStage = "session_before_monitor";
    const freshRuntime = await validateEnrolledNodeRuntime({
      preparedTarget,
      descriptor: runtimeDescriptor,
    });
    if (freshRuntime.digest !== runtime.digest) {
      throw new Error("normalized runtime changed before execution");
    }
    await verifyPreparedRuntimeTree(preparedTarget.hostRoot, snapshot);
    const executionId = "enrolled-one-call";
    executionInvocation = createEnrolledNodeStdioDockerInvocation({
      runId: options.runId,
      experimentId: executionId,
      preparedTarget,
      resources,
      runtime: freshRuntime,
      bounds: experiment.compiled.plan.bounds,
      image,
    });
    let mcpResult: Awaited<ReturnType<typeof runMcpExperiment>> | undefined;
    let primaryFailure: unknown;
    try {
      mcpResult = await runMcpExperiment({
        runId: options.runId,
        experimentId: executionId,
        store,
        server: executionInvocation.server,
        timeoutMs: executionInvocation.backend.hardRuntimeMs,
        cooldownMs: 0,
        toolExperiment: {
          id: selected.id,
          tool: step.toolName,
          input: step.arguments as Record<string, never>,
          expected: selected.expected,
        },
        beforeToolCall: async (context) => {
          executionMonitorChecks += 1;
          if (executionMonitorChecks !== 1) {
            throw new Error("enrolled reference monitor ran more than once");
          }
          dispatchReceipt = await authority.revalidateDispatch({
            consumed,
            invocation: executionInvocation!,
            liveCatalog: context.catalog,
            toolName: context.toolName,
            arguments: context.arguments,
          });
          executionMonitorPassed = true;
        },
        onToolCallSent: () => {
          executionSentCalls += 1;
          if (executionSentCalls !== 1) {
            throw new Error("enrolled transport reported more than one call");
          }
        },
      });
    } catch (error) {
      primaryFailure = error;
    }

    try {
      await removeManagedContainer(
        executionInvocation.containerName,
        options.runId,
      );
      executionContainerAbsent = true;
    } catch (error) {
      primaryFailure ??= error;
    }
    if (
      primaryFailure !== undefined ||
      mcpResult === undefined ||
      mcpResult.toolResult === undefined ||
      executionMonitorChecks !== 1 ||
      !executionMonitorPassed ||
      dispatchReceipt === undefined ||
      executionSentCalls !== 1 ||
      !executionContainerAbsent
    ) {
      executionFailureStage = !executionContainerAbsent
        ? ("cleanup_verification" as const)
        : executionMonitorChecks === 0
          ? ("session_before_monitor" as const)
          : !executionMonitorPassed
            ? ("pre_dispatch_monitor" as const)
            : executionSentCalls === 0
              ? ("transport_before_send" as const)
              : ("runtime_or_protocol" as const);
      throw sanitizedFailure("the guarded MCP session did not complete");
    }

    executionFailureStage = "post_return_verification";
    const postTree = await verifyPreparedRuntimeTree(
      preparedTarget.hostRoot,
      snapshot,
    );
    await resources.verify();
    const executionTranscript = await inspectEnrolledTranscript(
      store.pathFor(`raw/${executionId}/mcp-transcript.jsonl`),
    );
    if (
      executionTranscript.toolsListRequests !== 1 ||
      executionTranscript.toolsCallRequests !== 1 ||
      executionTranscript.toolsListChangedNotifications !== 0 ||
      executionTranscript.followupCalls !== 0 ||
      executionTranscript.initializeRequests !== 1 ||
      executionTranscript.initializedNotifications !== 1 ||
      executionTranscript.unexpectedServerRequests !== 0 ||
      executionTranscript.unexpectedClientMethods !== 0 ||
      executionTranscript.sequenceContiguous !== true
    ) {
      throw sanitizedFailure("transcript call invariants failed");
    }
    const verifiedDispatch = authority.verifyDispatchReceipt(dispatchReceipt);
    const dispatchEvidence = enrolledDispatchReceiptEvidenceSchema.parse({
      format: "forge.enrolled-dispatch-receipt/v1alpha1",
      enrollmentDigest: verifiedDispatch.enrollmentDigest,
      reviewDigest: verifiedDispatch.reviewDigest,
      experimentPlanDigest:
        verifiedDispatch.authorization.experiment.experimentPlanDigest,
      policyDigest: verifiedDispatch.authorization.experiment.policyDigest,
      hypothesisDigest:
        verifiedDispatch.authorization.experiment.hypothesisDigest,
      caseId: verifiedDispatch.authorization.experiment.caseId,
      stepId: verifiedDispatch.authorization.experiment.stepId,
      toolName: verifiedDispatch.toolName,
      argumentSha256: verifiedDispatch.argumentSha256,
      liveCatalogDigest: verifiedDispatch.liveCatalogDigest,
      runtimeInvocationDigest: verifiedDispatch.runtimeInvocationDigest,
      dockerInvocationDigest: verifiedDispatch.dockerInvocationDigest,
      consumedAt: verifiedDispatch.consumedAt,
      checkedAt: verifiedDispatch.checkedAt,
      expiresAt: verifiedDispatch.authorization.expiresAt,
      sequence: verifiedDispatch.sequence,
      authority: {
        opaqueReceiptVerified: true,
        serializedReceiptIsBearerAuthority: false,
        authorizesRetry: false,
        authorizesFollowup: false,
      },
    });
    const dispatchReceiptDigest = digestCanonicalJson(
      "forge.enrolled-dispatch-receipt",
      "v1alpha1",
      dispatchEvidence,
    );
    await store.writeJson(
      "v2/execution/dispatch.json",
      enrolledDispatchReceiptEvidenceSchema,
      dispatchEvidence,
    );
    executionFailureStage = "cleanup_verification";
    const inputsDisposed = await disposeInputs({ preparedTarget, resources });
    const executionCleanupReceipt = await writeCleanupReceipt({
      store,
      artifactPath: "v2/execution/cleanup.json",
      runId: options.runId,
      phase: "execution",
      containerName: executionInvocation.containerName,
      containerAbsent: executionContainerAbsent,
      hostInputs: inputsDisposed.hostInputs,
    });
    if (!inputsDisposed.verified || !executionCleanupReceipt.verified) {
      throw sanitizedFailure("host temporary input cleanup could not be verified");
    }
    preparedTarget = undefined;
    resources = undefined;
    const cleanupVerifiedAt = executionCleanupReceipt.verifiedAt;

    executionFailureStage = "post_return_verification";
    const toolPhase = mcpResult.phases.find((phase) => phase.kind === "tool");
    const runtimeMs =
      toolPhase === undefined
        ? 0
        : Math.max(
            0,
            Date.parse(toolPhase.endedAt) - Date.parse(toolPhase.startedAt),
          );
    const resultRecord = mcpResult.toolResult as Record<string, unknown>;
    const protocolOutcome =
      resultRecord["isError"] === true ? "tool_error" : "success";
    const observation = buildOutcomeObservation({
      observationId: `${identityPrefix}-observation`,
      recordedAt: timestamp(),
      envelope: experiment.compiled,
      catalog: mcpResult.discoveredCatalog,
      policy: experiment.policy,
      hypothesis,
      consumed: verifiedDispatch,
      result: mcpResult.toolResult,
      protocolOutcome,
      runtimeMs,
      transcriptEvidenceReference: "enrolled-execution-transcript",
      cleanup: {
        status: "verified",
        evidenceReference: "enrolled-execution-cleanup",
      },
    });
    const comparison = compareOutcome({
      comparisonId: `${identityPrefix}-comparison`,
      comparedAt: timestamp(),
      envelope: experiment.compiled,
      catalog: mcpResult.discoveredCatalog,
      policy: experiment.policy,
      hypothesis,
      observation,
    });
    verifyOutcomeComparison({
      envelope: experiment.compiled,
      catalog: mcpResult.discoveredCatalog,
      policy: experiment.policy,
      hypothesis,
      observation,
      comparison,
    });
    const observationDigest = digestCanonicalJson(
      "forge.outcome-observation",
      "v1alpha1",
      observation,
    );
    const comparisonDigest = digestCanonicalJson(
      "forge.outcome-comparison",
      "v1alpha1",
      comparison,
    );
    const liveCatalog = computeCatalogIdentity(
      mcpResult.discoveredCatalog,
      ENROLLED_DISCOVERY_CATALOG_BOUNDS,
    );
    const attempt = enrolledRunAttemptSchema.parse({
      format: ENROLLED_RUN_ATTEMPT_FORMAT,
      runId: options.runId,
      targetId: loaded.config.target.id,
      enrollmentDigest: registered.recordDigest,
      reviewDigest: reviewed.recordDigest,
      experimentPlanDigest: experiment.compiled.experimentPlanDigest,
      hypothesisDigest,
      observationDigest,
      comparisonDigest,
      targetTreeSha256: postTree.treeSha256,
      runtimeInvocationDigest: runtime.digest,
      sandboxProfileDigest: executionInvocation.backendProfileDigest,
      liveCatalogDigest: liveCatalog.identity.planCatalogDigest,
      selectedCall: {
        caseId: experimentCase.caseId,
        stepId: step.stepId,
        toolName: step.toolName,
        argumentSha256: step.argumentSha256,
      },
      dispatch: {
        requestedCalls: 1,
        sentCalls: 1,
        retries: 0,
        followupCalls: 0,
        monitorChecks: 1,
        receiptDigest: dispatchReceiptDigest,
        checkedAt: verifiedDispatch.checkedAt,
        runtimeInvocationDigest: verifiedDispatch.runtimeInvocationDigest,
        dockerInvocationDigest: verifiedDispatch.dockerInvocationDigest,
      },
      transcript: {
        sha256: executionTranscript.sha256,
        byteLength: executionTranscript.byteLength,
        toolsListRequests: 1,
        toolsCallRequests: 1,
        toolsListChangedNotifications: 0,
        messageCount: executionTranscript.messageCount,
        initializeRequests: 1,
        initializedNotifications: 1,
        unexpectedServerRequests: 0,
        unexpectedClientMethods: 0,
        sequenceContiguous: true,
      },
      comparisonSummary: comparison.summary,
      sensorCoverage: {
        complete: comparison.coverage.completeSensors,
        incomplete: comparison.coverage.incompleteSensors,
      },
      cleanup: {
        containerAbsent: true,
        hostTemporaryInputsAbsent: true,
        verifiedAt: cleanupVerifiedAt,
      },
      quarantine: {
        exposure: "local_quarantine_only",
        outputOnlyStringEscapeCheck: "passed",
        exposedToPlanner: false,
        exposedToProvider: false,
        usedForFollowup: false,
      },
      authority: {
        recordAuthorizesRetry: false,
        recordAuthorizesFollowup: false,
        recordDeclaresTargetSafe: false,
      },
      limitations: [
        "This record proves one bounded reviewed call, not target safety or catalog-wide behavior.",
        "Process, filesystem, and network sensors are unavailable, so the overall behavioral comparison remains inconclusive.",
        "The one-call count covers tools/call only; initialization and tools/list also execute target code in two isolated sessions.",
        "The container may execute transitive native code or child processes; those effects are contained but unobserved by this alpha.",
        "No provider interface is available after result receipt; raw result bytes remain only in local mode-0600 transcript evidence.",
        "This run executes an operator-authored exact YAML call; it does not demonstrate agent-selected planning over an unfamiliar catalog.",
      ],
    });
    assertOutputOnlyStringsQuarantined({
      result: mcpResult.toolResult,
      preCallValues: [
        registered.record,
        reviewed.record,
        experiment.compiled.plan,
        hypothesis,
        mcpResult.discoveredCatalog,
      ],
      safeArtifacts: [observation, comparison, attempt],
    });
    await store.writeJson(
      "v2/execution/observation.json",
      outcomeObservationV2Schema,
      observation,
    );
    await store.writeJson(
      "v2/execution/comparison.json",
      outcomeComparisonV2Schema,
      comparison,
    );
    await store.writeJson(
      "v2/execution/attempt.json",
      enrolledRunAttemptSchema,
      attempt,
    );
    await writeEvidenceIndex({
      store,
      runId: options.runId,
      entries: [
        { evidenceId: "target-provenance", artifactPath: "target/provenance.json" },
        {
          evidenceId: "prepared-runtime-tree",
          artifactPath: "raw/enrollment/prepared-runtime-tree.json",
        },
        {
          evidenceId: "enrollment-discovery-transcript",
          artifactPath: "raw/enrollment-discovery/mcp-transcript.jsonl",
        },
        {
          evidenceId: "enrollment-discovery-cleanup",
          artifactPath: "v2/enrollment/discovery-cleanup.json",
        },
        { evidenceId: "enrollment-record", artifactPath: "v2/enrollment/record.json" },
        { evidenceId: "experiment-plan", artifactPath: "v2/enrollment/experiment-plan.json" },
        { evidenceId: "outcome-hypothesis", artifactPath: "v2/enrollment/hypothesis.json" },
        { evidenceId: "exact-call-review", artifactPath: "v2/enrollment/review.json" },
        { evidenceId: "enrolled-dispatch", artifactPath: "v2/execution/dispatch.json" },
        {
          evidenceId: "enrolled-execution-transcript",
          artifactPath: "raw/enrolled-one-call/mcp-transcript.jsonl",
        },
        {
          evidenceId: "enrolled-execution-cleanup",
          artifactPath: "v2/execution/cleanup.json",
        },
        { evidenceId: "outcome-observation", artifactPath: "v2/execution/observation.json" },
        { evidenceId: "outcome-comparison", artifactPath: "v2/execution/comparison.json" },
        { evidenceId: "one-call-attempt", artifactPath: "v2/execution/attempt.json" },
      ],
    });
    return Object.freeze({
      status: "completed" as const,
      runId: options.runId,
      runDirectory: store.runDirectory,
      enrollment: registered.record,
      enrollmentDigest: registered.recordDigest,
      review: reviewed.record,
      reviewDigest: reviewed.recordDigest,
      hypothesis,
      observation,
      comparison,
      attempt,
    });
  } catch (error) {
    if (enrollmentRegistered && loaded !== undefined) {
      if (
        executionInvocation !== undefined &&
        !executionContainerAbsent
      ) {
        try {
          await removeManagedContainer(
            executionInvocation.containerName,
            options.runId,
          );
          executionContainerAbsent = true;
        } catch {
          executionFailureStage = "cleanup_verification";
        }
      }
      const containerAbsent =
        executionInvocation === undefined || executionContainerAbsent;
      const disposed = await disposeInputs({ preparedTarget, resources });
      const cleanupReceipt = await writeCleanupReceipt({
        store,
        artifactPath: "v2/execution/failure-cleanup.json",
        runId: options.runId,
        phase: "failure",
        containerName:
          executionInvocation?.containerName ?? "execution-container-not-created",
        containerAbsent,
        hostInputs: disposed.hostInputs,
      });
      const cleanupVerified =
        containerAbsent && disposed.verified && cleanupReceipt.verified;
      if (cleanupVerified) {
        preparedTarget = undefined;
        resources = undefined;
      }
      try {
        const failure = await writeExecutionFailure({
          store,
          runId: options.runId,
          targetId: loaded.config.target.id,
          experimentId: "enrolled-one-call",
          stage: cleanupVerified
            ? executionFailureStage
            : "cleanup_verification",
          sentCalls: executionSentCalls === 0 ? 0 : 1,
          review: reviewOutcome,
          cleanupVerified,
          cleanupEvidenceReference: "v2/execution/failure-cleanup.json",
        });
        await writeEvidenceIndex({
          store,
          runId: options.runId,
          entries: await existingEvidenceEntries(store, [
            { evidenceId: "target-provenance", artifactPath: "target/provenance.json" },
            {
              evidenceId: "prepared-runtime-tree",
              artifactPath: "raw/enrollment/prepared-runtime-tree.json",
            },
            {
              evidenceId: "enrollment-discovery-transcript",
              artifactPath: "raw/enrollment-discovery/mcp-transcript.jsonl",
            },
            {
              evidenceId: "enrollment-discovery-cleanup",
              artifactPath: "v2/enrollment/discovery-cleanup.json",
            },
            { evidenceId: "enrollment-record", artifactPath: "v2/enrollment/record.json" },
            { evidenceId: "experiment-plan", artifactPath: "v2/enrollment/experiment-plan.json" },
            { evidenceId: "outcome-hypothesis", artifactPath: "v2/enrollment/hypothesis.json" },
            { evidenceId: "exact-call-review", artifactPath: "v2/enrollment/review.json" },
            { evidenceId: "enrolled-dispatch", artifactPath: "v2/execution/dispatch.json" },
            {
              evidenceId: "enrolled-execution-transcript",
              artifactPath: "raw/enrolled-one-call/mcp-transcript.jsonl",
            },
            {
              evidenceId: "enrolled-failure-cleanup",
              artifactPath: "v2/execution/failure-cleanup.json",
            },
            { evidenceId: "enrolled-execution-failure", artifactPath: "v2/execution/failure.json" },
          ]),
        });
        return Object.freeze({
          status: "failed" as const,
          runId: options.runId,
          runDirectory: store.runDirectory,
          failure,
        });
      } catch {
        throw sanitizedFailure(
          "bounded execution-failure evidence could not be persisted",
        );
      }
    }
    let cleanup:
      | { status: "not_started" }
      | { status: "verified_absent"; verifiedAt: string }
      | { status: "verification_failed"; verifiedAt: string } = {
      status: "not_started",
    };
    if (acquisitionCleanupUnverified) {
      cleanup = { status: "verification_failed", verifiedAt: timestamp() };
    }
    if (discoveryInvocation !== undefined && !discoveryContainerAbsent) {
      try {
        await removeManagedContainer(
          discoveryInvocation.containerName,
          options.runId,
        );
        discoveryContainerAbsent = true;
      } catch {
        cleanup = { status: "verification_failed", verifiedAt: timestamp() };
        rejectionStage = "discovery_cleanup";
      }
    }
    if (cleanup.status !== "verification_failed") {
      const canDispose = discoveryInvocation === undefined || discoveryContainerAbsent;
      const hadInputs = preparedTarget !== undefined || resources !== undefined;
      const disposed = canDispose
        ? await disposeInputs({ preparedTarget, resources })
        : { verified: false, hostInputs: [] as readonly HostCleanupFact[] };
      if (canDispose && disposed.verified && (hadInputs || discoveryInvocation !== undefined)) {
        try {
          const receipt = await writeCleanupReceipt({
            store,
            artifactPath: "v2/enrollment/cleanup.json",
            runId: options.runId,
            phase: "rejection",
            containerName:
              discoveryInvocation?.containerName ?? "discovery-container-not-created",
            containerAbsent: true,
            hostInputs: disposed.hostInputs,
          });
          cleanup = receipt.verified
            ? { status: "verified_absent", verifiedAt: receipt.verifiedAt }
            : { status: "verification_failed", verifiedAt: receipt.verifiedAt };
        } catch {
          cleanup = { status: "verification_failed", verifiedAt: timestamp() };
        }
      } else if (!hadInputs && discoveryInvocation === undefined) {
        cleanup = { status: "not_started" };
      } else {
        try {
          const receipt = await writeCleanupReceipt({
            store,
            artifactPath: "v2/enrollment/cleanup.json",
            runId: options.runId,
            phase: "rejection",
            containerName:
              discoveryInvocation?.containerName ?? "discovery-container-unverified",
            containerAbsent: canDispose,
            hostInputs: disposed.hostInputs,
          });
          cleanup = {
            status: "verification_failed",
            verifiedAt: receipt.verifiedAt,
          };
        } catch {
          cleanup = { status: "verification_failed", verifiedAt: timestamp() };
        }
      }
    }
    if (
      cleanup.status !== "not_started" &&
      (await pathIsAbsent(store.pathFor("v2/enrollment/cleanup.json")))
    ) {
      const unverifiedHostInputs = [
        ...(preparedTarget === undefined
          ? []
          : [
              {
                kind: "prepared_target" as const,
                rootSha256: sha256(dirname(preparedTarget.hostRoot)),
                disposition: "unverified" as const,
              },
            ]),
        ...(resources === undefined
          ? []
          : [
              {
                kind: "synthetic_resources" as const,
                rootSha256: sha256(dirname(resources.hostRoot)),
                disposition: "unverified" as const,
              },
            ]),
      ];
      try {
        await writeCleanupReceipt({
          store,
          artifactPath: "v2/enrollment/cleanup.json",
          runId: options.runId,
          phase: "rejection",
          containerName:
            discoveryInvocation?.containerName ?? "acquisition-cleanup-unverified",
          containerAbsent:
            !acquisitionCleanupUnverified &&
            (discoveryInvocation === undefined || discoveryContainerAbsent),
          hostInputs: unverifiedHostInputs,
        });
      } catch {
        throw sanitizedFailure("bounded rejection cleanup evidence could not be persisted");
      }
    }
    const reason = classifyRejection(rejectionStage, error);
    const rejection = await writeRejection({
      store,
      runId: options.runId,
      startedAt,
      ...(loaded === undefined
        ? {}
        : {
            targetId: loaded.config.target.id,
            sourceKind:
              loaded.config.target.source.type === "npm"
                ? ("npm" as const)
                : ("local_snapshot" as const),
          }),
      ...(configSha256 === undefined ? {} : { configSha256 }),
      stage: rejectionStage,
      reason,
      cleanup,
    });
    await writeEvidenceIndex({
      store,
      runId: options.runId,
      entries: await existingEvidenceEntries(store, [
        { evidenceId: "target-provenance", artifactPath: "target/provenance.json" },
        {
          evidenceId: "prepared-runtime-tree",
          artifactPath: "raw/enrollment/prepared-runtime-tree.json",
        },
        {
          evidenceId: "enrollment-discovery-transcript",
          artifactPath: "raw/enrollment-discovery/mcp-transcript.jsonl",
        },
        {
          evidenceId: "enrollment-discovery-cleanup",
          artifactPath: "v2/enrollment/discovery-cleanup.json",
        },
        { evidenceId: "enrollment-cleanup", artifactPath: "v2/enrollment/cleanup.json" },
        { evidenceId: "enrollment-rejection", artifactPath: "v2/enrollment/rejection.json" },
      ]),
    });
    return Object.freeze({
      status: "rejected" as const,
      runId: options.runId,
      runDirectory: store.runDirectory,
      rejection,
    });
  }
}
