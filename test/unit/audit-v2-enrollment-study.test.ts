import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseStrictJson } from "../../src/audit/v2/strict-json.js";

async function studyRecord(): Promise<Record<string, any>> {
  return parseStrictJson(
    await readFile(
      new URL(
        "../../experiments/evidence-first-v2/unseen-enrollment-study-2026-08-30.json",
        import.meta.url,
      ),
    ),
  ) as Record<string, any>;
}

describe("tracked reviewed unseen-MCP enrollment study", () => {
  it("retains the exact bounded outcomes without raw MCP output", async () => {
    const record = await studyRecord();

    expect(Object.keys(record).sort()).toEqual(
      [
        "aggregate",
        "cases",
        "conclusion",
        "evidenceStatus",
        "executionClass",
        "format",
        "limitations",
        "question",
        "reviewDecline",
        "reviewMechanism",
        "runDate",
        "scope",
        "verification",
      ].sort(),
    );
    expect({
      format: record.format,
      runDate: record.runDate,
      question: record.question,
      executionClass: record.executionClass,
      reviewMechanism: record.reviewMechanism,
    }).toEqual({
      format: "forge.v2-unseen-enrollment-study/v1alpha1",
      runDate: "2026-08-30",
      question:
        "Can Forge enroll exact local or npm Node.js STDIO MCPs without target-specific source changes, require an exact-call review, execute no more than one call, quarantine the result, and fail closed on incompatible candidates?",
      executionClass: "enrolled_node_stdio_single_call",
      reviewMechanism:
        "deterministic_verifier_callback_with_exact_binding_echo",
    });
    expect(record.evidenceStatus).toEqual({
      kind: "sanitized_reproducible_semantic_summary",
      stableFieldsCheckedBy: "npm run verify:v2-enrollment",
      rawEvidenceTracked: false,
      perRunArtifactDigestsTracked: false,
      ephemeralEvidenceIndexesVerified: true,
    });
    expect(record.scope).toEqual({
      candidateSelection: "curated_fixed_not_random",
      candidateCounts: { localFixtures: 3, exactNpm: 3, total: 6 },
      syntheticInputsOnly: true,
      maxToolCallsPerCandidate: 1,
      callSelection: "operator_authored_yaml",
      hypothesisProposal: "optional_non_authoritative",
      supportedSources: ["exact_npm_version", "local_snapshot_install_none"],
      runtime: "direct_node_stdio",
      runtimeNetwork: "blocked",
      npmLifecycleScripts: "disabled",
      resultObservation: "result_channel_only",
    });

    expect(record.cases).toHaveLength(6);
    const completed = record.cases.filter(
      (experiment: Record<string, any>) => experiment.status === "completed",
    );
    const rejected = record.cases.filter(
      (experiment: Record<string, any>) => experiment.status === "rejected",
    );
    expect(record.aggregate).toEqual({
      configuredCandidates: record.cases.length,
      completed: completed.length,
      rejected: rejected.length,
      reviewDeclineControls: record.reviewDecline.status === "failed" ? 1 : 0,
      npmCompleted: completed.filter(
        (experiment: Record<string, any>) => experiment.source.kind === "npm",
      ).length,
      unexpectedDispositionCount: record.cases.filter(
        (experiment: Record<string, any>) =>
          experiment.status !== "completed" && experiment.status !== "rejected",
      ).length,
      targetContainersRemaining: 0,
      serializedArtifactsGrantAuthority: false,
      targetSafetyDeclared: false,
    });
    for (const experiment of completed) {
      expect(Object.keys(experiment).sort()).toEqual(
        [
          "cleanup",
          "comparison",
          "discovery",
          "execution",
          "id",
          "quarantine",
          "selectedTool",
          "sensorCoverage",
          "source",
          "status",
          "targetId",
          ...(experiment.id === "local_lifecycle_side_effect"
            ? ["blindSpotDemonstration"]
            : []),
        ].sort(),
      );
    }
    for (const experiment of rejected) {
      expect(Object.keys(experiment).sort()).toEqual(
        [
          "cleanup",
          "enrolledToolCallAuthorityIssued",
          "id",
          "reasonCodes",
          "source",
          "stage",
          "status",
          "targetId",
        ].sort(),
      );
    }
    expect(
      record.cases.map((experiment: Record<string, any>) => ({
        id: experiment.id,
        status: experiment.status,
        tool: experiment.selectedTool ?? null,
        stage: experiment.stage ?? null,
        reasonCodes: experiment.reasonCodes ?? [],
        calls: experiment.execution?.toolCalls ?? 0,
        authority:
          experiment.execution?.opaqueDispatchReceiptVerified ??
          experiment.enrolledToolCallAuthorityIssued,
        cleanup: experiment.cleanup,
      })),
    ).toEqual([
      {
        id: "local_echo",
        status: "completed",
        tool: "mirror_value",
        stage: null,
        reasonCodes: [],
        calls: 1,
        authority: true,
        cleanup: "verified",
      },
      {
        id: "local_math",
        status: "completed",
        tool: "add_numbers",
        stage: null,
        reasonCodes: [],
        calls: 1,
        authority: true,
        cleanup: "verified",
      },
      {
        id: "local_lifecycle_side_effect",
        status: "completed",
        tool: "readiness_probe",
        stage: null,
        reasonCodes: [],
        calls: 1,
        authority: true,
        cleanup: "verified",
      },
      {
        id: "npm_sequential_thinking",
        status: "completed",
        tool: "sequentialthinking",
        stage: null,
        reasonCodes: [],
        calls: 1,
        authority: true,
        cleanup: "verified",
      },
      {
        id: "npm_server_everything",
        status: "rejected",
        tool: null,
        stage: "catalog_validation",
        reasonCodes: ["catalog_changed"],
        calls: 0,
        authority: false,
        cleanup: "verified",
      },
      {
        id: "npm_wrtn_calculator",
        status: "rejected",
        tool: null,
        stage: "discovery_startup",
        reasonCodes: ["discovery_failed"],
        calls: 0,
        authority: false,
        cleanup: "verified",
      },
    ]);

    expect(
      record.cases
        .filter(
          (experiment: Record<string, any>) =>
            experiment.status === "completed",
        )
        .map((experiment: Record<string, any>) => ({
          id: experiment.id,
          comparison: experiment.comparison,
          completeSensors: experiment.sensorCoverage.complete,
          incompleteSensors: experiment.sensorCoverage.incomplete,
          exposure: experiment.quarantine.resultExposure,
          discovery: experiment.discovery,
          executionListCalls: experiment.execution.listCalls,
          retries: experiment.execution.retries,
          followups: experiment.execution.followupCalls,
          structuralOutputOnlyStringCheck:
            experiment.quarantine.structuralOutputOnlyStringCheck,
          rawResultExposedToPlanner:
            experiment.quarantine.rawResultExposedToPlanner,
          rawResultExposedToProvider:
            experiment.quarantine.rawResultExposedToProvider,
          rawResultUsedForFollowup:
            experiment.quarantine.rawResultUsedForFollowup,
        })),
    ).toEqual([
      {
        id: "local_echo",
        comparison: {
          expectation: "deviates",
          policy: "inconclusive",
          intrinsicRisk: "signals_observed",
          outcome: "intrinsic_hazard_evidence",
        },
        completeSensors: ["mcp_transcript", "cleanup"],
        incompleteSensors: ["process", "filesystem", "network"],
        exposure: "local_quarantine_only",
        discovery: { listCalls: 1, toolCalls: 0, catalogChanged: false },
        executionListCalls: 1,
        retries: 0,
        followups: 0,
        structuralOutputOnlyStringCheck: "passed",
        rawResultExposedToPlanner: false,
        rawResultExposedToProvider: false,
        rawResultUsedForFollowup: false,
      },
      ...[
        "local_math",
        "local_lifecycle_side_effect",
        "npm_sequential_thinking",
      ].map((id) => ({
        id,
        comparison: {
          expectation: "matches",
          policy: "inconclusive",
          intrinsicRisk: "no_signal_observed",
          outcome: "inconclusive",
        },
        completeSensors: ["mcp_transcript", "cleanup"],
        incompleteSensors: ["process", "filesystem", "network"],
        exposure: "local_quarantine_only",
        discovery: { listCalls: 1, toolCalls: 0, catalogChanged: false },
        executionListCalls: 1,
        retries: 0,
        followups: 0,
        structuralOutputOnlyStringCheck: "passed",
        rawResultExposedToPlanner: false,
        rawResultExposedToProvider: false,
        rawResultUsedForFollowup: false,
      })),
    ]);

    expect(record.reviewDecline).toEqual({
      id: "local_review_decline",
      targetId: "unfamiliar-math-mcp",
      status: "failed",
      stage: "review",
      review: {
        status: "declined",
        exactBindingsEchoed: true,
        externallyAuthenticatedIdentity: false,
      },
      dispatch: {
        requestedCalls: 1,
        sentCalls: 0,
        retries: 0,
        followupCalls: 0,
      },
      cleanup: "verified",
    });
    expect(
      record.cases
        .slice(0, 3)
        .map((experiment: Record<string, any>) => experiment.source),
    ).toEqual([
      { kind: "local_snapshot", installMode: "none" },
      { kind: "local_snapshot", installMode: "none" },
      { kind: "local_snapshot", installMode: "none" },
    ]);
    expect(record.cases[2].blindSpotDemonstration).toEqual({
      fixtureIntent:
        "initialization performs bounded child-process and temporary-filesystem effects",
      currentBehaviorSensors: "unavailable",
      effectsObservedByThisVerifier: false,
    });
    expect(
      record.cases
        .slice(3)
        .map((experiment: Record<string, any>) => experiment.source),
    ).toEqual([
      {
        kind: "npm",
        package: "@modelcontextprotocol/server-sequential-thinking",
        version: "2026.7.4",
        integrity:
          "sha512-tmR/ieGaeweffLNBrDp1H1w4sn4M6TN5yWSbMS+YMfS+0GDyPjnNKzqCl2uqfdRiX3D44PJUhwiDGqtJp6tFhw==",
      },
      {
        kind: "npm",
        package: "@modelcontextprotocol/server-everything",
        version: "2026.8.18",
        integrity:
          "sha512-sBW2l6uMa9ii78QixTKjXgNSv/Ad6LB8cTGBApJMytHe+VCufLQyME55JbLl/0+fcLmcx93wsZ6ce+0aOF8YXA==",
      },
      {
        kind: "npm",
        package: "@wrtnlabs/calculator-mcp",
        version: "0.2.1",
        integrity:
          "sha512-t0yEi/u/XMwj+fBI0hgkafNVCbUqTt8rBsIHKEPccH29RuY5+XU63LahXGOcPoW+OWUcmR94PaH2j8KJa6tPbw==",
      },
    ]);
    expect(record.conclusion).toEqual({
      hypothesis:
        "A target-independent reviewed one-call path can handle eligible exact local and npm Node.js STDIO MCPs without adding package-specific implementation code.",
      result: "supported_for_selected_cases",
      safetyVerdict: "not_assessed",
      generalization:
        "One previously unenrolled exact npm package and three local controls completed through the same generic path; two incompatible npm candidates were rejected without tool-call authority.",
    });
    expect(record.verification).toEqual({
      localVerifier: "npm run verify:v2-enrollment:local",
      localVerifierStatus: "passed",
      fullVerifier: "npm run verify:v2-enrollment",
      fullVerifierStatus: "passed",
      controlledV2Regression: "npm run verify:v2-outcome",
      controlledV2RegressionStatus: "passed",
    });
    expect(record.limitations).toEqual([
      "The call and exact arguments remain operator-authored YAML; the optional proposer predicts the result but does not select executable behavior.",
      "Selected-case results do not establish package, catalog-wide, or transitive-dependency safety.",
      "Process, filesystem, and network behavior remain unassessed in this result-channel-only alpha.",
      "The lifecycle fixture intentionally performs bounded process and temporary-filesystem effects during initialization, yet the current result-only observer cannot see them.",
      "Docker containment is not a malware-grade virtual machine boundary, so this path is not approved for known malware.",
      "Exact npm direct versions do not pin the complete transitive dependency graph across fresh acquisitions.",
      "The verifier callback exercises exact binding and decline behavior but is not externally authenticated human identity evidence.",
      "One-page catalogs only are supported; catalog pagination or change signals fail closed.",
      "Prepared-tree inspection is bounded but not a race-free filesystem snapshot.",
    ]);
  });

  it("contains no volatile run evidence or the known output-only taint", async () => {
    const source = await readFile(
      new URL(
        "../../experiments/evidence-first-v2/unseen-enrollment-study-2026-08-30.json",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).not.toContain("RESULT_ONLY_TAINT_93D7");
    expect(source).not.toContain("example.invalid/collect");
    expect(source).not.toMatch(/v2-enroll-[a-z0-9-]+-[a-f0-9]{10}/u);
    expect(source).not.toContain("forge-v2-enrollment-verify-");

    const record = await studyRecord();
    const stack: unknown[] = [record];
    while (stack.length > 0) {
      const current = stack.pop();
      if (typeof current === "string") {
        expect(current).not.toMatch(/\/(?:private|tmp|var)\//u);
        expect(current).not.toMatch(/(?:^|\/)runs\//u);
        expect(current).not.toMatch(/agent-run-[0-9]/u);
        continue;
      }
      if (current === null || typeof current !== "object") continue;
      for (const [key, value] of Object.entries(current)) {
        expect(key).not.toMatch(
          /^(?:runId|runDirectory|recordedAt|createdAt|reviewedAt|verifiedAt|expiresAt|containerName)$/u,
        );
        expect(key).not.toMatch(/(?:Sha256|Digest)$/u);
        stack.push(value);
      }
    }
  });
});
