import { z } from "zod";

import {
  staticCapabilitySchema,
  staticEvidenceReferenceV1Schema,
} from "../static/contracts.js";

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
          description: z.string().optional(),
          inputSchema: z.json(),
        })
      .strict(),
    ),
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
    staticRuntimeComparison: z
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
      .strict(),
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
        installDelta: z.string().min(1).optional(),
      })
      .strict(),
    limitations: z.array(z.string().min(1)),
  })
  .strict();

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
