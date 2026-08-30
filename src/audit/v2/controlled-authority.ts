import {
  APPROVAL_CLASS_RANK,
  approvedPolicyV2Schema,
  controlledExecutionAuthorizationV2Schema,
  identifierV2Schema,
  outcomeHypothesisV2Schema,
  timestampV2Schema,
  type ApprovalClassV2,
  type ControlledExecutionAuthorizationV2,
  type OutcomeHypothesisV2,
} from "../../contracts/v2/index.js";
import {
  compileExperimentPlan,
  type CompileExperimentPlanInput,
} from "./compile.js";
import { computeCatalogIdentity } from "./catalog.js";
import { canonicalizeJson, digestCanonicalJson } from "./canonical.js";
import {
  type ExperimentPlanEnvelopeV2,
  verifyExperimentPlanEnvelope,
} from "./envelope.js";
import { deepFreezeJson } from "./freeze.js";
import { computeOutputSchemaExpectation } from "./outcome-comparison.js";
import {
  consumeControlledProposalReviewCapability,
  type ConsumeControlledProposalReviewInput,
} from "./controlled-proposal.js";
import {
  cloneStrictBoundedJson,
  V2_ARTIFACT_CLONE_LIMITS,
} from "./strict-clone.js";

export const CONTROLLED_EXECUTION_AUTHORITY_IDENTITY = Object.freeze({
  id: "forge-controlled-fixture-authority",
  version: "1alpha1",
});

export const CONTROLLED_EXECUTION_RUNNER_IDENTITY = Object.freeze({
  id: "forge-controlled-single-step-runner",
  version: "1alpha1",
});

export const CONTROLLED_EXECUTION_SANDBOX_IDENTITY = Object.freeze({
  id: "forge-docker-research-sandbox",
  version: "1alpha1-controlled-fixture-only",
});

export const CONTROLLED_PERMIT_MAX_LIFETIME_MS = 5 * 60_000;

const PERMIT_BRAND: unique symbol = Symbol("forge-controlled-execution-permit");
const CONSUMED_BRAND: unique symbol = Symbol(
  "forge-consumed-controlled-execution",
);

/** The exact object identity, not its fields, is the bearer capability. */
export interface ControlledExecutionPermit {
  readonly [PERMIT_BRAND]: true;
}

export type ControlledExecutionAuthorityErrorCode =
  | "invalid_authorization"
  | "sandbox_prerequisites_unmet"
  | "binding_mismatch"
  | "review_insufficient"
  | "expired"
  | "replay";

export class ControlledExecutionAuthorityError extends Error {
  public constructor(
    readonly code: ControlledExecutionAuthorityErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ControlledExecutionAuthorityError";
  }
}

export interface ControlledFixtureAllowlistEntry {
  readonly fixtureId: string;
  readonly targetIdentityDigest: string;
  readonly preparedTargetTreeSha256: string;
  readonly sandboxImageId: string;
  readonly proposalReviewRequired: boolean;
}

export interface IssueControlledExecutionInput {
  readonly authorizationId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly reviewerId: string;
  readonly approvalClass: ApprovalClassV2;
  readonly compileInput: CompileExperimentPlanInput;
  readonly envelope: ExperimentPlanEnvelopeV2;
  readonly hypothesis: unknown;
  readonly caseId: string;
  readonly stepId: string;
  readonly fixtureId: string;
  readonly preparedTargetTreeSha256: string;
  readonly sandboxImageId: string;
  readonly proposalReview?: Omit<
    ConsumeControlledProposalReviewInput,
    "consumedAt"
  >;
}

export interface IssuedControlledExecution {
  readonly permit: ControlledExecutionPermit;
  readonly authorization: Readonly<ControlledExecutionAuthorizationV2>;
  readonly authorizationDigest: string;
}

export interface ConsumedControlledExecution {
  readonly authorization: Readonly<ControlledExecutionAuthorizationV2>;
  readonly authorizationDigest: string;
  readonly consumedAt: string;
  readonly [CONSUMED_BRAND]: true;
}

