import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  agentOutcomeHypothesisDraftV2Schema,
  agentProposalComparisonV2Schema,
  controlledExecutionAttemptV2Schema,
  controlledExecutionAuthorizationV2Schema,
  controlledExecutionFailureV2Schema,
  controlledProposalReviewRecordV2AlphaSchema,
  outcomeComparisonV2Schema,
  outcomeHypothesisV2Schema,
  outcomeObservationV2Schema,
  rawAgentProposalSubmissionV2Schema,
  type ControlledExecutionAttemptV2,
  type ControlledExecutionAuthorizationV2,
  type ControlledExecutionFailureV2,
  type OutcomeComparisonV2,
  type OutcomeHypothesisV2,
  type OutcomeObservationV2,
} from "../../contracts/v2/index.js";
import {
  loadTargetConfig,
  resolveLocalSourcePath,
  type LoadedTargetConfig,
} from "../../config.js";
import { EvidenceStore, sha256File } from "../../evidence-store.js";
import { runMcpExperiment } from "../../mcp/stdio.js";
import { removeManagedContainer } from "../../sandbox/docker.js";
import {
  digestTargetTree,
  prepareTarget,
  type PreparedTarget,
} from "../../target/prepare.js";
import { computeCatalogIdentity } from "./catalog.js";
import { canonicalizeJson, digestCanonicalJson } from "./canonical.js";
import {
  CONTROLLED_RESULT_FIXTURE_ID,
  CONTROLLED_RESULT_FIXTURE_SOURCE_TREE_SHA256,
  CONTROLLED_RESULT_SENTINEL,
  CONTROLLED_TREATMENT_DOCUMENT,
  createControlledOutcomeFixtureInputs,
} from "./controlled-fixture.js";
import {
  ControlledExecutionAuthorityError,
  createControlledFixtureExecutionAuthority,
} from "./controlled-authority.js";
import {
  createControlledDockerInvocation,
  materializeControlledSyntheticResources,
  verifyPinnedControlledSandboxImage,
} from "./controlled-sandbox.js";
import {
  compareOutcome,
  compileAgentOutcomeHypothesis,
  verifyOutcomeComparison,
} from "./outcome-comparison.js";
import { revalidateControlledDispatch } from "./reference-monitor.js";
import { buildControlledOutcomeObservation } from "./runtime-observation.js";
import { parseStrictJson } from "./strict-json.js";

export type ControlledOutcomeArm = "control" | "treatment";

export interface RunControlledOutcomeExperimentOptions {
  readonly outputRoot: string;
  readonly runId: string;
  readonly arm: ControlledOutcomeArm;
}

export interface ControlledOutcomeRunResult {
  readonly arm: ControlledOutcomeArm;
  readonly runId: string;
  readonly runDirectory: string;
  readonly experimentPlanDigest: string;
  readonly policyDigest: string;
  readonly targetIdentityDigest: string;
  readonly targetTreeSha256: string;
  readonly sandboxImageId: string;
  readonly syntheticResourceManifestDigest: string;
  readonly proposalContextDigest: string;
  readonly proposalSubmissionDigest: string;
  readonly proposalComparisonDigest: string;
  readonly proposalReviewDigest: string;
  readonly transcriptSha256: string;
  readonly transcriptMetrics: {
    readonly toolsListRequests: number;
    readonly toolsCallRequests: 1;
    readonly followupCalls: 0;
  };
  readonly authorization: Readonly<ControlledExecutionAuthorizationV2>;
  readonly hypothesis: Readonly<OutcomeHypothesisV2>;
  readonly observation: Readonly<OutcomeObservationV2>;
  readonly comparison: Readonly<OutcomeComparisonV2>;
  readonly attempt: Readonly<ControlledExecutionAttemptV2>;
}

