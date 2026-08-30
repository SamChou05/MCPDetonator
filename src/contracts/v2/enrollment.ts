import { valid as validSemver } from "semver";
import { posix } from "node:path";
import { z } from "zod";

import {
  executionBoundsV2Schema,
  targetIdentityV2Schema,
} from "./artifact-reference.js";
import { catalogIdentityV2Schema } from "./catalog.js";
import {
  V2_CONTRACT_LIMITS,
  addDuplicateIssues,
  componentIdentityV2Schema,
  descriptionV2Schema,
  identifierV2Schema,
  nonnegativeSafeIntegerV2Schema,
  positiveSafeIntegerV2Schema,
  sha256V2Schema,
  shortTextV2Schema,
  timestampV2Schema,
  toolNameV2Schema,
} from "./common.js";
import { APPROVAL_CLASS_RANK, approvalClassV2Schema } from "./vocabulary.js";

/**
 * Experimental enrollment sidecars. These records are evidence, not members
 * of V2_TOP_LEVEL_SCHEMA_IDS and not serialized dispatch credentials.
 */
export const MCP_ENROLLMENT_RECORD_FORMAT =
  "forge.mcp-enrollment/v1alpha1" as const;
export const MCP_ENROLLMENT_REJECTION_FORMAT =
  "forge.mcp-enrollment-rejection/v1alpha1" as const;
export const MCP_ENROLLMENT_REVIEW_FORMAT =
  "forge.mcp-enrollment-review/v1alpha1" as const;

export const MCP_ENROLLMENT_REVIEW_MAX_LIFETIME_MS = 5 * 60 * 1_000;

export const MCP_ENROLLMENT_LIMITS = Object.freeze({
  maxPreparedEntries: 200_000,
  maxPreparedTreeBytes: V2_CONTRACT_LIMITS.artifactBytes,
  maxPreparedFileBytes: V2_CONTRACT_LIMITS.artifactBytes,
  maxPreparedTreeDepth: 128,
  maxApplicationArgs: 32,
  maxDiscoveryTranscriptBytes: 16 * 1_024 * 1_024,
  maxDiscoveryTools: 10_000,
  maxRejectionReasons: 16,
  maxEvidenceReferences: 32,
});

const packageNameV2Schema = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u);

const exactSemverV2Schema = shortTextV2Schema.refine(
  (value) => validSemver(value) === value,
  "must be one canonical exact semantic version, not a tag or range",
);

const npmIntegrityV2Schema = shortTextV2Schema.regex(
  /^sha512-[A-Za-z0-9+/]+={0,2}$/u,
  "must be an exact sha512 subresource-integrity value",
);

const dockerImageIdV2Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

const targetEntrypointV2Schema = shortTextV2Schema.refine((value) => {
  if (!value.startsWith("/opt/target/")) return false;
  const segments = value.split("/");
  return (
    !value.includes("\0") &&
    posix.normalize(value) === value &&
    segments.every((segment) => segment !== "." && segment !== "..") &&
    [".cjs", ".js", ".mjs"].includes(posix.extname(value))
  );
}, "entrypoint must be a normalized .js, .mjs, or .cjs path beneath /opt/target without traversal");

const forbiddenApplicationExecutableTokens = new Set([
  "bash",
  "dash",
  "ksh",
  "node",
  "npm",
  "npx",
  "sh",
  "zsh",
]);

const applicationArgumentV2Schema = shortTextV2Schema
  .refine((value) => Buffer.byteLength(value, "utf8") <= 512, {
    message: "application arguments may contain at most 512 UTF-8 bytes",
  })
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value) && !value.includes("\\"),
    {
      message:
        "application arguments cannot contain control characters or backslashes",
    },
  )
  .refine(
    (value) =>
      !/^(?:-e|--eval|-r|--require|--import|--loader|--experimental-loader|--inspect|--inspect-brk|--input-type|--env-file)(?:=|$)/u.test(
        value,
      ),
    {
      message:
        "application arguments cannot request Node evaluation, preload, loader, inspector, input-type, or environment-file behavior",
    },
  )
  .refine((value) => !value.split("/").includes(".."), {
    message: "application arguments cannot contain path traversal",
  })
  .refine(
    (value) => {
      const token = value.includes("=")
        ? value.slice(value.indexOf("=") + 1)
        : value;
      return !forbiddenApplicationExecutableTokens.has(
        posix.basename(token).toLowerCase(),
      );
    },
    {
      message:
        "application arguments cannot name a shell, package manager, or Node executable token",
    },
  )
  .refine(
    (value) => {
      if (!value.startsWith("/")) return true;
      return (
        value === "/opt/target" ||
        value === "/forge/synthetic" ||
        value.startsWith("/opt/target/") ||
        value.startsWith("/forge/synthetic/")
      );
    },
    {
      message:
        "absolute application paths must stay inside the target or synthetic-resource mounts",
    },
  );

