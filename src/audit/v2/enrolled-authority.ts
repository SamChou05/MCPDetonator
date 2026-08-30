import {
  APPROVAL_CLASS_RANK,
  approvedPolicyV2Schema,
  auditSpecV2Schema,
  claimProfileV2Schema,
  identifierV2Schema,
  mandatoryCaseTemplateV2Schema,
  mcpEnrollmentRecordV2AlphaSchema,
  mcpEnrollmentReviewRecordV2AlphaSchema,
  normalizedNodeInvocationV2AlphaSchema,
  outcomeHypothesisV2Schema,
  targetIdentityV2Schema,
  timestampV2Schema,
  type ApprovalClassV2,
  type McpEnrollmentRecordV2Alpha,
  type McpEnrollmentSourceV2Alpha,
  type McpEnrollmentReviewRecordV2Alpha,
  type OutcomeHypothesisV2,
} from "../../contracts/v2/index.js";
import { targetProvenanceV1Schema } from "../../contracts/v1.js";
import { sha256 } from "../../evidence-store.js";
import type { PreparedTarget } from "../../target/prepare.js";
import { computeCatalogIdentity } from "./catalog.js";
import { canonicalizeJson, digestCanonicalJson } from "./canonical.js";
import {
  compileExperimentPlan,
  type CompiledExperimentPlanV2,
  type CompileExperimentPlanInput,
} from "./compile.js";
import {
  ENROLLED_DISCOVERY_CATALOG_BOUNDS,
  type EnrolledExperimentInputs,
} from "./enrolled-experiment.js";
import {
  ENROLLED_NODE_STDIO_SANDBOX_IDENTITY,
  verifyEnrolledDockerInvocationBinding,
  type EnrolledNodeStdioDockerInvocation,
  type EnrolledSandboxResources,
  type VerifiedV2SandboxImage,
} from "./enrolled-sandbox.js";
import {
  DEFAULT_ENROLLED_APPLICATION_ARGUMENT_LIMITS,
  verifyPreparedRuntimeTree,
  type NormalizedEnrolledNodeInvocation,
  type PreparedRuntimeTreeSnapshot,
} from "./enrolled-runtime.js";
import {
  CONTROLLED_SANDBOX_IMAGE_ID,
  CONTROLLED_SANDBOX_IMAGE_REFERENCE,
} from "./controlled-fixture.js";
import { verifyExperimentPlanEnvelope } from "./envelope.js";
import { deepFreezeJson } from "./freeze.js";
import {
  cloneStrictBoundedJson,
  V2_ARTIFACT_CLONE_LIMITS,
} from "./strict-clone.js";
import { runtimeDescriptorV2Schema } from "./target.js";

export const ENROLLED_TARGET_AUTHORITY_IDENTITY = Object.freeze({
  id: "forge-enrolled-target-authority",
  version: "1alpha1",
});

export type EnrolledAuthorityErrorCode =
  | "invalid_enrollment"
  | "invalid_capability"
  | "binding_mismatch"
  | "review_insufficient"
  | "expired"
  | "replay"
  | "sandbox_prerequisites_unmet";

export class EnrolledAuthorityError extends Error {
  public constructor(
    readonly code: EnrolledAuthorityErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EnrolledAuthorityError";
  }
}

export interface RetainedEnrolledResources extends EnrolledSandboxResources {
  verify(): Promise<string>;
  dispose(): Promise<void>;
}

export interface VerifiedEnrollmentContext {
  readonly preparedTarget: PreparedTarget;
  readonly resources: RetainedEnrolledResources;
  readonly snapshot: Readonly<PreparedRuntimeTreeSnapshot>;
  readonly runtime: Readonly<NormalizedEnrolledNodeInvocation>;
  readonly catalog: unknown;
  readonly experiment: EnrolledExperimentInputs;
  readonly image: VerifiedV2SandboxImage;
  readonly backendProfileDigest: string;
  readonly discoveryInvocation: EnrolledNodeStdioDockerInvocation;
  readonly discoveryEvidence: Readonly<{
    startedAt: string;
    completedAt: string;
    transcript: Readonly<{
      sha256: string;
      byteLength: number;
      messageCount: number;
      toolsListRequests: 1;
      toolsCallRequests: 0;
      toolsListChangedNotifications: 0;
      followupCalls: 0;
      initializeRequests: 1;
      initializedNotifications: 1;
      unexpectedServerRequests: 0;
      unexpectedClientMethods: 0;
      sequenceContiguous: true;
    }>;
    cleanup: Readonly<{
      containerName: string;
      containerAbsent: true;
      ephemeralDiscoveryInputsAbsent: true;
      verifiedAt: string;
    }>;
  }>;
}

declare const enrollmentCandidateBrand: unique symbol;
declare const enrolledCallReviewBrand: unique symbol;
declare const consumedEnrolledCallBrand: unique symbol;
const preparedEnrolledDispatchBrand: unique symbol = Symbol(
  "forge-prepared-enrolled-dispatch",
);

export const ENROLLED_REVIEW_CAPABILITY_LIFETIME_MS = 5 * 60_000;

export interface EnrollmentCandidateCapability {
  readonly [enrollmentCandidateBrand]: never;
}

export interface EnrolledCallReviewCapability {
  readonly [enrolledCallReviewBrand]: never;
}

export interface ConsumedEnrolledCall {
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
  readonly enrollmentRecord: Readonly<McpEnrollmentRecordV2Alpha>;
  readonly enrollmentDigest: string;
  readonly reviewRecord: Readonly<McpEnrollmentReviewRecordV2Alpha>;
  readonly reviewDigest: string;
  readonly hypothesis: Readonly<OutcomeHypothesisV2>;
  readonly consumedAt: string;
  readonly [consumedEnrolledCallBrand]: never;
}

