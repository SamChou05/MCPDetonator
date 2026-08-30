import {
  approvalReceiptV2Schema,
  timestampV2Schema,
  type ApprovalClassV2,
  type ApprovalReceiptV2,
} from "../../contracts/v2/index.js";
import { verifyArtifactReference } from "./artifacts.js";
import {
  compileExperimentPlan,
  type CompiledExperimentPlanV2,
  type CompileExperimentPlanInput,
} from "./compile.js";
import { canonicalizeJson, digestCanonicalJson } from "./canonical.js";
import type { ExperimentPlanEnvelopeV2 } from "./envelope.js";
import { verifyExperimentPlanEnvelope } from "./envelope.js";
import { V2CompileError } from "./errors.js";
import { deepFreezeJson } from "./freeze.js";
import { maximumApprovalClass } from "./policy.js";
import {
  cloneStrictBoundedJson,
  V2_ARTIFACT_CLONE_LIMITS,
} from "./strict-clone.js";

export interface Phase1CaseDecision {
  readonly caseId: string;
  readonly decision: "approved" | "denied";
  readonly approvalClass: ApprovalClassV2;
}

export interface IssuePhase1ApprovalInput {
  readonly receiptId: string;
  readonly issuerId: string;
  readonly controllerId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly envelope: CompiledExperimentPlanV2;
  readonly compilationInput: CompileExperimentPlanInput;
  readonly caseDecisions: readonly Phase1CaseDecision[];
}

export interface Phase1ApprovalVerification {
  readonly receipt: Readonly<ApprovalReceiptV2>;
  readonly structurallyBound: true;
  readonly dispatchAuthorized: false;
}

function fail(message: string): never {
  throw new V2CompileError("receipt_invalid", message);
}

function validateDecisionCoverage(
  receipt: ApprovalReceiptV2,
  envelope: ExperimentPlanEnvelopeV2,
): void {
  const cases = new Map(envelope.plan.cases.map((item) => [item.caseId, item]));
  const seen = new Set<string>();
  for (const decision of receipt.caseDecisions) {
    if (seen.has(decision.caseId)) fail("approval receipt has duplicate case decisions");
    seen.add(decision.caseId);
    const planned = cases.get(decision.caseId);
    if (planned === undefined) fail("approval receipt references an unknown case");
    if (decision.decision !== "approved") {
      fail("a Phase 1 plan envelope requires every scoped case to be approved");
    }
    if (
      maximumApprovalClass(
        decision.approvalClass,
        planned.requiredApprovalClass,
      ) !== decision.approvalClass
    ) {
      fail("case approval class is lower than the compiled requirement");
    }
  }
  if (seen.size !== cases.size) fail("approval receipt does not cover every plan case");
  if (
    canonicalizeJson([...seen].sort()) !==
    canonicalizeJson([...receipt.scope.approvedCaseIds].sort())
  ) {
    fail("approval receipt scope and case decisions disagree");
  }
}

function expectedRepetitions(envelope: ExperimentPlanEnvelopeV2): number {
  return Math.max(...envelope.plan.cases.map((item) => item.repetition), 0);
}

function verifyCompiledResources(compiled: CompiledExperimentPlanV2): void {
  const instances = compiled.plan.syntheticResourceManifest.instances;
  if (compiled.resources.bytesByResourceId.size !== instances.length) {
    fail("compiled resource bytes do not exactly cover the plan manifest");
  }
  for (const instance of instances) {
    const bytes = compiled.resources.bytesByResourceId.get(instance.resourceId);
    if (bytes === undefined) fail("compiled resource bytes are missing");
    try {
      verifyArtifactReference(instance.artifact, bytes);
    } catch (error) {
      throw new V2CompileError(
        "receipt_invalid",
        "compiled resource bytes no longer match the plan manifest",
        { cause: error },
      );
    }
  }
}