const sourceCounterFields = {
  sourceTreeSha256: sha256V2Schema,
  sourceEntryCount: positiveSafeIntegerV2Schema.max(
    MCP_ENROLLMENT_LIMITS.maxPreparedEntries,
  ),
  sourceRegularFileBytes: nonnegativeSafeIntegerV2Schema.max(
    MCP_ENROLLMENT_LIMITS.maxPreparedTreeBytes,
  ),
  sourceArtifactSha256: sha256V2Schema,
  lifecycleScripts: z.literal("disabled"),
} as const;

export const mcpEnrollmentSourceV2AlphaSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("npm"),
      ...sourceCounterFields,
      package: packageNameV2Schema,
      requestedVersion: exactSemverV2Schema,
      resolvedVersion: exactSemverV2Schema,
      resolvedTarball: shortTextV2Schema.refine(
        (value) => !/\s/u.test(value),
        "resolvedTarball cannot contain whitespace",
      ),
      integrity: npmIntegrityV2Schema,
      packageLockSha256: sha256V2Schema,
      acquisitionNetwork: z.literal("networked_package_acquisition"),
    })
    .strict()
    .superRefine((source, ctx) => {
      if (source.requestedVersion !== source.resolvedVersion) {
        ctx.addIssue({
          code: "custom",
          message: "resolvedVersion must equal the exact requestedVersion",
          path: ["resolvedVersion"],
        });
      }
    }),
  z
    .object({
      kind: z.literal("local_snapshot"),
      ...sourceCounterFields,
      configuredPathSha256: sha256V2Schema,
      installMode: z.enum(["none", "npm_ignore_scripts"]),
      packageLockSha256: sha256V2Schema.optional(),
      acquisitionNetwork: z.literal("none"),
    })
    .strict(),
]);

export const mcpPreparedTreeSnapshotV2AlphaSchema = z
  .object({
    format: z.literal("forge.enrolled-runtime-tree/v1alpha1"),
    complete: z.literal(true),
    scope: z.literal("entire_prepared_root"),
    specialEntriesRejected: z.literal(true),
    treeSha256: sha256V2Schema,
    evidenceReference: identifierV2Schema,
    runtimeSnapshotArtifactSha256: sha256V2Schema,
    counters: z
      .object({
        entryCount: positiveSafeIntegerV2Schema.max(
          MCP_ENROLLMENT_LIMITS.maxPreparedEntries,
        ),
        directoryCount: nonnegativeSafeIntegerV2Schema.max(
          MCP_ENROLLMENT_LIMITS.maxPreparedEntries,
        ),
        fileCount: positiveSafeIntegerV2Schema.max(
          MCP_ENROLLMENT_LIMITS.maxPreparedEntries,
        ),
        symlinkCount: nonnegativeSafeIntegerV2Schema.max(
          MCP_ENROLLMENT_LIMITS.maxPreparedEntries,
        ),
        fileBytesHashed: nonnegativeSafeIntegerV2Schema.max(
          MCP_ENROLLMENT_LIMITS.maxPreparedTreeBytes,
        ),
        symlinkTargetBytesHashed: nonnegativeSafeIntegerV2Schema.max(
          MCP_ENROLLMENT_LIMITS.maxPreparedTreeBytes,
        ),
        maximumDepth: nonnegativeSafeIntegerV2Schema.max(
          MCP_ENROLLMENT_LIMITS.maxPreparedTreeDepth,
        ),
      })
      .strict(),
    limits: z
      .object({
        maxEntries: positiveSafeIntegerV2Schema.max(
          MCP_ENROLLMENT_LIMITS.maxPreparedEntries,
        ),
        maxDepth: nonnegativeSafeIntegerV2Schema.max(
          MCP_ENROLLMENT_LIMITS.maxPreparedTreeDepth,
        ),
        maxDirectoryEntries: positiveSafeIntegerV2Schema.max(
          MCP_ENROLLMENT_LIMITS.maxPreparedEntries,
        ),
        maxPathBytes: positiveSafeIntegerV2Schema.max(65_536),
        maxFileBytes: positiveSafeIntegerV2Schema.max(
          MCP_ENROLLMENT_LIMITS.maxPreparedFileBytes,
        ),
        maxTotalFileBytes: positiveSafeIntegerV2Schema.max(
          MCP_ENROLLMENT_LIMITS.maxPreparedTreeBytes,
        ),
        maxSymlinkTargetBytes: positiveSafeIntegerV2Schema.max(65_536),
      })
      .strict(),
    capturedAt: timestampV2Schema,
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const { counters, limits } = snapshot;
    if (
      counters.directoryCount + counters.fileCount + counters.symlinkCount !==
      counters.entryCount
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "entryCount must equal directoryCount plus fileCount plus symlinkCount",
        path: ["counters", "entryCount"],
      });
    }
    if (counters.entryCount > limits.maxEntries) {
      ctx.addIssue({
        code: "custom",
        message: "prepared-tree entry count exceeds its retained limit",
        path: ["counters", "entryCount"],
      });
    }
    if (counters.fileBytesHashed > limits.maxTotalFileBytes) {
      ctx.addIssue({
        code: "custom",
        message: "prepared-tree byte count exceeds its retained limit",
        path: ["counters", "fileBytesHashed"],
      });
    }
    if (counters.maximumDepth > limits.maxDepth) {
      ctx.addIssue({
        code: "custom",
        message: "prepared-tree depth exceeds its retained limit",
        path: ["counters", "maximumDepth"],
      });
    }
  });