export interface RegisteredEnrollment {
  readonly record: Readonly<McpEnrollmentRecordV2Alpha>;
  readonly recordDigest: string;
  readonly capability: EnrollmentCandidateCapability;
}

export interface IssuedEnrolledCallReview {
  readonly record: Readonly<McpEnrollmentReviewRecordV2Alpha>;
  readonly recordDigest: string;
  readonly capability: EnrolledCallReviewCapability;
}

export interface PreparedEnrolledDispatch {
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly argumentSha256: string;
  readonly liveCatalogDigest: string;
  readonly runtimeInvocationDigest: string;
  readonly dockerInvocationDigest: string;
  readonly checkedAt: string;
  readonly sequence: 0;
  readonly authorization: ConsumedEnrolledCall["authorization"];
  readonly consumedAt: string;
  readonly enrollmentDigest: string;
  readonly reviewDigest: string;
  readonly [preparedEnrolledDispatchBrand]: true;
}

interface EnrollmentState {
  readonly record: Readonly<McpEnrollmentRecordV2Alpha>;
  readonly recordDigest: string;
  readonly context: VerifiedEnrollmentContext;
  reviewClaimed: boolean;
}

interface ReviewState extends EnrollmentState {
  readonly reviewRecord: Readonly<McpEnrollmentReviewRecordV2Alpha>;
  readonly reviewDigest: string;
  readonly hypothesis: Readonly<OutcomeHypothesisV2>;
  consumed: boolean;
}

interface ConsumedState extends ReviewState {
  readonly consumedAt: string;
  dispatchClaimed: boolean;
}

export interface EnrolledTargetAuthority {
  registerVerifiedEnrollment(input: {
    readonly record: unknown;
    readonly context: VerifiedEnrollmentContext;
  }): RegisteredEnrollment;
  approveExactCall(input: {
    readonly capability: EnrollmentCandidateCapability;
    readonly enrollmentRecord: unknown;
    readonly enrollmentDigest: string;
    readonly hypothesis: unknown;
    readonly reviewId: string;
    readonly reviewerId: string;
    readonly approvalClass: ApprovalClassV2;
  }): IssuedEnrolledCallReview;
  consumeExactCallReview(input: {
    readonly capability: EnrolledCallReviewCapability;
    readonly reviewRecord: unknown;
    readonly reviewDigest: string;
  }): ConsumedEnrolledCall;
  revalidateDispatch(input: {
    readonly consumed: ConsumedEnrolledCall;
    readonly invocation: EnrolledNodeStdioDockerInvocation;
    readonly liveCatalog: unknown;
    readonly toolName: string;
    readonly arguments: unknown;
  }): Promise<Readonly<PreparedEnrolledDispatch>>;
  verifyDispatchReceipt(
    receipt: PreparedEnrolledDispatch,
  ): Readonly<PreparedEnrolledDispatch>;
}