interface ConsumedCapabilityState {
  readonly authorization: Readonly<ControlledExecutionAuthorizationV2>;
  readonly authorizationDigest: string;
  readonly consumedAt: string;
  dispatchClaimed: boolean;
}

const consumedCapabilities = new WeakMap<
  ConsumedControlledExecution,
  ConsumedCapabilityState
>();

export interface ControlledFixtureExecutionAuthority {
  issueSingleStepPermit(
    input: IssueControlledExecutionInput,
  ): IssuedControlledExecution;
  consumeSingleStepPermit(input: {
    readonly permit: ControlledExecutionPermit;
    readonly authorization: unknown;
    readonly authorizationDigest: string;
    readonly now: string;
  }): ConsumedControlledExecution;
}

interface PermitState {
  readonly authorization: Readonly<ControlledExecutionAuthorizationV2>;
  readonly authorizationDigest: string;
  consumed: boolean;
}

function fail(
  code: ControlledExecutionAuthorityErrorCode,
  message: string,
): never {
  throw new ControlledExecutionAuthorityError(code, message);
}

function assertCanonicalEqual(
  label: string,
  actual: unknown,
  expected: unknown,
) {
  if (canonicalizeJson(actual) !== canonicalizeJson(expected)) {
    fail("binding_mismatch", `${label} does not match`);
  }
}

function parseHypothesis(value: unknown): OutcomeHypothesisV2 {
  return outcomeHypothesisV2Schema.parse(
    cloneStrictBoundedJson(
      value,
      V2_ARTIFACT_CLONE_LIMITS,
      "controlled execution hypothesis",
    ).clone,
  );
}

/**
 * Atomically claim the exact live consumed capability for its sole reference-
 * monitor check. A failed check burns the claim; copied records and repeated
 * checks cannot be used as dispatch authority.
 */
export function claimConsumedControlledExecutionForDispatch(
  consumed: ConsumedControlledExecution,
): void {
  const state = consumedCapabilities.get(consumed);
  if (state === undefined) {
    fail(
      "invalid_authorization",
      "dispatch requires the exact live consumed execution capability",
    );
  }
  if (state.dispatchClaimed) {
    fail(
      "replay",
      "consumed execution capability was already claimed for dispatch",
    );
  }
  // Claim before any validation so an exception cannot restore authority.
  state.dispatchClaimed = true;
  if (
    consumed.authorizationDigest !== state.authorizationDigest ||
    consumed.consumedAt !== state.consumedAt
  ) {
    fail("binding_mismatch", "consumed execution capability fields changed");
  }
  assertCanonicalEqual(
    "consumed execution authorization",
    consumed.authorization,
    state.authorization,
  );
}

