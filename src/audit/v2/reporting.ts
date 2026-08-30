import {
  approvalReceiptV2Schema,
  auditCoverageV2Schema,
  auditResultV2Schema,
  type ApprovalReceiptV2,
  type AuditCoverageV2,
  type AuditResultV2,
} from "../../contracts/v2/index.js";
import { verifyPhase1Approval } from "./approval.js";
import type { CompiledExperimentPlanV2 } from "./compile.js";
import { canonicalizeJson, digestCanonicalJson } from "./canonical.js";
import { verifyExperimentPlanEnvelope } from "./envelope.js";
import { V2CompileError } from "./errors.js";
import { deepFreezeJson } from "./freeze.js";
import {
  cloneStrictBoundedJson,
  V2_ARTIFACT_CLONE_LIMITS,
} from "./strict-clone.js";

export interface VerifiedPhase1ReportingArtifacts {
  readonly coverage: Readonly<AuditCoverageV2>;
  readonly result: Readonly<AuditResultV2>;
  readonly approvalReceiptDigest: string;
  readonly coverageDigest: string;
}

function fail(message: string): never {
  throw new V2CompileError("digest_mismatch", message);
}

function assertSame(label: string, actual: unknown, expected: unknown): void {
  if (canonicalizeJson(actual) !== canonicalizeJson(expected)) {
    fail(`${label} does not match the compiled plan`);
  }
}