function fail(
  code: EnrolledAuthorityErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new EnrolledAuthorityError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function assertCanonicalEqual(
  label: string,
  actual: unknown,
  expected: unknown,
): void {
  if (canonicalizeJson(actual) !== canonicalizeJson(expected)) {
    fail("binding_mismatch", `${label} does not match`);
  }
}

function parseHypothesis(value: unknown): Readonly<OutcomeHypothesisV2> {
  try {
    return deepFreezeJson(
      outcomeHypothesisV2Schema.parse(
        cloneStrictBoundedJson(
          value,
          V2_ARTIFACT_CLONE_LIMITS,
          "enrolled outcome hypothesis",
        ).clone,
      ),
    );
  } catch (error) {
    return fail("binding_mismatch", "outcome hypothesis is invalid", error);
  }
}

function enrollmentDigest(record: McpEnrollmentRecordV2Alpha): string {
  return digestCanonicalJson(
    "forge.mcp-enrollment-record",
    "v1alpha1",
    record,
  );
}

function reviewDigest(record: McpEnrollmentReviewRecordV2Alpha): string {
  return digestCanonicalJson(
    "forge.mcp-enrollment-review-record",
    "v1alpha1",
    record,
  );
}

function selectedCall(experiment: EnrolledExperimentInputs) {
  const envelope = verifyExperimentPlanEnvelope(experiment.compiled);
  if (envelope.plan.cases.length !== 1) {
    fail(
      "sandbox_prerequisites_unmet",
      "enrolled execution requires exactly one compiled case",
    );
  }
  const experimentCase = envelope.plan.cases[0];
  const step = experimentCase?.steps[0];
  if (
    experimentCase === undefined ||
    experimentCase.steps.length !== 1 ||
    step === undefined ||
    typeof step.arguments !== "object" ||
    step.arguments === null ||
    Array.isArray(step.arguments)
  ) {
    fail(
      "sandbox_prerequisites_unmet",
      "enrolled execution requires one object-argument tool step",
    );
  }
  return { envelope, experimentCase, step };
}

function stricterApprovalClass(
  left: ApprovalClassV2,
  right: ApprovalClassV2,
): ApprovalClassV2 {
  return APPROVAL_CLASS_RANK[left] >= APPROVAL_CLASS_RANK[right]
    ? left
    : right;
}

function validateEnrollmentContext(
  record: Readonly<McpEnrollmentRecordV2Alpha>,
  context: VerifiedEnrollmentContext,
): void {
  const catalog = computeCatalogIdentity(
    context.catalog,
    ENROLLED_DISCOVERY_CATALOG_BOUNDS,
  );
  const { envelope } = selectedCall(context.experiment);
  const invocationBindings = verifyEnrolledDockerInvocationBinding(
    context.discoveryInvocation,
  );
  const targetIdentityDigest = digestCanonicalJson(
    "forge.target-identity",
    "v2",
    envelope.plan.target,
  );
  if (
    record.target.identityDigest !== targetIdentityDigest ||
    context.experiment.targetIdentityDigest !== targetIdentityDigest ||
    record.preparedTree.treeSha256 !== context.snapshot.treeSha256 ||
    record.runtime.invocation.digest !== context.runtime.digest ||
    record.sandbox.profileDigest !== context.backendProfileDigest ||
    record.sandbox.profileDigest !== invocationBindings.backendProfileDigest ||
    record.sandbox.imageId !== context.image.imageId ||
    record.sandbox.imageReference !== context.image.imageReference ||
    context.resources.manifestDigest !==
      envelope.plan.syntheticResourceManifestDigest
  ) {
    fail(
      "binding_mismatch",
      "enrollment record differs from retained target, runtime, sandbox, or plan state",
    );
  }
  assertCanonicalEqual(
    "enrolled source provenance",
    record.source.provenance,
    expectedSourceProvenance(context),
  );
  assertCanonicalEqual(
    "enrolled prepared-tree snapshot",
    {
      format: record.preparedTree.format,
      complete: record.preparedTree.complete,
      scope: record.preparedTree.scope,
      specialEntriesRejected: record.preparedTree.specialEntriesRejected,
      treeSha256: record.preparedTree.treeSha256,
      counters: record.preparedTree.counters,
      limits: record.preparedTree.limits,
    },
    {
      format: context.snapshot.format,
      complete: context.snapshot.complete,
      scope: context.snapshot.scope,
      specialEntriesRejected: context.snapshot.specialEntriesRejected,
      treeSha256: context.snapshot.treeSha256,
      counters: context.snapshot.summary,
      limits: context.snapshot.limits,
    },
  );
  assertCanonicalEqual(
    "enrolled normalized runtime invocation",
    record.runtime.invocation,
    context.runtime,
  );
  assertCanonicalEqual(
    "enrolled runtime argument limits",
    record.runtime.argumentLimits,
    DEFAULT_ENROLLED_APPLICATION_ARGUMENT_LIMITS,
  );
  assertCanonicalEqual("enrolled target identity", record.target.identity, envelope.plan.target);
  assertCanonicalEqual("enrolled catalog", record.discovery.catalog, catalog.identity);
  assertCanonicalEqual(
    "enrolled execution bounds",
    record.sandbox.executionBounds,
    envelope.plan.bounds,
  );
  assertCanonicalEqual(
    "enrolled sandbox identity",
    record.sandbox.profile,
    ENROLLED_NODE_STDIO_SANDBOX_IDENTITY,
  );
  if (
    context.discoveryInvocation.experimentId !== "enrollment-discovery" ||
    context.discoveryInvocation.backend.targetMount.source !==
      context.preparedTarget.hostRoot ||
    context.discoveryInvocation.backend.syntheticResourceMount.source !==
      context.resources.hostRoot ||
    context.discoveryInvocation.backend.containerProcess.runtime.digest !==
      context.runtime.digest ||
    context.discoveryInvocation.backend.sandboxImageId !== context.image.imageId ||
    context.discoveryInvocation.backend.sandboxImageReference !==
      context.image.imageReference
  ) {
    fail(
      "sandbox_prerequisites_unmet",
      "discovery invocation differs from retained target, resources, runtime, or image",
    );
  }
  assertCanonicalEqual(
    "enrolled discovery transcript",
    {
      sha256: record.discovery.transcript.sha256,
      byteLength: record.discovery.transcript.byteLength,
      toolsListRequests: record.discovery.transcript.toolsListRequests,
      toolsCallRequests: record.discovery.transcript.toolsCallRequests,
      toolsListChangedNotifications:
        record.discovery.transcript.toolsListChangedNotifications,
    },
    {
      sha256: context.discoveryEvidence.transcript.sha256,
      byteLength: context.discoveryEvidence.transcript.byteLength,
      toolsListRequests: context.discoveryEvidence.transcript.toolsListRequests,
      toolsCallRequests: context.discoveryEvidence.transcript.toolsCallRequests,
      toolsListChangedNotifications:
        context.discoveryEvidence.transcript.toolsListChangedNotifications,
    },
  );
  if (
    context.discoveryEvidence.transcript.initializeRequests !== 1 ||
    context.discoveryEvidence.transcript.initializedNotifications !== 1 ||
    context.discoveryEvidence.transcript.unexpectedServerRequests !== 0 ||
    context.discoveryEvidence.transcript.unexpectedClientMethods !== 0 ||
    context.discoveryEvidence.transcript.sequenceContiguous !== true ||
    record.discovery.startedAt !== context.discoveryEvidence.startedAt ||
    record.discovery.completedAt !== context.discoveryEvidence.completedAt ||
    record.discovery.cleanup.containerAbsent !== true ||
    record.discovery.cleanup.ephemeralDiscoveryInputsAbsent !== true ||
    record.discovery.cleanup.verifiedAt !==
      context.discoveryEvidence.cleanup.verifiedAt ||
    context.discoveryEvidence.cleanup.containerName !==
      context.discoveryInvocation.containerName ||
    context.discoveryEvidence.cleanup.containerAbsent !== true ||
    context.discoveryEvidence.cleanup.ephemeralDiscoveryInputsAbsent !== true
  ) {
    fail(
      "binding_mismatch",
      "discovery transcript, chronology, or cleanup receipt is incomplete",
    );
  }
  assertCanonicalEqual("enrolled discovery limits", record.discovery.limits, {
    maxPages: ENROLLED_DISCOVERY_CATALOG_BOUNDS.maxPages,
    maxTools: ENROLLED_DISCOVERY_CATALOG_BOUNDS.maxTools,
    maxTranscriptBytes: 2_000_000,
  });
}

function expectedSourceProvenance(
  context: VerifiedEnrollmentContext,
): Readonly<McpEnrollmentSourceV2Alpha> {
  const provenance = context.preparedTarget.provenance;
  if (provenance.install.lifecycleScripts !== "disabled") {
    fail(
      "sandbox_prerequisites_unmet",
      "retained target provenance does not disable lifecycle scripts",
    );
  }
  const common = {
    sourceTreeSha256: context.snapshot.treeSha256,
    sourceEntryCount: context.snapshot.summary.entryCount,
    sourceRegularFileBytes: context.snapshot.summary.fileBytesHashed,
    sourceArtifactSha256: context.experiment.target.sourceArtifact.sha256,
    lifecycleScripts: "disabled" as const,
  };
  if (provenance.source.type === "npm") {
    if (
      provenance.source.resolved === undefined ||
      provenance.source.integrity === undefined ||
      provenance.packageLockSha256 === undefined
    ) {
      fail(
        "sandbox_prerequisites_unmet",
        "npm enrollment provenance lacks resolved tarball, integrity, or lock identity",
      );
    }
    return {
      kind: "npm",
      ...common,
      package: provenance.source.package,
      requestedVersion: provenance.source.requestedVersion,
      resolvedVersion: provenance.source.resolvedVersion,
      resolvedTarball: provenance.source.resolved,
      integrity: provenance.source.integrity,
      packageLockSha256: provenance.packageLockSha256,
      acquisitionNetwork: "networked_package_acquisition",
    };
  }
  if (
    provenance.source.type !== "local" ||
    provenance.install.strategy !== "none"
  ) {
    fail(
      "sandbox_prerequisites_unmet",
      "enrolled local provenance must be a no-install local snapshot",
    );
  }
  return {
    kind: "local_snapshot",
    ...common,
    configuredPathSha256: sha256(provenance.source.configuredPath),
    installMode: "none",
    ...(provenance.packageLockSha256 === undefined
      ? {}
      : { packageLockSha256: provenance.packageLockSha256 }),
    acquisitionNetwork: "none",
  };
}

function sealExperiment(
  input: EnrolledExperimentInputs,
  catalogInput: unknown,
): EnrolledExperimentInputs {
  const submitted = verifyExperimentPlanEnvelope(input.compiled);
  const target = deepFreezeJson(
    targetIdentityV2Schema.parse(
      cloneStrictBoundedJson(
        input.target,
        V2_ARTIFACT_CLONE_LIMITS,
        "enrolled target identity",
      ).clone,
    ),
  );
  const runtimeDescriptor = deepFreezeJson(
    runtimeDescriptorV2Schema.parse(
      cloneStrictBoundedJson(
        input.runtimeDescriptor,
        V2_ARTIFACT_CLONE_LIMITS,
        "enrolled runtime descriptor",
      ).clone,
    ),
  );
  const claimProfile = deepFreezeJson(
    claimProfileV2Schema.parse(
      cloneStrictBoundedJson(
        input.claimProfile,
        V2_ARTIFACT_CLONE_LIMITS,
        "enrolled claim profile",
      ).clone,
    ),
  );
  const policy = deepFreezeJson(
    approvedPolicyV2Schema.parse(
      cloneStrictBoundedJson(
        input.policy,
        V2_ARTIFACT_CLONE_LIMITS,
        "enrolled policy",
      ).clone,
    ),
  );
  const auditSpec = deepFreezeJson(
    auditSpecV2Schema.parse(
      cloneStrictBoundedJson(
        input.auditSpec,
        V2_ARTIFACT_CLONE_LIMITS,
        "enrolled audit specification",
      ).clone,
    ),
  );
  const mandatoryCase = deepFreezeJson(
    mandatoryCaseTemplateV2Schema.parse(
      cloneStrictBoundedJson(
        input.mandatoryCase,
        V2_ARTIFACT_CLONE_LIMITS,
        "enrolled mandatory case",
      ).clone,
    ),
  );
  const catalog = deepFreezeJson(
    cloneStrictBoundedJson(
      catalogInput,
      V2_ARTIFACT_CLONE_LIMITS,
      "enrolled discovery catalog",
    ).clone,
  );
  computeCatalogIdentity(catalog, ENROLLED_DISCOVERY_CATALOG_BOUNDS);
  const sourceArtifactBytes = Uint8Array.from(input.sourceArtifactBytes);
  const runtimeSnapshotBytes = Uint8Array.from(input.runtimeSnapshotBytes);
  const compileInput: CompileExperimentPlanInput = Object.freeze({
    planId: identifierV2Schema.parse(input.compileInput.planId),
    manifestId: identifierV2Schema.parse(input.compileInput.manifestId),
    compiledAt: timestampV2Schema.parse(input.compileInput.compiledAt),
    target: Object.freeze({
      identity: target,
      sourceArtifactBytes,
      runtimeSnapshotBytes,
      runtimeDescriptor,
    }),
    catalog,
    claimProfile,
    policy,
    auditSpec,
    mandatoryCases: Object.freeze([mandatoryCase]),
  });
  const compiled = compileExperimentPlan(compileInput);
  if (compiled.experimentPlanDigest !== submitted.experimentPlanDigest) {
    fail("binding_mismatch", "sealed experiment compilation changed its digest");
  }
  assertCanonicalEqual("sealed experiment plan", compiled.plan, submitted.plan);
  const targetIdentityDigest = digestCanonicalJson(
    "forge.target-identity",
    "v2",
    target,
  );
  if (
    input.targetIdentityDigest !== targetIdentityDigest ||
    input.caseId !== mandatoryCase.caseId ||
    mandatoryCase.steps.length !== 1 ||
    input.stepId !== mandatoryCase.steps[0]?.stepId
  ) {
    fail("binding_mismatch", "enrolled experiment identities changed");
  }
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
    caseId: input.caseId,
    stepId: input.stepId,
  });
}