export const normalizedNodeInvocationV2AlphaSchema = z
  .object({
    format: z.literal("forge.enrolled-node-invocation/v1alpha1"),
    transport: z.literal("stdio"),
    protocol: z.literal("mcp"),
    descriptorCommand: z.literal("node"),
    executable: z.literal("/usr/local/bin/node"),
    entrypoint: targetEntrypointV2Schema,
    applicationArgs: z
      .array(applicationArgumentV2Schema)
      .max(MCP_ENROLLMENT_LIMITS.maxApplicationArgs),
    cwd: z.literal("/opt/target"),
    environment: z.object({}).strict(),
    digest: sha256V2Schema,
  })
  .strict()
  .superRefine((invocation, ctx) => {
    const aggregateBytes = invocation.applicationArgs.reduce(
      (total, argument) => total + Buffer.byteLength(argument, "utf8"),
      0,
    );
    if (aggregateBytes > 8_192) {
      ctx.addIssue({
        code: "custom",
        message: "application arguments exceed the aggregate UTF-8 byte limit",
        path: ["applicationArgs"],
      });
    }
  });

export const enrolledNodeRuntimeV2AlphaSchema = z
  .object({
    runtimeDescriptorDigest: sha256V2Schema,
    invocation: normalizedNodeInvocationV2AlphaSchema,
    argumentLimits: z
      .object({
        maxArguments: positiveSafeIntegerV2Schema.max(
          MCP_ENROLLMENT_LIMITS.maxApplicationArgs,
        ),
        maxArgumentBytes: positiveSafeIntegerV2Schema.max(512),
        maxAggregateBytes: positiveSafeIntegerV2Schema.max(8_192),
      })
      .strict(),
    validatedAt: timestampV2Schema,
  })
  .strict()
  .superRefine((runtime, ctx) => {
    if (
      runtime.invocation.applicationArgs.length >
      runtime.argumentLimits.maxArguments
    ) {
      ctx.addIssue({
        code: "custom",
        message: "application argument count exceeds its enrolled limit",
        path: ["invocation", "applicationArgs"],
      });
    }
    let aggregateBytes = 0;
    runtime.invocation.applicationArgs.forEach((argument, index) => {
      const byteLength = Buffer.byteLength(argument, "utf8");
      aggregateBytes += byteLength;
      if (byteLength > runtime.argumentLimits.maxArgumentBytes) {
        ctx.addIssue({
          code: "custom",
          message: "application argument exceeds its enrolled byte limit",
          path: ["invocation", "applicationArgs", index],
        });
      }
    });
    if (aggregateBytes > runtime.argumentLimits.maxAggregateBytes) {
      ctx.addIssue({
        code: "custom",
        message:
          "application arguments exceed their enrolled aggregate byte limit",
        path: ["invocation", "applicationArgs"],
      });
    }
  });