function parseBounded<T>(
  value: unknown,
  label: string,
  parse: (detached: unknown) => T,
): T {
  return parse(
    cloneStrictBoundedJson(value, V2_ARTIFACT_CLONE_LIMITS, label).clone,
  );
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function assertExactNames(
  label: string,
  actual: Iterable<string>,
  expected: Iterable<string>,
): void {
  if (canonicalizeJson(sorted(actual)) !== canonicalizeJson(sorted(expected))) {
    fail(`${label} does not exactly match the compiled plan`);
  }
}

/**
 * Cross-bind the schema-valid, explicitly nonexecuting Phase 1A reporting
 * artifacts. This verifies identities and references only; it does not convert
 * them into runtime observations, freshness evidence, or an attestation.
 */
export function verifyPhase1ReportingArtifacts(input: {
  readonly compiled: CompiledExperimentPlanV2;
  readonly receipt: unknown;
  readonly coverage: unknown;
  readonly result: unknown;
}): VerifiedPhase1ReportingArtifacts {
  const envelope = verifyExperimentPlanEnvelope(input.compiled);
  const receipt = parseBounded(
    input.receipt,
    "Phase 1A ApprovalReceipt reporting input",
    (value): ApprovalReceiptV2 => approvalReceiptV2Schema.parse(value),
  );
  verifyPhase1Approval(receipt, {
    envelope,
    controllerId: receipt.audience.controllerId,
    now: receipt.issuedAt,
  });
  const coverage = parseBounded(
    input.coverage,
    "Phase 1A CoverageRecord",
    (value): AuditCoverageV2 => auditCoverageV2Schema.parse(value),
  );
  const result = parseBounded(
    input.result,
    "Phase 1A AuditResult",
    (value): AuditResultV2 => auditResultV2Schema.parse(value),
  );

  const approvalReceiptDigest = digestCanonicalJson(
    "forge.audit-approval",
    "v2",
    receipt,
  );
  if (coverage.experimentPlanDigest !== envelope.experimentPlanDigest) {
    fail("CoverageRecord ExperimentPlan digest does not match");
  }
  if (coverage.approvalReceiptDigest !== approvalReceiptDigest) {
    fail("CoverageRecord ApprovalReceipt digest does not match");
  }
  if (Date.parse(coverage.recordedAt) < Date.parse(receipt.issuedAt)) {
    fail("CoverageRecord cannot predate its ApprovalReceipt");
  }
  assertSame("CoverageRecord target", coverage.target, envelope.plan.target);
  assertSame("CoverageRecord catalog", coverage.catalog, envelope.plan.catalog);
  assertSame(
    "compiled catalog identity",
    input.compiled.catalog.identity,
    envelope.plan.catalog,
  );

  const planCases = new Map(
    envelope.plan.cases.map((experimentCase) => [
      experimentCase.caseId,
      experimentCase,
    ] as const),
  );
  if (coverage.caseAccounting.generated !== planCases.size) {
    fail("CoverageRecord generated case count does not match the plan");
  }
  assertExactNames(
    "CoverageRecord discovered tools",
    coverage.toolCoverage.discoveredToolNames,
    input.compiled.catalog.catalog.tools.map((tool) => tool.name),
  );

  const referencedCases: Array<readonly [string, string]> = [];
  for (const partition of coverage.schemaCoverage.partitions) {
    const knownTool = input.compiled.catalog.catalog.tools.some(
      (tool) => tool.name === partition.toolName,
    );
    if (!knownTool) fail("schema coverage references an unknown tool");
    for (const caseId of partition.caseIds) {
      referencedCases.push(["schema coverage", caseId]);
      if (
        !planCases
          .get(caseId)
          ?.steps.some((step) => step.toolName === partition.toolName)
      ) {
        fail("schema coverage case does not exercise its named tool");
      }
    }
  }
  for (const edge of coverage.workflowCoverage.attemptedEdges) {
    const toolNames = new Set(
      input.compiled.catalog.catalog.tools.map((tool) => tool.name),
    );
    if (
      !toolNames.has(edge.producerToolName) ||
      !toolNames.has(edge.consumerToolName)
    ) {
      fail("workflow coverage references an unknown tool");
    }
    for (const caseId of edge.caseIds) {
      referencedCases.push(["workflow coverage", caseId]);
    }
  }
  for (const probe of coverage.securityProbeCoverage) {
    for (const caseId of probe.caseIds) {
      referencedCases.push(["security-probe coverage", caseId]);
      if (planCases.get(caseId)?.kind !== "security_probe") {
        fail("security-probe coverage references a non-security case");
      }
    }
  }
  for (const variant of coverage.environmentVariantCoverage) {
    if (
      !envelope.plan.cases.some(
        (experimentCase) =>
          experimentCase.environmentVariant === variant.variantId,
      )
    ) {
      fail("environment coverage references an unknown variant");
    }
    for (const caseId of variant.caseIds) {
      referencedCases.push(["environment coverage", caseId]);
      if (planCases.get(caseId)?.environmentVariant !== variant.variantId) {
        fail("environment coverage case does not belong to its named variant");
      }
    }
  }
  for (const [label, caseId] of referencedCases) {
    if (!planCases.has(caseId)) fail(`${label} references an unknown caseId`);
  }
  assertExactNames(
    "CoverageRecord sensors",
    coverage.sensorCoverage.map((row) => row.sensor),
    envelope.plan.requiredSensors,
  );

  const coverageDigest = digestCanonicalJson(
    "forge.audit-coverage",
    "v2",
    coverage,
  );
  assertSame("AuditResult target", result.target, envelope.plan.target);
  assertSame("AuditResult catalog", result.catalog, envelope.plan.catalog);
  if (result.auditSpecDigest !== envelope.plan.auditSpecDigest) {
    fail("AuditResult AuditSpec digest does not match");
  }
  if (
    result.dimensions.advertised.claimProfileDigest !==
    envelope.plan.claimProfileDigest
  ) {
    fail("AuditResult ClaimProfile digest does not match");
  }
  if (result.dimensions.approved.policyDigest !== envelope.plan.policyDigest) {
    fail("AuditResult policy digest does not match");
  }
  if (
    result.dimensions.approved.approvalReceiptDigest !== approvalReceiptDigest
  ) {
    fail("AuditResult ApprovalReceipt digest does not match");
  }
  if (
    result.dimensions.predicted.experimentPlanDigest !==
    envelope.experimentPlanDigest
  ) {
    fail("AuditResult ExperimentPlan digest does not match");
  }
  if (result.dimensions.coverage.coverageDigest !== coverageDigest) {
    fail("AuditResult CoverageRecord digest does not match");
  }
  if (Date.parse(result.completedAt) < Date.parse(coverage.recordedAt)) {
    fail("AuditResult cannot predate its CoverageRecord");
  }

  return Object.freeze({
    coverage: deepFreezeJson(coverage),
    result: deepFreezeJson(result),
    approvalReceiptDigest,
    coverageDigest,
  });
}