function sealEnrollmentContext(
  context: VerifiedEnrollmentContext,
): VerifiedEnrollmentContext {
  const provenance = deepFreezeJson(
    targetProvenanceV1Schema.parse(
      cloneStrictBoundedJson(
        context.preparedTarget.provenance,
        V2_ARTIFACT_CLONE_LIMITS,
        "retained target provenance",
      ).clone,
    ),
  );
  const originalTarget = context.preparedTarget;
  const preparedTarget = Object.freeze({
    hostRoot: originalTarget.hostRoot,
    packageRoot: originalTarget.packageRoot,
    ...(originalTarget.hostNpmCache === undefined
      ? {}
      : { hostNpmCache: originalTarget.hostNpmCache }),
    containerRoot: originalTarget.containerRoot,
    provenance,
    dispose: () => originalTarget.dispose(),
  }) satisfies PreparedTarget;
  const originalResources = context.resources;
  const resources = Object.freeze({
    hostRoot: originalResources.hostRoot,
    manifestDigest: originalResources.manifestDigest,
    verify: () => originalResources.verify(),
    dispose: () => originalResources.dispose(),
  }) satisfies RetainedEnrolledResources;
  const snapshot = deepFreezeJson(
    cloneStrictBoundedJson(
      context.snapshot,
      V2_ARTIFACT_CLONE_LIMITS,
      "prepared runtime-tree snapshot",
    ).clone as unknown as PreparedRuntimeTreeSnapshot,
  );
  const runtime = deepFreezeJson(
    normalizedNodeInvocationV2AlphaSchema.parse(
      cloneStrictBoundedJson(
        context.runtime,
        V2_ARTIFACT_CLONE_LIMITS,
        "normalized enrolled runtime",
      ).clone,
    ),
  ) as Readonly<NormalizedEnrolledNodeInvocation>;
  const { digest: suppliedRuntimeDigest, ...runtimeProjection } = runtime;
  const expectedRuntimeDigest = digestCanonicalJson(
    "forge.enrolled-node-invocation",
    "v1alpha1",
    runtimeProjection,
  );
  if (suppliedRuntimeDigest !== expectedRuntimeDigest) {
    fail("binding_mismatch", "normalized enrolled runtime digest is false");
  }
  const catalog = deepFreezeJson(
    cloneStrictBoundedJson(
      context.catalog,
      V2_ARTIFACT_CLONE_LIMITS,
      "enrolled discovery catalog",
    ).clone,
  );
  const image = deepFreezeJson(
    cloneStrictBoundedJson(
      context.image,
      V2_ARTIFACT_CLONE_LIMITS,
      "verified enrollment image",
    ).clone as unknown as VerifiedV2SandboxImage,
  );
  if (
    image.imageReference !== CONTROLLED_SANDBOX_IMAGE_REFERENCE ||
    image.imageId !== CONTROLLED_SANDBOX_IMAGE_ID ||
    image.declaredVolumes !== false
  ) {
    fail("sandbox_prerequisites_unmet", "enrollment image is not the pinned verified image");
  }
  const discoveryInvocation = deepFreezeJson(
    cloneStrictBoundedJson(
      context.discoveryInvocation,
      V2_ARTIFACT_CLONE_LIMITS,
      "enrolled discovery invocation",
    ).clone as unknown as EnrolledNodeStdioDockerInvocation,
  );
  const discoveryInvocationBinding = verifyEnrolledDockerInvocationBinding(
    discoveryInvocation,
  );
  if (
    context.backendProfileDigest !==
    discoveryInvocationBinding.backendProfileDigest
  ) {
    fail("binding_mismatch", "supplied discovery profile digest is false");
  }
  const discoveryEvidence = deepFreezeJson(
    cloneStrictBoundedJson(
      context.discoveryEvidence,
      V2_ARTIFACT_CLONE_LIMITS,
      "enrolled discovery evidence",
    ).clone as VerifiedEnrollmentContext["discoveryEvidence"],
  );
  const experiment = sealExperiment(context.experiment, catalog);
  return Object.freeze({
    preparedTarget,
    resources,
    snapshot,
    runtime,
    catalog,
    experiment,
    image,
    backendProfileDigest: discoveryInvocationBinding.backendProfileDigest,
    discoveryInvocation,
    discoveryEvidence,
  });
}

