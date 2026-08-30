import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EnrolledAuthorityError,
  createEnrolledTargetAuthority,
  type EnrollmentCandidateCapability,
  type EnrolledCallReviewCapability,
} from "../../src/audit/v2/enrolled-authority.js";
import { materializeEmptyEnrolledResources } from "../../src/audit/v2/enrolled-evidence.js";
import { createEnrolledSingleCallExperiment } from "../../src/audit/v2/enrolled-experiment.js";
import {
  ENROLLED_NODE_STDIO_SANDBOX_IDENTITY,
  createEnrolledNodeStdioDockerInvocation,
} from "../../src/audit/v2/enrolled-sandbox.js";
import {
  DEFAULT_ENROLLED_APPLICATION_ARGUMENT_LIMITS,
  snapshotPreparedRuntimeTree,
  validateEnrolledNodeRuntime,
} from "../../src/audit/v2/enrolled-runtime.js";
import { computeCatalogIdentity } from "../../src/audit/v2/catalog.js";
import { digestCanonicalJson } from "../../src/audit/v2/canonical.js";
import {
  CONTROLLED_SANDBOX_IMAGE_ID,
  CONTROLLED_SANDBOX_IMAGE_REFERENCE,
} from "../../src/audit/v2/controlled-fixture.js";
import { compileAgentOutcomeHypothesis } from "../../src/audit/v2/outcome-comparison.js";
import type { PreparedTarget } from "../../src/target/prepare.js";

