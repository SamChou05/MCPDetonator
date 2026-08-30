import { describe, expect, it } from "vitest";

import { issuePhase1Approval } from "../../src/audit/v2/approval.js";
import { compileExperimentPlan } from "../../src/audit/v2/compile.js";
import { digestCanonicalJson } from "../../src/audit/v2/canonical.js";
import { verifyPhase1ReportingArtifacts } from "../../src/audit/v2/index.js";
import {
  APPROVAL_CLASS_RANK,
  V2_TOP_LEVEL_SCHEMA_IDS,
  approvalReceiptV2Schema,
  artifactReferenceV2Schema,
  auditCoverageV2Schema,
  auditResultV2Schema,
  auditSpecV2Schema,
  claimProfileV2Schema,
  experimentPlanV2Schema,
  v2TopLevelArtifactSchema,
  v2TopLevelSchemas,
} from "../../src/contracts/v2/index.js";
import {
  jsonClone,
  loadManualFixtureInputs,
} from "../helpers/evidence-first-v2.js";

async function validArtifacts() {
  const fixture = await loadManualFixtureInputs();
  const compiled = compileExperimentPlan(fixture.compileInput);
  const receipt = issuePhase1Approval({
    ...fixture.approval,
    envelope: compiled,
    compilationInput: fixture.compileInput,
    caseDecisions: compiled.plan.cases.map((item) => ({
      caseId: item.caseId,
      decision: "approved" as const,
      approvalClass: item.requiredApprovalClass,
    })),
  });
  const approvalReceiptDigest = digestCanonicalJson(
    "forge.audit-approval",
    "v2",
    receipt,
  );
  const coverage = auditCoverageV2Schema.parse({
    schema: "forge.audit-coverage/v2",
    coverageId: "phase1-coverage",
    recordedAt: "2026-08-30T07:31:00.000Z",
    execution: {
      mode: "phase1_contract_compiler",
      dispatched: false,
    },
    target: fixture.target,
    catalog: compiled.catalog.identity,
    experimentPlanDigest: compiled.experimentPlanDigest,
    approvalReceiptDigest,
    toolCoverage: {
      discoveredToolNames: ["read_document"],
      executedToolNames: [],
      catalogFreshness: {
        status: "not_rechecked",
      },
    },
    schemaCoverage: {
      dialect: "2020-12",
      supportedKeywords: ["type", "properties", "required"],
      unsupportedKeywords: ["pattern", "patternProperties", "$ref"],
      partitions: [],
    },
    workflowCoverage: {
      attemptedEdges: [],
      unsupportedBindings: [
        "Producer-output bindings are disabled in Phase 1A.",
      ],
    },
    phaseCoverage: [
      { phase: "invocation", status: "not_covered" },
      { phase: "post_return", status: "not_covered" },
    ],
    securityProbeCoverage: [
      {
        probeId: "mandatory-sensitive-read",
        status: "not_covered",
        caseIds: [compiled.plan.cases[1]!.caseId],
      },
    ],
    environmentVariantCoverage: [
      {
        variantId: "default",
        status: "not_covered",
        caseIds: compiled.plan.cases.map((item) => item.caseId),
      },
    ],
    sensorCoverage: fixture.auditSpec.requiredSensors.map((sensor) => ({
      sensor,
      status: "not_covered",
      gaps: ["V2 runtime execution is disabled in Phase 1A."],
    })),
    caseAccounting: {
      generated: 3,
      rejected: 0,
      skipped: 3,
      executed: 0,
      timedOut: 0,
      truncated: 0,
      inconclusive: 0,
    },
    budget: {
      exhausted: false,
      exhaustedDimensions: [],
      samplingStrategy: "Human-authored provider-free Phase 1A fixture.",
    },
    proposer: { mode: "disabled" },
    limitations: ["No target execution occurred."],
  });
  const result = auditResultV2Schema.parse({
    schema: "forge.audit-result/v2",
    resultId: "phase1-structural-result",
    completedAt: "2026-08-30T07:32:00.000Z",
    execution: {
      mode: "phase1_contract_compiler",
      dispatched: false,
    },
    status: "inconclusive",
    outcome: "unknown_or_untested",
    target: fixture.target,
    catalog: compiled.catalog.identity,
    auditSpecDigest: compiled.plan.auditSpecDigest,
    dimensions: {
      advertised: { claimProfileDigest: compiled.plan.claimProfileDigest },
      approved: {
        policyDigest: compiled.plan.policyDigest,
        approvalReceiptDigest,
      },
      predicted: { experimentPlanDigest: compiled.experimentPlanDigest },
      observed: {
        status: "not_observed",
        reason: "Phase 1A does not execute plans.",
      },
      risk: {
        status: "not_assessed",
        reason: "No runtime observations exist to assess.",
      },
      coverage: {
        coverageDigest: digestCanonicalJson(
          "forge.audit-coverage",
          "v2",
          coverage,
        ),
      },
    },
    catalogFreshness: {
      status: "not_rechecked",
    },
    cleanup: { status: "unverified" },
    limitations: ["Phase 1A does not execute plans."],
  });
  return { fixture, compiled, receipt, coverage, result };
}

