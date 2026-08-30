import { describe, expect, it } from "vitest";

import {
  MCP_ENROLLMENT_RECORD_FORMAT,
  MCP_ENROLLMENT_REJECTION_FORMAT,
  MCP_ENROLLMENT_REVIEW_FORMAT,
  mcpEnrollmentRecordV2AlphaSchema,
  mcpEnrollmentRejectionV2AlphaSchema,
  mcpEnrollmentReviewRecordV2AlphaSchema,
} from "../../src/contracts/v2/index.js";

const digest = (character: string): string => character.repeat(64);
const imageId = `sha256:${digest("a")}`;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validBounds() {
  return {
    maxCases: 2,
    maxStepsPerCase: 1,
    maxTotalSteps: 2,
    maxCaseRuntimeMs: 10_000,
    maxTotalRuntimeMs: 20_000,
    maxArgumentBytes: 4_096,
    maxOutputBytesPerStep: 65_536,
    maxTotalOutputBytes: 131_072,
    maxWritableBytes: 131_072,
    maxWritableFiles: 8,
    maxFileBytes: 65_536,
    maxProcesses: 32,
    maxMemoryMb: 128,
    maxCpuMs: 10_000,
    maxOpenFiles: 64,
  };
}

function validCatalog() {
  return {
    canonicalization: "rfc8785-jcs",
    rawProjection: "forge.mcp-raw-discovery/v2",
    planProjection: "forge.mcp-plan-catalog/v2",
    rawDiscoveryDigest: digest("b"),
    planCatalogDigest: digest("c"),
    toolCount: 3,
  };
}

