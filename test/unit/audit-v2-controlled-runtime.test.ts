import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { digestCanonicalJson } from "../../src/audit/v2/canonical.js";
import {
  createControlledFixtureExecutionAuthority,
  type ConsumedControlledExecution,
} from "../../src/audit/v2/controlled-authority.js";
import {
  CONTROLLED_CONTROL_DOCUMENT,
  CONTROLLED_OUTCOME_CATALOG,
  CONTROLLED_RESULT_FIXTURE_ID,
  CONTROLLED_RESULT_FIXTURE_SOURCE_TREE_SHA256,
  CONTROLLED_RESULT_SENTINEL,
  CONTROLLED_TREATMENT_DOCUMENT,
  createControlledOutcomeFixtureInputs,
} from "../../src/audit/v2/controlled-fixture.js";
import {
  createControlledDockerInvocation,
  materializeControlledSyntheticResources,
  type MaterializedControlledResources,
} from "../../src/audit/v2/controlled-sandbox.js";
import {
  compareOutcome,
  compileAgentOutcomeHypothesis,
} from "../../src/audit/v2/outcome-comparison.js";
import { buildControlledOutcomeObservation } from "../../src/audit/v2/runtime-observation.js";
import type { PreparedTarget } from "../../src/target/prepare.js";
import {
  controlledExecutionAttemptV2Schema,
  controlledExecutionFailureV2Schema,
} from "../../src/contracts/v2/index.js";

const IMAGE_ID = `sha256:${"d".repeat(64)}`;

function fixture() {
  return createControlledOutcomeFixtureInputs({
    preparedTreeSha256: CONTROLLED_RESULT_FIXTURE_SOURCE_TREE_SHA256,
    preparedTreeFileCount: 3,
  });
}

function resultWith(content: string) {
  return {
    content: [{ type: "text", text: content }],
    structuredContent: { content },
  };
}

function caseFor(
  context: ReturnType<typeof fixture>,
  arm: "control" | "treatment",
) {
  const caseId =
    arm === "control"
      ? "controlled-control--default--r1"
      : "controlled-treatment--default--r1";
  const experimentCase = context.compiled.plan.cases.find(
    (candidate) => candidate.caseId === caseId,
  );
  const step = experimentCase?.steps[0];
  if (experimentCase === undefined || step === undefined) {
    throw new Error("controlled case missing");
  }
  return { experimentCase, step };
}

function authorizeArm(
  context: ReturnType<typeof fixture>,
  arm: "control" | "treatment",
  proposalReviewRequired = false,
  reviewOverrides: {
    readonly reviewerId?: string;
    readonly approvalClass?: "operator_review" | "security_review";
  } = {},
) {
  const { experimentCase, step } = caseFor(context, arm);
  const hypothesis = compileAgentOutcomeHypothesis({
    envelope: context.compiled,
    catalog: CONTROLLED_OUTCOME_CATALOG,
    caseId: experimentCase.caseId,
    stepId: step.stepId,
    draft: {
      format: "forge.agent-outcome-hypothesis-draft/v1alpha1",
      hypothesisId: `${arm}-runtime-hypothesis`,
      createdAt: "2026-08-30T00:05:00.000Z",
      source: {
        origin: "model_inference",
        component: { id: "deterministic-test-provider", version: "1" },
        confidence: "high",
        evidenceBasis: [
          { kind: "model_output", reference: "unit test prediction" },
        ],
      },
      expected: {
        protocolOutcomes: ["success"],
        shapes: ["json_object"],
        contentClasses: ["structured_data"],
        maxReasonableBytes: 8_192,
      },
      limitations: ["This prediction is not authorization."],
      authority: {
        authorizesExecution: false,
        grantsApproval: false,
        declaresSafety: false,
      },
    },
  });
  const targetIdentityDigest = digestCanonicalJson(
    "forge.target-identity",
    "v2",
    context.target,
  );
  const authority = createControlledFixtureExecutionAuthority({
    controllerId: "controlled-runtime-test",
    allowedFixtures: [
      {
        fixtureId: CONTROLLED_RESULT_FIXTURE_ID,
        targetIdentityDigest,
        preparedTargetTreeSha256: CONTROLLED_RESULT_FIXTURE_SOURCE_TREE_SHA256,
        sandboxImageId: IMAGE_ID,
        proposalReviewRequired,
      },
    ],
  });
  const issued = authority.issueSingleStepPermit({
    authorizationId: `${arm}-runtime-authorization`,
    issuedAt: "2026-08-30T00:06:00.000Z",
    expiresAt: "2026-08-30T00:11:00.000Z",
    reviewerId:
      reviewOverrides.reviewerId ??
      (proposalReviewRequired
        ? context.proposalReview.record.review.reviewerId
        : "controlled-runtime-reviewer"),
    approvalClass:
      reviewOverrides.approvalClass ??
      (proposalReviewRequired
        ? context.proposalReview.record.review.approvalClass
        : "operator_review"),
    compileInput: context.compileInput,
    envelope: context.compiled,
    hypothesis,
    caseId: experimentCase.caseId,
    stepId: step.stepId,
    fixtureId: CONTROLLED_RESULT_FIXTURE_ID,
    preparedTargetTreeSha256: CONTROLLED_RESULT_FIXTURE_SOURCE_TREE_SHA256,
    sandboxImageId: IMAGE_ID,
    ...(proposalReviewRequired
      ? {
          proposalReview: {
            capability: context.proposalReview.capability,
            record: context.proposalReview.record,
            recordDigest: context.proposalReview.recordDigest,
            experimentPlanDigest: context.proposalReview.experimentPlanDigest,
            finalPlan: context.proposalReview.finalPlan,
            finalCompileInput: context.proposalReview.finalCompileInput,
          },
        }
      : {}),
  });
  const consumed: ConsumedControlledExecution =
    authority.consumeSingleStepPermit({
      permit: issued.permit,
      authorization: issued.authorization,
      authorizationDigest: issued.authorizationDigest,
      now: "2026-08-30T00:07:00.000Z",
    });
  return { experimentCase, step, hypothesis, issued, consumed };
}