export function createEnrolledTargetAuthority(options: {
  readonly controllerId: string;
  /** Authority-owned clock; injectable only to make deterministic tests possible. */
  readonly clock?: () => string;
}): EnrolledTargetAuthority {
  identifierV2Schema.parse(options.controllerId);
  const readClock = (): string =>
    timestampV2Schema.parse((options.clock ?? (() => new Date().toISOString()))());
  const enrollmentCapabilities = new WeakMap<
    EnrollmentCandidateCapability,
    EnrollmentState
  >();
  const reviewCapabilities = new WeakMap<
    EnrolledCallReviewCapability,
    ReviewState
  >();
  const consumedCapabilities = new WeakMap<ConsumedEnrolledCall, ConsumedState>();
  const dispatchReceipts = new WeakMap<
    PreparedEnrolledDispatch,
    Readonly<PreparedEnrolledDispatch>
  >();

  return Object.freeze({
    registerVerifiedEnrollment(input: {
      readonly record: unknown;
      readonly context: VerifiedEnrollmentContext;
    }): RegisteredEnrollment {
      let record: Readonly<McpEnrollmentRecordV2Alpha>;
      try {
        record = deepFreezeJson(
          mcpEnrollmentRecordV2AlphaSchema.parse(
            cloneStrictBoundedJson(
              input.record,
              V2_ARTIFACT_CLONE_LIMITS,
              "MCP enrollment record",
            ).clone,
          ),
        );
      } catch (error) {
        return fail("invalid_enrollment", "enrollment record is invalid", error);
      }
      let context: VerifiedEnrollmentContext;
      try {
        context = sealEnrollmentContext(input.context);
        validateEnrollmentContext(record, context);
      } catch (error) {
        if (error instanceof EnrolledAuthorityError) throw error;
        return fail(
          "invalid_enrollment",
          "verified enrollment context is invalid",
          error,
        );
      }
      if (record.enroller.id !== options.controllerId) {
        fail("binding_mismatch", "enrollment enroller differs from controller");
      }
      const recordDigest = enrollmentDigest(record);
      const capability = Object.freeze({}) as EnrollmentCandidateCapability;
      enrollmentCapabilities.set(capability, {
        record,
        recordDigest,
        context,
        reviewClaimed: false,
      });
      return Object.freeze({ record, recordDigest, capability });
    },

    approveExactCall(input: {
      readonly capability: EnrollmentCandidateCapability;
      readonly enrollmentRecord: unknown;
      readonly enrollmentDigest: string;
      readonly hypothesis: unknown;
      readonly reviewId: string;
      readonly reviewerId: string;
      readonly approvalClass: ApprovalClassV2;
    }): IssuedEnrolledCallReview {
      const state = enrollmentCapabilities.get(input.capability);
      if (state === undefined) {
        fail(
          "invalid_capability",
          "manual review requires the exact live enrollment capability",
        );
      }
      if (state.reviewClaimed) {
        fail("replay", "enrollment capability was already claimed for review");
      }
      // Burn before validation: a failed or substituted review never restores
      // authority to execute the retained untrusted target.
      state.reviewClaimed = true;
      let submittedEnrollment: McpEnrollmentRecordV2Alpha;
      try {
        submittedEnrollment = mcpEnrollmentRecordV2AlphaSchema.parse(
          cloneStrictBoundedJson(
            input.enrollmentRecord,
            V2_ARTIFACT_CLONE_LIMITS,
            "submitted enrollment record",
          ).clone,
        );
      } catch (error) {
        return fail(
          "binding_mismatch",
          "submitted enrollment record is invalid",
          error,
        );
      }
      if (
        input.enrollmentDigest !== state.recordDigest ||
        enrollmentDigest(submittedEnrollment) !== state.recordDigest
      ) {
        fail("binding_mismatch", "enrollment record or digest was substituted");
      }
      assertCanonicalEqual(
        "submitted enrollment record",
        submittedEnrollment,
        state.record,
      );
      validateEnrollmentContext(state.record, state.context);

      const hypothesis = parseHypothesis(input.hypothesis);
      const hypothesisDigest = digestCanonicalJson(
        "forge.outcome-hypothesis",
        "v1alpha1",
        hypothesis,
      );
      const { envelope, experimentCase, step } = selectedCall(
        state.context.experiment,
      );
      if (
        hypothesis.experimentPlanDigest !== envelope.experimentPlanDigest ||
        hypothesis.caseId !== experimentCase.caseId ||
        hypothesis.stepId !== step.stepId ||
        hypothesis.toolName !== step.toolName
      ) {
        fail("binding_mismatch", "hypothesis differs from the exact enrolled call");
      }
      assertCanonicalEqual(
        "hypothesis catalog",
        hypothesis.catalog,
        envelope.plan.catalog,
      );
      assertCanonicalEqual(
        "hypothesis planned effects",
        hypothesis.expected.predictedEffects,
        experimentCase.predictedEffects,
      );
      const reviewedAt = readClock();
      const approvalClass = input.approvalClass;
      const requiredApprovalClass = stricterApprovalClass(
        experimentCase.requiredApprovalClass,
        state.record.eligibility.requiredApprovalClass,
      );
      if (
        APPROVAL_CLASS_RANK[approvalClass] <
        APPROVAL_CLASS_RANK[requiredApprovalClass]
      ) {
        fail(
          "review_insufficient",
          "manual approval class is below the compiled case requirement",
        );
      }
      const policy = approvedPolicyV2Schema.parse(
        state.context.experiment.policy,
      );
      const maximumExpiresAt = new Date(
        Date.parse(reviewedAt) + ENROLLED_REVIEW_CAPABILITY_LIFETIME_MS,
      ).toISOString();
      const capabilityExpiresAt =
        policy.expiresAt === undefined ||
        Date.parse(policy.expiresAt) > Date.parse(maximumExpiresAt)
          ? maximumExpiresAt
          : policy.expiresAt;
      if (Date.parse(capabilityExpiresAt) <= Date.parse(reviewedAt)) {
        fail("expired", "enrolled policy expired before exact-call review");
      }
      const record = deepFreezeJson(
        mcpEnrollmentReviewRecordV2AlphaSchema.parse({
          format: "forge.mcp-enrollment-review/v1alpha1",
          reviewId: input.reviewId,
          enrollment: {
            enrollmentId: state.record.enrollmentId,
            enrollmentDigest: state.recordDigest,
            enrollmentRecordedAt: state.record.recordedAt,
            targetIdentityDigest: state.record.target.identityDigest,
            preparedTargetTreeSha256: state.record.preparedTree.treeSha256,
            runtimeInvocationDigest: state.record.runtime.invocation.digest,
            catalog: state.record.discovery.catalog,
            sandboxProfileDigest: state.record.sandbox.profileDigest,
            sandboxImageId: state.record.sandbox.imageId,
          },
          exactCall: {
            experimentPlanDigest: envelope.experimentPlanDigest,
            policyDigest: envelope.plan.policyDigest,
            hypothesisDigest,
            syntheticResourceManifestDigest:
              envelope.plan.syntheticResourceManifestDigest,
            planCompiledAt: envelope.plan.compiledAt,
            hypothesisCreatedAt: hypothesis.createdAt,
            ...(policy.expiresAt === undefined
              ? {}
              : { policyExpiresAt: policy.expiresAt }),
            caseId: experimentCase.caseId,
            stepId: step.stepId,
            toolName: step.toolName,
            argumentSha256: step.argumentSha256,
            sequence: 0,
            maxCalls: 1,
            maxRetries: 0,
            authorizesFollowup: false,
          },
          review: {
            reviewerId: input.reviewerId,
            method: "explicit_manual",
            externallyAuthenticatedIdentity: false,
            reviewedAt,
            decision: "approved",
            approvalClass,
            requiredApprovalClass,
            capabilityExpiresAt,
          },
          authority: {
            recordAuthorizesEnrollment: false,
            recordAuthorizesExecution: false,
            recordGrantsApproval: false,
            serializedRecordIsBearerAuthority: false,
            serializedCapabilityExists: false,
            requiredNextStep:
              "consume_opaque_single_use_enrollment_review_capability",
          },
          limitations: [
            "This serialized review is evidence only; only its exact in-memory opaque capability can enter execution.",
            "Reviewer identity is local controller provenance and is not externally authenticated.",
            "The review authorizes one exact call, not the target catalog or target behavior generally.",
          ],
        }),
      );
      const recordDigest = reviewDigest(record);
      const capability = Object.freeze({}) as EnrolledCallReviewCapability;
      reviewCapabilities.set(capability, {
        ...state,
        reviewRecord: record,
        reviewDigest: recordDigest,
        hypothesis,
        consumed: false,
      });
      return Object.freeze({ record, recordDigest, capability });
    },

    consumeExactCallReview(input: {
      readonly capability: EnrolledCallReviewCapability;
      readonly reviewRecord: unknown;
      readonly reviewDigest: string;
    }): ConsumedEnrolledCall {
      const state = reviewCapabilities.get(input.capability);
      if (state === undefined) {
        fail(
          "invalid_capability",
          "execution requires the exact live exact-call review capability",
        );
      }
      if (state.consumed) {
        fail("replay", "exact-call review capability was already consumed");
      }
      state.consumed = true;
      const now = readClock();
      let submitted: McpEnrollmentReviewRecordV2Alpha;
      try {
        submitted = mcpEnrollmentReviewRecordV2AlphaSchema.parse(
          cloneStrictBoundedJson(
            input.reviewRecord,
            V2_ARTIFACT_CLONE_LIMITS,
            "submitted enrolled-call review",
          ).clone,
        );
      } catch (error) {
        return fail(
          "binding_mismatch",
          "submitted exact-call review is invalid",
          error,
        );
      }
      if (
        input.reviewDigest !== state.reviewDigest ||
        reviewDigest(submitted) !== state.reviewDigest
      ) {
        fail("binding_mismatch", "review record or digest was substituted");
      }
      assertCanonicalEqual("submitted review record", submitted, state.reviewRecord);
      if (
        Date.parse(now) < Date.parse(state.reviewRecord.review.reviewedAt) ||
        Date.parse(now) >=
          Date.parse(state.reviewRecord.review.capabilityExpiresAt)
      ) {
        fail("expired", "exact-call review is outside its validity window");
      }
      const consumed = deepFreezeJson({
        authorization: {
          expiresAt: state.reviewRecord.review.capabilityExpiresAt,
          experiment: {
            experimentPlanDigest:
              state.reviewRecord.exactCall.experimentPlanDigest,
            policyDigest: state.reviewRecord.exactCall.policyDigest,
            hypothesisDigest: state.reviewRecord.exactCall.hypothesisDigest,
            caseId: state.reviewRecord.exactCall.caseId,
            stepId: state.reviewRecord.exactCall.stepId,
            toolName: state.reviewRecord.exactCall.toolName,
          },
        },
        enrollmentRecord: state.record,
        enrollmentDigest: state.recordDigest,
        reviewRecord: state.reviewRecord,
        reviewDigest: state.reviewDigest,
        hypothesis: state.hypothesis,
        consumedAt: now,
      }) as ConsumedEnrolledCall;
      consumedCapabilities.set(consumed, {
        ...state,
        consumedAt: now,
        dispatchClaimed: false,
      });
      return consumed;
    },

    async revalidateDispatch(input: {
      readonly consumed: ConsumedEnrolledCall;
      readonly invocation: EnrolledNodeStdioDockerInvocation;
      readonly liveCatalog: unknown;
      readonly toolName: string;
      readonly arguments: unknown;
    }): Promise<Readonly<PreparedEnrolledDispatch>> {
      const state = consumedCapabilities.get(input.consumed);
      if (state === undefined) {
        fail(
          "invalid_capability",
          "dispatch requires the exact live consumed review capability",
        );
      }
      if (state.dispatchClaimed) {
        fail("replay", "consumed review capability was already claimed for dispatch");
      }
      // Atomically burn the only dispatch claim before freshness work.
      state.dispatchClaimed = true;
      const now = readClock();
      if (
        Date.parse(now) < Date.parse(state.consumedAt) ||
        Date.parse(now) >=
          Date.parse(state.reviewRecord.review.capabilityExpiresAt)
      ) {
        fail("expired", "dispatch is outside the reviewed capability window");
      }
      assertCanonicalEqual(
        "consumed enrollment record",
        input.consumed.enrollmentRecord,
        state.record,
      );
      assertCanonicalEqual(
        "consumed review record",
        input.consumed.reviewRecord,
        state.reviewRecord,
      );
      assertCanonicalEqual("consumed authorization", input.consumed.authorization, {
        expiresAt: state.reviewRecord.review.capabilityExpiresAt,
        experiment: {
          experimentPlanDigest:
            state.reviewRecord.exactCall.experimentPlanDigest,
          policyDigest: state.reviewRecord.exactCall.policyDigest,
          hypothesisDigest: state.reviewRecord.exactCall.hypothesisDigest,
          caseId: state.reviewRecord.exactCall.caseId,
          stepId: state.reviewRecord.exactCall.stepId,
          toolName: state.reviewRecord.exactCall.toolName,
        },
      });
      validateEnrollmentContext(state.record, state.context);
      const invocationBindings = verifyEnrolledDockerInvocationBinding(
        input.invocation,
      );
      if (
        invocationBindings.backendProfileDigest !==
          state.record.sandbox.profileDigest ||
        input.invocation.backend.containerProcess.runtime.digest !==
          state.record.runtime.invocation.digest ||
        input.invocation.backend.targetMount.source !==
          state.context.preparedTarget.hostRoot ||
        input.invocation.backend.syntheticResourceMount.source !==
          state.context.resources.hostRoot
      ) {
        fail(
          "sandbox_prerequisites_unmet",
          "fresh Docker invocation differs from the enrolled sandbox, runtime, or mounts",
        );
      }
      await verifyPreparedRuntimeTree(
        state.context.preparedTarget.hostRoot,
        state.context.snapshot,
      );
      const resourceDigest = await state.context.resources.verify();
      if (
        resourceDigest !==
          state.reviewRecord.exactCall.syntheticResourceManifestDigest
      ) {
        fail("binding_mismatch", "synthetic resource manifest changed");
      }
      const liveCatalog = computeCatalogIdentity(
        input.liveCatalog,
        ENROLLED_DISCOVERY_CATALOG_BOUNDS,
      );
      const freshCompilation = compileExperimentPlan({
        ...state.context.experiment.compileInput,
        catalog: input.liveCatalog,
      });
      const submitted = verifyExperimentPlanEnvelope(
        state.context.experiment.compiled,
      );
      if (
        freshCompilation.experimentPlanDigest !==
          submitted.experimentPlanDigest ||
        freshCompilation.experimentPlanDigest !==
          state.reviewRecord.exactCall.experimentPlanDigest
      ) {
        fail("binding_mismatch", "fresh catalog compilation changed the plan");
      }
      assertCanonicalEqual("fresh plan", freshCompilation.plan, submitted.plan);
      assertCanonicalEqual(
        "fresh live catalog",
        liveCatalog.identity,
        state.reviewRecord.enrollment.catalog,
      );
      const policy = approvedPolicyV2Schema.parse(
        state.context.experiment.policy,
      );
      if (
        policy.expiresAt !== undefined &&
        Date.parse(now) >= Date.parse(policy.expiresAt)
      ) {
        fail("expired", "enrolled exact-target policy expired before dispatch");
      }
      const { step } = selectedCall(state.context.experiment);
      if (
        input.toolName !== step.toolName ||
        input.toolName !== state.reviewRecord.exactCall.toolName
      ) {
        fail("binding_mismatch", "dispatch tool differs from exact review");
      }
      assertCanonicalEqual("dispatch arguments", input.arguments, step.arguments);
      const argumentSha256 = digestCanonicalJson(
        "forge.tool-arguments",
        "v2",
        input.arguments,
      );
      if (argumentSha256 !== state.reviewRecord.exactCall.argumentSha256) {
        fail("binding_mismatch", "dispatch argument digest changed");
      }
      const projection = deepFreezeJson({
        toolName: step.toolName,
        arguments: step.arguments as Record<string, unknown>,
        argumentSha256,
        liveCatalogDigest: liveCatalog.identity.planCatalogDigest,
        runtimeInvocationDigest: state.context.runtime.digest,
        dockerInvocationDigest: invocationBindings.invocationDigest,
        checkedAt: now,
        sequence: 0 as const,
        authorization: input.consumed.authorization,
        consumedAt: state.consumedAt,
        enrollmentDigest: state.recordDigest,
        reviewDigest: state.reviewDigest,
      });
      const receipt = Object.freeze({
        ...projection,
        [preparedEnrolledDispatchBrand]: true as const,
      }) as Readonly<PreparedEnrolledDispatch>;
      dispatchReceipts.set(receipt, receipt);
      return receipt;
    },

    verifyDispatchReceipt(
      receipt: PreparedEnrolledDispatch,
    ): Readonly<PreparedEnrolledDispatch> {
      const issued = dispatchReceipts.get(receipt);
      if (issued === undefined || issued !== receipt) {
        fail(
          "invalid_capability",
          "result attribution requires the exact live dispatch receipt",
        );
      }
      return issued;
    },
  });
}

export function recomputeEnrolledPlan(
  compileInput: CompileExperimentPlanInput,
): CompiledExperimentPlanV2 {
  return compileExperimentPlan(compileInput);
}