const catalog = {
  protocolVersion: "2025-06-18",
  server: { name: "authority-test", version: "1.0.0" },
  acquisition: {
    complete: true,
    pageCount: 1 as const,
    listChangedDuringDiscovery: false,
  },
  tools: [
    {
      name: "echo_value",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
  ],
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-enrolled-authority-test-"));
  roots.push(root);
  await writeFile(join(root, "server.js"), "process.stdin.resume();\n", "utf8");
  const preparedTarget = {
    hostRoot: root,
    packageRoot: root,
    containerRoot: "/opt/target",
    provenance: {},
    dispose: async () => undefined,
  } as unknown as PreparedTarget;
  const snapshot = await snapshotPreparedRuntimeTree(root);
  const descriptor = {
    transport: "stdio" as const,
    protocol: "mcp" as const,
    command: "node",
    args: ["/opt/target/server.js"],
    cwd: "/opt/target" as const,
    environment: {},
  };
  const runtime = await validateEnrolledNodeRuntime({
    preparedTarget,
    descriptor,
  });
  const resources = await materializeEmptyEnrolledResources(
    "authority-test-resources",
  );
  roots.push(join(resources.hostRoot, ".."));
  const experiment = createEnrolledSingleCallExperiment({
    identityPrefix: "authority-test",
    targetId: "authority-target",
    sourceEvidence: { format: "authority-test-source/v1", tree: snapshot.treeSha256 },
    runtimeSnapshotEvidence: snapshot,
    runtimeDescriptor: descriptor,
    catalog,
    toolName: "echo_value",
    arguments: { value: "synthetic" },
    createdAt: "2026-08-30T20:00:00.000Z",
    reviewedAt: "2026-08-30T20:07:00.000Z",
    expiresAt: "2026-08-30T20:20:00.000Z",
  });
  expect(resources.manifestDigest).toBe(
    experiment.compiled.plan.syntheticResourceManifestDigest,
  );
  const image = {
    imageReference: CONTROLLED_SANDBOX_IMAGE_REFERENCE,
    imageId: CONTROLLED_SANDBOX_IMAGE_ID,
    declaredVolumes: false as const,
  };
  const invocation = createEnrolledNodeStdioDockerInvocation({
    runId: "authority-run",
    experimentId: "authority-discovery",
    preparedTarget,
    resources,
    runtime,
    bounds: experiment.compiled.plan.bounds,
    image,
  });
  const catalogIdentity = computeCatalogIdentity(catalog).identity;
  const record = {
    format: "forge.mcp-enrollment/v1alpha1",
    enrollmentId: "authority-enrollment",
    recordedAt: "2026-08-30T20:06:00.000Z",
    enroller: { id: "authority-test-enroller", version: "1alpha1" },
    target: {
      identity: experiment.target,
      identityDigest: experiment.targetIdentityDigest,
    },
    source: {
      acquiredAt: "2026-08-30T20:00:00.000Z",
      evidenceReference: "authority-source-evidence",
      provenance: {
        kind: "local_snapshot",
        sourceTreeSha256: snapshot.treeSha256,
        sourceEntryCount: snapshot.summary.entryCount,
        sourceRegularFileBytes: snapshot.summary.fileBytesHashed,
        sourceArtifactSha256: experiment.target.sourceArtifact.sha256,
        lifecycleScripts: "disabled",
        configuredPathSha256: "a".repeat(64),
        installMode: "none",
        acquisitionNetwork: "none",
      },
    },
    preparedTree: {
      format: snapshot.format,
      complete: true,
      scope: snapshot.scope,
      specialEntriesRejected: true,
      treeSha256: snapshot.treeSha256,
      evidenceReference: "authority-tree-evidence",
      runtimeSnapshotArtifactSha256: experiment.target.runtimeSnapshot.sha256,
      counters: snapshot.summary,
      limits: snapshot.limits,
      capturedAt: "2026-08-30T20:01:00.000Z",
    },
    runtime: {
      runtimeDescriptorDigest: experiment.target.runtimeDescriptorDigest,
      invocation: runtime,
      argumentLimits: DEFAULT_ENROLLED_APPLICATION_ARGUMENT_LIMITS,
      validatedAt: "2026-08-30T20:02:00.000Z",
    },
    sandbox: {
      profile: ENROLLED_NODE_STDIO_SANDBOX_IDENTITY,
      profileDigest: invocation.backendProfileDigest,
      imageReference: image.imageReference,
      imageId: image.imageId,
      platform: "linux",
      imageDeclaredVolumes: false,
      network: "none",
      ipc: "none",
      readOnlyRootFilesystem: true,
      readOnlyTargetMount: true,
      readOnlySyntheticResourceMount: true,
      writableHostBinds: false,
      providerAvailable: false,
      maxCalls: 1,
      maxRetries: 0,
      authorizesFollowup: false,
      resultExposure: "local_quarantine_only",
      cleanupVerificationRequired: true,
      executionBounds: experiment.compiled.plan.bounds,
      verifiedAt: "2026-08-30T20:02:00.000Z",
    },
    discovery: {
      startedAt: "2026-08-30T20:03:00.000Z",
      completedAt: "2026-08-30T20:04:00.000Z",
      catalog: catalogIdentity,
      completeness: catalog.acquisition,
      transcript: {
        evidenceReference: "authority-discovery-transcript",
        sha256: "b".repeat(64),
        byteLength: 512,
        toolsListRequests: 1,
        toolsCallRequests: 0,
      },
      limits: { maxPages: 1, maxTools: 1_000, maxTranscriptBytes: 2_000_000 },
      cleanup: {
        status: "verified_absent",
        containerAbsent: true,
        ephemeralDiscoveryInputsAbsent: true,
        preparedTargetDisposition: "retained_for_review",
        evidenceReference: "authority-discovery-cleanup",
        verifiedAt: "2026-08-30T20:05:00.000Z",
      },
    },
    eligibility: {
      status: "eligible_for_manual_review",
      executionClass: "enrolled_node_stdio_single_call",
      assessedAt: "2026-08-30T20:06:00.000Z",
      requiredApprovalClass: "operator_review",
      rejectionReasonCodes: [],
    },
    authority: {
      recordAuthorizesEnrollment: false,
      recordAuthorizesExecution: false,
      recordGrantsApproval: false,
      serializedRecordIsBearerAuthority: false,
      serializedCapabilityExists: false,
      requiresManualExactCallReview: true,
    },
    limitations: ["Authority fixture enrollment is not a safety verdict."],
  };
  const experimentCase = experiment.compiled.plan.cases[0]!;
  const step = experimentCase.steps[0]!;
  const hypothesis = compileAgentOutcomeHypothesis({
    envelope: experiment.compiled,
    catalog,
    caseId: experimentCase.caseId,
    stepId: step.stepId,
    draft: {
      format: "forge.agent-outcome-hypothesis-draft/v1alpha1",
      hypothesisId: "authority-test-hypothesis",
      createdAt: "2026-08-30T20:08:00.000Z",
      source: {
        origin: "model_inference",
        component: { id: "authority-test-provider", version: "1" },
        confidence: "medium",
        evidenceBasis: [{ kind: "model_output", reference: "test prediction" }],
      },
      expected: {
        protocolOutcomes: ["success"],
        shapes: ["json_object"],
        contentClasses: ["structured_data"],
        maxReasonableBytes: 4_096,
      },
      limitations: ["Test hypothesis is not authority."],
      authority: {
        authorizesExecution: false,
        grantsApproval: false,
        declaresSafety: false,
      },
    },
  });
  const context = {
    preparedTarget,
    resources,
    snapshot,
    runtime,
    catalog,
    experiment,
    image,
    backendProfileDigest: invocation.backendProfileDigest,
  };
  return { record, context, experiment, hypothesis, invocation };
}

describe("enrolled target authority", () => {
  it("requires live enrollment/review capabilities and binds one exact call", async () => {
    const setup = await fixture();
    const authority = createEnrolledTargetAuthority({ controllerId: "authority-test" });
    const registered = authority.registerVerifiedEnrollment({
      record: setup.record,
      context: setup.context,
    });
    const copied = { ...(registered.capability as object) } as EnrollmentCandidateCapability;
    expect(() =>
      authority.approveExactCall({
        capability: copied,
        enrollmentRecord: registered.record,
        enrollmentDigest: registered.recordDigest,
        hypothesis: setup.hypothesis,
        reviewId: "authority-review-copy",
        reviewerId: "authority-reviewer",
        reviewedAt: "2026-08-30T20:09:00.000Z",
        capabilityExpiresAt: "2026-08-30T20:14:00.000Z",
        approvalClass: "operator_review",
      }),
    ).toThrow(EnrolledAuthorityError);

    const reviewed = authority.approveExactCall({
      capability: registered.capability,
      enrollmentRecord: registered.record,
      enrollmentDigest: registered.recordDigest,
      hypothesis: setup.hypothesis,
      reviewId: "authority-review",
      reviewerId: "authority-reviewer",
      reviewedAt: "2026-08-30T20:09:00.000Z",
      capabilityExpiresAt: "2026-08-30T20:14:00.000Z",
      approvalClass: "operator_review",
    });
    expect(reviewed.record.exactCall).toMatchObject({
      toolName: "echo_value",
      argumentSha256: setup.experiment.compiled.plan.cases[0]!.steps[0]!.argumentSha256,
      maxCalls: 1,
      maxRetries: 0,
      authorizesFollowup: false,
    });
    const forged = Object.freeze({}) as EnrolledCallReviewCapability;
    expect(() =>
      authority.consumeExactCallReview({
        capability: forged,
        reviewRecord: reviewed.record,
        reviewDigest: reviewed.recordDigest,
        now: "2026-08-30T20:10:00.000Z",
      }),
    ).toThrow(EnrolledAuthorityError);
    const consumed = authority.consumeExactCallReview({
      capability: reviewed.capability,
      reviewRecord: reviewed.record,
      reviewDigest: reviewed.recordDigest,
      now: "2026-08-30T20:10:00.000Z",
    });
    const executionInvocation = createEnrolledNodeStdioDockerInvocation({
      runId: "authority-run",
      experimentId: "authority-execution",
      preparedTarget: setup.context.preparedTarget,
      resources: setup.context.resources,
      runtime: setup.context.runtime,
      bounds: setup.experiment.compiled.plan.bounds,
      image: setup.context.image,
    });
    const step = setup.experiment.compiled.plan.cases[0]!.steps[0]!;
    const dispatch = await authority.revalidateDispatch({
      consumed,
      invocation: executionInvocation,
      liveCatalog: catalog,
      toolName: step.toolName,
      arguments: step.arguments,
      now: "2026-08-30T20:11:00.000Z",
    });
    expect(dispatch).toMatchObject({
      toolName: "echo_value",
      arguments: { value: "synthetic" },
      sequence: 0,
    });
    await expect(
      authority.revalidateDispatch({
        consumed,
        invocation: executionInvocation,
        liveCatalog: catalog,
        toolName: step.toolName,
        arguments: step.arguments,
        now: "2026-08-30T20:12:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "replay" });
  });

  it("burns a capability when the serialized enrollment is substituted", async () => {
    const setup = await fixture();
    const authority = createEnrolledTargetAuthority({ controllerId: "authority-test" });
    const registered = authority.registerVerifiedEnrollment({
      record: setup.record,
      context: setup.context,
    });
    const changed = structuredClone(registered.record);
    changed.eligibility.assessedAt = "2026-08-30T20:05:30.000Z";
    expect(() =>
      authority.approveExactCall({
        capability: registered.capability,
        enrollmentRecord: changed,
        enrollmentDigest: registered.recordDigest,
        hypothesis: setup.hypothesis,
        reviewId: "substituted-review",
        reviewerId: "authority-reviewer",
        reviewedAt: "2026-08-30T20:09:00.000Z",
        capabilityExpiresAt: "2026-08-30T20:14:00.000Z",
        approvalClass: "operator_review",
      }),
    ).toThrow();
    expect(() =>
      authority.approveExactCall({
        capability: registered.capability,
        enrollmentRecord: registered.record,
        enrollmentDigest: registered.recordDigest,
        hypothesis: setup.hypothesis,
        reviewId: "replayed-review",
        reviewerId: "authority-reviewer",
        reviewedAt: "2026-08-30T20:09:00.000Z",
        capabilityExpiresAt: "2026-08-30T20:14:00.000Z",
        approvalClass: "operator_review",
      }),
    ).toThrowError(expect.objectContaining({ code: "replay" }));
  });
});
