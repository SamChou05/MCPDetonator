import { z } from "zod";

import {
  staticCapabilitySchema,
  staticEvidenceReferenceV1Schema,
} from "../static/contracts.js";
import { nodeSemanticReportSummaryV1Schema } from "../static/semantic-contracts.js";
import { mcpAdvertisedClaimsV1Schema } from "../mcp/interface-claims.js";
import {
  fingerprintMcpCatalog,
  MCP_CATALOG_HASH_ALGORITHM,
  MCP_CATALOG_LIMITS,
} from "../mcp/catalog.js";

const identifierSchema = z.string().min(1);
const timestampSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const dockerImageIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const artifactReferenceV1Schema = z
  .object({
    path: z.string().min(1),
    sha256: sha256Schema,
    mediaType: z.string().min(1),
  })
  .strict();

const targetProvenanceSourceV1Schema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(["local", "fixture"]),
      configuredPath: z.string().min(1),
      sourceTreeSha256: sha256Schema,
      sourceFileCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("npm"),
      package: z.string().min(1),
      requestedVersion: z.string().min(1),
      resolvedVersion: z.string().min(1),
      packageTreeSha256: sha256Schema,
      packageFileCount: z.number().int().nonnegative(),
      resolved: z.string().min(1).optional(),
      integrity: z.string().min(1).optional(),
    })
    .strict(),
]);

