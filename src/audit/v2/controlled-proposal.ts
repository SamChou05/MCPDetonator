import {
  agentExperimentProposalV2Schema,
  agentProposalComparisonV2Schema,
  rawAgentProposalSubmissionV2Schema,
  type AgentProposalComparisonV2,
} from "../../contracts/v2/agent-proposal.js";
import {
  auditSpecV2Schema,
  manualAuditCaseV2Schema,
} from "../../contracts/v2/audit-spec.js";
import {
  CONTROLLED_PROPOSAL_REVIEW_FORMAT,
  controlledProposalReviewRecordV2AlphaSchema,
  type ControlledProposalReviewRecordV2Alpha,
} from "../../contracts/v2/controlled-proposal.js";
import {
  identifierV2Schema,
  timestampV2Schema,
} from "../../contracts/v2/common.js";
import {
  APPROVAL_CLASS_RANK,
  approvalClassV2Schema,
  type ApprovalClassV2,
} from "../../contracts/v2/vocabulary.js";
import {
  compareAgentProposalSubmission,
  prepareAgentProposalExperiment,
  type AgentProposalRunMetadataV2,
  type PrepareAgentProposalExperimentOptions,
} from "./agent-proposal.js";
import { canonicalizeJson, digestCanonicalJson } from "./canonical.js";
import {
  compileExperimentPlan,
  type CompiledExperimentPlanV2,
  type CompileExperimentPlanInput,
} from "./compile.js";
import { verifyExperimentPlanEnvelope } from "./envelope.js";
import { deepFreezeJson } from "./freeze.js";
import {
  cloneStrictBoundedJson,
  V2_ARTIFACT_CLONE_LIMITS,
} from "./strict-clone.js";

export type ControlledProposalReviewErrorCode =
  | "invalid_input"
  | "comparison_mismatch"
  | "proposal_not_accepted"
  | "semantic_mismatch"
  | "operator_case_invalid"
  | "final_compilation_mismatch"
  | "insufficient_review"
  | "timestamp_invalid"
  | "capability_invalid"
  | "capability_replayed"
  | "capability_expired"
  | "binding_mismatch";

export class ControlledProposalReviewError extends Error {
  public constructor(
    readonly code: ControlledProposalReviewErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ControlledProposalReviewError";
  }
}

export interface CreateControlledProposalReviewInput extends PrepareAgentProposalExperimentOptions {
  /** Inputs that produced the non-authoritative proposal context. */
  readonly proposalCompileInput: CompileExperimentPlanInput;
  readonly expectedContextDigest: string;
  readonly submission: unknown;
  /** A caller-retained comparison; it is never trusted without recomputation. */
  readonly comparison: unknown;
  readonly proposalMetadata: AgentProposalRunMetadataV2;
  readonly selectedProposalId: string;
  /** Independently controller-authored template; model predictions are rejected. */
  readonly operatorAdoptedCase: unknown;
  readonly finalCompilation: {
    readonly auditSpecId: string;
    readonly auditSpecCreatedAt: string;
    readonly planId: string;
    readonly manifestId: string;
    readonly compiledAt: string;
  };
  readonly review: {
    readonly reviewId: string;
    readonly reviewerId: string;
    readonly reviewedAt: string;
    readonly approvalClass: ApprovalClassV2;
    readonly capabilityExpiresAt: string;
  };
}

declare const controlledProposalReviewCapabilityBrand: unique symbol;

/**
 * Runtime authority is only the exact object returned by the issuer. The
 * private brand improves TypeScript ergonomics; the WeakMap is the boundary.
 */
export interface ControlledProposalReviewCapability {
  readonly [controlledProposalReviewCapabilityBrand]: never;
}

export interface IssuedControlledProposalReview {
  readonly record: Readonly<ControlledProposalReviewRecordV2Alpha>;
  readonly recordDigest: string;
  readonly experimentPlanDigest: string;
  readonly finalPlan: CompiledExperimentPlanV2;
  readonly finalCompileInput: CompileExperimentPlanInput;
  readonly capability: ControlledProposalReviewCapability;
}

export interface ConsumeControlledProposalReviewInput {
  readonly capability: ControlledProposalReviewCapability;
  readonly record: Readonly<ControlledProposalReviewRecordV2Alpha>;
  readonly recordDigest: string;
  readonly experimentPlanDigest: string;
  readonly finalPlan: CompiledExperimentPlanV2;
  readonly finalCompileInput: CompileExperimentPlanInput;
  readonly consumedAt: string;
}