describe("controlled V2 fixture runtime", () => {
  it("binds a freshly consumed proposal-review capability into execution authority", () => {
    const context = fixture();
    const authorized = authorizeArm(context, "treatment", true);
    expect(
      authorized.issued.authorization.experiment.proposalReviewDigest,
    ).toBe(context.proposalReview.recordDigest);
    expect(context.proposalReview.record.authority).toMatchObject({
      recordAuthorizesExecution: false,
      recordGrantsApproval: false,
      serializedRecordIsBearerAuthority: false,
    });
  });

  it("rejects execution provenance that differs from the consumed proposal review", () => {
    const context = fixture();
    expect(() =>
      authorizeArm(context, "treatment", true, {
        reviewerId: "substituted-reviewer",
      }),
    ).toThrow("review provenance differs");
  });

  it("retains bounded zero-send failure evidence and rejects contradictory pre-send claims", () => {
    const digest = "a".repeat(64);
    const candidate = {
      format: "forge.controlled-execution-failure/v1alpha1",
      recordId: "controlled-failure-record",
      authorizationId: "controlled-authorization",
      authorizationDigest: digest,
      consumedAt: "2026-08-30T00:07:00.000Z",
      failedAt: "2026-08-30T00:07:01.000Z",
      experimentPlanDigest: digest,
      hypothesisDigest: digest,
      caseId: "controlled-case",
      stepId: "controlled-step",
      toolName: "read_document",
      argumentSha256: digest,
      stage: "pre_dispatch_monitor",
      dispatch: {
        requestedCalls: 1,
        sentCalls: 0,
        transcriptCallRecords: 0,
        retries: 0,
        followupCalls: 0,
      },
      transcript: {
        status: "unavailable",
        reason: "No complete transcript was available.",
      },
      cleanup: {
        status: "verified",
        evidenceReference: "cleanup-controlled",
        limitations: [],
      },
      rawResult: {
        exposure: "local_quarantine_only",
        exposedToPlanner: false,
        exposedToAuthority: false,
        usedForFollowup: false,
      },
      authority: {
        grantsApproval: false,
        authorizesRetry: false,
        authorizesFollowup: false,
        declaresSafety: false,
      },
      limitations: ["The failure record contains no raw target error text."],
    };
    expect(controlledExecutionFailureV2Schema.parse(candidate)).toMatchObject({
      stage: "pre_dispatch_monitor",
      dispatch: { sentCalls: 0 },
    });
    expect(() =>
      controlledExecutionFailureV2Schema.parse({
        ...candidate,
        dispatch: { ...candidate.dispatch, sentCalls: 1 },
      }),
    ).toThrow();
    expect(
      controlledExecutionFailureV2Schema.parse({
        ...candidate,
        stage: "post_return_verification",
        dispatch: {
          ...candidate.dispatch,
          sentCalls: 1,
          transcriptCallRecords: 1,
        },
      }),
    ).toMatchObject({
      stage: "post_return_verification",
      dispatch: { sentCalls: 1, transcriptCallRecords: 1 },
    });
  });

  it("rejects a completed attempt record that claims no call was sent", () => {
    const context = fixture();
    const authorized = authorizeArm(context, "control");
    const digest = "a".repeat(64);
    const candidate = {
      format: "forge.controlled-execution-attempt/v1alpha1",
      recordId: "controlled-attempt-record",
      authorizationId: authorized.issued.authorization.authorizationId,
      authorizationDigest: authorized.issued.authorizationDigest,
      startedAt: "2026-08-30T00:07:01.000Z",
      endedAt: "2026-08-30T00:07:02.000Z",
      experimentPlanDigest: context.compiled.experimentPlanDigest,
      hypothesisDigest: digest,
      caseId: authorized.experimentCase.caseId,
      stepId: authorized.step.stepId,
      toolName: authorized.step.toolName,
      argumentSha256: authorized.step.argumentSha256,
      targetTreeSha256: CONTROLLED_RESULT_FIXTURE_SOURCE_TREE_SHA256,
      liveCatalog: context.compiled.plan.catalog,
      permit: {
        consumed: true,
        consumedAt: authorized.consumed.consumedAt,
        persistedRecordIsBearerCredential: false,
      },
      dispatch: {
        sequence: 0,
        requestedCalls: 1,
        sentCalls: 1,
        retries: 0,
        followupCalls: 0,
      },
      protocolOutcome: "success",
      resultCapture: {
        status: "complete",
        projection: "canonical_mcp_call_tool_result",
        byteLength: 1,
        contentSha256: digest,
      },
      rawResult: {
        evidenceReference: "mcp-transcript-control",
        exposure: "local_quarantine_only",
        exposedToPlanner: false,
        exposedToAuthority: false,
        usedForFollowup: false,
      },
      observationDigest: digest,
      comparisonDigest: digest,
      cleanup: {
        status: "verified",
        evidenceReference: "cleanup-control",
        limitations: [],
      },
      authority: {
        grantsApproval: false,
        authorizesFollowup: false,
        declaresSafety: false,
      },
      limitations: ["This record is evidence, not authority."],
    };
    expect(controlledExecutionAttemptV2Schema.parse(candidate)).toMatchObject({
      dispatch: { sentCalls: 1 },
    });
    expect(() =>
      controlledExecutionAttemptV2Schema.parse({
        ...candidate,
        dispatch: { ...candidate.dispatch, sentCalls: 0 },
      }),
    ).toThrow();
  });

  it("compiles byte-matched one-step arms with only transcript and cleanup coverage", () => {
    const context = fixture();
    expect(Buffer.byteLength(CONTROLLED_CONTROL_DOCUMENT, "utf8")).toBe(
      Buffer.byteLength(CONTROLLED_TREATMENT_DOCUMENT, "utf8"),
    );
    expect(context.compiled.plan.requiredSensors).toEqual([
      "mcp_transcript",
      "cleanup",
    ]);
    expect(context.compiled.plan.cases).toHaveLength(2);
    expect(context.proposalComparison.summary).toMatchObject({
      submitted: 1,
      acceptedNovel: 1,
      rejected: 0,
    });
    expect(context.proposalReview.record).toMatchObject({
      proposalEvidence: {
        selectedProposalId: "controlled-treatment-proposal",
      },
      adoption: {
        adoptedCaseId: "controlled-treatment",
        adoptedPredictionOrigin: "operator",
        proposalPredictionsImported: false,
      },
      finalCompilation: {
        experimentPlanDigest: context.compiled.experimentPlanDigest,
      },
    });
    expect(
      context.compiled.plan.cases.every(
        (candidate) => candidate.steps.length === 1,
      ),
    ).toBe(true);
    expect(
      context.compiled.plan.syntheticResourceManifest.instances,
    ).toHaveLength(2);
  });

  it("re-reads every materialized resource and rejects byte mutation", async () => {
    const context = fixture();
    const resources = await materializeControlledSyntheticResources(
      context.compiled,
    );
    try {
      await expect(resources.verify()).resolves.toBe(
        context.compiled.plan.syntheticResourceManifestDigest,
      );
      const resourceId =
        context.compiled.plan.syntheticResourceManifest.instances[0]
          ?.resourceId;
      if (resourceId === undefined) throw new Error("resource missing");
      const path = join(resources.hostRoot, resourceId);
      await chmod(path, 0o644);
      await writeFile(path, "mutated controlled resource", "utf8");
      await expect(resources.verify()).rejects.toThrow();
    } finally {
      await resources.dispose();
    }
  });

  it("uses the immutable image and exposes no writable host bind or provider path", () => {
    const context = fixture();
    const preparedTarget = {
      hostRoot: "/private/tmp/controlled-target",
      packageRoot: "/private/tmp/controlled-target",
      containerRoot: "/opt/target",
      dispose: async () => undefined,
    } as PreparedTarget;
    const resources = {
      hostRoot: "/private/tmp/controlled-resources",
      manifestDigest: context.compiled.plan.syntheticResourceManifestDigest,
      verify: async () => context.compiled.plan.syntheticResourceManifestDigest,
      dispose: async () => undefined,
    } satisfies MaterializedControlledResources;
    const invocation = createControlledDockerInvocation({
      runId: "controlled-sandbox-test",
      experimentId: "controlled-arm",
      preparedTarget,
      resources,
      runtime: context.runtimeDescriptor,
      bounds: context.compiled.plan.bounds,
      imageId: IMAGE_ID,
    });
    const args = invocation.server.args ?? [];
    expect(args).toContain(IMAGE_ID);
    expect(args).toContain("/usr/bin/env");
    expect(args).toContain("-i");
    expect(args).toContain("none");
    expect(args).toContain("core=0:0");
    expect(args).toContain(
      "/dev/mqueue:ro,noexec,nosuid,nodev,size=4096,nr_inodes=1,mode=0555",
    );
    expect(args).toContain(
      `nofile=${context.compiled.plan.bounds.maxOpenFiles}:${context.compiled.plan.bounds.maxOpenFiles}`,
    );
    expect(
      args
        .filter((value) => value.startsWith("type=bind,"))
        .every((value) => value.endsWith(",readonly")),
    ).toBe(true);
    expect(invocation.backend).toMatchObject({
      network: "none",
      maxCalls: 1,
      maxRetries: 0,
      readonlyMessageQueueMount: true,
      writableRootFilesystem: false,
      writableHostBinds: false,
      providerAvailable: false,
    });

    const concurrent = createControlledDockerInvocation({
      runId: "controlled-sandbox-test",
      experimentId: "controlled-arm",
      preparedTarget,
      resources,
      runtime: context.runtimeDescriptor,
      bounds: context.compiled.plan.bounds,
      imageId: IMAGE_ID,
    });
    expect(concurrent.containerName).not.toBe(invocation.containerName);
  });

  it("derives a clean control and hash-only treatment hazard without exposing raw content", () => {
    const context = fixture();
    const observations: Record<
      "control" | "treatment",
      ReturnType<typeof buildControlledOutcomeObservation>
    > = {} as never;
    const comparisons: Record<
      "control" | "treatment",
      ReturnType<typeof compareOutcome>
    > = {} as never;

    for (const arm of ["control", "treatment"] as const) {
      const authorized = authorizeArm(context, arm);
      const content =
        arm === "control"
          ? CONTROLLED_CONTROL_DOCUMENT
          : CONTROLLED_TREATMENT_DOCUMENT;
      const observation = buildControlledOutcomeObservation({
        observationId: `${arm}-runtime-observation`,
        recordedAt: "2026-08-30T00:08:00.000Z",
        envelope: context.compiled,
        catalog: CONTROLLED_OUTCOME_CATALOG,
        policy: context.policy,
        hypothesis: authorized.hypothesis,
        consumed: authorized.consumed,
        result: resultWith(content),
        protocolOutcome: "success",
        runtimeMs: 5,
        transcriptEvidenceReference: `transcript-${arm}`,
        cleanup: {
          status: "verified",
          evidenceReference: `cleanup-${arm}`,
        },
      });
      const comparison = compareOutcome({
        comparisonId: `${arm}-runtime-comparison`,
        comparedAt: "2026-08-30T00:09:00.000Z",
        envelope: context.compiled,
        catalog: CONTROLLED_OUTCOME_CATALOG,
        policy: context.policy,
        hypothesis: authorized.hypothesis,
        observation,
      });
      observations[arm] = observation;
      comparisons[arm] = comparison;
    }

    expect(observations.control.capture).toMatchObject({ status: "complete" });
    expect(observations.treatment.capture).toMatchObject({
      status: "complete",
    });
    expect(
      observations.control.capture.status === "complete" &&
        observations.treatment.capture.status === "complete"
        ? observations.control.capture.byteLength
        : -1,
    ).toBe(
      observations.treatment.capture.status === "complete"
        ? observations.treatment.capture.byteLength
        : -2,
    );
    expect(comparisons.control.summary).toMatchObject({
      policy: "within_policy",
      intrinsicRisk: "no_signal_observed",
      outcome: "expected_within_policy",
    });
    expect(comparisons.treatment.summary).toMatchObject({
      policy: "within_policy",
      intrinsicRisk: "signals_observed",
      outcome: "intrinsic_hazard_evidence",
    });
    if (observations.treatment.contentAnalysis.status !== "assessed") {
      throw new Error("treatment was not analyzed");
    }
    expect(
      observations.treatment.contentAnalysis.signals.map(
        (signal) => signal.kind,
      ),
    ).toEqual(
      expect.arrayContaining([
        "instruction_override",
        "secret_request",
        "external_action_request",
      ]),
    );
    for (const artifact of [observations.treatment, comparisons.treatment]) {
      expect(JSON.stringify(artifact)).not.toContain(
        CONTROLLED_RESULT_SENTINEL,
      );
      expect(JSON.stringify(artifact)).not.toContain(
        "collector.example.invalid",
      );
    }
  });
});