export const targetProvenanceV1Schema = z
  .object({
    schema: z.literal("forge.target-provenance/v1"),
    runId: identifierSchema,
    targetId: identifierSchema,
    preparedAt: timestampSchema,
    containerRoot: z.literal("/opt/target"),
    containerPackageRoot: z.string().startsWith("/opt/target"),
    source: targetProvenanceSourceV1Schema,
    install: z
      .object({
        strategy: z.enum(["none", "npm-install", "npm-ci"]),
        lifecycleScripts: z.literal("disabled"),
      })
      .strict(),
    packageManifestSha256: sha256Schema.optional(),
    packageLockSha256: sha256Schema.optional(),
    runtimeSnapshot: z
      .object({
        sourceExperimentId: z.string().min(1),
        lifecycleScripts: z.enum(["disabled", "enabled"]),
        treeSha256: sha256Schema,
        fileCount: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    limitations: z.array(z.string().min(1)),
  })
  .strict();

export const sandboxProfileManifestV1Schema = z
  .object({
    schema: z.literal("forge.sandbox-profile/v1"),
    profile: z.literal("developer-v1"),
    experimentId: identifierSchema,
    createdAt: timestampSchema,
    roots: z
      .object({
        home: z.literal("/sandbox/home/forge"),
        workspace: z.literal("/sandbox/workspace"),
      })
      .strict(),
    canaries: z.array(
      z
        .object({
          id: identifierSchema,
          path: z.string().startsWith("/"),
          sha256: sha256Schema,
        })
        .strict(),
    ),
    fixtures: z.array(
      z
        .object({
          path: z.string().startsWith("/"),
          sha256: sha256Schema,
        })
        .strict(),
    ),
  })
  .strict();

export const mcpMessageV1Schema = z
  .object({
    schema: z.literal("forge.mcp-message/v1"),
    runId: identifierSchema,
    experimentId: identifierSchema,
    sequence: z.number().int().nonnegative(),
    timestamp: timestampSchema,
    direction: z.enum(["client_to_server", "server_to_client"]),
    message: z.json(),
  })
  .strict();

export const mcpInterfaceV1Schema = z
  .object({
    schema: z.literal("forge.mcp-interface/v1"),
    runId: identifierSchema,
    experimentId: identifierSchema,
    server: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
      })
      .strict(),
    tools: z.array(
      z
        .object({
          name: z.string().min(1),
          title: z.string().min(1).optional(),
          description: z.string().optional(),
          inputSchema: z.json(),
          annotations: z.json().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const runManifestV1Schema = z
  .object({
    schema: z.literal("forge.run/v1"),
    runId: identifierSchema,
    targetId: identifierSchema,
    configSha256: sha256Schema,
    status: z.enum(["running", "completed", "failed", "timed_out"]),
    createdAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    sandboxPolicy: z
      .object({
        profile: z.string().min(1),
        network: z.literal("blocked"),
        timeoutMs: z.number().int().positive(),
      })
      .strict(),
    toolchain: z
      .object({
        forgeVersion: z.string().min(1),
        nodeVersion: z.string().min(1),
        dockerVersion: z.string().min(1).optional(),
        straceVersion: z.string().min(1).optional(),
        observerImageReference: z.string().min(1),
        observerImageId: dockerImageIdSchema,
      })
      .strict(),
    limitations: z.array(z.string().min(1)),
    artifacts: z.array(artifactReferenceV1Schema),
  })
  .strict();

export const phaseV1Schema = z
  .object({
    schema: z.literal("forge.phase/v1"),
    phaseId: identifierSchema,
    runId: identifierSchema,
    experimentId: identifierSchema,
    kind: z.enum([
      "acquisition",
      "install",
      "initialization",
      "tool",
      "workflow",
      "cooldown",
    ]),
    stage: z
      .enum([
        "handshake",
        "tool_discovery",
        "tool_invocation",
        "observation_window",
      ])
      .optional(),
    name: z.string().min(1),
    toolName: z.string().min(1).optional(),
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    status: z.enum(["completed", "failed", "timed_out"]),
  })
  .strict()
  .refine((phase) => Date.parse(phase.endedAt) >= Date.parse(phase.startedAt), {
    message: "endedAt must not precede startedAt",
    path: ["endedAt"],
  });

const succeededOutcomeSchema = z.object({ status: z.literal("succeeded") }).strict();
const failedOutcomeSchema = z
  .object({
    status: z.literal("failed"),
    errno: z.string().min(1),
  })
  .strict();
const outcomeSchema = z.discriminatedUnion("status", [
  succeededOutcomeSchema,
  failedOutcomeSchema,
]);

const processStartEffectSchema = z
  .object({
    kind: z.literal("process.start"),
    pid: z.number().int().positive(),
    parentProcessRef: identifierSchema.optional(),
  })
  .strict();

const processExecEffectSchema = z
  .object({
    kind: z.literal("process.exec"),
    executable: z.string().min(1),
    args: z.array(z.string()),
    outcome: outcomeSchema,
  })
  .strict();

const processExitEffectSchema = z
  .object({
    kind: z.literal("process.exit"),
    exitCode: z.number().int().optional(),
    signal: z.string().min(1).optional(),
  })
  .strict()
  .refine((effect) => effect.exitCode !== undefined || effect.signal !== undefined, {
    message: "process.exit requires an exitCode or signal",
  });

const fileEffectSchema = z
  .object({
    kind: z.enum(["file.open", "file.read", "file.write", "file.delete"]),
    path: z.string().startsWith("/"),
    bytes: z.number().int().nonnegative().optional(),
    outcome: outcomeSchema,
  })
  .strict();

const networkEffectSchema = z
  .object({
    kind: z.enum(["network.connect_attempt", "network.listen"]),
    protocol: z.enum(["tcp", "udp", "unix", "unknown"]),
    address: z.string().min(1),
    port: z.number().int().min(1).max(65_535).optional(),
    outcome: outcomeSchema,
  })
  .strict();

const observedEffectKindSchema = z.enum([
  "process.start",
  "process.exec",
  "process.exit",
  "file.open",
  "file.read",
  "file.write",
  "file.delete",
  "network.connect_attempt",
  "network.listen",
]);

const filesystemStateEntryKindSchema = z.enum([
  "directory",
  "file",
  "symlink",
]);

const filesystemStateChangeKindSchema = z.enum([
  "created",
  "modified",
  "deleted",
  "type_changed",
]);

const filesystemStateChangedAttributeSchema = z.enum([
  "mode",
  "size",
  "hash_status",
  "sha256",
  "symlink_target_status",
  "symlink_target",
]);

export const observedEffectV1Schema = z.union([
  processStartEffectSchema,
  processExecEffectSchema,
  processExitEffectSchema,
  fileEffectSchema,
  networkEffectSchema,
]);

export const observedEventV1Schema = z
  .object({
    schema: z.literal("forge.event/v1"),
    eventId: identifierSchema,
    runId: identifierSchema,
    experimentId: identifierSchema,
    sequence: z.number().int().nonnegative(),
    timestamp: timestampSchema,
    processRef: identifierSchema,
    effect: observedEffectV1Schema,
    source: z
      .object({
        collector: z.enum(["strace", "forge"]),
        rawRef: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const attributionV1Schema = z
  .object({
    schema: z.literal("forge.attribution/v1"),
    attributionId: identifierSchema,
    runId: identifierSchema,
    eventId: identifierSchema,
    activePhaseId: identifierSchema.optional(),
    processOriginPhaseId: identifierSchema.optional(),
    confidence: z.enum(["high", "medium", "low", "unattributed"]),
    reasons: z.array(z.string().min(1)),
  })
  .strict();

export const findingV1Schema = z
  .object({
    schema: z.literal("forge.finding/v1"),
    findingId: identifierSchema,
    runId: identifierSchema,
    ruleId: identifierSchema,
    title: z.string().min(1),
    summary: z.string().min(1),
    severity: z.enum(["info", "low", "medium", "high"]),
    confidence: z.enum(["high", "medium", "low"]),
    eventIds: z.array(identifierSchema).min(1),
    attributionIds: z.array(identifierSchema),
    limitations: z.array(z.string().min(1)),
  })
  .strict();

export const advertisedInterfaceSummaryV1Schema = z
  .object({
    selection: z.literal("first_observed_interface"),
    catalogHashAlgorithm: z.literal(MCP_CATALOG_HASH_ALGORITHM),
    catalogLimits: z
      .object({
        maxTools: z.literal(MCP_CATALOG_LIMITS.maxTools),
        maxJsonDepth: z.literal(MCP_CATALOG_LIMITS.maxJsonDepth),
        maxJsonNodes: z.literal(MCP_CATALOG_LIMITS.maxJsonNodes),
        maxObjectKeys: z.literal(MCP_CATALOG_LIMITS.maxObjectKeys),
        maxTotalStringCharacters: z.literal(
          MCP_CATALOG_LIMITS.maxTotalStringCharacters,
        ),
      })
      .strict(),
    sourceCatalogSha256: sha256Schema.optional(),
    sourceOrderedCatalogSha256: sha256Schema.optional(),
    sourceExperimentId: identifierSchema.optional(),
    catalogConsistency: z.enum([
      "not_observed",
      "consistent",
      "drift_detected",
    ]),
    comparedExperimentIds: z.array(identifierSchema),
    catalogFingerprints: z.array(
      z
        .object({
          experimentId: identifierSchema,
          sha256: sha256Schema,
          orderedSha256: sha256Schema,
        })
        .strict(),
    ),
    differingExperimentIds: z.array(identifierSchema),
    duplicateToolNames: z.array(
      z
        .object({
          experimentId: identifierSchema,
          names: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ),
    limitations: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((summary, context) => {
    const compared = new Set(summary.comparedExperimentIds);
    if (compared.size !== summary.comparedExperimentIds.length) {
      context.addIssue({
        code: "custom",
        message: "compared experiment IDs must be unique",
        path: ["comparedExperimentIds"],
      });
    }
    const differing = new Set(summary.differingExperimentIds);
    if (differing.size !== summary.differingExperimentIds.length) {
      context.addIssue({
        code: "custom",
        message: "differing experiment IDs must be unique",
        path: ["differingExperimentIds"],
      });
    }
    if (
      summary.differingExperimentIds.some(
        (experimentId) => !compared.has(experimentId),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "differing experiment IDs must also be compared",
        path: ["differingExperimentIds"],
      });
    }
    const fingerprintIds = summary.catalogFingerprints.map(
      (fingerprint) => fingerprint.experimentId,
    );
    if (
      duplicateStrings(fingerprintIds) ||
      !sameStringSet(fingerprintIds, summary.comparedExperimentIds)
    ) {
      context.addIssue({
        code: "custom",
        message: "catalog fingerprints must exactly cover compared experiments",
        path: ["catalogFingerprints"],
      });
    }
    const duplicateExperiments = summary.duplicateToolNames.map(
      (entry) => entry.experimentId,
    );
    if (duplicateStrings(duplicateExperiments)) {
      context.addIssue({
        code: "custom",
        message: "duplicate-tool records must be unique per experiment",
        path: ["duplicateToolNames"],
      });
    }
    for (const [index, entry] of summary.duplicateToolNames.entries()) {
      if (!compared.has(entry.experimentId)) {
        context.addIssue({
          code: "custom",
          message: "duplicate-tool records must refer to compared experiments",
          path: ["duplicateToolNames", index, "experimentId"],
        });
      }
      if (duplicateStrings(entry.names)) {
        context.addIssue({
          code: "custom",
          message: "duplicate tool names must themselves be unique",
          path: ["duplicateToolNames", index, "names"],
        });
      }
    }
    if (summary.catalogConsistency === "not_observed") {
      if (
        summary.sourceExperimentId !== undefined ||
        summary.sourceCatalogSha256 !== undefined ||
        summary.sourceOrderedCatalogSha256 !== undefined ||
        summary.comparedExperimentIds.length !== 0 ||
        summary.catalogFingerprints.length !== 0 ||
        summary.differingExperimentIds.length !== 0 ||
        summary.duplicateToolNames.length !== 0
      ) {
        context.addIssue({
          code: "custom",
          message: "an unobserved interface summary cannot contain catalog evidence",
        });
      }
      return;
    }
    if (
      summary.sourceExperimentId === undefined ||
      summary.sourceCatalogSha256 === undefined ||
      summary.sourceOrderedCatalogSha256 === undefined ||
      !compared.has(summary.sourceExperimentId)
    ) {
      context.addIssue({
        code: "custom",
        message: "an observed interface summary requires a fingerprinted compared source experiment",
        path: ["sourceExperimentId"],
      });
    }
    const sourceFingerprint = summary.catalogFingerprints.find(
      (fingerprint) =>
        fingerprint.experimentId === summary.sourceExperimentId,
    );
    if (
      sourceFingerprint === undefined ||
      sourceFingerprint.sha256 !== summary.sourceCatalogSha256 ||
      sourceFingerprint.orderedSha256 !==
        summary.sourceOrderedCatalogSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "source catalog digest must match its experiment fingerprint",
        path: ["sourceCatalogSha256"],
      });
    }
    if (
      sourceFingerprint !== undefined &&
      !sameStringSet(
        summary.differingExperimentIds,
        summary.catalogFingerprints
          .filter(
            (fingerprint) => fingerprint.sha256 !== sourceFingerprint.sha256,
          )
          .map((fingerprint) => fingerprint.experimentId),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "differing experiment IDs must exactly reflect catalog fingerprints",
        path: ["differingExperimentIds"],
      });
    }
    if (
      summary.sourceExperimentId !== undefined &&
      differing.has(summary.sourceExperimentId)
    ) {
      context.addIssue({
        code: "custom",
        message: "the source experiment cannot differ from itself",
        path: ["differingExperimentIds"],
      });
    }
    if (
      summary.catalogConsistency === "consistent" &&
      summary.differingExperimentIds.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: "a consistent catalog cannot list differing experiments",
        path: ["differingExperimentIds"],
      });
    }
    if (
      summary.catalogConsistency === "drift_detected" &&
      summary.differingExperimentIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "catalog drift requires at least one differing experiment",
        path: ["differingExperimentIds"],
      });
    }
  });

const comparedBehaviorCapabilitySchema = z.enum([
  "filesystem_access",
  "network_access",
  "process_execution",
]);

const advertisedClaimReferenceV1Schema = z
  .object({
    evidenceId: identifierSchema,
    fieldReference: z.string().startsWith("/"),
  })
  .strict();

function duplicateStrings(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

export const behaviorComparisonRowV1Schema = z
  .object({
    capability: comparedBehaviorCapabilitySchema,
    advertisedState: z.enum([
      "claimed",
      "not_claimed",
      "not_observed",
      "not_applicable",
    ]),
    advertisedClaimReferences: z.array(advertisedClaimReferenceV1Schema),
    staticState: z.enum(["found", "not_found"]),
    staticSignalIds: z.array(identifierSchema),
    runtimeState: z.enum(["observed", "not_observed"]),
    runtimeEventIds: z.array(identifierSchema),
    correlationBasis: z.literal(
      "phase_timing_and_process_origin_inference",
    ),
    temporalOverlapEventIds: z.array(identifierSchema),
    operatorScopeState: z.enum(["configured", "not_configured"]),
    withinOperatorScopeEventIds: z.array(identifierSchema),
    outsideOperatorScopeEventIds: z.array(identifierSchema),
    unclassifiedRuntimeEventIds: z.array(identifierSchema),
    interpretation: z.string().min(1),
  })
  .strict()
  .superRefine((row, context) => {
    const identifierArrays = [
      ["staticSignalIds", row.staticSignalIds],
      ["runtimeEventIds", row.runtimeEventIds],
      ["temporalOverlapEventIds", row.temporalOverlapEventIds],
      ["withinOperatorScopeEventIds", row.withinOperatorScopeEventIds],
      ["outsideOperatorScopeEventIds", row.outsideOperatorScopeEventIds],
      ["unclassifiedRuntimeEventIds", row.unclassifiedRuntimeEventIds],
    ] as const;
    for (const [field, values] of identifierArrays) {
      if (duplicateStrings(values)) {
        context.addIssue({
          code: "custom",
          message: `${field} must contain unique identifiers`,
          path: [field],
        });
      }
    }
    const claimKeys = row.advertisedClaimReferences.map(
      (reference) => `${reference.evidenceId}\0${reference.fieldReference}`,
    );
    if (duplicateStrings(claimKeys)) {
      context.addIssue({
        code: "custom",
        message: "advertised claim references must be unique",
        path: ["advertisedClaimReferences"],
      });
    }
    if (
      (row.advertisedState === "claimed") !==
      (row.advertisedClaimReferences.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "claimed state must exactly reflect advertised claim references",
        path: ["advertisedState"],
      });
    }
    if ((row.staticState === "found") !== (row.staticSignalIds.length > 0)) {
      context.addIssue({
        code: "custom",
        message: "static state must exactly reflect static signal IDs",
        path: ["staticState"],
      });
    }
    if (
      (row.runtimeState === "observed") !== (row.runtimeEventIds.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "runtime state must exactly reflect runtime event IDs",
        path: ["runtimeState"],
      });
    }

    const runtimeIds = new Set(row.runtimeEventIds);
    if (row.temporalOverlapEventIds.some((eventId) => !runtimeIds.has(eventId))) {
      context.addIssue({
        code: "custom",
        message: "temporal-overlap IDs must be selected runtime event IDs",
        path: ["temporalOverlapEventIds"],
      });
    }
    const partitions = [
      row.withinOperatorScopeEventIds,
      row.outsideOperatorScopeEventIds,
      row.unclassifiedRuntimeEventIds,
    ];
    const partitionIds = partitions.flat();
    if (duplicateStrings(partitionIds)) {
      context.addIssue({
        code: "custom",
        message: "operator-scope event partitions must be disjoint",
        path: ["withinOperatorScopeEventIds"],
      });
    }
    const partitionSet = new Set(partitionIds);
    if (
      partitionSet.size !== runtimeIds.size ||
      [...runtimeIds].some((eventId) => !partitionSet.has(eventId))
    ) {
      context.addIssue({
        code: "custom",
        message: "operator-scope partitions must exactly cover runtime event IDs",
        path: ["runtimeEventIds"],
      });
    }
    if (
      row.operatorScopeState === "configured" &&
      row.unclassifiedRuntimeEventIds.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: "configured scope cannot contain unclassified runtime events",
        path: ["unclassifiedRuntimeEventIds"],
      });
    }
    if (
      row.operatorScopeState === "not_configured" &&
      (row.withinOperatorScopeEventIds.length !== 0 ||
        row.outsideOperatorScopeEventIds.length !== 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "unconfigured scope cannot classify runtime events as inside or outside",
        path: ["operatorScopeState"],
      });
    }
  });

export const behaviorComparisonScopeV1Schema = z
  .object({
    experimentId: identifierSchema,
    kind: z.enum(["initialization", "tool"]),
    toolName: z.string().min(1).optional(),
    rows: z.array(behaviorComparisonRowV1Schema),
  })
  .strict()
  .superRefine((scope, context) => {
    const capabilities = scope.rows.map((row) => row.capability);
    const requiredCapabilities = comparedBehaviorCapabilitySchema.options;
    if (
      duplicateStrings(capabilities) ||
      capabilities.length !== requiredCapabilities.length ||
      requiredCapabilities.some(
        (capability) => !capabilities.includes(capability),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "each behavior scope requires one row for every compared capability",
        path: ["rows"],
      });
    }
    if (scope.kind === "initialization") {
      if (scope.toolName !== undefined) {
        context.addIssue({
          code: "custom",
          message: "initialization scope cannot name a tool",
          path: ["toolName"],
        });
      }
      if (scope.rows.some((row) => row.advertisedState !== "not_applicable")) {
        context.addIssue({
          code: "custom",
          message: "initialization rows have no applicable tool advertisement",
          path: ["rows"],
        });
      }
    } else {
      if (scope.toolName === undefined) {
        context.addIssue({
          code: "custom",
          message: "tool scope requires a tool name",
          path: ["toolName"],
        });
      }
      if (scope.rows.some((row) => row.advertisedState === "not_applicable")) {
        context.addIssue({
          code: "custom",
          message: "tool rows require claimed, not-claimed, or not-observed advertisement state",
          path: ["rows"],
        });
      }
    }
  });