export interface ConsumedControlledProposalReview {
  readonly record: Readonly<ControlledProposalReviewRecordV2Alpha>;
  readonly recordDigest: string;
  readonly experimentPlanDigest: string;
  readonly finalPlan: CompiledExperimentPlanV2;
  readonly finalCompileInput: CompileExperimentPlanInput;
  readonly consumedAt: string;
}

interface CapabilityState {
  consumed: boolean;
  readonly record: Readonly<ControlledProposalReviewRecordV2Alpha>;
  readonly recordDigest: string;
  readonly experimentPlanDigest: string;
  readonly finalPlan: CompiledExperimentPlanV2;
  readonly finalCompileInput: CompileExperimentPlanInput;
  readonly reviewedAtMs: number;
  readonly expiresAtMs: number;
}

const capabilityState = new WeakMap<
  ControlledProposalReviewCapability,
  CapabilityState
>();

function fail(
  code: ControlledProposalReviewErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new ControlledProposalReviewError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function detachedSubmission(value: unknown) {
  try {
    return rawAgentProposalSubmissionV2Schema.parse(
      cloneStrictBoundedJson(
        value,
        V2_ARTIFACT_CLONE_LIMITS,
        "controlled proposal submission",
      ).clone,
    );
  } catch (error) {
    return fail("invalid_input", "proposal submission is invalid", error);
  }
}

function detachedComparison(
  value: unknown,
): Readonly<AgentProposalComparisonV2> {
  try {
    return deepFreezeJson(
      agentProposalComparisonV2Schema.parse(
        cloneStrictBoundedJson(
          value,
          V2_ARTIFACT_CLONE_LIMITS,
          "controlled proposal comparison",
        ).clone,
      ),
    );
  } catch (error) {
    return fail("comparison_mismatch", "proposal comparison is invalid", error);
  }
}

function caseSemanticDigest(auditCase: {
  readonly steps: readonly {
    readonly toolName: string;
    readonly arguments: unknown;
  }[];
}): string {
  return digestCanonicalJson(
    "forge.agent-proposal-case-semantics",
    "v1alpha1",
    {
      steps: auditCase.steps.map((step) => ({
        toolName: step.toolName,
        arguments: step.arguments,
      })),
    },
  );
}

function strictestApprovalClass(
  ...classes: readonly ApprovalClassV2[]
): ApprovalClassV2 {
  return classes.reduce((strictest, candidate) =>
    APPROVAL_CLASS_RANK[candidate] > APPROVAL_CLASS_RANK[strictest]
      ? candidate
      : strictest,
  );
}

function assertFinalPlanBindings(
  finalPlan: CompiledExperimentPlanV2,
  expected: {
    readonly targetIdentityDigest: string;
    readonly catalog: unknown;
    readonly policyDigest: string;
    readonly claimProfileDigest: string;
  },
): void {
  const plan = finalPlan.plan;
  const targetIdentityDigest = digestCanonicalJson(
    "forge.target-identity",
    "v2",
    plan.target,
  );
  if (
    targetIdentityDigest !== expected.targetIdentityDigest ||
    canonicalizeJson(plan.catalog) !== canonicalizeJson(expected.catalog) ||
    plan.policyDigest !== expected.policyDigest ||
    plan.claimProfileDigest !== expected.claimProfileDigest
  ) {
    fail(
      "final_compilation_mismatch",
      "fresh final plan changed proposal-context authority inputs",
    );
  }
}

/**
 * Revalidate a selected model proposal, adopt only its call semantics into an
 * independently authored manual case, freshly compile, and issue one opaque
 * review capability. Neither the proposal nor the serialized record is
 * dispatch authority.
 */
export function createControlledProposalReview(
  input: CreateControlledProposalReviewInput,
): IssuedControlledProposalReview {
  const submission = detachedSubmission(input.submission);
  const suppliedComparison = detachedComparison(input.comparison);
  const selectedProposalId = identifierV2Schema.parse(input.selectedProposalId);

  const prepared = prepareAgentProposalExperiment(
    input.proposalCompileInput,
    input,
  );
  if (prepared.contextDigest !== input.expectedContextDigest) {
    fail(
      "comparison_mismatch",
      "proposal context digest does not match a fresh preparation",
    );
  }
  const comparison = compareAgentProposalSubmission({
    compileInput: input.proposalCompileInput,
    expectedContextDigest: input.expectedContextDigest,
    submission,
    metadata: input.proposalMetadata,
    ...(input.maxCandidates === undefined
      ? {}
      : { maxCandidates: input.maxCandidates }),
    ...(input.maxTotalSteps === undefined
      ? {}
      : { maxTotalSteps: input.maxTotalSteps }),
  });
  if (canonicalizeJson(suppliedComparison) !== canonicalizeJson(comparison)) {
    fail(
      "comparison_mismatch",
      "supplied proposal comparison differs from deterministic recomputation",
    );
  }

  const selectedRows = comparison.candidates.filter(
    (candidate) => candidate.proposalId === selectedProposalId,
  );
  if (
    selectedRows.length !== 1 ||
    selectedRows[0]?.disposition !== "accepted_novel"
  ) {
    fail(
      "proposal_not_accepted",
      "selected proposal must identify exactly one accepted_novel candidate",
    );
  }
  const selected = selectedRows[0];
  if (selected.semanticDigest === undefined || selected.caseId === undefined) {
    fail(
      "proposal_not_accepted",
      "accepted proposal is missing deterministic semantic bindings",
    );
  }
  const rawCandidate = submission.proposals[selected.index];
  let proposal;
  try {
    proposal = agentExperimentProposalV2Schema.parse(rawCandidate);
  } catch (error) {
    return fail(
      "proposal_not_accepted",
      "selected raw proposal candidate is invalid",
      error,
    );
  }
  if (
    proposal.proposalId !== selectedProposalId ||
    proposal.case.caseId !== selected.caseId
  ) {
    fail(
      "proposal_not_accepted",
      "selected comparison row does not bind the raw proposal candidate",
    );
  }
  const proposalSemanticDigest = caseSemanticDigest(proposal.case);
  if (proposalSemanticDigest !== selected.semanticDigest) {
    fail(
      "comparison_mismatch",
      "selected comparison semantic digest differs from the raw candidate",
    );
  }
  const selectedProposalDigest = digestCanonicalJson(
    "forge.controlled-selected-agent-proposal",
    "v1alpha1",
    proposal,
  );

  let adoptedCase;
  try {
    adoptedCase = manualAuditCaseV2Schema.parse(
      cloneStrictBoundedJson(
        input.operatorAdoptedCase,
        V2_ARTIFACT_CLONE_LIMITS,
        "operator-adopted proposal case",
      ).clone,
    );
  } catch (error) {
    return fail(
      "operator_case_invalid",
      "operator-adopted case is invalid",
      error,
    );
  }
  if (
    adoptedCase.predictedEffects.some(
      (prediction) =>
        prediction.origin !== "operator" ||
        prediction.evidenceBasis.some((basis) => basis.kind === "model_output"),
    )
  ) {
    fail(
      "operator_case_invalid",
      "adopted predictions must be independently operator-origin and cannot cite model output",
    );
  }
  const adoptedSemanticDigest = caseSemanticDigest(adoptedCase);
  if (adoptedCase.kind !== proposal.case.kind) {
    fail("semantic_mismatch", "adopted case changed the selected case kind");
  }
  if (adoptedSemanticDigest !== proposalSemanticDigest) {
    fail(
      "semantic_mismatch",
      "adopted case changed selected tool or symbolic argument semantics",
    );
  }
  if (
    selected.deterministicApprovalClass === undefined ||
    APPROVAL_CLASS_RANK[adoptedCase.minimumApprovalClass] <
      APPROVAL_CLASS_RANK[selected.deterministicApprovalClass]
  ) {
    fail(
      "operator_case_invalid",
      "adopted case minimum approval class is below the deterministic proposal requirement",
    );
  }

  const finalFields = {
    auditSpecId: identifierV2Schema.parse(input.finalCompilation.auditSpecId),
    auditSpecCreatedAt: timestampV2Schema.parse(
      input.finalCompilation.auditSpecCreatedAt,
    ),
    planId: identifierV2Schema.parse(input.finalCompilation.planId),
    manifestId: identifierV2Schema.parse(input.finalCompilation.manifestId),
    compiledAt: timestampV2Schema.parse(input.finalCompilation.compiledAt),
  };
  if (
    finalFields.auditSpecId === prepared.spec.specId ||
    finalFields.planId === input.proposalCompileInput.planId ||
    finalFields.manifestId === input.proposalCompileInput.manifestId ||
    Date.parse(finalFields.auditSpecCreatedAt) <
      Date.parse(prepared.spec.createdAt)
  ) {
    fail(
      "timestamp_invalid",
      "final compilation must use new identities and a non-regressing AuditSpec time",
    );
  }
  const finalAuditSpec = auditSpecV2Schema.parse({
    ...prepared.spec,
    specId: finalFields.auditSpecId,
    createdAt: finalFields.auditSpecCreatedAt,
    manualCases: [...prepared.spec.manualCases, adoptedCase],
  });
  const finalCompileInput: CompileExperimentPlanInput = {
    ...input.proposalCompileInput,
    planId: finalFields.planId,
    manifestId: finalFields.manifestId,
    compiledAt: finalFields.compiledAt,
    auditSpec: finalAuditSpec,
  };
  const finalPlan = compileExperimentPlan(finalCompileInput);
  assertFinalPlanBindings(finalPlan, {
    targetIdentityDigest: prepared.context.targetIdentityDigest,
    catalog: prepared.context.catalog,
    policyDigest: prepared.context.policyDigest,
    claimProfileDigest: prepared.spec.claimProfileDigest,
  });
  const auditSpecDigest = digestCanonicalJson(
    "forge.audit-spec",
    "v2",
    finalAuditSpec,
  );
  if (finalPlan.plan.auditSpecDigest !== auditSpecDigest) {
    fail(
      "final_compilation_mismatch",
      "fresh final plan does not bind the adopted AuditSpec",
    );
  }

  const requiredApprovalClass = strictestApprovalClass(
    "operator_review",
    selected.deterministicApprovalClass ?? "security_review",
    finalPlan.plan.requiredApprovalClass,
  );
  const approvalClass = approvalClassV2Schema.parse(input.review.approvalClass);
  if (
    APPROVAL_CLASS_RANK[approvalClass] <
    APPROVAL_CLASS_RANK[requiredApprovalClass]
  ) {
    fail(
      "insufficient_review",
      "operator review class is below the deterministic requirement",
    );
  }

  const comparisonDigest = digestCanonicalJson(
    "forge.agent-proposal-comparison",
    "v1alpha1",
    comparison,
  );
  const adoptedCaseTemplateDigest = digestCanonicalJson(
    "forge.controlled-proposal-adopted-case",
    "v1alpha1",
    adoptedCase,
  );
  let record: Readonly<ControlledProposalReviewRecordV2Alpha>;
  try {
    record = deepFreezeJson(
      controlledProposalReviewRecordV2AlphaSchema.parse({
        format: CONTROLLED_PROPOSAL_REVIEW_FORMAT,
        proposalEvidence: {
          contextDigest: comparison.contextDigest,
          submissionDigest: comparison.submissionDigest,
          comparisonDigest,
          selectedProposalId,
          selectedProposalDigest,
          selectedCaseId: selected.caseId,
          selectedCaseKind: proposal.case.kind,
          selectedCandidateIndex: selected.index,
          selectedCaseSemanticDigest: selected.semanticDigest,
        },
        adoption: {
          adoptedCaseId: adoptedCase.caseId,
          adoptedCaseKind: adoptedCase.kind,
          adoptedCaseSemanticDigest: adoptedSemanticDigest,
          adoptedCaseTemplateDigest,
          adoptedPredictionOrigin: "operator",
          independentOperatorPredictionsConfirmed: true,
          proposalPredictionsImported: false,
          proposalRationaleImported: false,
        },
        finalCompilation: {
          auditSpecDigest,
          experimentPlanDigest: finalPlan.experimentPlanDigest,
          auditSpecCreatedAt: finalAuditSpec.createdAt,
          planCompiledAt: finalPlan.plan.compiledAt,
          ...(finalPlan.plan.policyExpiresAt === undefined
            ? {}
            : { policyExpiresAt: finalPlan.plan.policyExpiresAt }),
        },
        review: {
          reviewId: identifierV2Schema.parse(input.review.reviewId),
          reviewerId: identifierV2Schema.parse(input.review.reviewerId),
          reviewedAt: timestampV2Schema.parse(input.review.reviewedAt),
          approvalClass,
          requiredApprovalClass,
          capabilityExpiresAt: timestampV2Schema.parse(
            input.review.capabilityExpiresAt,
          ),
        },
        authority: {
          recordAuthorizesExecution: false,
          recordGrantsApproval: false,
          serializedRecordIsBearerAuthority: false,
          serializedCapabilityExists: false,
          proposalPredictionsAreAuthority: false,
          proposalRationaleIsAuthority: false,
          requiredNextStep: "consume_opaque_single_use_review_capability",
        },
      }),
    );
  } catch (error) {
    return fail(
      "timestamp_invalid",
      "review timestamps or record bindings are invalid",
      error,
    );
  }
  const recordDigest = digestCanonicalJson(
    "forge.controlled-proposal-review",
    "v1alpha1",
    record,
  );
  const capability = Object.freeze(
    Object.create(null) as object,
  ) as ControlledProposalReviewCapability;
  capabilityState.set(capability, {
    consumed: false,
    record,
    recordDigest,
    experimentPlanDigest: finalPlan.experimentPlanDigest,
    finalPlan,
    finalCompileInput,
    reviewedAtMs: Date.parse(record.review.reviewedAt),
    expiresAtMs: Date.parse(record.review.capabilityExpiresAt),
  });

  return Object.freeze({
    record,
    recordDigest,
    experimentPlanDigest: finalPlan.experimentPlanDigest,
    finalPlan,
    finalCompileInput,
    capability,
  });
}

/**
 * Atomically burns the opaque capability before checking caller-supplied
 * bindings. A failed substitution therefore cannot be retried as an oracle.
 */
export function consumeControlledProposalReviewCapability(
  input: ConsumeControlledProposalReviewInput,
): ConsumedControlledProposalReview {
  const state = capabilityState.get(input.capability);
  if (state === undefined) {
    fail(
      "capability_invalid",
      "review capability is not an issuer-held object identity",
    );
  }
  if (state.consumed) {
    fail("capability_replayed", "review capability was already consumed");
  }
  state.consumed = true;

  let consumedAt: string;
  try {
    consumedAt = timestampV2Schema.parse(input.consumedAt);
  } catch (error) {
    return fail(
      "timestamp_invalid",
      "capability consumption time is invalid",
      error,
    );
  }
  const consumedAtMs = Date.parse(consumedAt);
  if (consumedAtMs < state.reviewedAtMs || consumedAtMs >= state.expiresAtMs) {
    fail(
      "capability_expired",
      "review capability was consumed outside its reviewed lifetime",
    );
  }

  if (
    input.record !== state.record ||
    input.finalPlan !== state.finalPlan ||
    input.finalCompileInput !== state.finalCompileInput ||
    input.recordDigest !== state.recordDigest ||
    input.experimentPlanDigest !== state.experimentPlanDigest
  ) {
    fail(
      "binding_mismatch",
      "review record, digest, or final plan was substituted",
    );
  }
  const parsedRecord = controlledProposalReviewRecordV2AlphaSchema.parse(
    input.record,
  );
  const recomputedRecordDigest = digestCanonicalJson(
    "forge.controlled-proposal-review",
    "v1alpha1",
    parsedRecord,
  );
  if (recomputedRecordDigest !== state.recordDigest) {
    fail("binding_mismatch", "review record digest no longer matches");
  }
  const verifiedPlan = verifyExperimentPlanEnvelope(input.finalPlan);
  const recompiled = compileExperimentPlan(input.finalCompileInput);
  if (
    verifiedPlan.experimentPlanDigest !== state.experimentPlanDigest ||
    recompiled.experimentPlanDigest !== state.experimentPlanDigest ||
    canonicalizeJson(recompiled.plan) !== canonicalizeJson(verifiedPlan.plan) ||
    parsedRecord.finalCompilation.experimentPlanDigest !==
      state.experimentPlanDigest ||
    parsedRecord.finalCompilation.auditSpecDigest !==
      verifiedPlan.plan.auditSpecDigest
  ) {
    fail(
      "binding_mismatch",
      "fresh plan no longer matches the reviewed record",
    );
  }

  return Object.freeze({
    record: state.record,
    recordDigest: state.recordDigest,
    experimentPlanDigest: state.experimentPlanDigest,
    finalPlan: state.finalPlan,
    finalCompileInput: state.finalCompileInput,
    consumedAt,
  });
}
