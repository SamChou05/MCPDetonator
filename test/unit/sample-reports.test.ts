import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { reportV1Schema } from "../../src/contracts/v1.js";

const sampleReports = [
  "deceptive-control.report.json",
  "official-filesystem.report.json",
] as const;

describe("checked-in sample reports", () => {
  for (const filename of sampleReports) {
    it(`${filename} satisfies the current report contract`, async () => {
      const path = join(process.cwd(), "examples", "reports", filename);
      const document = JSON.parse(await readFile(path, "utf8")) as unknown;

      expect(() => reportV1Schema.parse(document)).not.toThrow();
    });
  }

  it("rejects a behavior claim reference that does not resolve", async () => {
    const path = join(
      process.cwd(),
      "examples",
      "reports",
      "deceptive-control.report.json",
    );
    const document = reportV1Schema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
    const reference = document.behaviorComparison.scopes
      .flatMap((scope) => scope.rows)
      .flatMap((row) => row.advertisedClaimReferences)[0];
    if (reference === undefined) {
      throw new Error("sample report lacks an advertised claim reference");
    }
    reference.fieldReference = "/tools/0/not-a-real-claim-field";

    expect(reportV1Schema.safeParse(document).success).toBe(false);
  });

  it("rejects erased advertised and static evidence even when row states are flipped", async () => {
    const path = join(
      process.cwd(),
      "examples",
      "reports",
      "deceptive-control.report.json",
    );
    const source = reportV1Schema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
    const withoutClaim = structuredClone(source);
    const claimedRow = withoutClaim.behaviorComparison.scopes
      .flatMap((scope) => scope.rows)
      .find((row) => row.advertisedState === "claimed");
    if (claimedRow === undefined) throw new Error("sample lacks a claimed row");
    claimedRow.advertisedClaimReferences = [];
    claimedRow.advertisedState = "not_claimed";
    expect(reportV1Schema.safeParse(withoutClaim).success).toBe(false);

    const withoutStatic = structuredClone(source);
    const staticRow = withoutStatic.behaviorComparison.scopes
      .flatMap((scope) => scope.rows)
      .find((row) => row.staticState === "found");
    if (staticRow === undefined) throw new Error("sample lacks a static row");
    staticRow.staticSignalIds = [];
    staticRow.staticState = "not_found";
    expect(reportV1Schema.safeParse(withoutStatic).success).toBe(false);
  });

  it("rejects incomplete or contradictory legacy static/runtime summaries", async () => {
    const path = join(
      process.cwd(),
      "examples",
      "reports",
      "deceptive-control.report.json",
    );
    const source = reportV1Schema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );

    const withoutRows = structuredClone(source);
    withoutRows.staticRuntimeComparison.rows = [];
    expect(reportV1Schema.safeParse(withoutRows).success).toBe(false);

    const changedStaticEvidence = structuredClone(source);
    const filesystem = changedStaticEvidence.staticRuntimeComparison.rows.find(
      (row) => row.capability === "filesystem_access",
    );
    if (filesystem === undefined || filesystem.staticSignalIds[0] === undefined) {
      throw new Error("sample lacks legacy filesystem static evidence");
    }
    filesystem.staticSignal = "not_found";
    filesystem.staticSignalIds = [];
    expect(reportV1Schema.safeParse(changedStaticEvidence).success).toBe(false);

    const duplicateStaticId = structuredClone(source);
    const duplicateRow = duplicateStaticId.staticRuntimeComparison.rows.find(
      (row) => row.capability === "filesystem_access",
    );
    const repeatedSignalId = duplicateRow?.staticSignalIds[0];
    if (duplicateRow === undefined || repeatedSignalId === undefined) {
      throw new Error("sample lacks a repeatable legacy static signal ID");
    }
    duplicateRow.staticSignalIds.push(repeatedSignalId);
    expect(reportV1Schema.safeParse(duplicateStaticId).success).toBe(false);

    const comparableWithoutCoherentState = structuredClone(source);
    const comparableRow =
      comparableWithoutCoherentState.staticRuntimeComparison.rows.find(
        (row) =>
          row.capability === "filesystem_access" &&
          row.runtimeEventIds.length > 0,
      );
    if (comparableRow === undefined) {
      throw new Error("sample lacks observed comparable runtime evidence");
    }
    comparableRow.runtimeObservation = "not_observed";
    expect(
      reportV1Schema.safeParse(comparableWithoutCoherentState).success,
    ).toBe(false);

    const unsupportedRuntimeEvidence = structuredClone(source);
    const unsupportedRow =
      unsupportedRuntimeEvidence.staticRuntimeComparison.rows.find(
        (row) => row.capability === "environment_access",
      );
    if (unsupportedRow === undefined) {
      throw new Error("sample lacks an unsupported runtime capability row");
    }
    unsupportedRow.runtimeObservation = "observed";
    unsupportedRow.runtimeEventIds = ["fabricated-runtime-event"];
    expect(reportV1Schema.safeParse(unsupportedRuntimeEvidence).success).toBe(
      false,
    );
  });

  it("rejects claim evidence that exceeds a lowered declared bound", async () => {
    const path = join(
      process.cwd(),
      "examples",
      "reports",
      "deceptive-control.report.json",
    );
    const source = reportV1Schema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );

    const loweredEvidenceLimit = structuredClone(source);
    const maximumEvidence = Math.max(
      ...loweredEvidenceLimit.advertisedClaims.interfaces.flatMap((analysis) =>
        analysis.capabilityAssessments.map(
          (assessment) => assessment.evidence.length,
        ),
      ),
    );
    if (maximumEvidence <= 1) {
      throw new Error("sample lacks enough claim evidence to lower its bound");
    }
    loweredEvidenceLimit.advertisedClaims.limits.maxEvidencePerCapability =
      maximumEvidence - 1;
    for (const analysis of loweredEvidenceLimit.advertisedClaims.interfaces) {
      analysis.limits.maxEvidencePerCapability = maximumEvidence - 1;
    }
    expect(reportV1Schema.safeParse(loweredEvidenceLimit).success).toBe(false);

    const loweredExcerptLimit = structuredClone(source);
    const maximumExcerpt = Math.max(
      ...loweredExcerptLimit.advertisedClaims.interfaces.flatMap((analysis) =>
        analysis.capabilityAssessments.flatMap((assessment) =>
          assessment.evidence.map((evidence) => evidence.excerpt.length),
        ),
      ),
    );
    if (maximumExcerpt <= 16) {
      throw new Error("sample lacks a claim excerpt above the schema minimum");
    }
    const excerptLimit = maximumExcerpt - 1;
    loweredExcerptLimit.advertisedClaims.limits.maxExcerptCharacters =
      excerptLimit;
    for (const analysis of loweredExcerptLimit.advertisedClaims.interfaces) {
      analysis.limits.maxExcerptCharacters = excerptLimit;
    }
    expect(reportV1Schema.safeParse(loweredExcerptLimit).success).toBe(false);
  });

  it("binds operator-scope state and top-level catalog fields to their source evidence", async () => {
    const path = join(
      process.cwd(),
      "examples",
      "reports",
      "deceptive-control.report.json",
    );
    const source = reportV1Schema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
    const withoutScope = structuredClone(source);
    const toolScope = withoutScope.behaviorComparison.scopes.find(
      (scope) => scope.kind === "tool",
    );
    if (toolScope === undefined) throw new Error("sample lacks a tool scope");
    for (const row of toolScope.rows) {
      row.operatorScopeState = "not_configured";
      row.unclassifiedRuntimeEventIds = [...row.runtimeEventIds];
      row.withinOperatorScopeEventIds = [];
      row.outsideOperatorScopeEventIds = [];
    }
    expect(reportV1Schema.safeParse(withoutScope).success).toBe(false);

    const changedCatalog = structuredClone(source);
    const firstTool = changedCatalog.advertisedTools[0];
    if (firstTool === undefined) throw new Error("sample lacks a tool catalog");
    firstTool.description = `${firstTool.description ?? ""} changed`;
    expect(reportV1Schema.safeParse(changedCatalog).success).toBe(false);

    const reorderedCatalog = reportV1Schema.parse(
      JSON.parse(
        await readFile(
          join(
            process.cwd(),
            "examples",
            "reports",
            "official-filesystem.report.json",
          ),
          "utf8",
        ),
      ) as unknown,
    );
    const first = reorderedCatalog.advertisedTools[0];
    const second = reorderedCatalog.advertisedTools[1];
    if (first === undefined || second === undefined) {
      throw new Error("sample lacks two advertised tools");
    }
    reorderedCatalog.advertisedTools[0] = second;
    reorderedCatalog.advertisedTools[1] = first;
    expect(reportV1Schema.safeParse(reorderedCatalog).success).toBe(false);

    const changedClaimDigest = structuredClone(source);
    const secondClaims = changedClaimDigest.advertisedClaims.interfaces[1];
    if (secondClaims === undefined) {
      throw new Error("sample lacks a second claim interface");
    }
    secondClaims.catalogSha256 = "0".repeat(64);
    expect(reportV1Schema.safeParse(changedClaimDigest).success).toBe(false);
  });

  it("rejects stale run identity, ghost interfaces, and miscounted static evidence", async () => {
    const path = join(
      process.cwd(),
      "examples",
      "reports",
      "deceptive-control.report.json",
    );
    const source = reportV1Schema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );

    const staleProvenance = structuredClone(source);
    staleProvenance.artifactProvenance.runId = "run-stale";
    expect(reportV1Schema.safeParse(staleProvenance).success).toBe(false);

    const staleFinding = structuredClone(source);
    if (staleFinding.findings[0] === undefined) {
      throw new Error("sample lacks a finding");
    }
    staleFinding.findings[0].runId = "run-stale";
    expect(reportV1Schema.safeParse(staleFinding).success).toBe(false);

    const miscountedStatic = structuredClone(source);
    if (miscountedStatic.staticAnalysis.capabilitySignals[0] === undefined) {
      throw new Error("sample lacks static capability evidence");
    }
    miscountedStatic.staticAnalysis.capabilitySignals[0].count += 1;
    expect(reportV1Schema.safeParse(miscountedStatic).success).toBe(false);

    const ghostInterface = structuredClone(source);
    const sourceClaims = ghostInterface.advertisedClaims.interfaces[0];
    if (sourceClaims === undefined) throw new Error("sample lacks claim evidence");
    ghostInterface.advertisedClaims.interfaces.push({
      schema: "forge.mcp-interface-claims/v1",
      runId: ghostInterface.runId,
      experimentId: "ghost-experiment",
      server: structuredClone(sourceClaims.server),
      catalogSha256: sourceClaims.catalogSha256,
      orderedCatalogSha256: sourceClaims.orderedCatalogSha256,
      limits: structuredClone(ghostInterface.advertisedClaims.limits),
      advertisedToolCount: 0,
      analyzedToolCount: 0,
      capabilityAssessments: [],
      annotations: [],
      annotationIssues: [],
      coverage: {
        schemaNodesVisited: 0,
        schemaTextCharactersExamined: 0,
        truncations: [],
        truncationsOmitted: 0,
      },
    });
    ghostInterface.advertisedInterfaceSummary.comparedExperimentIds.push(
      "ghost-experiment",
    );
    ghostInterface.advertisedInterfaceSummary.catalogFingerprints.push({
      experimentId: "ghost-experiment",
      sha256: sourceClaims.catalogSha256,
      orderedSha256: sourceClaims.orderedCatalogSha256,
    });
    expect(reportV1Schema.safeParse(ghostInterface).success).toBe(false);
  });

  it("binds static analysis to runtime provenance and enforces first-interface selection", async () => {
    const path = join(
      process.cwd(),
      "examples",
      "reports",
      "deceptive-control.report.json",
    );
    const source = reportV1Schema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );

    const changedSnapshot = structuredClone(source);
    changedSnapshot.staticAnalysis.snapshot.treeSha256 = "0".repeat(64);
    expect(reportV1Schema.safeParse(changedSnapshot).success).toBe(false);

    const missingRuntimeSnapshot = structuredClone(source);
    delete missingRuntimeSnapshot.artifactProvenance.runtimeSnapshot;
    expect(reportV1Schema.safeParse(missingRuntimeSnapshot).success).toBe(false);

    const secondInterface = source.advertisedClaims.interfaces[1];
    if (secondInterface === undefined) {
      throw new Error("sample lacks a second advertised-claim interface");
    }
    const changedSource = structuredClone(source);
    changedSource.advertisedInterfaceSummary.sourceExperimentId =
      secondInterface.experimentId;
    const secondFingerprint =
      changedSource.advertisedInterfaceSummary.catalogFingerprints.find(
        (fingerprint) =>
          fingerprint.experimentId === secondInterface.experimentId,
      );
    if (secondFingerprint === undefined) {
      throw new Error("sample lacks the second interface fingerprint");
    }
    changedSource.advertisedInterfaceSummary.sourceCatalogSha256 =
      secondFingerprint.sha256;
    changedSource.advertisedInterfaceSummary.sourceOrderedCatalogSha256 =
      secondFingerprint.orderedSha256;
    expect(reportV1Schema.safeParse(changedSource).success).toBe(false);
  });
});