export const enrolledSandboxBoundaryV2AlphaSchema = z
  .object({
    profile: componentIdentityV2Schema,
    profileDigest: sha256V2Schema,
    imageReference: shortTextV2Schema,
    imageId: dockerImageIdV2Schema,
    platform: z.literal("linux"),
    imageDeclaredVolumes: z.literal(false),
    network: z.literal("none"),
    ipc: z.literal("none"),
    readOnlyRootFilesystem: z.literal(true),
    readOnlyTargetMount: z.literal(true),
    readOnlySyntheticResourceMount: z.literal(true),
    writableHostBinds: z.literal(false),
    providerAvailable: z.literal(false),
    maxCalls: z.literal(1),
    maxRetries: z.literal(0),
    authorizesFollowup: z.literal(false),
    resultExposure: z.literal("local_quarantine_only"),
    cleanupVerificationRequired: z.literal(true),
    executionBounds: executionBoundsV2Schema,
    verifiedAt: timestampV2Schema,
  })
  .strict();

const verifiedEnrollmentCleanupV2AlphaSchema = z
  .object({
    status: z.literal("verified_absent"),
    containerAbsent: z.literal(true),
    ephemeralDiscoveryInputsAbsent: z.literal(true),
    preparedTargetDisposition: z.literal("retained_for_review"),
    evidenceReference: identifierV2Schema,
    verifiedAt: timestampV2Schema,
  })
  .strict();

export const mcpEnrollmentDiscoveryV2AlphaSchema = z
  .object({
    startedAt: timestampV2Schema,
    completedAt: timestampV2Schema,
    catalog: catalogIdentityV2Schema,
    completeness: z
      .object({
        complete: z.literal(true),
        pageCount: z.literal(1),
        listChangedDuringDiscovery: z.literal(false),
      })
      .strict(),
    transcript: z
      .object({
        evidenceReference: identifierV2Schema,
        sha256: sha256V2Schema,
        byteLength: positiveSafeIntegerV2Schema.max(
          MCP_ENROLLMENT_LIMITS.maxDiscoveryTranscriptBytes,
        ),
        toolsListRequests: z.literal(1),
        toolsCallRequests: z.literal(0),
        toolsListChangedNotifications: z.literal(0),
      })
      .strict(),
    limits: z
      .object({
        maxPages: z.literal(1),
        maxTools: positiveSafeIntegerV2Schema.max(
          MCP_ENROLLMENT_LIMITS.maxDiscoveryTools,
        ),
        maxTranscriptBytes: positiveSafeIntegerV2Schema.max(
          MCP_ENROLLMENT_LIMITS.maxDiscoveryTranscriptBytes,
        ),
      })
      .strict(),
    cleanup: verifiedEnrollmentCleanupV2AlphaSchema,
  })
  .strict()
  .superRefine((discovery, ctx) => {
    if (Date.parse(discovery.completedAt) < Date.parse(discovery.startedAt)) {
      ctx.addIssue({
        code: "custom",
        message: "discovery completion cannot predate discovery start",
        path: ["completedAt"],
      });
    }
    if (
      Date.parse(discovery.cleanup.verifiedAt) <
      Date.parse(discovery.completedAt)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "cleanup verification cannot predate discovery completion",
        path: ["cleanup", "verifiedAt"],
      });
    }
    if (discovery.catalog.toolCount < 1) {
      ctx.addIssue({
        code: "custom",
        message: "an admitted enrollment must retain at least one tool",
        path: ["catalog", "toolCount"],
      });
    }
    if (discovery.catalog.toolCount > discovery.limits.maxTools) {
      ctx.addIssue({
        code: "custom",
        message: "discovered tool count exceeds the retained discovery limit",
        path: ["catalog", "toolCount"],
      });
    }
    if (discovery.transcript.byteLength > discovery.limits.maxTranscriptBytes) {
      ctx.addIssue({
        code: "custom",
        message: "discovery transcript exceeds its retained byte limit",
        path: ["transcript", "byteLength"],
      });
    }
  });