export function createControlledFixtureExecutionAuthority(options: {
  readonly controllerId: string;
  readonly allowedFixtures: readonly ControlledFixtureAllowlistEntry[];
}): ControlledFixtureExecutionAuthority {
  const controllerId = identifierV2Schema.parse(options.controllerId);
  const allowed = new Map<string, ControlledFixtureAllowlistEntry>();
  for (const entry of options.allowedFixtures) {
    const fixtureId = identifierV2Schema.parse(entry.fixtureId);
    if (allowed.has(fixtureId)) {
      throw new ControlledExecutionAuthorityError(
        "invalid_authorization",
        `duplicate controlled fixture '${fixtureId}'`,
      );
    }
    if (!/^[a-f0-9]{64}$/u.test(entry.targetIdentityDigest)) {
      throw new ControlledExecutionAuthorityError(
        "invalid_authorization",
        `controlled fixture '${fixtureId}' has an invalid target digest`,
      );
    }
    if (!/^[a-f0-9]{64}$/u.test(entry.preparedTargetTreeSha256)) {
      throw new ControlledExecutionAuthorityError(
        "invalid_authorization",
        `controlled fixture '${fixtureId}' has an invalid tree digest`,
      );
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(entry.sandboxImageId)) {
      throw new ControlledExecutionAuthorityError(
        "invalid_authorization",
        `controlled fixture '${fixtureId}' has an invalid sandbox image ID`,
      );
    }
    if (typeof entry.proposalReviewRequired !== "boolean") {
      throw new ControlledExecutionAuthorityError(
        "invalid_authorization",
        `controlled fixture '${fixtureId}' has an invalid proposal-review requirement`,
      );
    }
    allowed.set(fixtureId, Object.freeze({ ...entry, fixtureId }));
  }
  const permits = new WeakMap<ControlledExecutionPermit, PermitState>();

  return Object.freeze({
    issueSingleStepPermit(
      input: IssueControlledExecutionInput,
    ): IssuedControlledExecution {
      const fixture = allowed.get(identifierV2Schema.parse(input.fixtureId));
      if (fixture === undefined) {
        fail(
          "sandbox_prerequisites_unmet",
          "V2 runtime execution is restricted to an exact controlled-fixture allowlist",
        );
      }
      const issuedAt = timestampV2Schema.parse(input.issuedAt);
      let proposalReviewDigest: string | undefined;
      let proposalReviewExpiresAt: string | undefined;
      if (fixture.proposalReviewRequired) {
        if (input.proposalReview === undefined) {
          fail(
            "review_insufficient",
            "controlled fixture requires an opaque reviewed-proposal capability",
          );
        }
        const reviewed = consumeControlledProposalReviewCapability({
          ...input.proposalReview,
          consumedAt: issuedAt,
        });
        if (
          input.compileInput !== reviewed.finalCompileInput ||
          input.envelope !== reviewed.finalPlan
        ) {
          fail(
            "binding_mismatch",
            "execution inputs are not the exact reviewed proposal plan",
          );
        }
        proposalReviewDigest = reviewed.recordDigest;
        proposalReviewExpiresAt = reviewed.record.review.capabilityExpiresAt;
        if (
          input.reviewerId !== reviewed.record.review.reviewerId ||
          input.approvalClass !== reviewed.record.review.approvalClass
        ) {
          fail(
            "binding_mismatch",
            "execution review provenance differs from the consumed proposal review",
          );
        }
      } else if (input.proposalReview !== undefined) {
        fail(
          "binding_mismatch",
          "fixture does not admit a proposal-review capability",
        );
      }
      const compiled = compileExperimentPlan(input.compileInput);
      const submitted = verifyExperimentPlanEnvelope(input.envelope);
      if (compiled.experimentPlanDigest !== submitted.experimentPlanDigest) {
        fail(
          "binding_mismatch",
          "submitted plan does not match fresh compilation",
        );
      }
      assertCanonicalEqual("submitted plan", submitted.plan, compiled.plan);
      const catalog = computeCatalogIdentity(input.compileInput.catalog);
      assertCanonicalEqual(
        "compiled catalog",
        catalog.identity,
        compiled.plan.catalog,
      );
      const policy = approvedPolicyV2Schema.parse(
        cloneStrictBoundedJson(
          input.compileInput.policy,
          V2_ARTIFACT_CLONE_LIMITS,
          "controlled execution policy",
        ).clone,
      );
      const policyDigest = digestCanonicalJson(
        "forge.audit-policy",
        "v2",
        policy,
      );
      if (policyDigest !== compiled.plan.policyDigest) {
        fail(
          "binding_mismatch",
          "policy digest does not match the compiled plan",
        );
      }
      const hypothesis = parseHypothesis(input.hypothesis);
      const hypothesisDigest = digestCanonicalJson(
        "forge.outcome-hypothesis",
        "v1alpha1",
        hypothesis,
      );
      const experimentCase = compiled.plan.cases.find(
        (candidate) => candidate.caseId === input.caseId,
      );
      if (experimentCase === undefined)
        fail("binding_mismatch", "case is absent from plan");
      if (experimentCase.steps.length !== 1) {
        fail(
          "sandbox_prerequisites_unmet",
          "controlled V2 execution supports exactly one preplanned step",
        );
      }
      const step = experimentCase.steps.find(
        (candidate) => candidate.stepId === input.stepId,
      );
      if (step === undefined)
        fail("binding_mismatch", "step is absent from case");
      if (
        hypothesis.experimentPlanDigest !== compiled.experimentPlanDigest ||
        hypothesis.caseId !== experimentCase.caseId ||
        hypothesis.stepId !== step.stepId ||
        hypothesis.toolName !== step.toolName
      ) {
        fail(
          "binding_mismatch",
          "hypothesis is not bound to the selected step",
        );
      }
      assertCanonicalEqual(
        "hypothesis catalog",
        hypothesis.catalog,
        compiled.plan.catalog,
      );
      assertCanonicalEqual(
        "hypothesis predicted effects",
        hypothesis.expected.predictedEffects,
        experimentCase.predictedEffects,
      );
      const tool = catalog.catalog.tools.find(
        (candidate) => candidate.name === step.toolName,
      );
      if (tool === undefined)
        fail("binding_mismatch", "selected tool is absent");
      assertCanonicalEqual(
        "hypothesis output schema",
        hypothesis.expected.outputSchema,
        computeOutputSchemaExpectation(tool),
      );
      const targetIdentityDigest = digestCanonicalJson(
        "forge.target-identity",
        "v2",
        compiled.plan.target,
      );
      if (
        fixture.targetIdentityDigest !== targetIdentityDigest ||
        fixture.preparedTargetTreeSha256 !== input.preparedTargetTreeSha256
      ) {
        fail(
          "sandbox_prerequisites_unmet",
          "target identity or mounted-tree digest is outside the controlled-fixture allowlist",
        );
      }
      if (
        APPROVAL_CLASS_RANK[input.approvalClass] <
        APPROVAL_CLASS_RANK[experimentCase.requiredApprovalClass]
      ) {
        fail(
          "review_insufficient",
          "review class is lower than the compiled case requirement",
        );
      }
      const expiresAt = timestampV2Schema.parse(input.expiresAt);
      if (
        proposalReviewExpiresAt !== undefined &&
        Date.parse(expiresAt) > Date.parse(proposalReviewExpiresAt)
      ) {
        fail(
          "invalid_authorization",
          "execution authorization exceeds the reviewed-proposal capability window",
        );
      }
      if (!/^sha256:[a-f0-9]{64}$/u.test(input.sandboxImageId)) {
        fail(
          "sandbox_prerequisites_unmet",
          "sandbox image ID is not immutable",
        );
      }
      if (input.sandboxImageId !== fixture.sandboxImageId) {
        fail(
          "sandbox_prerequisites_unmet",
          "sandbox image is outside the controlled-fixture allowlist",
        );
      }
      if (
        Date.parse(expiresAt) - Date.parse(issuedAt) >
        CONTROLLED_PERMIT_MAX_LIFETIME_MS
      ) {
        fail(
          "invalid_authorization",
          "controlled execution capability lifetime exceeds five minutes",
        );
      }
      if (
        Date.parse(issuedAt) < Date.parse(hypothesis.createdAt) ||
        Date.parse(issuedAt) < Date.parse(compiled.plan.compiledAt)
      ) {
        fail(
          "invalid_authorization",
          "authorization predates its plan or hypothesis",
        );
      }
      if (
        policy.expiresAt !== undefined &&
        Date.parse(expiresAt) > Date.parse(policy.expiresAt)
      ) {
        fail(
          "invalid_authorization",
          "authorization exceeds the policy window",
        );
      }

      const authorization = deepFreezeJson(
        controlledExecutionAuthorizationV2Schema.parse({
          format: "forge.controlled-execution-authorization/v1alpha1",
          authorizationId: input.authorizationId,
          issuedAt,
          expiresAt,
          executionClass: "controlled_fixture_only",
          dispatchEligibility: "requires_live_opaque_capability",
          controller: {
            controllerId,
            authority: CONTROLLED_EXECUTION_AUTHORITY_IDENTITY,
            authenticatedRecord: false,
          },
          review: {
            reviewerId: input.reviewerId,
            approvalClass: input.approvalClass,
            decision: "approved",
          },
          experiment: {
            experimentPlanDigest: compiled.experimentPlanDigest,
            policyDigest,
            catalog: compiled.plan.catalog,
            controlledFixtureId: fixture.fixtureId,
            targetIdentityDigest,
            runtimeDescriptorDigest:
              compiled.plan.target.runtimeDescriptorDigest,
            preparedTargetTreeSha256: input.preparedTargetTreeSha256,
            syntheticResourceManifestDigest:
              compiled.plan.syntheticResourceManifestDigest,
            ...(proposalReviewDigest === undefined
              ? {}
              : { proposalReviewDigest }),
            hypothesisDigest,
            caseId: experimentCase.caseId,
            stepId: step.stepId,
            toolName: step.toolName,
            argumentSha256: step.argumentSha256,
            sequence: 0,
          },
          bounds: compiled.plan.bounds,
          boundary: {
            runner: CONTROLLED_EXECUTION_RUNNER_IDENTITY,
            sandbox: CONTROLLED_EXECUTION_SANDBOX_IDENTITY,
            imageId: input.sandboxImageId,
            network: "none",
            maxCalls: 1,
            maxRetries: 0,
            authorizesFollowup: false,
            resultExposure: "local_quarantine_only",
          },
          limitations: [
            "The serialized authorization record is evidence and cannot dispatch without its live opaque capability.",
            "This experimental authority permits only an exact repository-controlled fixture, not arbitrary local or npm MCP targets.",
          ],
        }),
      );
      const authorizationDigest = digestCanonicalJson(
        "forge.controlled-execution-authorization",
        "v1alpha1",
        authorization,
      );
      const permit = Object.freeze({
        [PERMIT_BRAND]: true as const,
      }) as ControlledExecutionPermit;
      permits.set(permit, {
        authorization,
        authorizationDigest,
        consumed: false,
      });
      return Object.freeze({ permit, authorization, authorizationDigest });
    },

    consumeSingleStepPermit(input: {
      readonly permit: ControlledExecutionPermit;
      readonly authorization: unknown;
      readonly authorizationDigest: string;
      readonly now: string;
    }): ConsumedControlledExecution {
      const state = permits.get(input.permit);
      if (state === undefined) {
        fail(
          "invalid_authorization",
          "dispatch requires the exact live opaque capability issued by this authority",
        );
      }
      if (state.consumed)
        fail("replay", "controlled execution permit was already consumed");
      const now = timestampV2Schema.parse(input.now);
      const submitted = controlledExecutionAuthorizationV2Schema.parse(
        cloneStrictBoundedJson(
          input.authorization,
          V2_ARTIFACT_CLONE_LIMITS,
          "controlled execution authorization record",
        ).clone,
      );
      if (
        input.authorizationDigest !== state.authorizationDigest ||
        digestCanonicalJson(
          "forge.controlled-execution-authorization",
          "v1alpha1",
          submitted,
        ) !== state.authorizationDigest
      ) {
        fail(
          "binding_mismatch",
          "authorization record or digest was substituted",
        );
      }
      assertCanonicalEqual(
        "authorization record",
        submitted,
        state.authorization,
      );
      if (
        Date.parse(now) < Date.parse(state.authorization.issuedAt) ||
        Date.parse(now) >= Date.parse(state.authorization.expiresAt)
      ) {
        fail(
          "expired",
          "controlled execution permit is outside its validity window",
        );
      }
      // Consume before any target process can start. Timeout, stale discovery,
      // runtime failure, and cleanup failure never restore this capability.
      state.consumed = true;
      const consumed = Object.freeze({
        authorization: state.authorization,
        authorizationDigest: state.authorizationDigest,
        consumedAt: now,
        [CONSUMED_BRAND]: true as const,
      });
      consumedCapabilities.set(consumed, {
        authorization: state.authorization,
        authorizationDigest: state.authorizationDigest,
        consumedAt: now,
        dispatchClaimed: false,
      });
      return consumed;
    },
  });
}