export function issuePhase1Approval(
  input: IssuePhase1ApprovalInput,
): Readonly<ApprovalReceiptV2> {
  const submittedEnvelope = verifyExperimentPlanEnvelope(input.envelope);
  const recomputed = compileExperimentPlan(input.compilationInput);
  const envelope = verifyExperimentPlanEnvelope(recomputed);
  if (
    submittedEnvelope.experimentPlanDigest !== envelope.experimentPlanDigest
  ) {
    fail("submitted plan does not match deterministic recompilation");
  }
  verifyCompiledResources(recomputed);
  const issuedAt = timestampV2Schema.parse(input.issuedAt);
  const expiresAt = timestampV2Schema.parse(input.expiresAt);
  if (Date.parse(issuedAt) < Date.parse(envelope.plan.compiledAt)) {
    fail("approval receipt cannot be issued before the plan was compiled");
  }
  if (
    envelope.plan.policyExpiresAt !== undefined &&
    (Date.parse(issuedAt) >= Date.parse(envelope.plan.policyExpiresAt) ||
      Date.parse(expiresAt) > Date.parse(envelope.plan.policyExpiresAt))
  ) {
    fail("approval receipt cannot postdate the ApprovedPolicy validity window");
  }
  const receipt = approvalReceiptV2Schema.parse({
    schema: "forge.audit-approval/v2",
    receiptId: input.receiptId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    purpose: "audit_execution",
    audience: {
      controllerId: input.controllerId,
      environment: "phase1_contract_compiler",
    },
    scope: {
      planId: envelope.plan.planId,
      approvedCaseIds: input.caseDecisions
        .filter((decision) => decision.decision === "approved")
        .map((decision) => decision.caseId),
      repetitions: expectedRepetitions(envelope),
      maxUses: 1,
    },
    reusePolicy: "prohibited",
    authority: {
      issuerId: input.issuerId,
      authentication: "unsigned",
      authenticated: false,
    },
    dispatchEligibility: "non_dispatchable_phase1",
    target: envelope.plan.target,
    targetIdentityDigest: digestCanonicalJson(
      "forge.target-identity",
      "v2",
      envelope.plan.target,
    ),
    catalog: envelope.plan.catalog,
    claimProfileDigest: envelope.plan.claimProfileDigest,
    policyDigest: envelope.plan.policyDigest,
    ...(envelope.plan.policyExpiresAt === undefined
      ? {}
      : { policyExpiresAt: envelope.plan.policyExpiresAt }),
    auditSpecDigest: envelope.plan.auditSpecDigest,
    syntheticResourceManifestDigest:
      envelope.plan.syntheticResourceManifestDigest,
    experimentPlanDigest: envelope.experimentPlanDigest,
    executionBounds: envelope.plan.bounds,
    requiredApprovalClass: envelope.plan.requiredApprovalClass,
    caseDecisions: input.caseDecisions,
    canonicalization: "rfc8785-jcs",
    compiler: envelope.plan.compiler,
    executionBoundary: {
      runner: "not_implemented_phase1",
      sandbox: "not_approved_phase1",
    },
  });
  validateDecisionCoverage(receipt, envelope);
  return deepFreezeJson(receipt);
}

function assertSame(label: string, actual: unknown, expected: unknown): void {
  if (canonicalizeJson(actual) !== canonicalizeJson(expected)) {
    fail(`approval receipt ${label} binding does not match the plan`);
  }
}

export function verifyPhase1Approval(
  value: unknown,
  input: {
    readonly envelope: ExperimentPlanEnvelopeV2;
    readonly controllerId: string;
    readonly now: string;
  },
): Phase1ApprovalVerification {
  const envelope = verifyExperimentPlanEnvelope(input.envelope);
  const receipt = approvalReceiptV2Schema.parse(
    cloneStrictBoundedJson(
      value,
      V2_ARTIFACT_CLONE_LIMITS,
      "V2 ApprovalReceipt",
    ).clone,
  );
  const now = Date.parse(timestampV2Schema.parse(input.now));
  if (now < Date.parse(receipt.issuedAt) || now >= Date.parse(receipt.expiresAt)) {
    fail("approval receipt is not currently valid");
  }
  if (receipt.audience.controllerId !== input.controllerId) {
    fail("approval receipt audience does not match the controller");
  }
  if (receipt.scope.planId !== envelope.plan.planId) {
    fail("approval receipt plan scope does not match");
  }
  if (Date.parse(receipt.issuedAt) < Date.parse(envelope.plan.compiledAt)) {
    fail("approval receipt predates the compiled plan");
  }
  if (receipt.scope.repetitions !== expectedRepetitions(envelope)) {
    fail("approval receipt repetition scope does not match");
  }
  if (receipt.experimentPlanDigest !== envelope.experimentPlanDigest) {
    fail("approval receipt ExperimentPlan digest does not match");
  }
  if (
    receipt.targetIdentityDigest !==
    digestCanonicalJson(
      "forge.target-identity",
      "v2",
      envelope.plan.target,
    )
  ) {
    fail("approval receipt target identity digest does not match");
  }
  assertSame("target", receipt.target, envelope.plan.target);
  assertSame("catalog", receipt.catalog, envelope.plan.catalog);
  assertSame("execution bounds", receipt.executionBounds, envelope.plan.bounds);
  assertSame("compiler", receipt.compiler, envelope.plan.compiler);
  if (receipt.claimProfileDigest !== envelope.plan.claimProfileDigest) {
    fail("approval receipt ClaimProfile digest does not match");
  }
  if (receipt.policyDigest !== envelope.plan.policyDigest) {
    fail("approval receipt policy digest does not match");
  }
  if (receipt.policyExpiresAt !== envelope.plan.policyExpiresAt) {
    fail("approval receipt policy expiry does not match");
  }
  if (
    receipt.policyExpiresAt !== undefined &&
    (Date.parse(receipt.issuedAt) >= Date.parse(receipt.policyExpiresAt) ||
      Date.parse(receipt.expiresAt) > Date.parse(receipt.policyExpiresAt))
  ) {
    fail("approval receipt exceeds the ApprovedPolicy validity window");
  }
  if (receipt.auditSpecDigest !== envelope.plan.auditSpecDigest) {
    fail("approval receipt AuditSpec digest does not match");
  }
  if (
    receipt.syntheticResourceManifestDigest !==
    envelope.plan.syntheticResourceManifestDigest
  ) {
    fail("approval receipt synthetic manifest digest does not match");
  }
  if (receipt.requiredApprovalClass !== envelope.plan.requiredApprovalClass) {
    fail("approval receipt required class does not match");
  }
  validateDecisionCoverage(receipt, envelope);

  return Object.freeze({
    receipt: deepFreezeJson(receipt),
    structurallyBound: true,
    dispatchAuthorized: false,
  });
}