export const mcpEnrollmentRecordV2AlphaSchema = z
  .object({
    format: z.literal(MCP_ENROLLMENT_RECORD_FORMAT),
    enrollmentId: identifierV2Schema,
    recordedAt: timestampV2Schema,
    enroller: componentIdentityV2Schema,
    target: z
      .object({
        identity: targetIdentityV2Schema,
        identityDigest: sha256V2Schema,
      })
      .strict(),
    source: z
      .object({
        acquiredAt: timestampV2Schema,
        evidenceReference: identifierV2Schema,
        provenance: mcpEnrollmentSourceV2AlphaSchema,
      })
      .strict(),
    preparedTree: mcpPreparedTreeSnapshotV2AlphaSchema,
    runtime: enrolledNodeRuntimeV2AlphaSchema,
    sandbox: enrolledSandboxBoundaryV2AlphaSchema,
    discovery: mcpEnrollmentDiscoveryV2AlphaSchema,
    eligibility: z
      .object({
        status: z.literal("eligible_for_manual_review"),
        executionClass: z.literal("enrolled_node_stdio_single_call"),
        assessedAt: timestampV2Schema,
        requiredApprovalClass: approvalClassV2Schema,
        rejectionReasonCodes: z.array(identifierV2Schema).length(0),
      })
      .strict(),
    authority: z
      .object({
        recordAuthorizesEnrollment: z.literal(false),
        recordAuthorizesExecution: z.literal(false),
        recordGrantsApproval: z.literal(false),
        serializedRecordIsBearerAuthority: z.literal(false),
        serializedCapabilityExists: z.literal(false),
        requiresManualExactCallReview: z.literal(true),
      })
      .strict(),
    limitations: z.array(descriptionV2Schema).min(1).max(16),
  })
  .strict()
  .superRefine((record, ctx) => {
    const issue = (message: string, path: PropertyKey[]) =>
      ctx.addIssue({ code: "custom", message, path });
    if (
      record.source.provenance.sourceArtifactSha256 !==
      record.target.identity.sourceArtifact.sha256
    ) {
      issue("source provenance must bind the target source artifact", [
        "source",
        "provenance",
        "sourceArtifactSha256",
      ]);
    }
    if (
      record.preparedTree.runtimeSnapshotArtifactSha256 !==
      record.target.identity.runtimeSnapshot.sha256
    ) {
      issue("prepared tree must bind the target runtime-snapshot artifact", [
        "preparedTree",
        "runtimeSnapshotArtifactSha256",
      ]);
    }
    if (
      record.runtime.runtimeDescriptorDigest !==
      record.target.identity.runtimeDescriptorDigest
    ) {
      issue("normalized runtime must bind the target runtime descriptor", [
        "runtime",
        "runtimeDescriptorDigest",
      ]);
    }
    if (
      APPROVAL_CLASS_RANK[record.eligibility.requiredApprovalClass] <
      APPROVAL_CLASS_RANK.operator_review
    ) {
      issue("enrolled execution requires at least operator review", [
        "eligibility",
        "requiredApprovalClass",
      ]);
    }
    const acquiredAt = Date.parse(record.source.acquiredAt);
    const capturedAt = Date.parse(record.preparedTree.capturedAt);
    const runtimeValidatedAt = Date.parse(record.runtime.validatedAt);
    const sandboxVerifiedAt = Date.parse(record.sandbox.verifiedAt);
    const discoveryStartedAt = Date.parse(record.discovery.startedAt);
    const cleanupVerifiedAt = Date.parse(record.discovery.cleanup.verifiedAt);
    const eligibilityAssessedAt = Date.parse(record.eligibility.assessedAt);
    const recordedAt = Date.parse(record.recordedAt);
    if (capturedAt < acquiredAt) {
      issue("prepared-tree capture cannot predate acquisition", [
        "preparedTree",
        "capturedAt",
      ]);
    }
    if (runtimeValidatedAt < capturedAt) {
      issue("runtime validation cannot predate prepared-tree capture", [
        "runtime",
        "validatedAt",
      ]);
    }
    if (
      discoveryStartedAt < runtimeValidatedAt ||
      discoveryStartedAt < sandboxVerifiedAt
    ) {
      issue("discovery cannot predate runtime and sandbox verification", [
        "discovery",
        "startedAt",
      ]);
    }
    if (eligibilityAssessedAt < cleanupVerifiedAt) {
      issue("eligibility assessment cannot predate verified cleanup", [
        "eligibility",
        "assessedAt",
      ]);
    }
    if (recordedAt < eligibilityAssessedAt) {
      issue("enrollment record cannot predate eligibility assessment", [
        "recordedAt",
      ]);
    }
  });

export const mcpEnrollmentRejectionStageV2AlphaSchema = z.enum([
  "configuration",
  "acquisition",
  "prepared_tree_snapshot",
  "runtime_validation",
  "sandbox_image_validation",
  "discovery_startup",
  "catalog_validation",
  "discovery_cleanup",
  "eligibility",
]);

