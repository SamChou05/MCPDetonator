import {
  APPROVAL_CLASS_RANK,
  approvedPolicyV2Schema,
  identifierV2Schema,
  mcpEnrollmentRecordV2AlphaSchema,
  mcpEnrollmentReviewRecordV2AlphaSchema,
  outcomeHypothesisV2Schema,
  timestampV2Schema,
  type ApprovalClassV2,
  type McpEnrollmentRecordV2Alpha,
  type McpEnrollmentReviewRecordV2Alpha,
  type OutcomeHypothesisV2,
} from "../../contracts/v2/index.js";
import type { PreparedTarget } from "../../target/prepare.js";
import { computeCatalogIdentity } from "./catalog.js";
import { canonicalizeJson, digestCanonicalJson } from "./canonical.js";
import {
  compileExperimentPlan,
  type CompiledExperimentPlanV2,
  type CompileExperimentPlanInput,
} from "./compile.js";
import type { EnrolledExperimentInputs } from "./enrolled-experiment.js";
import {
  verifyEnrolledDockerInvocationBinding,
  type EnrolledNodeStdioDockerInvocation,
  type EnrolledSandboxResources,
  type VerifiedV2SandboxImage,
} from "./enrolled-sandbox.js";
import {
  verifyPreparedRuntimeTree,
  type NormalizedEnrolledNodeInvocation,
  type PreparedRuntimeTreeSnapshot,
} from "./enrolled-runtime.js";
import { verifyExperimentPlanEnvelope } from "./envelope.js";
import { deepFreezeJson } from "./freeze.js";
import {
  cloneStrictBoundedJson,
  V2_ARTIFACT_CLONE_LIMITS,
} from "./strict-clone.js";

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
}

declare const enrollmentCandidateBrand: unique symbol;
declare const enrolledCallReviewBrand: unique symbol;
declare const consumedEnrolledCallBrand: unique symbol;

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
    readonly reviewedAt: string;
    readonly capabilityExpiresAt: string;
    readonly approvalClass: ApprovalClassV2;
  }): IssuedEnrolledCallReview;
  consumeExactCallReview(input: {
    readonly capability: EnrolledCallReviewCapability;
    readonly reviewRecord: unknown;
    readonly reviewDigest: string;
    readonly now: string;
  }): ConsumedEnrolledCall;
  revalidateDispatch(input: {
    readonly consumed: ConsumedEnrolledCall;
    readonly invocation: EnrolledNodeStdioDockerInvocation;
    readonly liveCatalog: unknown;
    readonly toolName: string;
    readonly arguments: unknown;
    readonly now: string;
  }): Promise<Readonly<PreparedEnrolledDispatch>>;
  contextForConsumed(
    consumed: ConsumedEnrolledCall,
  ): VerifiedEnrollmentContext;
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

function validateEnrollmentContext(
  record: Readonly<McpEnrollmentRecordV2Alpha>,
  context: VerifiedEnrollmentContext,
): void {
  const catalog = computeCatalogIdentity(context.catalog);
  const { envelope } = selectedCall(context.experiment);
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
  assertCanonicalEqual("enrolled target identity", record.target.identity, envelope.plan.target);
  assertCanonicalEqual("enrolled catalog", record.discovery.catalog, catalog.identity);
  assertCanonicalEqual(
    "enrolled execution bounds",
    record.sandbox.executionBounds,
    envelope.plan.bounds,
  );
}

export function createEnrolledTargetAuthority(options: {
  readonly controllerId: string;
}): EnrolledTargetAuthority {
  identifierV2Schema.parse(options.controllerId);
  const enrollmentCapabilities = new WeakMap<
    EnrollmentCandidateCapability,
    EnrollmentState
  >();
  const reviewCapabilities = new WeakMap<
    EnrolledCallReviewCapability,
    ReviewState
  >();
  const consumedCapabilities = new WeakMap<ConsumedEnrolledCall, ConsumedState>();

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
      validateEnrollmentContext(record, input.context);
      const recordDigest = enrollmentDigest(record);
      const capability = Object.freeze({}) as EnrollmentCandidateCapability;
      enrollmentCapabilities.set(capability, {
        record,
        recordDigest,
        context: input.context,
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
      readonly reviewedAt: string;
      readonly capabilityExpiresAt: string;
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
      const submittedEnrollment = mcpEnrollmentRecordV2AlphaSchema.parse(
        cloneStrictBoundedJson(
          input.enrollmentRecord,
          V2_ARTIFACT_CLONE_LIMITS,
          "submitted enrollment record",
        ).clone,
      );
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
      const reviewedAt = timestampV2Schema.parse(input.reviewedAt);
      const capabilityExpiresAt = timestampV2Schema.parse(
        input.capabilityExpiresAt,
      );
      const approvalClass = input.approvalClass;
      if (
        APPROVAL_CLASS_RANK[approvalClass] <
        APPROVAL_CLASS_RANK[experimentCase.requiredApprovalClass]
      ) {
        fail(
          "review_insufficient",
          "manual approval class is below the compiled case requirement",
        );
      }
      const policy = approvedPolicyV2Schema.parse(
        state.context.experiment.policy,
      );
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
            requiredApprovalClass: experimentCase.requiredApprovalClass,
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
      readonly now: string;
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
      const now = timestampV2Schema.parse(input.now);
      const submitted = mcpEnrollmentReviewRecordV2AlphaSchema.parse(
        cloneStrictBoundedJson(
          input.reviewRecord,
          V2_ARTIFACT_CLONE_LIMITS,
          "submitted enrolled-call review",
        ).clone,
      );
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
      const consumed = Object.freeze({
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
      readonly now: string;
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
      const now = timestampV2Schema.parse(input.now);
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
      const liveCatalog = computeCatalogIdentity(input.liveCatalog);
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
      return deepFreezeJson({
        toolName: step.toolName,
        arguments: step.arguments as Record<string, unknown>,
        argumentSha256,
        liveCatalogDigest: liveCatalog.identity.planCatalogDigest,
        runtimeInvocationDigest: state.context.runtime.digest,
        dockerInvocationDigest: invocationBindings.invocationDigest,
        checkedAt: now,
        sequence: 0 as const,
      });
    },

    contextForConsumed(consumed: ConsumedEnrolledCall): VerifiedEnrollmentContext {
      const state = consumedCapabilities.get(consumed);
      if (state === undefined) {
        fail(
          "invalid_capability",
          "retained execution context requires the exact consumed capability",
        );
      }
      return state.context;
    },
  });
}

export function recomputeEnrolledPlan(
  compileInput: CompileExperimentPlanInput,
): CompiledExperimentPlanV2 {
  return compileExperimentPlan(compileInput);
}