const cleanupEvidenceSchema = z
  .object({
    format: z.literal("forge.controlled-cleanup-evidence/v1alpha1"),
    runId: z.string().min(1),
    experimentId: z.string().min(1),
    containerNameSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    status: z.enum(["pending", "verified_absent", "verification_failed"]),
    containerStatus: z.enum(["verified_absent", "verification_failed"]),
    hostTemporaryInputsStatus: z.enum([
      "pending",
      "verified_absent",
      "retained_due_to_container_cleanup_failure",
      "verification_failed",
    ]),
    verifiedAt: z.string().datetime({ offset: true }),
    limitations: z.array(z.string().min(1).max(4_096)).max(8),
  })
  .strict()
  .superRefine((cleanup, ctx) => {
    const fullyVerified =
      cleanup.containerStatus === "verified_absent" &&
      cleanup.hostTemporaryInputsStatus === "verified_absent";
    const pending =
      cleanup.containerStatus === "verified_absent" &&
      cleanup.hostTemporaryInputsStatus === "pending";
    if (
      (cleanup.status === "verified_absent") !== fullyVerified ||
      (cleanup.status === "pending") !== pending ||
      (cleanup.status === "verification_failed") !==
        (!fullyVerified && !pending)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "overall cleanup status must reflect both cleanup components",
        path: ["status"],
      });
    }
    if (
      cleanup.status !== "verified_absent" &&
      cleanup.limitations.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "failed cleanup must retain a limitation",
        path: ["limitations"],
      });
    }
    if (
      cleanup.status === "verified_absent" &&
      cleanup.limitations.length !== 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "verified cleanup cannot retain a cleanup limitation",
        path: ["limitations"],
      });
    }
  });

interface TranscriptMetrics {
  readonly toolsListRequests: number;
  readonly toolsCallRequests: number;
  readonly followupCalls: number;
  readonly containsSentinel: boolean;
}