describe("Evidence-First V2 contracts", () => {
  it("exports exactly the seven approved top-level identifiers", () => {
    expect(V2_TOP_LEVEL_SCHEMA_IDS).toEqual([
      "forge.claim-profile/v2",
      "forge.audit-policy/v2",
      "forge.audit-spec/v2",
      "forge.experiment-plan/v2",
      "forge.audit-approval/v2",
      "forge.audit-coverage/v2",
      "forge.audit-result/v2",
    ]);
    expect(Object.keys(v2TopLevelSchemas)).toEqual(V2_TOP_LEVEL_SCHEMA_IDS);
  });

  it("parses one valid artifact for every top-level contract", async () => {
    const { fixture, compiled, receipt, coverage, result } =
      await validArtifacts();
    const artifacts = [
      fixture.claimProfile,
      fixture.policy,
      fixture.auditSpec,
      compiled.plan,
      receipt,
      coverage,
      result,
    ];
    expect(artifacts.map((artifact) => artifact.schema)).toEqual(
      V2_TOP_LEVEL_SCHEMA_IDS,
    );
    for (const artifact of artifacts) {
      expect(v2TopLevelArtifactSchema.parse(artifact)).toEqual(artifact);
    }
  });

  it("cross-binds nonexecuting coverage and result artifacts", async () => {
    const { compiled, receipt, coverage, result } = await validArtifacts();
    const verified = verifyPhase1ReportingArtifacts({
      compiled,
      receipt,
      coverage,
      result,
    });
    expect(verified.coverageDigest).toBe(
      result.dimensions.coverage.coverageDigest,
    );

    const ghostCase = jsonClone(coverage);
    ghostCase.environmentVariantCoverage[0]!.caseIds.push("ghost-case");
    expect(() =>
      verifyPhase1ReportingArtifacts({
        compiled,
        receipt,
        coverage: ghostCase,
        result,
      }),
    ).toThrow("environment coverage case does not belong");

    const ghostTool = jsonClone(coverage);
    ghostTool.toolCoverage.discoveredToolNames = ["ghost_tool"];
    expect(() =>
      verifyPhase1ReportingArtifacts({
        compiled,
        receipt,
        coverage: ghostTool,
        result,
      }),
    ).toThrow("discovered tools");

    const substitutedResult = jsonClone(result);
    substitutedResult.dimensions.coverage.coverageDigest = "0".repeat(64);
    expect(() =>
      verifyPhase1ReportingArtifacts({
        compiled,
        receipt,
        coverage,
        result: substitutedResult,
      }),
    ).toThrow("CoverageRecord digest");

    for (const recordedAt of [
      "2026-08-30T06:59:59.999Z",
      "2026-08-30T07:00:30.000Z",
    ]) {
      const predatingCoverage = jsonClone(coverage);
      predatingCoverage.recordedAt = recordedAt;
      const reboundResult = jsonClone(result);
      reboundResult.dimensions.coverage.coverageDigest = digestCanonicalJson(
        "forge.audit-coverage",
        "v2",
        predatingCoverage,
      );
      expect(() =>
        verifyPhase1ReportingArtifacts({
          compiled,
          receipt,
          coverage: predatingCoverage,
          result: reboundResult,
        }),
      ).toThrow("cannot predate its ApprovalReceipt");
    }
  });

  it("rejects unknown fields in every top-level artifact", async () => {
    const { fixture, compiled, receipt, coverage, result } =
      await validArtifacts();
    const artifacts = [
      fixture.claimProfile,
      fixture.policy,
      fixture.auditSpec,
      compiled.plan,
      receipt,
      coverage,
      result,
    ];
    for (const artifact of artifacts) {
      expect(() =>
        v2TopLevelArtifactSchema.parse({
          ...artifact,
          unexpectedAuthority: "not-allowed",
        }),
      ).toThrow();
    }
  });

  it("keeps claims and plans structurally unable to authorize themselves", async () => {
    const { fixture, compiled } = await validArtifacts();
    expect(() =>
      claimProfileV2Schema.parse({
        ...fixture.claimProfile,
        authorization: { decision: "allow" },
      }),
    ).toThrow();
    expect(() =>
      experimentPlanV2Schema.parse({
        ...compiled.plan,
        experimentPlanDigest: compiled.experimentPlanDigest,
      }),
    ).toThrow();
    expect(() =>
      experimentPlanV2Schema.parse({
        ...compiled.plan,
        approval: { authority: "model" },
      }),
    ).toThrow();
    expect(() =>
      experimentPlanV2Schema.parse({
        ...compiled.plan,
        cases: compiled.plan.cases.map((item, index) =>
          index === 0 ? { ...item, kind: "negative_tool_call" } : item,
        ),
      }),
    ).toThrow();
  });

  it("binds manual budgets across repetitions and environment variants", async () => {
    const { fixture } = await validArtifacts();
    const spec = jsonClone(fixture.auditSpec);
    spec.environmentVariants = ["default", "alternate"];
    expect(() => auditSpecV2Schema.parse(spec)).toThrow(
      "mandatory reservation plus repeated manual cases exceeds",
    );
  });

  it("rejects receipt authority or dispatch escalation", async () => {
    const { receipt } = await validArtifacts();
    expect(() =>
      approvalReceiptV2Schema.parse({
        ...receipt,
        authority: {
          ...receipt.authority,
          authentication: "signed",
          authenticated: true,
        },
      }),
    ).toThrow();
    expect(() =>
      approvalReceiptV2Schema.parse({
        ...receipt,
        dispatchEligibility: "dispatchable",
      }),
    ).toThrow();
  });

  it("rejects paths, URIs, and executable payloads in ArtifactReference", () => {
    const valid = {
      artifactId: "bounded-artifact",
      kind: "source_bundle",
      mediaType: "application/json",
      byteLength: 2,
      sha256: "a".repeat(64),
    };
    expect(artifactReferenceV2Schema.parse(valid)).toEqual(valid);
    for (const addition of [
      { path: "/Users/operator/source" },
      { uri: "https://example.invalid/artifact" },
      { environment: "SECRET_PATH" },
      { executable: "node payload.js" },
    ]) {
      expect(() =>
        artifactReferenceV2Schema.parse({ ...valid, ...addition }),
      ).toThrow();
    }
  });

  it("keeps all six report dimensions distinct and required", async () => {
    const { result } = await validArtifacts();
    expect(Object.keys(result.dimensions)).toEqual([
      "advertised",
      "approved",
      "predicted",
      "observed",
      "risk",
      "coverage",
    ]);
    const missingPrediction = jsonClone(result) as unknown as Record<
      string,
      unknown
    >;
    delete (missingPrediction["dimensions"] as Record<string, unknown>)[
      "predicted"
    ];
    expect(() => auditResultV2Schema.parse(missingPrediction)).toThrow();
  });

  it("locks Phase 1A results to non-dispatch and inconclusive semantics", async () => {
    const { result } = await validArtifacts();
    expect(result.execution).toEqual({
      mode: "phase1_contract_compiler",
      dispatched: false,
    });
    expect(() =>
      auditResultV2Schema.parse({
        ...result,
        execution: { ...result.execution, dispatched: true },
      }),
    ).toThrow();
    expect(() =>
      auditResultV2Schema.parse({
        ...result,
        execution: { mode: "runtime", dispatched: false },
      }),
    ).toThrow();
    expect(() =>
      auditResultV2Schema.parse({
        ...result,
        cleanup: { status: "verified" },
      }),
    ).toThrow();
    expect(() =>
      auditResultV2Schema.parse({
        ...result,
        status: "completed",
        outcome: "no_covered_violation_observed",
        catalogFreshness: { status: "not_rechecked" },
      }),
    ).toThrow();
  });

  it("requires covered rows to identify at least one case", async () => {
    const { coverage } = await validArtifacts();

    const schemaCoverage = jsonClone(coverage);
    schemaCoverage.schemaCoverage.partitions.push({
      toolName: "read_document",
      jsonPointer: "/document_id",
      partition: "nominal",
      status: "covered",
      caseIds: [],
    });
    expect(() => auditCoverageV2Schema.parse(schemaCoverage)).toThrow(
      "covered schema partitions must identify at least one caseId",
    );

    const workflowCoverage = jsonClone(coverage);
    workflowCoverage.workflowCoverage.attemptedEdges.push({
      edgeId: "read-after-read",
      producerToolName: "read_document",
      consumerToolName: "read_document",
      bindingPointer: "/document_id",
      status: "covered",
      caseIds: [],
    });
    expect(() => auditCoverageV2Schema.parse(workflowCoverage)).toThrow(
      "covered workflow edges must identify at least one caseId",
    );

    const securityCoverage = jsonClone(coverage);
    securityCoverage.securityProbeCoverage[0] = {
      ...securityCoverage.securityProbeCoverage[0]!,
      status: "covered",
      caseIds: [],
    };
    expect(() => auditCoverageV2Schema.parse(securityCoverage)).toThrow(
      "covered security probes must identify at least one caseId",
    );

    const environmentCoverage = jsonClone(coverage);
    environmentCoverage.environmentVariantCoverage[0] = {
      ...environmentCoverage.environmentVariantCoverage[0]!,
      status: "covered",
      caseIds: [],
    };
    expect(() => auditCoverageV2Schema.parse(environmentCoverage)).toThrow(
      "covered environment variants must identify at least one caseId",
    );
  });

  it("keeps sensor gaps consistent with coverage status", async () => {
    const { coverage } = await validArtifacts();
    const coveredWithGap = jsonClone(coverage);
    coveredWithGap.sensorCoverage[0] = {
      ...coveredWithGap.sensorCoverage[0]!,
      status: "covered",
    };
    expect(() => auditCoverageV2Schema.parse(coveredWithGap)).toThrow(
      "covered sensors must not report coverage gaps",
    );

    const uncoveredWithoutGap = jsonClone(coverage);
    uncoveredWithoutGap.sensorCoverage[0] = {
      ...uncoveredWithoutGap.sensorCoverage[0]!,
      gaps: [],
    };
    expect(() => auditCoverageV2Schema.parse(uncoveredWithoutGap)).toThrow(
      "sensors that are not covered must explain at least one gap",
    );
  });

  it("rejects contradictory or duplicate set-like coverage facts", async () => {
    const { coverage, compiled } = await validArtifacts();

    const overlappingKeywords = jsonClone(coverage);
    overlappingKeywords.schemaCoverage.unsupportedKeywords.push("type");
    expect(() => auditCoverageV2Schema.parse(overlappingKeywords)).toThrow(
      "both supported and unsupported",
    );

    const duplicatePartitions = jsonClone(coverage);
    const partition = {
      toolName: "read_document",
      jsonPointer: "/path",
      partition: "nominal" as const,
      status: "covered" as const,
      caseIds: [compiled.plan.cases[0]!.caseId],
    };
    duplicatePartitions.schemaCoverage.partitions.push(partition, {
      ...partition,
      status: "unsupported",
    });
    expect(() => auditCoverageV2Schema.parse(duplicatePartitions)).toThrow(
      "duplicate schema partition",
    );

    const duplicateDimensions = jsonClone(coverage);
    duplicateDimensions.budget = {
      ...duplicateDimensions.budget,
      exhausted: true,
      exhaustedDimensions: ["cases", "cases"],
    };
    expect(() => auditCoverageV2Schema.parse(duplicateDimensions)).toThrow(
      "duplicate exhausted budget dimension",
    );
  });

  it("locks Phase 1A coverage to nonexecution and a disabled proposer", async () => {
    const { coverage } = await validArtifacts();
    const namedWithoutExecution = jsonClone(coverage);
    namedWithoutExecution.toolCoverage.executedToolNames = ["read_document"];
    expect(() => auditCoverageV2Schema.parse(namedWithoutExecution)).toThrow();

    const executionWithoutName = jsonClone(coverage) as unknown as {
      caseAccounting: { executed: number; skipped: number };
    };
    executionWithoutName.caseAccounting.executed = 1;
    executionWithoutName.caseAccounting.skipped = 2;
    expect(() => auditCoverageV2Schema.parse(executionWithoutName)).toThrow();

    const modelProposer = jsonClone(coverage) as unknown as Record<
      string,
      unknown
    >;
    modelProposer["proposer"] = {
      mode: "model",
      provider: "provider",
      model: "model",
      projectionDigest: "a".repeat(64),
    };
    expect(() => auditCoverageV2Schema.parse(modelProposer)).toThrow();

    const claimedCoverage = jsonClone(coverage);
    claimedCoverage.environmentVariantCoverage[0]!.status = "covered";
    expect(() => auditCoverageV2Schema.parse(claimedCoverage)).toThrow(
      "Phase 1A cannot claim executed coverage",
    );
  });

  it("accounts for every generated case exactly once", async () => {
    const { coverage } = await validArtifacts();
    const missingCaseDisposition = jsonClone(coverage);
    missingCaseDisposition.caseAccounting.skipped = 2;
    expect(() => auditCoverageV2Schema.parse(missingCaseDisposition)).toThrow(
      "rejected + skipped + executed must equal generated",
    );

    const overcountedCaseDisposition = jsonClone(coverage);
    overcountedCaseDisposition.caseAccounting.rejected = 1;
    expect(() => auditCoverageV2Schema.parse(overcountedCaseDisposition)).toThrow(
      "rejected + skipped + executed must equal generated",
    );
  });

  it("binds budget exhaustion to named exhausted dimensions", async () => {
    const { coverage } = await validArtifacts();
    const exhaustedWithoutDimension = jsonClone(coverage);
    exhaustedWithoutDimension.budget.exhausted = true;
    expect(() =>
      auditCoverageV2Schema.parse(exhaustedWithoutDimension),
    ).toThrow(
      "budget.exhausted must be true if and only if exhaustedDimensions is non-empty",
    );

    const dimensionWithoutExhaustion = jsonClone(coverage);
    dimensionWithoutExhaustion.budget.exhaustedDimensions = ["cases"];
    expect(() =>
      auditCoverageV2Schema.parse(dimensionWithoutExhaustion),
    ).toThrow(
      "budget.exhausted must be true if and only if exhaustedDimensions is non-empty",
    );
  });

  it("rejects duplicate claim IDs and preserves approval ordering", async () => {
    const { fixture } = await validArtifacts();
    const duplicate = jsonClone(fixture.claimProfile);
    duplicate.claims.push(jsonClone(duplicate.claims[0]!));
    expect(() => claimProfileV2Schema.parse(duplicate)).toThrow(
      "duplicate claimId",
    );
    const duplicateEvidence = jsonClone(fixture.claimProfile);
    duplicateEvidence.claims[0]!.evidence.push(
      jsonClone(duplicateEvidence.claims[0]!.evidence[0]!),
    );
    expect(() => claimProfileV2Schema.parse(duplicateEvidence)).toThrow(
      "duplicate claim evidence row",
    );
    expect(APPROVAL_CLASS_RANK).toEqual({
      automatic: 0,
      operator_review: 1,
      security_review: 2,
    });
  });
});