export const mcpEnrollmentRejectionReasonV2AlphaSchema = z.enum([
  "invalid_target_config",
  "unsupported_source",
  "npm_version_not_exact",
  "acquisition_failed",
  "lifecycle_scripts_not_disabled",
  "prepared_tree_incomplete",
  "prepared_tree_limit_exceeded",
  "prepared_tree_identity_mismatch",
  "unsupported_runtime",
  "unsafe_node_invocation",
  "sandbox_image_mismatch",
  "sandbox_profile_mismatch",
  "discovery_failed",
  "catalog_incomplete",
  "catalog_multi_page",
  "catalog_changed",
  "catalog_limit_exceeded",
  "no_tools",
  "input_schema_unsupported",
  "cleanup_unverified",
  "no_safe_single_call_candidate",
]);

const rejectionReasonStage = {
  invalid_target_config: "configuration",
  unsupported_source: "configuration",
  npm_version_not_exact: "configuration",
  acquisition_failed: "acquisition",
  lifecycle_scripts_not_disabled: "acquisition",
  prepared_tree_incomplete: "prepared_tree_snapshot",
  prepared_tree_limit_exceeded: "prepared_tree_snapshot",
  prepared_tree_identity_mismatch: "prepared_tree_snapshot",
  unsupported_runtime: "runtime_validation",
  unsafe_node_invocation: "runtime_validation",
  sandbox_image_mismatch: "sandbox_image_validation",
  sandbox_profile_mismatch: "sandbox_image_validation",
  discovery_failed: "discovery_startup",
  catalog_incomplete: "catalog_validation",
  catalog_multi_page: "catalog_validation",
  catalog_changed: "catalog_validation",
  catalog_limit_exceeded: "catalog_validation",
  no_tools: "catalog_validation",
  input_schema_unsupported: "eligibility",
  cleanup_unverified: "discovery_cleanup",
  no_safe_single_call_candidate: "eligibility",
} as const;

const rejectionCleanupV2AlphaSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("not_started"),
      evidenceReferences: z.array(identifierV2Schema).length(0),
      limitations: z.array(descriptionV2Schema).length(0),
    })
    .strict(),
  z
    .object({
      status: z.literal("verified_absent"),
      evidenceReferences: z.array(identifierV2Schema).min(1).max(8),
      verifiedAt: timestampV2Schema,
      limitations: z.array(descriptionV2Schema).length(0),
    })
    .strict(),
  z
    .object({
      status: z.literal("verification_failed"),
      evidenceReferences: z.array(identifierV2Schema).max(8),
      verifiedAt: timestampV2Schema,
      limitations: z.array(descriptionV2Schema).min(1).max(8),
    })
    .strict(),
]);