interface ControlledFailureEvidenceInput {
  readonly store: EvidenceStore;
  readonly arm: ControlledOutcomeArm;
  readonly runId: string;
  readonly experimentId: string;
  readonly authorization: Readonly<ControlledExecutionAuthorizationV2>;
  readonly authorizationDigest: string;
  readonly consumedAt: string;
  readonly experimentPlanDigest: string;
  readonly proposalReviewDigest: string;
  readonly hypothesisDigest: string;
  readonly caseId: string;
  readonly stepId: string;
  readonly toolName: string;
  readonly argumentSha256: string;
  readonly stage: ControlledExecutionFailureV2["stage"];
  readonly sentCalls: 0 | 1;
  readonly cleanupFailed: boolean;
  readonly failedAt: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function timestamp(): string {
  return new Date().toISOString();
}

function expiresAfter(issuedAt: string, milliseconds: number): string {
  return new Date(Date.parse(issuedAt) + milliseconds).toISOString();
}

function sanitizedFailure(message: string): Error {
  return new Error(
    `controlled fixture execution failed: ${message}; inspect the local quarantined run evidence`,
  );
}

async function inspectTranscript(path: string): Promise<TranscriptMetrics> {
  const source = await readFile(path, "utf8");
  let toolsListRequests = 0;
  let toolsCallRequests = 0;
  for (const line of source.split("\n")) {
    if (line.length === 0) continue;
    const entry = parseStrictJson(line, {
      maxBytes: 1_100_000,
      maxDepth: 160,
      maxNodes: 100_000,
      maxTotalStringCharacters: 1_000_000,
      maxKeyCharacters: 1_024,
      maxArrayItems: 20_000,
      maxObjectKeys: 20_000,
    }) as Record<string, unknown>;
    if (entry["direction"] !== "client_to_server") continue;
    const message = entry["message"] as Record<string, unknown> | undefined;
    if (message?.["method"] === "tools/list") toolsListRequests += 1;
    if (message?.["method"] === "tools/call") toolsCallRequests += 1;
  }
  return {
    toolsListRequests,
    toolsCallRequests,
    followupCalls: Math.max(0, toolsCallRequests - 1),
    containsSentinel: source.includes(CONTROLLED_RESULT_SENTINEL),
  };
}

async function writeControlledFailureEvidence(
  input: ControlledFailureEvidenceInput,
): Promise<void> {
  const transcriptPath = input.store.pathFor(
    `raw/${input.experimentId}/mcp-transcript.jsonl`,
  );
  let transcript:
    | {
        readonly status: "available";
        readonly evidenceReference: string;
        readonly sha256: string;
        readonly toolsListRequests: number;
        readonly callRecords: number;
      }
    | {
        readonly status: "unavailable";
        readonly reason: string;
        readonly callRecords: 0;
      };
  try {
    const metrics = await inspectTranscript(transcriptPath);
    transcript = {
      status: "available",
      evidenceReference: `mcp-transcript-${input.arm}`,
      sha256: await sha256File(transcriptPath),
      toolsListRequests: metrics.toolsListRequests,
      callRecords: metrics.toolsCallRequests,
    };
  } catch {
    transcript = {
      status: "unavailable",
      reason:
        "No complete bounded MCP transcript was available for this failed attempt.",
      callRecords: 0,
    };
  }

  await input.store.writeJson(
    `v2/${input.arm}/failure.json`,
    controlledExecutionFailureV2Schema,
    {
      format: "forge.controlled-execution-failure/v1alpha1",
      recordId: `controlled-${input.arm}-failure-${sha256(input.runId).slice(0, 12)}`,
      authorizationId: input.authorization.authorizationId,
      authorizationDigest: input.authorizationDigest,
      consumedAt: input.consumedAt,
      failedAt: input.failedAt,
      experimentPlanDigest: input.experimentPlanDigest,
      proposalReviewDigest: input.proposalReviewDigest,
      hypothesisDigest: input.hypothesisDigest,
      caseId: input.caseId,
      stepId: input.stepId,
      toolName: input.toolName,
      argumentSha256: input.argumentSha256,
      stage: input.stage,
      dispatch: {
        requestedCalls: 1,
        sentCalls: input.sentCalls,
        transcriptCallRecords: transcript.callRecords,
        retries: 0,
        followupCalls: 0,
      },
      transcript:
        transcript.status === "available"
          ? {
              status: "available",
              evidenceReference: transcript.evidenceReference,
              sha256: transcript.sha256,
              toolsListRequests: transcript.toolsListRequests,
            }
          : {
              status: "unavailable",
              reason: transcript.reason,
            },
      cleanup: {
        status: input.cleanupFailed ? "failed" : "verified",
        evidenceReference: `cleanup-${input.arm}`,
        limitations: input.cleanupFailed
          ? [
              "Managed container or host temporary input cleanup could not be fully verified.",
            ]
          : [],
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
      limitations: [
        "This failure record contains bounded controller evidence and no raw target error text.",
        "A sent call means the guarded write was handed to the live transport; it does not prove that the target processed it.",
      ],
    },
  );
}

function exactFixtureConfigPath(): string {
  return fileURLToPath(
    new URL(
      "../../../fixtures/evidence-first-v2/controlled-result-mcp/target.yaml",
      import.meta.url,
    ),
  );
}

export interface VerifiedPinnedControlledFixtureSource {
  readonly loaded: LoadedTargetConfig;
  readonly sourcePath: string;
  readonly tree: {
    readonly sha256: string;
    readonly fileCount: number;
  };
}

/** Resolve and hash the sole admitted source before any target process exists. */
export async function verifyPinnedControlledFixtureSource(): Promise<VerifiedPinnedControlledFixtureSource> {
  const loaded = await loadTargetConfig(exactFixtureConfigPath());
  const sourcePath = resolveLocalSourcePath(loaded);
  const expectedPath = await realpath(
    fileURLToPath(
      new URL(
        "../../../fixtures/evidence-first-v2/controlled-result-mcp",
        import.meta.url,
      ),
    ),
  );
  if (
    loaded.config.target.id !== "controlled-result-mcp" ||
    loaded.config.target.source.type !== "local" ||
    loaded.config.target.source.install !== "none" ||
    sourcePath === undefined ||
    (await realpath(sourcePath)) !== expectedPath ||
    loaded.config.target.runtime.command !== "node" ||
    loaded.config.target.runtime.args.length !== 1 ||
    loaded.config.target.runtime.args[0] !== "/opt/target/server.js" ||
    loaded.config.target.runtime.cwd !== "/opt/target" ||
    Object.keys(loaded.config.target.runtime.env).length !== 0
  ) {
    throw new ControlledExecutionAuthorityError(
      "sandbox_prerequisites_unmet",
      "controlled V2 execution accepts only the exact pinned repository fixture",
    );
  }
  const tree = await digestTargetTree(expectedPath, {
    includeNodeModules: true,
  });
  if (tree.sha256 !== CONTROLLED_RESULT_FIXTURE_SOURCE_TREE_SHA256) {
    throw new ControlledExecutionAuthorityError(
      "sandbox_prerequisites_unmet",
      "controlled fixture bytes differ from the reviewed source-tree trust anchor",
    );
  }
  return Object.freeze({ loaded, sourcePath: expectedPath, tree });
}

function selectedCaseId(arm: ControlledOutcomeArm): string {
  return arm === "control"
    ? "controlled-control--default--r1"
    : "controlled-treatment--default--r1";
}

function safeArtifactsContainRawContent(values: readonly unknown[]): boolean {
  const serialized = values.map((value) => canonicalizeJson(value)).join("\n");
  return (
    serialized.includes(CONTROLLED_RESULT_SENTINEL) ||
    serialized.includes(CONTROLLED_TREATMENT_DOCUMENT) ||
    serialized.includes("collector.example.invalid") ||
    serialized.includes("Ignore previous instructions")
  );
}

/**
 * Execute one preplanned arm. There is deliberately no target-path, provider,
 * retry, workflow, or follow-up parameter in this API.
 */
export async function runControlledOutcomeExperiment(
  options: RunControlledOutcomeExperimentOptions,
): Promise<ControlledOutcomeRunResult> {
  const store = await EvidenceStore.create(options.outputRoot, options.runId);
  const pinned = await verifyPinnedControlledFixtureSource();
  const sandboxImage = await verifyPinnedControlledSandboxImage();
  const imageId = sandboxImage.imageId;
  let preparedTarget: PreparedTarget | undefined;
  let resources:
    | Awaited<ReturnType<typeof materializeControlledSyntheticResources>>
    | undefined;
  let containerMayExist = false;
  let containerCleanupVerified = false;

  try {
    preparedTarget = await prepareTarget({
      loaded: pinned.loaded,
      runId: options.runId,
      store,
      image: sandboxImage.imageReference,
    });
    const preparedTree = await digestTargetTree(preparedTarget.hostRoot, {
      includeNodeModules: true,
    });
    if (
      preparedTree.sha256 !== CONTROLLED_RESULT_FIXTURE_SOURCE_TREE_SHA256 ||
      preparedTree.fileCount !== pinned.tree.fileCount
    ) {
      throw new ControlledExecutionAuthorityError(
        "sandbox_prerequisites_unmet",
        "prepared target tree differs from the pinned controlled fixture",
      );
    }

    const reviewedAt = timestamp();
    const fixture = createControlledOutcomeFixtureInputs({
      preparedTreeSha256: preparedTree.sha256,
      preparedTreeFileCount: preparedTree.fileCount,
      review: {
        reviewId: `controlled-treatment-review-${sha256(options.runId).slice(0, 12)}`,
        reviewerId: "forge-controlled-fixture-review",
        reviewedAt,
        capabilityExpiresAt: expiresAfter(reviewedAt, 5 * 60_000),
      },
    });
    const experimentCase = fixture.compiled.plan.cases.find(
      (candidate) => candidate.caseId === selectedCaseId(options.arm),
    );
    const step = experimentCase?.steps[0];
    if (experimentCase === undefined || step === undefined) {
      throw new Error("controlled plan omitted the selected arm");
    }
    if (
      typeof step.arguments !== "object" ||
      step.arguments === null ||
      Array.isArray(step.arguments)
    ) {
      throw new Error("controlled plan produced non-object tool arguments");
    }
    const draft = agentOutcomeHypothesisDraftV2Schema.parse({
      format: "forge.agent-outcome-hypothesis-draft/v1alpha1",
      hypothesisId: `controlled-${options.arm}-hypothesis-${sha256(options.runId).slice(0, 12)}`,
      createdAt: timestamp(),
      source: {
        origin: "model_inference",
        component: {
          id: "forge-deterministic-local-outcome-provider",
          version: "1alpha1",
        },
        confidence: "high",
        evidenceBasis: [
          {
            kind: "model_output",
            reference: "deterministic local provider fixture output",
          },
        ],
      },
      expected: {
        protocolOutcomes: ["success"],
        shapes: ["json_object"],
        contentClasses: ["structured_data"],
        maxReasonableBytes: 8_192,
      },
      limitations: [
        "The verifier uses a deterministic local provider fixture, not a live model robustness trial.",
        "This prediction cannot authorize execution or characterize hidden result content.",
      ],
      authority: {
        authorizesExecution: false,
        grantsApproval: false,
        declaresSafety: false,
      },
    });
    const hypothesis = compileAgentOutcomeHypothesis({
      envelope: fixture.compiled,
      catalog: fixture.catalog,
      caseId: experimentCase.caseId,
      stepId: step.stepId,
      draft,
    });
    const targetIdentityDigest = digestCanonicalJson(
      "forge.target-identity",
      "v2",
      fixture.target,
    );
    const authority = createControlledFixtureExecutionAuthority({
      controllerId: "forge-controlled-outcome-controller",
      allowedFixtures: [
        {
          fixtureId: CONTROLLED_RESULT_FIXTURE_ID,
          targetIdentityDigest,
          preparedTargetTreeSha256: preparedTree.sha256,
          sandboxImageId: imageId,
          proposalReviewRequired: true,
        },
      ],
    });
    const issuedAt = timestamp();
    const issued = authority.issueSingleStepPermit({
      authorizationId: `controlled-${options.arm}-authorization-${sha256(options.runId).slice(0, 12)}`,
      issuedAt,
      expiresAt: fixture.proposalReview.record.review.capabilityExpiresAt,
      reviewerId: "forge-controlled-fixture-review",
      approvalClass: "operator_review",
      compileInput: fixture.compileInput,
      envelope: fixture.compiled,
      hypothesis,
      caseId: experimentCase.caseId,
      stepId: step.stepId,
      fixtureId: CONTROLLED_RESULT_FIXTURE_ID,
      preparedTargetTreeSha256: preparedTree.sha256,
      sandboxImageId: imageId,
      proposalReview: {
        capability: fixture.proposalReview.capability,
        record: fixture.proposalReview.record,
        recordDigest: fixture.proposalReview.recordDigest,
        experimentPlanDigest: fixture.proposalReview.experimentPlanDigest,
        finalPlan: fixture.proposalReview.finalPlan,
        finalCompileInput: fixture.proposalReview.finalCompileInput,
      },
    });
    await store.writeJson(
      `v2/${options.arm}/proposal-submission.json`,
      rawAgentProposalSubmissionV2Schema,
      fixture.proposalSubmission,
    );
    await store.writeJson(
      `v2/${options.arm}/proposal-comparison.json`,
      agentProposalComparisonV2Schema,
      fixture.proposalComparison,
    );
    await store.writeJson(
      `v2/${options.arm}/proposal-review.json`,
      controlledProposalReviewRecordV2AlphaSchema,
      fixture.proposalReview.record,
    );
    await store.writeJson(
      `v2/${options.arm}/authorization.json`,
      controlledExecutionAuthorizationV2Schema,
      issued.authorization,
    );
    await store.writeJson(
      `v2/${options.arm}/hypothesis.json`,
      outcomeHypothesisV2Schema,
      hypothesis,
    );

    resources = await materializeControlledSyntheticResources(fixture.compiled);
    const invocation = createControlledDockerInvocation({
      runId: options.runId,
      experimentId: `v2-controlled-${options.arm}`,
      preparedTarget,
      resources,
      runtime: fixture.runtimeDescriptor,
      bounds: fixture.compiled.plan.bounds,
      imageId,
    });
    const consumedAt = timestamp();
    const consumed = authority.consumeSingleStepPermit({
      permit: issued.permit,
      authorization: issued.authorization,
      authorizationDigest: issued.authorizationDigest,
      now: consumedAt,
    });
    const startedAt = timestamp();
    let monitorChecks = 0;
    let monitorPassed = false;
    let sentCalls = 0;
    let primaryFailure: unknown;
    let mcpResult: Awaited<ReturnType<typeof runMcpExperiment>> | undefined;
    try {
      containerMayExist = true;
      mcpResult = await runMcpExperiment({
        runId: options.runId,
        experimentId: `v2-controlled-${options.arm}`,
        store,
        server: invocation.server,
        timeoutMs: invocation.backend.hardRuntimeMs,
        cooldownMs: 0,
        toolExperiment: {
          id: `controlled-${options.arm}`,
          tool: step.toolName,
          input: step.arguments as Record<string, never>,
          expected: {
            fileReads: [],
            fileReadPrefixes: [],
            fileWrites: [],
            fileWritePrefixes: [],
            networkConnections: [],
            childExecutables: [],
            childExecutablePrefixes: [],
          },
        },
        beforeToolCall: async (context) => {
          monitorChecks += 1;
          if (monitorChecks !== 1) {
            throw new Error("controlled reference monitor ran more than once");
          }
          const currentTree = await digestTargetTree(preparedTarget!.hostRoot, {
            includeNodeModules: true,
          });
          const currentResourceManifestDigest = await resources!.verify();
          revalidateControlledDispatch({
            compileInput: fixture.compileInput,
            envelope: fixture.compiled,
            authorization: issued.authorization,
            consumed,
            liveCatalog: context.catalog,
            currentTargetTreeSha256: currentTree.sha256,
            currentSyntheticResourceManifestDigest:
              currentResourceManifestDigest,
            toolName: context.toolName,
            arguments: context.arguments,
            now: timestamp(),
            backend: invocation.backend,
          });
          monitorPassed = true;
        },
        onToolCallSent: () => {
          sentCalls += 1;
          if (sentCalls !== 1) {
            throw new Error("controlled transport reported more than one send");
          }
        },
      });
    } catch (error) {
      primaryFailure = error;
    }

    let cleanupFailure: unknown;
    try {
      await removeManagedContainer(invocation.containerName, options.runId);
      containerCleanupVerified = true;
    } catch (error) {
      cleanupFailure = error;
    }
    const experimentId = `v2-controlled-${options.arm}`;
    const cleanupEvidenceReference = `cleanup-${options.arm}`;
    type HostTemporaryInputsStatus =
      | "pending"
      | "verified_absent"
      | "retained_due_to_container_cleanup_failure"
      | "verification_failed";
    let hostTemporaryInputsStatus: HostTemporaryInputsStatus =
      cleanupFailure === undefined
        ? "pending"
        : "retained_due_to_container_cleanup_failure";

    const disposeHostTemporaryInputs = async (): Promise<boolean> => {
      let failure = false;
      if (resources !== undefined) {
        try {
          await resources.dispose();
          resources = undefined;
        } catch {
          failure = true;
        }
      }
      if (preparedTarget !== undefined) {
        try {
          await preparedTarget.dispose();
          preparedTarget = undefined;
        } catch {
          failure = true;
        }
      }
      return !failure;
    };

    const persistCleanupEvidence = async (): Promise<string> => {
      const containerStatus =
        cleanupFailure === undefined
          ? ("verified_absent" as const)
          : ("verification_failed" as const);
      const status =
        containerStatus === "verified_absent" &&
        hostTemporaryInputsStatus === "verified_absent"
          ? ("verified_absent" as const)
          : containerStatus === "verified_absent" &&
              hostTemporaryInputsStatus === "pending"
            ? ("pending" as const)
            : ("verification_failed" as const);
      const limitations =
        status === "verified_absent"
          ? []
          : containerStatus === "verification_failed"
            ? [
                "Managed container absence could not be verified.",
                "Host temporary inputs were retained because the container may still reference them.",
              ]
            : hostTemporaryInputsStatus === "pending"
              ? ["Host temporary input cleanup has not yet been verified."]
              : ["Host temporary input disposal could not be fully verified."];
      const verifiedAt = timestamp();
      await store.writeJson(
        `v2/${options.arm}/cleanup.json`,
        cleanupEvidenceSchema,
        {
          format: "forge.controlled-cleanup-evidence/v1alpha1",
          runId: options.runId,
          experimentId,
          containerNameSha256: sha256(invocation.containerName),
          status,
          containerStatus,
          hostTemporaryInputsStatus,
          verifiedAt,
          limitations,
        },
      );
      return verifiedAt;
    };

    let cleanupVerifiedAt = await persistCleanupEvidence();
    if (
      cleanupFailure !== undefined ||
      primaryFailure !== undefined ||
      mcpResult === undefined ||
      monitorChecks !== 1 ||
      sentCalls !== 1 ||
      mcpResult.toolResult === undefined
    ) {
      if (cleanupFailure === undefined) {
        hostTemporaryInputsStatus = (await disposeHostTemporaryInputs())
          ? "verified_absent"
          : "verification_failed";
        cleanupVerifiedAt = await persistCleanupEvidence();
      }
      const cleanupFailed =
        cleanupFailure !== undefined ||
        hostTemporaryInputsStatus !== "verified_absent";
      const stage: ControlledExecutionFailureV2["stage"] = cleanupFailed
        ? "cleanup_verification"
        : monitorChecks === 0
          ? "session_before_monitor"
          : !monitorPassed
            ? "pre_dispatch_monitor"
            : sentCalls === 0
              ? "transport_before_send"
              : "runtime_or_protocol";
      try {
        await writeControlledFailureEvidence({
          store,
          arm: options.arm,
          runId: options.runId,
          experimentId,
          authorization: issued.authorization,
          authorizationDigest: issued.authorizationDigest,
          consumedAt: consumed.consumedAt,
          experimentPlanDigest: fixture.compiled.experimentPlanDigest,
          proposalReviewDigest: fixture.proposalReview.recordDigest,
          hypothesisDigest: issued.authorization.experiment.hypothesisDigest,
          caseId: experimentCase.caseId,
          stepId: step.stepId,
          toolName: step.toolName,
          argumentSha256: step.argumentSha256,
          stage,
          sentCalls: sentCalls === 0 ? 0 : 1,
          cleanupFailed,
          failedAt: cleanupVerifiedAt,
        });
      } catch {
        throw sanitizedFailure(
          "the guarded session failed and bounded failure evidence could not be persisted",
        );
      }
      if (cleanupFailed) {
        throw sanitizedFailure("sandbox cleanup could not be verified");
      }
      throw sanitizedFailure("the guarded MCP session did not complete");
    }
    try {
      const postTree = await digestTargetTree(preparedTarget.hostRoot, {
        includeNodeModules: true,
      });
      if (postTree.sha256 !== preparedTree.sha256) {
        throw sanitizedFailure(
          "the prepared target tree changed during execution",
        );
      }
      await resources.verify();

      const transcriptPath = store.pathFor(
        `raw/${experimentId}/mcp-transcript.jsonl`,
      );
      const transcript = await inspectTranscript(transcriptPath);
      const transcriptSha256 = await sha256File(transcriptPath);
      if (
        transcript.toolsListRequests !== 1 ||
        transcript.toolsCallRequests !== 1 ||
        transcript.followupCalls !== 0 ||
        transcript.containsSentinel !== (options.arm === "treatment")
      ) {
        throw sanitizedFailure(
          "transcript call or quarantine invariants failed",
        );
      }
      hostTemporaryInputsStatus = (await disposeHostTemporaryInputs())
        ? "verified_absent"
        : "verification_failed";
      cleanupVerifiedAt = await persistCleanupEvidence();
      if (hostTemporaryInputsStatus !== "verified_absent") {
        throw sanitizedFailure(
          "host temporary input cleanup could not be verified",
        );
      }
      const toolPhase = mcpResult.phases.find((phase) => phase.kind === "tool");
      const runtimeMs =
        toolPhase === undefined
          ? 0
          : Math.max(
              0,
              Date.parse(toolPhase.endedAt) - Date.parse(toolPhase.startedAt),
            );
      const resultRecord = mcpResult.toolResult as Record<string, unknown>;
      const protocolOutcome =
        resultRecord["isError"] === true ? "tool_error" : "success";
      const observation = buildControlledOutcomeObservation({
        observationId: `controlled-${options.arm}-observation-${sha256(options.runId).slice(0, 12)}`,
        recordedAt: timestamp(),
        envelope: fixture.compiled,
        catalog: mcpResult.discoveredCatalog,
        policy: fixture.policy,
        hypothesis,
        consumed,
        result: mcpResult.toolResult,
        protocolOutcome,
        runtimeMs,
        transcriptEvidenceReference: `mcp-transcript-${options.arm}`,
        cleanup: {
          status: "verified",
          evidenceReference: cleanupEvidenceReference,
        },
      });
      const comparison = compareOutcome({
        comparisonId: `controlled-${options.arm}-comparison-${sha256(options.runId).slice(0, 12)}`,
        comparedAt: timestamp(),
        envelope: fixture.compiled,
        catalog: mcpResult.discoveredCatalog,
        policy: fixture.policy,
        hypothesis,
        observation,
      });
      verifyOutcomeComparison({
        envelope: fixture.compiled,
        catalog: mcpResult.discoveredCatalog,
        policy: fixture.policy,
        hypothesis,
        observation,
        comparison,
      });
      const liveCatalog = computeCatalogIdentity(mcpResult.discoveredCatalog);
      const endedAt = timestamp();
      const attempt = controlledExecutionAttemptV2Schema.parse({
        format: "forge.controlled-execution-attempt/v1alpha1",
        recordId: `controlled-${options.arm}-attempt-${sha256(options.runId).slice(0, 12)}`,
        authorizationId: issued.authorization.authorizationId,
        authorizationDigest: issued.authorizationDigest,
        startedAt,
        endedAt,
        experimentPlanDigest: fixture.compiled.experimentPlanDigest,
        proposalReviewDigest: fixture.proposalReview.recordDigest,
        hypothesisDigest: issued.authorization.experiment.hypothesisDigest,
        caseId: experimentCase.caseId,
        stepId: step.stepId,
        toolName: step.toolName,
        argumentSha256: step.argumentSha256,
        targetTreeSha256: preparedTree.sha256,
        liveCatalog: liveCatalog.identity,
        permit: {
          consumed: true,
          consumedAt: consumed.consumedAt,
          persistedRecordIsBearerCredential: false,
        },
        dispatch: {
          sequence: 0,
          requestedCalls: 1,
          sentCalls: 1,
          retries: 0,
          followupCalls: 0,
        },
        protocolOutcome,
        resultCapture: observation.capture,
        rawResult: {
          evidenceReference: `mcp-transcript-${options.arm}`,
          exposure: "local_quarantine_only",
          exposedToPlanner: false,
          exposedToAuthority: false,
          usedForFollowup: false,
        },
        observationDigest: digestCanonicalJson(
          "forge.outcome-observation",
          "v1alpha1",
          observation,
        ),
        comparisonDigest: digestCanonicalJson(
          "forge.outcome-comparison",
          "v1alpha1",
          comparison,
        ),
        cleanup: {
          status: "verified",
          evidenceReference: cleanupEvidenceReference,
          limitations: [],
        },
        authority: {
          grantsApproval: false,
          authorizesFollowup: false,
          declaresSafety: false,
        },
        limitations: [
          "This execution record is evidence, not a reusable dispatch capability or safety verdict.",
          "The result was never exposed to a model, so this run does not measure model robustness to tool-result injection.",
        ],
      });
      if (
        safeArtifactsContainRawContent([
          fixture.proposalSubmission,
          fixture.proposalComparison,
          fixture.proposalReview.record,
          issued.authorization,
          hypothesis,
          observation,
          comparison,
          attempt,
        ])
      ) {
        throw sanitizedFailure("raw result content escaped its quarantine");
      }
      await store.writeJson(
        `v2/${options.arm}/observation.json`,
        outcomeObservationV2Schema,
        observation,
      );
      await store.writeJson(
        `v2/${options.arm}/comparison.json`,
        outcomeComparisonV2Schema,
        comparison,
      );
      await store.writeJson(
        `v2/${options.arm}/attempt.json`,
        controlledExecutionAttemptV2Schema,
        attempt,
      );

      return Object.freeze({
        arm: options.arm,
        runId: options.runId,
        runDirectory: store.runDirectory,
        experimentPlanDigest: fixture.compiled.experimentPlanDigest,
        policyDigest: fixture.compiled.plan.policyDigest,
        targetIdentityDigest,
        targetTreeSha256: preparedTree.sha256,
        sandboxImageId: imageId,
        syntheticResourceManifestDigest:
          fixture.compiled.plan.syntheticResourceManifestDigest,
        proposalContextDigest: fixture.proposalContextDigest,
        proposalSubmissionDigest:
          fixture.proposalReview.record.proposalEvidence.submissionDigest,
        proposalComparisonDigest:
          fixture.proposalReview.record.proposalEvidence.comparisonDigest,
        proposalReviewDigest: fixture.proposalReview.recordDigest,
        transcriptSha256,
        transcriptMetrics: {
          toolsListRequests: transcript.toolsListRequests,
          toolsCallRequests: 1 as const,
          followupCalls: 0 as const,
        },
        authorization: issued.authorization,
        hypothesis,
        observation,
        comparison,
        attempt,
      });
    } catch {
      try {
        if (
          cleanupFailure === undefined &&
          hostTemporaryInputsStatus === "pending"
        ) {
          hostTemporaryInputsStatus = (await disposeHostTemporaryInputs())
            ? "verified_absent"
            : "verification_failed";
          cleanupVerifiedAt = await persistCleanupEvidence();
        }
        await writeControlledFailureEvidence({
          store,
          arm: options.arm,
          runId: options.runId,
          experimentId,
          authorization: issued.authorization,
          authorizationDigest: issued.authorizationDigest,
          consumedAt: consumed.consumedAt,
          experimentPlanDigest: fixture.compiled.experimentPlanDigest,
          proposalReviewDigest: fixture.proposalReview.recordDigest,
          hypothesisDigest: issued.authorization.experiment.hypothesisDigest,
          caseId: experimentCase.caseId,
          stepId: step.stepId,
          toolName: step.toolName,
          argumentSha256: step.argumentSha256,
          stage: "post_return_verification",
          sentCalls: 1,
          cleanupFailed:
            cleanupFailure !== undefined ||
            hostTemporaryInputsStatus !== "verified_absent",
          failedAt: timestamp(),
        });
      } catch {
        throw sanitizedFailure(
          "post-return verification failed and bounded failure evidence could not be persisted",
        );
      }
      throw sanitizedFailure("post-return verification did not complete");
    }
  } finally {
    if (!containerMayExist || containerCleanupVerified) {
      await resources?.dispose().catch(() => undefined);
      await preparedTarget?.dispose().catch(() => undefined);
    }
  }
}