function validEnrollment() {
  return {
    format: MCP_ENROLLMENT_RECORD_FORMAT,
    enrollmentId: "enrollment-example-v1",
    recordedAt: "2026-08-30T12:07:00.000Z",
    enroller: { id: "forge-enrollment-controller", version: "1alpha1" },
    target: {
      identity: {
        targetId: "unfamiliar-example-mcp",
        sourceArtifact: {
          artifactId: "unfamiliar-source",
          kind: "source_bundle",
          mediaType: "application/json",
          byteLength: 512,
          sha256: digest("d"),
        },
        runtimeSnapshot: {
          artifactId: "unfamiliar-runtime",
          kind: "runtime_snapshot",
          mediaType: "application/vnd.forge.runtime-tree+json",
          byteLength: 256,
          sha256: digest("e"),
        },
        runtimeTreeAlgorithm: "forge.runtime-tree/v2",
        runtimeDescriptorDigest: digest("f"),
      },
      identityDigest: digest("1"),
    },
    source: {
      acquiredAt: "2026-08-30T12:00:00.000Z",
      evidenceReference: "enrollment-acquisition-evidence",
      provenance: {
        kind: "npm",
        sourceTreeSha256: digest("2"),
        sourceEntryCount: 120,
        sourceRegularFileBytes: 400_000,
        sourceArtifactSha256: digest("d"),
        lifecycleScripts: "disabled",
        package: "@example/unfamiliar-mcp",
        requestedVersion: "1.2.3",
        resolvedVersion: "1.2.3",
        resolvedTarball:
          "https://registry.example.invalid/@example/unfamiliar-mcp/-/unfamiliar-mcp-1.2.3.tgz",
        integrity: `sha512-${"A".repeat(86)}==`,
        packageLockSha256: digest("3"),
        acquisitionNetwork: "networked_package_acquisition",
      },
    },
    preparedTree: {
      format: "forge.enrolled-runtime-tree/v1alpha1",
      complete: true,
      scope: "entire_prepared_root",
      specialEntriesRejected: true,
      treeSha256: digest("4"),
      evidenceReference: "enrollment-runtime-tree-snapshot",
      runtimeSnapshotArtifactSha256: digest("e"),
      counters: {
        entryCount: 125,
        directoryCount: 10,
        fileCount: 113,
        symlinkCount: 2,
        fileBytesHashed: 450_000,
        symlinkTargetBytesHashed: 50,
        maximumDepth: 9,
      },
      limits: {
        maxEntries: 10_000,
        maxDepth: 32,
        maxDirectoryEntries: 1_000,
        maxPathBytes: 4_096,
        maxFileBytes: 1_000_000,
        maxTotalFileBytes: 10_000_000,
        maxSymlinkTargetBytes: 4_096,
      },
      capturedAt: "2026-08-30T12:01:00.000Z",
    },
    runtime: {
      runtimeDescriptorDigest: digest("f"),
      invocation: {
        format: "forge.enrolled-node-invocation/v1alpha1",
        transport: "stdio",
        protocol: "mcp",
        descriptorCommand: "node",
        executable: "/usr/local/bin/node",
        entrypoint:
          "/opt/target/node_modules/@example/unfamiliar-mcp/dist/index.js",
        applicationArgs: ["/forge/synthetic"],
        cwd: "/opt/target",
        environment: {},
        digest: digest("5"),
      },
      argumentLimits: {
        maxArguments: 32,
        maxArgumentBytes: 512,
        maxAggregateBytes: 8_192,
      },
      validatedAt: "2026-08-30T12:02:00.000Z",
    },
    sandbox: {
      profile: { id: "forge-enrolled-node-sandbox", version: "1alpha1" },
      profileDigest: digest("6"),
      imageReference: "forge-enrolled-sandbox:node-20260830",
      imageId,
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
      executionBounds: validBounds(),
      verifiedAt: "2026-08-30T12:02:30.000Z",
    },
    discovery: {
      startedAt: "2026-08-30T12:03:00.000Z",
      completedAt: "2026-08-30T12:04:00.000Z",
      catalog: validCatalog(),
      completeness: {
        complete: true,
        pageCount: 1,
        listChangedDuringDiscovery: false,
      },
      transcript: {
        evidenceReference: "enrollment-discovery-transcript",
        sha256: digest("7"),
        byteLength: 20_000,
        toolsListRequests: 1,
        toolsCallRequests: 0,
        toolsListChangedNotifications: 0,
      },
      limits: {
        maxPages: 1,
        maxTools: 100,
        maxTranscriptBytes: 1_000_000,
      },
      cleanup: {
        status: "verified_absent",
        containerAbsent: true,
        ephemeralDiscoveryInputsAbsent: true,
        preparedTargetDisposition: "retained_for_review",
        evidenceReference: "enrollment-discovery-cleanup",
        verifiedAt: "2026-08-30T12:05:00.000Z",
      },
    },
    eligibility: {
      status: "eligible_for_manual_review",
      executionClass: "enrolled_node_stdio_single_call",
      assessedAt: "2026-08-30T12:06:00.000Z",
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
    limitations: [
      "This deterministic enrollment record is evidence and cannot authorize execution.",
    ],
  };
}

function validRejection() {
  return {
    format: MCP_ENROLLMENT_REJECTION_FORMAT,
    rejectionId: "rejection-unsupported-schema",
    startedAt: "2026-08-30T13:00:00.000Z",
    recordedAt: "2026-08-30T13:05:00.000Z",
    candidate: {
      targetId: "unfamiliar-example-mcp",
      configSha256: digest("8"),
      sourceKind: "npm",
    },
    stage: "eligibility",
    reasonCodes: ["input_schema_unsupported"],
    evidenceReferences: ["bounded-catalog-evidence"],
    cleanup: {
      status: "verified_absent",
      evidenceReferences: ["enrollment-discovery-cleanup"],
      verifiedAt: "2026-08-30T13:04:00.000Z",
      limitations: [],
    },
    authority: {
      recordAuthorizesEnrollment: false,
      recordAuthorizesExecution: false,
      recordAuthorizesRetry: false,
      recordGrantsApproval: false,
      serializedRecordIsBearerAuthority: false,
    },
    limitations: [
      "The bounded reason code is not execution authority or a reusable retry decision.",
    ],
  };
}

function validReview() {
  return {
    format: MCP_ENROLLMENT_REVIEW_FORMAT,
    reviewId: "review-unfamiliar-example-read",
    enrollment: {
      enrollmentId: "enrollment-example-v1",
      enrollmentDigest: digest("9"),
      enrollmentRecordedAt: "2026-08-30T12:07:00.000Z",
      targetIdentityDigest: digest("1"),
      preparedTargetTreeSha256: digest("4"),
      runtimeInvocationDigest: digest("5"),
      catalog: validCatalog(),
      sandboxProfileDigest: digest("6"),
      sandboxImageId: imageId,
    },
    exactCall: {
      experimentPlanDigest: digest("0"),
      policyDigest: digest("a"),
      hypothesisDigest: digest("b"),
      syntheticResourceManifestDigest: digest("c"),
      planCompiledAt: "2026-08-30T12:06:30.000Z",
      hypothesisCreatedAt: "2026-08-30T12:09:00.000Z",
      policyExpiresAt: "2026-08-30T12:15:00.000Z",
      caseId: "agent-proposed-read-case--default--r1",
      stepId: "read-synthetic-input",
      toolName: "read_synthetic_input",
      argumentSha256: digest("d"),
      sequence: 0,
      maxCalls: 1,
      maxRetries: 0,
      authorizesFollowup: false,
    },
    review: {
      reviewerId: "local-operator",
      method: "explicit_manual",
      externallyAuthenticatedIdentity: false,
      reviewedAt: "2026-08-30T12:10:00.000Z",
      decision: "approved",
      approvalClass: "operator_review",
      requiredApprovalClass: "operator_review",
      capabilityExpiresAt: "2026-08-30T12:14:00.000Z",
    },
    authority: {
      recordAuthorizesEnrollment: false,
      recordAuthorizesExecution: false,
      recordGrantsApproval: false,
      serializedRecordIsBearerAuthority: false,
      serializedCapabilityExists: false,
      requiredNextStep:
        "consume_opaque_single_use_enrollment_review_capability",
    },
    limitations: [
      "The local reviewer identity is not an externally authenticated signature.",
    ],
  };
}

describe("V2 unseen-MCP enrollment evidence contracts", () => {
  it("accepts an exact npm Node STDIO enrollment with zero discovery calls", () => {
    const parsed = mcpEnrollmentRecordV2AlphaSchema.parse(validEnrollment());

    expect(parsed.source.provenance).toMatchObject({
      kind: "npm",
      requestedVersion: "1.2.3",
      resolvedVersion: "1.2.3",
      lifecycleScripts: "disabled",
    });
    expect(parsed.discovery).toMatchObject({
      completeness: { complete: true, pageCount: 1 },
      transcript: { toolsListRequests: 1, toolsCallRequests: 0 },
      cleanup: { status: "verified_absent" },
    });
    expect(parsed.authority).toMatchObject({
      recordAuthorizesExecution: false,
      serializedRecordIsBearerAuthority: false,
      requiresManualExactCallReview: true,
    });
  });

  it("accepts a fully identified local snapshot without acquisition network", () => {
    const enrollment = validEnrollment();
    enrollment.source.provenance = {
      kind: "local_snapshot",
      sourceTreeSha256: digest("2"),
      sourceEntryCount: 5,
      sourceRegularFileBytes: 20_000,
      sourceArtifactSha256: digest("d"),
      lifecycleScripts: "disabled",
      configuredPathSha256: digest("f"),
      installMode: "none",
      acquisitionNetwork: "none",
    } as any;

    const parsed = mcpEnrollmentRecordV2AlphaSchema.parse(enrollment);
    expect(parsed.source.provenance).toMatchObject({
      kind: "local_snapshot",
      installMode: "none",
      acquisitionNetwork: "none",
    });
  });

  it("rejects provenance, prepared-tree, runtime, and authority substitution", () => {
    const mutations: Array<(record: any) => void> = [
      (record) => {
        record.source.provenance.sourceArtifactSha256 = digest("0");
      },
      (record) => {
        record.preparedTree.runtimeSnapshotArtifactSha256 = digest("0");
      },
      (record) => {
        record.preparedTree.counters.entryCount += 1;
      },
      (record) => {
        record.preparedTree.counters.fileBytesHashed = 11_000_000;
      },
      (record) => {
        record.runtime.runtimeDescriptorDigest = digest("0");
      },
      (record) => {
        record.runtime.invocation.entrypoint = "/tmp/server.js";
      },
      (record) => {
        record.runtime.invocation.applicationArgs = ["--eval"];
      },
      (record) => {
        record.runtime.invocation.applicationArgs = ["sh"];
      },
      (record) => {
        record.sandbox.imageId = "forge:latest";
      },
      (record) => {
        record.authority.recordAuthorizesExecution = true;
      },
    ];

    for (const mutate of mutations) {
      const record: any = clone(validEnrollment());
      mutate(record);
      expect(mcpEnrollmentRecordV2AlphaSchema.safeParse(record).success).toBe(
        false,
      );
    }
  });

  it("rejects incomplete, over-limit, called, or chronologically invalid discovery", () => {
    const mutations: Array<(record: any) => void> = [
      (record) => {
        record.discovery.completeness.complete = false;
      },
      (record) => {
        record.discovery.completeness.pageCount = 2;
      },
      (record) => {
        record.discovery.transcript.toolsCallRequests = 1;
      },
      (record) => {
        record.discovery.catalog.toolCount = 101;
      },
      (record) => {
        record.discovery.transcript.byteLength = 1_000_001;
      },
      (record) => {
        record.discovery.cleanup.verifiedAt = "2026-08-30T12:03:30.000Z";
      },
      (record) => {
        record.eligibility.assessedAt = "2026-08-30T12:04:30.000Z";
      },
      (record) => {
        record.eligibility.requiredApprovalClass = "automatic";
      },
    ];

    for (const mutate of mutations) {
      const record: any = clone(validEnrollment());
      mutate(record);
      expect(mcpEnrollmentRecordV2AlphaSchema.safeParse(record).success).toBe(
        false,
      );
    }
  });

  it("rejects unknown enrollment keys at top-level and nested boundaries", () => {
    const top: any = clone(validEnrollment());
    top.dispatchPermit = "forged";
    expect(mcpEnrollmentRecordV2AlphaSchema.safeParse(top).success).toBe(false);

    const nested: any = clone(validEnrollment());
    nested.sandbox.networkFallback = "bridge";
    expect(mcpEnrollmentRecordV2AlphaSchema.safeParse(nested).success).toBe(
      false,
    );
  });

  it("accepts bounded deterministic rejection evidence", () => {
    const parsed = mcpEnrollmentRejectionV2AlphaSchema.parse(validRejection());
    expect(parsed).toMatchObject({
      stage: "eligibility",
      reasonCodes: ["input_schema_unsupported"],
      cleanup: { status: "verified_absent" },
      authority: {
        recordAuthorizesExecution: false,
        recordAuthorizesRetry: false,
      },
    });

    const prestart: any = clone(validRejection());
    prestart.stage = "configuration";
    prestart.reasonCodes = ["invalid_target_config", "unsupported_source"];
    prestart.cleanup = {
      status: "not_started",
      evidenceReferences: [],
      limitations: [],
    };
    expect(
      mcpEnrollmentRejectionV2AlphaSchema.safeParse(prestart).success,
    ).toBe(true);
  });

  it("rejects mismatched, duplicated, unordered, or authoritative rejection claims", () => {
    const mutations: Array<(record: any) => void> = [
      (record) => {
        record.stage = "runtime_validation";
      },
      (record) => {
        record.reasonCodes = [
          "no_safe_single_call_candidate",
          "input_schema_unsupported",
        ];
      },
      (record) => {
        record.reasonCodes = [
          "input_schema_unsupported",
          "input_schema_unsupported",
        ];
      },
      (record) => {
        record.cleanup.status = "not_started";
        record.cleanup.evidenceReferences = [];
        record.cleanup.limitations = [];
        delete record.cleanup.verifiedAt;
      },
      (record) => {
        record.authority.recordAuthorizesRetry = true;
      },
      (record) => {
        record.unboundedError = "raw target error";
      },
      (record) => {
        record.cleanup.verifiedAt = "2026-08-30T13:06:00.000Z";
      },
    ];

    for (const mutate of mutations) {
      const record: any = clone(validRejection());
      mutate(record);
      expect(
        mcpEnrollmentRejectionV2AlphaSchema.safeParse(record).success,
      ).toBe(false);
    }
  });

  it("accepts a non-bearer manual review bound to one exact call", () => {
    const parsed = mcpEnrollmentReviewRecordV2AlphaSchema.parse(validReview());
    expect(parsed).toMatchObject({
      enrollment: {
        enrollmentDigest: digest("9"),
        targetIdentityDigest: digest("1"),
        runtimeInvocationDigest: digest("5"),
      },
      exactCall: {
        caseId: "agent-proposed-read-case--default--r1",
        stepId: "read-synthetic-input",
        toolName: "read_synthetic_input",
        sequence: 0,
        maxCalls: 1,
        maxRetries: 0,
        authorizesFollowup: false,
      },
      review: { method: "explicit_manual", decision: "approved" },
      authority: {
        recordAuthorizesExecution: false,
        serializedRecordIsBearerAuthority: false,
        serializedCapabilityExists: false,
      },
    });
  });

  it("rejects review chronology, insufficient class, authority, and scope mutation", () => {
    const mutations: Array<(record: any) => void> = [
      (record) => {
        record.exactCall.planCompiledAt = "2026-08-30T12:08:00.000Z";
      },
      (record) => {
        record.exactCall.hypothesisCreatedAt = "2026-08-30T12:06:45.000Z";
      },
      (record) => {
        record.review.reviewedAt = "2026-08-30T12:08:30.000Z";
      },
      (record) => {
        record.review.capabilityExpiresAt = "2026-08-30T12:16:00.000Z";
      },
      (record) => {
        record.review.approvalClass = "operator_review";
        record.review.requiredApprovalClass = "security_review";
      },
      (record) => {
        record.review.approvalClass = "automatic";
        record.review.requiredApprovalClass = "automatic";
      },
      (record) => {
        record.exactCall.sequence = 1;
      },
      (record) => {
        delete record.exactCall.argumentSha256;
      },
      (record) => {
        record.authority.recordAuthorizesExecution = true;
      },
      (record) => {
        record.serializedPermit = { reusable: true };
      },
    ];

    for (const mutate of mutations) {
      const record: any = clone(validReview());
      mutate(record);
      expect(
        mcpEnrollmentReviewRecordV2AlphaSchema.safeParse(record).success,
      ).toBe(false);
    }
  });
});