export const mcpEnrollmentRejectionV2AlphaSchema = z
  .object({
    format: z.literal(MCP_ENROLLMENT_REJECTION_FORMAT),
    rejectionId: identifierV2Schema,
    startedAt: timestampV2Schema,
    recordedAt: timestampV2Schema,
    candidate: z
      .object({
        targetId: identifierV2Schema.optional(),
        configSha256: sha256V2Schema.optional(),
        sourceKind: z.enum(["npm", "local_snapshot"]).optional(),
      })
      .strict(),
    stage: mcpEnrollmentRejectionStageV2AlphaSchema,
    reasonCodes: z
      .array(mcpEnrollmentRejectionReasonV2AlphaSchema)
      .min(1)
      .max(MCP_ENROLLMENT_LIMITS.maxRejectionReasons),
    evidenceReferences: z
      .array(identifierV2Schema)
      .max(MCP_ENROLLMENT_LIMITS.maxEvidenceReferences),
    cleanup: rejectionCleanupV2AlphaSchema,
    authority: z
      .object({
        recordAuthorizesEnrollment: z.literal(false),
        recordAuthorizesExecution: z.literal(false),
        recordAuthorizesRetry: z.literal(false),
        recordGrantsApproval: z.literal(false),
        serializedRecordIsBearerAuthority: z.literal(false),
      })
      .strict(),
    limitations: z.array(descriptionV2Schema).min(1).max(16),
  })
  .strict()
  .superRefine((rejection, ctx) => {
    addDuplicateIssues(
      rejection.reasonCodes,
      (reason) => reason,
      ctx,
      ["reasonCodes"],
      "enrollment rejection reason",
    );
    addDuplicateIssues(
      rejection.evidenceReferences,
      (reference) => reference,
      ctx,
      ["evidenceReferences"],
      "enrollment rejection evidence reference",
    );
    const reasonOrder = new Map(
      mcpEnrollmentRejectionReasonV2AlphaSchema.options.map((reason, index) => [
        reason,
        index,
      ]),
    );
    rejection.reasonCodes.forEach((reason, index) => {
      if (rejectionReasonStage[reason] !== rejection.stage) {
        ctx.addIssue({
          code: "custom",
          message: `reason '${reason}' does not belong to stage '${rejection.stage}'`,
          path: ["reasonCodes", index],
        });
      }
      const previous = rejection.reasonCodes[index - 1];
      if (
        previous !== undefined &&
        reasonOrder.get(previous)! >= reasonOrder.get(reason)!
      ) {
        ctx.addIssue({
          code: "custom",
          message: "reasonCodes must use canonical enum ordering",
          path: ["reasonCodes", index],
        });
      }
    });
    if (Date.parse(rejection.recordedAt) < Date.parse(rejection.startedAt)) {
      ctx.addIssue({
        code: "custom",
        message: "rejection record cannot predate enrollment start",
        path: ["recordedAt"],
      });
    }
    if (
      rejection.cleanup.status !== "not_started" &&
      Date.parse(rejection.cleanup.verifiedAt) >
        Date.parse(rejection.recordedAt)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "cleanup evidence cannot postdate the rejection record",
        path: ["cleanup", "verifiedAt"],
      });
    }
    if (
      [
        "discovery_startup",
        "catalog_validation",
        "discovery_cleanup",
        "eligibility",
      ].includes(rejection.stage) &&
      rejection.cleanup.status === "not_started"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "a post-startup rejection must retain cleanup evidence",
        path: ["cleanup", "status"],
      });
    }
    if (
      rejection.stage === "discovery_cleanup" &&
      rejection.cleanup.status !== "verification_failed"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "a cleanup-stage rejection must retain failed cleanup",
        path: ["cleanup", "status"],
      });
    }
  });