export const behaviorComparisonV1Schema = z
  .object({
    scopes: z.array(behaviorComparisonScopeV1Schema),
    limitations: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((comparison, context) => {
    if (
      duplicateStrings(
        comparison.scopes.map((scope) => scope.experimentId),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "behavior comparison experiment IDs must be unique",
        path: ["scopes"],
      });
    }
  });

const staticRuntimeComparisonV1Schema = z
  .object({
    scope: z.string().min(1),
    rows: z.array(
      z
        .object({
          capability: staticCapabilitySchema,
          staticSignal: z.enum(["found", "not_found"]),
          runtimeObservation: z.enum([
            "observed",
            "not_observed",
            "not_comparable",
          ]),
          staticSignalIds: z.array(identifierSchema),
          runtimeEventIds: z.array(identifierSchema),
          interpretation: z.string().min(1),
        })
        .strict(),
    ),
    limitations: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((comparison, context) => {
    const capabilities = comparison.rows.map((row) => row.capability);
    const requiredCapabilities = staticCapabilitySchema.options;
    if (
      duplicateStrings(capabilities) ||
      capabilities.length !== requiredCapabilities.length ||
      requiredCapabilities.some(
        (capability) => !capabilities.includes(capability),
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "static/runtime comparison requires one row for every static capability",
        path: ["rows"],
      });
    }

    const globallySeenStaticIds = new Set<string>();
    const globallySeenRuntimeIds = new Set<string>();
    const comparableCapabilities = new Set<string>(
      comparedBehaviorCapabilitySchema.options,
    );
    for (const [rowIndex, row] of comparison.rows.entries()) {
      if (duplicateStrings(row.staticSignalIds)) {
        context.addIssue({
          code: "custom",
          message: "static signal IDs must be unique within a comparison row",
          path: ["rows", rowIndex, "staticSignalIds"],
        });
      }
      if (duplicateStrings(row.runtimeEventIds)) {
        context.addIssue({
          code: "custom",
          message: "runtime event IDs must be unique within a comparison row",
          path: ["rows", rowIndex, "runtimeEventIds"],
        });
      }
      for (const signalId of row.staticSignalIds) {
        if (globallySeenStaticIds.has(signalId)) {
          context.addIssue({
            code: "custom",
            message:
              "a static signal ID cannot belong to multiple capability rows",
            path: ["rows", rowIndex, "staticSignalIds"],
          });
        }
        globallySeenStaticIds.add(signalId);
      }
      for (const eventId of row.runtimeEventIds) {
        if (globallySeenRuntimeIds.has(eventId)) {
          context.addIssue({
            code: "custom",
            message:
              "a runtime event ID cannot belong to multiple capability rows",
            path: ["rows", rowIndex, "runtimeEventIds"],
          });
        }
        globallySeenRuntimeIds.add(eventId);
      }

      if (
        (row.staticSignal === "found") !== (row.staticSignalIds.length > 0)
      ) {
        context.addIssue({
          code: "custom",
          message: "static signal state must exactly reflect static signal IDs",
          path: ["rows", rowIndex, "staticSignal"],
        });
      }
      if (comparableCapabilities.has(row.capability)) {
        if (
          row.runtimeObservation === "not_comparable" ||
          ((row.runtimeObservation === "observed") !==
            (row.runtimeEventIds.length > 0))
        ) {
          context.addIssue({
            code: "custom",
            message:
              "comparable runtime state must exactly reflect runtime event IDs",
            path: ["rows", rowIndex, "runtimeObservation"],
          });
        }
      } else if (
        row.runtimeObservation !== "not_comparable" ||
        row.runtimeEventIds.length !== 0
      ) {
        context.addIssue({
          code: "custom",
          message:
            "unsupported runtime capabilities must be not_comparable without event IDs",
          path: ["rows", rowIndex, "runtimeObservation"],
        });
      }
    }
  });

export const reportV1Schema = z
  .object({
    schema: z.literal("forge.report/v1"),
    runId: identifierSchema,
    targetId: identifierSchema,
    generatedAt: timestampSchema,
    summary: z.string().min(1),
    artifactProvenance: targetProvenanceV1Schema,
    sandboxPolicy: z
      .object({
        profile: z.string().min(1),
        network: z.literal("blocked"),
      })
      .strict(),
    advertisedServer: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
      })
      .strict(),
    advertisedTools: z.array(
      z
        .object({
          name: z.string().min(1),
          title: z.string().min(1).optional(),
          description: z.string().optional(),
          inputSchema: z.json(),
          annotations: z.json().optional(),
        })
      .strict(),
    ),
    advertisedInterfaceSummary: advertisedInterfaceSummaryV1Schema,
    advertisedClaims: mcpAdvertisedClaimsV1Schema,
    staticAnalysis: z
      .object({
        snapshot: z
          .object({
            basis: z.literal("selected-runtime-snapshot"),
            sourceExperimentId: identifierSchema,
            lifecycleScripts: z.enum(["disabled", "enabled"]),
            treeSha256: sha256Schema,
            fileCount: z.number().int().nonnegative(),
          })
          .strict(),
        manifest: z
          .object({
            status: z.enum(["parsed", "invalid", "unreadable", "missing"]),
            name: z.string().min(1).optional(),
            version: z.string().min(1).optional(),
            error: z.string().min(1).optional(),
            evidence: staticEvidenceReferenceV1Schema.optional(),
          })
          .strict(),
        installLifecycleScripts: z.array(
          z
            .object({
              name: z.string().min(1),
              command: z.string(),
              evidence: staticEvidenceReferenceV1Schema,
            })
            .strict(),
        ),
        dependencyCounts: z
          .object({
            runtime: z.number().int().nonnegative(),
            development: z.number().int().nonnegative(),
            optional: z.number().int().nonnegative(),
            peer: z.number().int().nonnegative(),
          })
          .strict(),
        lockfiles: z.array(
          z
            .object({
              path: z.string().min(1),
              format: z.string().min(1),
              sha256: sha256Schema.optional(),
              evidence: staticEvidenceReferenceV1Schema.optional(),
            })
            .strict(),
        ),
        capabilitySignals: z.array(
          z
            .object({
              capability: staticCapabilitySchema,
              count: z.number().int().positive(),
              signalIds: z.array(identifierSchema).min(1),
              evidence: z.array(staticEvidenceReferenceV1Schema).min(1),
            })
            .strict(),
        ),
        sourceCoverage: z
          .object({
            candidateFiles: z.number().int().nonnegative(),
            scannedFiles: z.number().int().nonnegative(),
            skippedFiles: z.number().int().nonnegative(),
          })
          .strict(),
        limitations: z.array(z.string().min(1)),
      })
      .strict(),
    semanticAnalysis: nodeSemanticReportSummaryV1Schema.optional(),
    staticRuntimeComparison: staticRuntimeComparisonV1Schema,
    behaviorComparison: behaviorComparisonV1Schema,
    experiments: z.array(
      z
        .object({
          experimentId: identifierSchema,
          kind: z.enum(["install", "initialization", "tool"]),
          toolName: z.string().min(1).optional(),
          lifecycleScripts: z.enum(["disabled", "enabled"]).optional(),
          status: z.enum(["completed", "failed", "timed_out"]).optional(),
          input: z.json().optional(),
          expected: z
            .object({
              fileReads: z.array(z.string().startsWith("/")),
              fileReadPrefixes: z.array(z.string().startsWith("/")),
              fileWrites: z.array(z.string().startsWith("/")),
              fileWritePrefixes: z.array(z.string().startsWith("/")),
              networkConnections: z.array(
                z
                  .object({
                    address: z.string().min(1),
                    port: z.number().int().min(1).max(65_535).optional(),
                  })
                  .strict(),
              ),
              childExecutables: z.array(z.string().startsWith("/")),
              childExecutablePrefixes: z.array(z.string().startsWith("/")),
            })
            .strict()
            .optional(),
          eventCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    runtimeObservations: z.array(
      z
        .object({
          experimentId: identifierSchema,
          kind: z.enum(["initialization", "tool"]),
          toolName: z.string().min(1).optional(),
          effectCounts: z.array(
            z
              .object({
                effectKind: observedEffectKindSchema,
                count: z.number().int().positive(),
              })
              .strict(),
          ),
          phaseBreakdown: z
            .array(
              z
                .object({
                  phaseId: identifierSchema,
                  name: z.string().min(1),
                  stage: z
                    .enum([
                      "handshake",
                      "tool_discovery",
                      "tool_invocation",
                      "observation_window",
                    ])
                    .optional(),
                  effectCounts: z.array(
                    z
                      .object({
                        effectKind: observedEffectKindSchema,
                        count: z.number().int().positive(),
                      })
                      .strict(),
                  ),
                })
                .strict(),
            )
            .optional(),
          expectedScopeMatches: z
            .object({
              eventCount: z.number().int().nonnegative(),
              examples: z.array(
                z
                  .object({
                    eventId: identifierSchema,
                    effect: observedEffectV1Schema,
                    attributionConfidence: z.enum([
                      "high",
                      "medium",
                      "low",
                      "unattributed",
                    ]),
                    rawRef: z.string().min(1),
                  })
                  .strict(),
              ),
              examplesTruncated: z.boolean(),
            })
            .strict()
            .optional(),
          filesystemStateDelta: z
            .object({
              scope: z.literal("isolated_experiment_window"),
              attribution: z.literal("experiment_only"),
              snapshotsComplete: z
                .object({
                  before: z.boolean(),
                  after: z.boolean(),
                })
                .strict(),
              changeCounts: z
                .object({
                  created: z.number().int().nonnegative(),
                  modified: z.number().int().nonnegative(),
                  deleted: z.number().int().nonnegative(),
                  typeChanged: z.number().int().nonnegative(),
                })
                .strict(),
              examples: z.array(
                z
                  .object({
                    change: filesystemStateChangeKindSchema,
                    path: z.string().startsWith("/"),
                    beforeKind: filesystemStateEntryKindSchema.optional(),
                    afterKind: filesystemStateEntryKindSchema.optional(),
                    changedAttributes: z
                      .array(filesystemStateChangedAttributeSchema)
                      .optional(),
                  })
                  .strict(),
              ),
              examplesTruncated: z.boolean(),
              artifactRefs: z
                .object({
                  before: z.string().min(1),
                  after: z.string().min(1),
                  delta: z.string().min(1),
                })
                .strict(),
              limitations: z.array(z.string().min(1)),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    installLifecycle: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("not_run"),
          reason: z.string().min(1),
          limitations: z.array(z.string().min(1)),
        })
        .strict(),
      z
        .object({
          status: z.literal("observed"),
          experiments: z.array(
            z
              .object({
                experimentId: identifierSchema,
                lifecycleScripts: z.enum(["disabled", "enabled"]),
                outcome: z.enum(["completed", "failed", "timed_out"]),
                eventCount: z.number().int().nonnegative(),
                metadata: z.string().min(1),
              })
              .strict(),
          ),
          comparisonStatus: z.enum(["complete", "inconclusive"]),
          delta: z
            .object({
              controlExperimentId: identifierSchema,
              treatmentExperimentId: identifierSchema,
              treatmentOnly: z
                .object({
                  processExec: z.array(identifierSchema),
                  fileRead: z.array(identifierSchema),
                  fileWrite: z.array(identifierSchema),
                  fileDelete: z.array(identifierSchema),
                  network: z.array(identifierSchema),
                })
                .strict(),
              controlOnly: z
                .object({
                  processExec: z.array(identifierSchema),
                  fileRead: z.array(identifierSchema),
                  fileWrite: z.array(identifierSchema),
                  fileDelete: z.array(identifierSchema),
                  network: z.array(identifierSchema),
                })
                .strict(),
            })
            .strict()
            .optional(),
          limitations: z.array(z.string().min(1)),
        })
        .strict(),
    ]),
    findings: z.array(findingV1Schema),
    evidence: z
      .object({
        manifest: z.string().min(1),
        events: z.string().min(1),
        phases: z.string().min(1),
        attributions: z.string().min(1),
        findings: z.string().min(1),
        targetProvenance: z.string().min(1),
        staticInspection: z.string().min(1),
        preInstallStaticInspection: z.string().min(1),
        semanticInspection: z.string().min(1).optional(),
        preInstallSemanticInspection: z.string().min(1).optional(),
        installDelta: z.string().min(1).optional(),
        filesystemStateRoot: z.string().min(1).optional(),
        advertisedClaims: z.string().min(1),
      })
      .strict(),
    limitations: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((report, context) => {
    const semanticFieldsPresent = [
      report.semanticAnalysis !== undefined,
      report.evidence.semanticInspection !== undefined,
      report.evidence.preInstallSemanticInspection !== undefined,
    ];
    if (
      semanticFieldsPresent.some(Boolean) &&
      !semanticFieldsPresent.every(Boolean)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "semantic report summary and selected/pre-install evidence paths must appear together",
        path: ["semanticAnalysis"],
      });
    }
    if (
      report.semanticAnalysis !== undefined &&
      report.evidence.semanticInspection !==
        report.semanticAnalysis.artifactPath
    ) {
      context.addIssue({
        code: "custom",
        message:
          "semantic report summary must identify the retained selected semantic artifact",
        path: ["semanticAnalysis", "artifactPath"],
      });
    }
    if (
      report.artifactProvenance.runId !== report.runId ||
      report.artifactProvenance.targetId !== report.targetId
    ) {
      context.addIssue({
        code: "custom",
        message: "artifact provenance must belong to the report run and target",
        path: ["artifactProvenance"],
      });
    }
    const runtimeSnapshot = report.artifactProvenance.runtimeSnapshot;
    if (runtimeSnapshot === undefined) {
      context.addIssue({
        code: "custom",
        message: "report provenance requires the selected runtime snapshot",
        path: ["artifactProvenance", "runtimeSnapshot"],
      });
    } else if (
      runtimeSnapshot.sourceExperimentId !==
        report.staticAnalysis.snapshot.sourceExperimentId ||
      runtimeSnapshot.lifecycleScripts !==
        report.staticAnalysis.snapshot.lifecycleScripts ||
      runtimeSnapshot.treeSha256 !== report.staticAnalysis.snapshot.treeSha256 ||
      runtimeSnapshot.fileCount !== report.staticAnalysis.snapshot.fileCount
    ) {
      context.addIssue({
        code: "custom",
        message:
          "static analysis snapshot must exactly match the selected runtime snapshot in provenance",
        path: ["staticAnalysis", "snapshot"],
      });
    }
    if (
      report.findings.some((finding) => finding.runId !== report.runId) ||
      duplicateStrings(report.findings.map((finding) => finding.findingId))
    ) {
      context.addIssue({
        code: "custom",
        message: "findings must have unique IDs and belong to the report run",
        path: ["findings"],
      });
    }
    if (report.advertisedClaims.runId !== report.runId) {
      context.addIssue({
        code: "custom",
        message: "advertised claims must belong to the report run",
        path: ["advertisedClaims", "runId"],
      });
    }
    const topLevelCatalog = fingerprintMcpCatalog(
      report.advertisedServer,
      report.advertisedTools,
    );
    if (
      report.advertisedInterfaceSummary.catalogConsistency === "not_observed"
    ) {
      if (
        report.advertisedTools.length !== 0 ||
        report.advertisedServer.name !== "unknown-server" ||
        report.advertisedServer.version !== "unknown-version"
      ) {
        context.addIssue({
          code: "custom",
          message: "an unobserved interface requires explicit unknown/empty top-level placeholders",
          path: ["advertisedTools"],
        });
      }
    } else if (
      !topLevelCatalog.complete ||
      topLevelCatalog.sha256 !==
        report.advertisedInterfaceSummary.sourceCatalogSha256 ||
      topLevelCatalog.orderedSha256 !==
        report.advertisedInterfaceSummary.sourceOrderedCatalogSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "top-level advertised server and tools must match the bounded source catalog fingerprint",
        path: ["advertisedTools"],
      });
    }

    const claimInterfacesByExperiment = new Map(
      report.advertisedClaims.interfaces.map((mcpInterface) => [
        mcpInterface.experimentId,
        mcpInterface,
      ]),
    );
    if (
      claimInterfacesByExperiment.size !==
      report.advertisedClaims.interfaces.length
    ) {
      context.addIssue({
        code: "custom",
        message: "advertised claim interfaces require unique experiment IDs",
        path: ["advertisedClaims", "interfaces"],
      });
    }
    const comparedInterfaceIds = new Set(
      report.advertisedInterfaceSummary.comparedExperimentIds,
    );
    if (
      comparedInterfaceIds.size !== claimInterfacesByExperiment.size ||
      [...claimInterfacesByExperiment.keys()].some(
        (experimentId) => !comparedInterfaceIds.has(experimentId),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "interface summary must cover exactly the advertised-claim interfaces",
        path: ["advertisedInterfaceSummary", "comparedExperimentIds"],
      });
    }
    const catalogFingerprintByExperiment = new Map(
      report.advertisedInterfaceSummary.catalogFingerprints.map(
        (fingerprint) => [fingerprint.experimentId, fingerprint],
      ),
    );
    for (const [experimentId, claimInterface] of
      claimInterfacesByExperiment.entries()) {
      if (
        catalogFingerprintByExperiment.get(experimentId)?.sha256 !==
          claimInterface.catalogSha256 ||
        catalogFingerprintByExperiment.get(experimentId)?.orderedSha256 !==
          claimInterface.orderedCatalogSha256
      ) {
        context.addIssue({
          code: "custom",
          message: "claim-interface catalog digest must match the advertised interface summary",
          path: ["advertisedClaims", "interfaces"],
        });
      }
    }
    const sourceExperimentId =
      report.advertisedInterfaceSummary.sourceExperimentId;
    if (
      report.advertisedInterfaceSummary.catalogConsistency !== "not_observed" &&
      sourceExperimentId !==
        report.advertisedClaims.interfaces[0]?.experimentId
    ) {
      context.addIssue({
        code: "custom",
        message:
          "first-observed interface selection must use the first advertised-claim interface",
        path: ["advertisedInterfaceSummary", "sourceExperimentId"],
      });
    }
    if (sourceExperimentId !== undefined) {
      const sourceClaims = claimInterfacesByExperiment.get(sourceExperimentId);
      if (
        sourceClaims === undefined ||
        sourceClaims.server.name !== report.advertisedServer.name ||
        sourceClaims.server.version !== report.advertisedServer.version ||
        sourceClaims.catalogSha256 !==
          report.advertisedInterfaceSummary.sourceCatalogSha256 ||
        sourceClaims.orderedCatalogSha256 !==
          report.advertisedInterfaceSummary.sourceOrderedCatalogSha256
      ) {
        context.addIssue({
          code: "custom",
          message: "top-level advertised catalog must match the selected source interface",
          path: ["advertisedServer"],
        });
      }
    }

    const claimEvidence = new Map<
      string,
      {
        readonly experimentId: string;
        readonly toolName: string;
        readonly capability:
          | "filesystem_access"
          | "network_access"
          | "process_execution";
      }
    >();
    for (const mcpInterface of report.advertisedClaims.interfaces) {
      for (const assessment of mcpInterface.capabilityAssessments) {
        for (const evidence of assessment.evidence) {
          const key = `${evidence.evidenceId}\0${evidence.pointer}`;
          if (claimEvidence.has(key)) {
            context.addIssue({
              code: "custom",
              message: "advertised claim evidence references must be globally unique",
              path: ["advertisedClaims", "interfaces"],
            });
          }
          claimEvidence.set(key, {
            experimentId: mcpInterface.experimentId,
            toolName: assessment.toolName,
            capability: assessment.capability,
          });
        }
      }
    }
    const staticSignals = new Map<
      string,
      (typeof comparedBehaviorCapabilitySchema.options)[number]
    >();
    const staticSignalIdsByCapability = new Map<
      (typeof comparedBehaviorCapabilitySchema.options)[number],
      string[]
    >();
    const summarizedStaticSignalIdsByCapability = new Map<string, string[]>();
    const summarizedStaticCapabilities = new Set<string>();
    const globallySeenStaticSignalIds = new Set<string>();
    for (const capability of report.staticAnalysis.capabilitySignals) {
      if (
        summarizedStaticCapabilities.has(capability.capability) ||
        capability.count !== capability.signalIds.length ||
        capability.count !== capability.evidence.length
      ) {
        context.addIssue({
          code: "custom",
          message: "static capability summaries require one unique row with aligned count, signal IDs, and evidence",
          path: ["staticAnalysis", "capabilitySignals"],
        });
      }
      summarizedStaticCapabilities.add(capability.capability);
      summarizedStaticSignalIdsByCapability.set(
        capability.capability,
        capability.signalIds,
      );
      for (const signalId of capability.signalIds) {
        if (globallySeenStaticSignalIds.has(signalId)) {
          context.addIssue({
            code: "custom",
            message: "static signal IDs must be globally unique",
            path: ["staticAnalysis", "capabilitySignals"],
          });
        }
        globallySeenStaticSignalIds.add(signalId);
      }
      if (
        !comparedBehaviorCapabilitySchema.options.some(
          (candidate) => candidate === capability.capability,
        )
      ) {
        continue;
      }
      for (const signalId of capability.signalIds) {
        staticSignals.set(
          signalId,
          capability.capability as (typeof comparedBehaviorCapabilitySchema.options)[number],
        );
        const comparedCapability =
          capability.capability as (typeof comparedBehaviorCapabilitySchema.options)[number];
        const ids = staticSignalIdsByCapability.get(comparedCapability) ?? [];
        ids.push(signalId);
        staticSignalIdsByCapability.set(comparedCapability, ids);
      }
    }
    for (const [rowIndex, row] of
      report.staticRuntimeComparison.rows.entries()) {
      if (
        !sameStringSet(
          row.staticSignalIds,
          summarizedStaticSignalIdsByCapability.get(row.capability) ?? [],
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "static/runtime rows must exactly cover the summarized static capability evidence",
          path: [
            "staticRuntimeComparison",
            "rows",
            rowIndex,
            "staticSignalIds",
          ],
        });
      }
    }
    // The legacy runtime aggregate intentionally includes initialization
    // activity from each tool run and excludes file.open, while the newer
    // behavior comparison is scoped to each configured invocation and includes
    // file.open. Their runtime ID sets therefore cannot be truthfully equated.
    for (const [scopeIndex, scope] of report.behaviorComparison.scopes.entries()) {
      for (const [rowIndex, row] of scope.rows.entries()) {
        const claimInterface = claimInterfacesByExperiment.get(
          scope.experimentId,
        );
        const matchingToolAssessments =
          scope.kind === "tool" && scope.toolName !== undefined
            ? (claimInterface?.capabilityAssessments.filter(
                (assessment) => assessment.toolName === scope.toolName,
              ) ?? [])
            : [];
        const expectedClaimReferences = matchingToolAssessments
          .filter(
            (assessment) =>
              assessment.capability === row.capability &&
              assessment.status === "claim_identified",
          )
          .flatMap((assessment) =>
            assessment.evidence.map(
              (evidence) => `${evidence.evidenceId}\0${evidence.pointer}`,
            ),
          );
        const actualClaimReferences = row.advertisedClaimReferences.map(
          (reference) =>
            `${reference.evidenceId}\0${reference.fieldReference}`,
        );
        if (
          !sameStringSet(actualClaimReferences, expectedClaimReferences)
        ) {
          context.addIssue({
            code: "custom",
            message: "behavior claim references must exactly cover the analyzed tool-capability evidence",
            path: [
              "behaviorComparison",
              "scopes",
              scopeIndex,
              "rows",
              rowIndex,
              "advertisedClaimReferences",
            ],
          });
        }
        const expectedAdvertisedState =
          scope.kind === "initialization"
            ? "not_applicable"
            : matchingToolAssessments.length === 0
              ? "not_observed"
              : expectedClaimReferences.length > 0
                ? "claimed"
                : "not_claimed";
        if (row.advertisedState !== expectedAdvertisedState) {
          context.addIssue({
            code: "custom",
            message: "behavior advertised state must exactly reflect interface coverage and claim evidence",
            path: [
              "behaviorComparison",
              "scopes",
              scopeIndex,
              "rows",
              rowIndex,
              "advertisedState",
            ],
          });
        }
        for (const reference of row.advertisedClaimReferences) {
          const resolved = claimEvidence.get(
            `${reference.evidenceId}\0${reference.fieldReference}`,
          );
          if (
            resolved === undefined ||
            resolved.experimentId !== scope.experimentId ||
            resolved.toolName !== scope.toolName ||
            resolved.capability !== row.capability
          ) {
            context.addIssue({
              code: "custom",
              message: "behavior claim reference must resolve to the same experiment, tool, and capability",
              path: [
                "behaviorComparison",
                "scopes",
                scopeIndex,
                "rows",
                rowIndex,
                "advertisedClaimReferences",
              ],
            });
          }
        }
        if (
          row.staticSignalIds.some(
            (signalId) => staticSignals.get(signalId) !== row.capability,
          )
        ) {
          context.addIssue({
            code: "custom",
            message: "behavior static-signal IDs must resolve to the same capability",
            path: [
              "behaviorComparison",
              "scopes",
              scopeIndex,
              "rows",
              rowIndex,
              "staticSignalIds",
            ],
          });
        }
        if (
          !sameStringSet(
            row.staticSignalIds,
            staticSignalIdsByCapability.get(row.capability) ?? [],
          )
        ) {
          context.addIssue({
            code: "custom",
            message: "behavior static-signal IDs must exactly cover the summarized capability evidence",
            path: [
              "behaviorComparison",
              "scopes",
              scopeIndex,
              "rows",
              rowIndex,
              "staticSignalIds",
            ],
          });
        }
      }
    }

    const runtimeExperimentList = report.experiments.filter(
      (experiment) => experiment.kind !== "install",
    );
    if (
      duplicateStrings(
        report.experiments.map((experiment) => experiment.experimentId),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "report experiment IDs must be globally unique",
        path: ["experiments"],
      });
    }
    const runtimeExperiments = new Map(
      runtimeExperimentList.map((experiment) => [
        experiment.experimentId,
        experiment,
      ]),
    );
    const runtimeObservations = new Map(
      report.runtimeObservations.map((observation) => [
        observation.experimentId,
        observation,
      ]),
    );
    if (runtimeExperiments.size !== runtimeExperimentList.length) {
      context.addIssue({
        code: "custom",
        message: "runtime experiment IDs must be unique",
        path: ["experiments"],
      });
    }
    if (runtimeObservations.size !== report.runtimeObservations.length) {
      context.addIssue({
        code: "custom",
        message: "runtime observation experiment IDs must be unique",
        path: ["runtimeObservations"],
      });
    }
    if (
      [...comparedInterfaceIds].some(
        (experimentId) => !runtimeExperiments.has(experimentId),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "advertised interface evidence must belong to a runtime experiment",
        path: ["advertisedInterfaceSummary", "comparedExperimentIds"],
      });
    }
    const behaviorScopeIds = new Set(
      report.behaviorComparison.scopes.map((scope) => scope.experimentId),
    );
    if (
      behaviorScopeIds.size !== runtimeExperiments.size ||
      behaviorScopeIds.size !== runtimeObservations.size ||
      [...behaviorScopeIds].some(
        (experimentId) =>
          !runtimeExperiments.has(experimentId) ||
          !runtimeObservations.has(experimentId),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "behavior scopes must exactly cover runtime experiments and observations",
        path: ["behaviorComparison", "scopes"],
      });
    }
    for (const [scopeIndex, scope] of report.behaviorComparison.scopes.entries()) {
      const experiment = runtimeExperiments.get(scope.experimentId);
      const observation = runtimeObservations.get(scope.experimentId);
      if (
        experiment === undefined ||
        observation === undefined ||
        experiment.kind !== scope.kind ||
        observation.kind !== scope.kind ||
        experiment.toolName !== scope.toolName ||
        observation.toolName !== scope.toolName
      ) {
        context.addIssue({
          code: "custom",
          message: "behavior scope must match its runtime experiment and observation",
          path: ["behaviorComparison", "scopes", scopeIndex],
        });
      }
      if (
        experiment !== undefined &&
        scope.kind === "tool" &&
        experiment.expected === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "tool experiments require operator-authored expected scope",
          path: ["experiments", scopeIndex, "expected"],
        });
      }
      const expectedOperatorScopeState =
        experiment?.expected === undefined ? "not_configured" : "configured";
      if (
        scope.rows.some(
          (row) => row.operatorScopeState !== expectedOperatorScopeState,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "behavior operator-scope state must match experiment configuration",
          path: ["behaviorComparison", "scopes", scopeIndex, "rows"],
        });
      }
    }
  });

export type ArtifactReferenceV1 = z.infer<typeof artifactReferenceV1Schema>;
export type TargetProvenanceV1 = z.infer<typeof targetProvenanceV1Schema>;
export type SandboxProfileManifestV1 = z.infer<
  typeof sandboxProfileManifestV1Schema
>;
export type McpMessageV1 = z.infer<typeof mcpMessageV1Schema>;
export type McpInterfaceV1 = z.infer<typeof mcpInterfaceV1Schema>;
export type RunManifestV1 = z.infer<typeof runManifestV1Schema>;
export type PhaseV1 = z.infer<typeof phaseV1Schema>;
export type ObservedEffectV1 = z.infer<typeof observedEffectV1Schema>;
export type ObservedEventV1 = z.infer<typeof observedEventV1Schema>;
export type AttributionV1 = z.infer<typeof attributionV1Schema>;
export type FindingV1 = z.infer<typeof findingV1Schema>;
export type ReportV1 = z.infer<typeof reportV1Schema>;