export const mcpEnrollmentReviewRecordV2AlphaSchema = z
  .object({
    format: z.literal(MCP_ENROLLMENT_REVIEW_FORMAT),
    reviewId: identifierV2Schema,
    enrollment: z
      .object({
        enrollmentId: identifierV2Schema,
        enrollmentDigest: sha256V2Schema,
        enrollmentRecordedAt: timestampV2Schema,
        targetIdentityDigest: sha256V2Schema,
        preparedTargetTreeSha256: sha256V2Schema,
        runtimeInvocationDigest: sha256V2Schema,
        catalog: catalogIdentityV2Schema,
        sandboxProfileDigest: sha256V2Schema,
        sandboxImageId: dockerImageIdV2Schema,
      })
      .strict(),
    exactCall: z
      .object({
        experimentPlanDigest: sha256V2Schema,
        policyDigest: sha256V2Schema,
        hypothesisDigest: sha256V2Schema,
        syntheticResourceManifestDigest: sha256V2Schema,
        planCompiledAt: timestampV2Schema,
        hypothesisCreatedAt: timestampV2Schema,
        policyExpiresAt: timestampV2Schema.optional(),
        caseId: identifierV2Schema,
        stepId: identifierV2Schema,
        toolName: toolNameV2Schema,
        argumentSha256: sha256V2Schema,
        sequence: z.literal(0),
        maxCalls: z.literal(1),
        maxRetries: z.literal(0),
        authorizesFollowup: z.literal(false),
      })
      .strict(),
    review: z
      .object({
        reviewerId: identifierV2Schema,
        method: z.literal("explicit_manual"),
        externallyAuthenticatedIdentity: z.literal(false),
        reviewedAt: timestampV2Schema,
        decision: z.literal("approved"),
        approvalClass: approvalClassV2Schema,
        requiredApprovalClass: approvalClassV2Schema,
        capabilityExpiresAt: timestampV2Schema,
      })
      .strict(),
    authority: z
      .object({
        recordAuthorizesEnrollment: z.literal(false),
        recordAuthorizesExecution: z.literal(false),
        recordGrantsApproval: z.literal(false),
        serializedRecordIsBearerAuthority: z.literal(false),
        serializedCapabilityExists: z.literal(false),
        requiredNextStep: z.literal(
          "consume_opaque_single_use_enrollment_review_capability",
        ),
      })
      .strict(),
    limitations: z.array(descriptionV2Schema).min(1).max(16),
  })
  .strict()
  .superRefine((record, ctx) => {
    const enrollmentRecordedAt = Date.parse(
      record.enrollment.enrollmentRecordedAt,
    );
    const planCompiledAt = Date.parse(record.exactCall.planCompiledAt);
    const hypothesisCreatedAt = Date.parse(
      record.exactCall.hypothesisCreatedAt,
    );
    const reviewedAt = Date.parse(record.review.reviewedAt);
    const capabilityExpiresAt = Date.parse(record.review.capabilityExpiresAt);
    if (planCompiledAt > enrollmentRecordedAt) {
      ctx.addIssue({
        code: "custom",
        message: "the exact-call plan cannot postdate the enrollment record",
        path: ["exactCall", "planCompiledAt"],
      });
    }
    if (
      hypothesisCreatedAt < planCompiledAt ||
      hypothesisCreatedAt < enrollmentRecordedAt
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "the hypothesis cannot predate its exact-call plan or enrollment record",
        path: ["exactCall", "hypothesisCreatedAt"],
      });
    }
    if (reviewedAt < hypothesisCreatedAt) {
      ctx.addIssue({
        code: "custom",
        message: "manual review cannot predate the exact call and hypothesis",
        path: ["review", "reviewedAt"],
      });
    }
    if (
      capabilityExpiresAt <= reviewedAt ||
      capabilityExpiresAt - reviewedAt > MCP_ENROLLMENT_REVIEW_MAX_LIFETIME_MS
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "review capability expiration must follow review by at most five minutes",
        path: ["review", "capabilityExpiresAt"],
      });
    }
    if (
      APPROVAL_CLASS_RANK[record.review.approvalClass] <
      APPROVAL_CLASS_RANK[record.review.requiredApprovalClass]
    ) {
      ctx.addIssue({
        code: "custom",
        message: "manual approval class is below the deterministic requirement",
        path: ["review", "approvalClass"],
      });
    }
    if (
      APPROVAL_CLASS_RANK[record.review.approvalClass] <
      APPROVAL_CLASS_RANK.operator_review
    ) {
      ctx.addIssue({
        code: "custom",
        message: "an explicit manual review requires at least operator_review",
        path: ["review", "approvalClass"],
      });
    }
    const policyExpiresAt = record.exactCall.policyExpiresAt;
    if (
      policyExpiresAt !== undefined &&
      (reviewedAt >= Date.parse(policyExpiresAt) ||
        capabilityExpiresAt > Date.parse(policyExpiresAt))
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "manual review and capability lifetime must remain inside the policy window",
        path: ["review", "capabilityExpiresAt"],
      });
    }
  });

export type McpEnrollmentSourceV2Alpha = z.infer<
  typeof mcpEnrollmentSourceV2AlphaSchema
>;
export type McpPreparedTreeSnapshotV2Alpha = z.infer<
  typeof mcpPreparedTreeSnapshotV2AlphaSchema
>;
export type NormalizedNodeInvocationV2Alpha = z.infer<
  typeof normalizedNodeInvocationV2AlphaSchema
>;
export type EnrolledNodeRuntimeV2Alpha = z.infer<
  typeof enrolledNodeRuntimeV2AlphaSchema
>;
export type EnrolledSandboxBoundaryV2Alpha = z.infer<
  typeof enrolledSandboxBoundaryV2AlphaSchema
>;
export type McpEnrollmentDiscoveryV2Alpha = z.infer<
  typeof mcpEnrollmentDiscoveryV2AlphaSchema
>;
export type McpEnrollmentRecordV2Alpha = z.infer<
  typeof mcpEnrollmentRecordV2AlphaSchema
>;
export type McpEnrollmentRejectionStageV2Alpha = z.infer<
  typeof mcpEnrollmentRejectionStageV2AlphaSchema
>;
export type McpEnrollmentRejectionReasonV2Alpha = z.infer<
  typeof mcpEnrollmentRejectionReasonV2AlphaSchema
>;
export type McpEnrollmentRejectionV2Alpha = z.infer<
  typeof mcpEnrollmentRejectionV2AlphaSchema
>;
export type McpEnrollmentReviewRecordV2Alpha = z.infer<
  typeof mcpEnrollmentReviewRecordV2AlphaSchema
>;
