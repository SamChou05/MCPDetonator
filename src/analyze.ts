import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import type { LoadedTargetConfig } from "./config.js";
import { initializationEnabled, targetConfigV1Schema } from "./config.js";
import {
  runManifestV1Schema,
  targetProvenanceV1Schema,
  type ArtifactReferenceV1,
  type McpInterfaceV1,
  type ObservationHealthV1,
  type PhaseV1,
  type RunManifestV1,
  type TargetProvenanceV1,
} from "./contracts/v1.js";
import { attributeEvents } from "./attribute.js";
import { EvidenceStore, sha256File } from "./evidence-store.js";
import { runMcpExperiment } from "./mcp/stdio.js";
import {
  normalizeRun,
  type ObservedPathMapping,
} from "./observe/strace-normalizer.js";
import {
  discoverStraceExperimentIds,
  writeObservationHealth,
} from "./observe/observation-health.js";
import {
  captureFilesystemState,
  persistFilesystemStateEvidence,
  type FilesystemStateDeltaV1,
} from "./observe/filesystem-state.js";
import { writeReport } from "./report.js";
import { evaluateRuntimeRules } from "./rules.js";
import {
  createDockerMcpInvocation,
  defaultSandboxImage,
  dockerVersion,
  ensureSandboxImage,
  imageStraceVersion,
  removeManagedContainer,
  sandboxImageId,
} from "./sandbox/docker.js";
import {
  createDeveloperProfileSeed,
  materializeDeveloperProfile,
} from "./sandbox/profile.js";
import {
  digestTargetTree,
  prepareTarget,
  type PreparedTarget,
} from "./target/prepare.js";
import { inspectNodePackage } from "./static/node-package.js";
import { runNodeSemanticAnalysis } from "./static/node-semantic.js";
import {
  observeInstallLifecycle,
  type InstallLifecycleObservation,
} from "./install/lifecycle.js";
import {
  compareInstallLifecycle,
  type InstallLifecycleDeltaV1,
} from "./install/delta.js";

export interface AnalyzeOptions {
  readonly outputRoot: string;
  readonly projectRoot: string;
  readonly image?: string;
  readonly rebuildImage?: boolean;
}

export interface AnalyzeResult {
  readonly runId: string;
  readonly runDirectory: string;
}

export class AnalysisError extends Error {
  public constructor(
    message: string,
    public readonly runDirectory: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AnalysisError";
  }
}

function createRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `run-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function mediaType(path: string): string {
  if (path.endsWith(".jsonl")) {
    return "application/x-ndjson";
  }
  if (path.endsWith(".json")) {
    return "application/json";
  }
  return "text/plain";
}

async function listRegularFiles(directory: string): Promise<string[]> {
  const result: string[] = [];

  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        result.push(path);
      }
    }
  }

  await visit(directory);
  return result;
}

async function collectArtifacts(runDirectory: string): Promise<ArtifactReferenceV1[]> {
  const files = await listRegularFiles(runDirectory);
  const artifacts: ArtifactReferenceV1[] = [];

  for (const file of files) {
    const path = relative(runDirectory, file).split(sep).join("/");
    if (
      path === "run.json" ||
      (path.startsWith("sandboxes/") && !path.endsWith("/profile.json"))
    ) {
      continue;
    }
    const stat = await lstat(file);
    if (!stat.isFile()) {
      continue;
    }
    artifacts.push({
      path,
      sha256: await sha256File(file),
      mediaType: mediaType(path),
    });
  }

  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

export async function analyzeTarget(
  loaded: LoadedTargetConfig,
  options: AnalyzeOptions,
): Promise<AnalyzeResult> {
  const imageReference = options.image ?? defaultSandboxImage;
  await ensureSandboxImage(
    options.projectRoot,
    imageReference,
    options.rebuildImage ?? false,
  );
  const image = await sandboxImageId(imageReference);

  const runId = createRunId();
  const store = await EvidenceStore.create(options.outputRoot, runId);
  const createdAt = new Date().toISOString();
  const configSha256 = await sha256File(loaded.configPath);
  const limitations = [
    "The trusted strace supervisor shares the target container in this prototype.",
    "Network evidence records socket behavior and destinations, not decrypted request contents.",
    "Dependency acquisition runs with package lifecycle scripts disabled.",
    "This run observes selected inputs and does not prove all possible target behavior.",
    "Trace integrity and policy-relevant gaps cover a selected syscall surface and bounded taxonomy, not every kernel or userspace behavior.",
  ];
  const manifestBase = {
    schema: "forge.run/v1" as const,
    runId,
    targetId: loaded.config.target.id,
    configSha256,
    createdAt,
    sandboxPolicy: {
      profile: loaded.config.sandbox.profile,
      network: loaded.config.sandbox.network,
      timeoutMs: loaded.config.sandbox.limits.timeoutMs,
    },
    toolchain: {
      forgeVersion: "0.1.0",
      nodeVersion: process.version,
      dockerVersion: await dockerVersion(),
      straceVersion: await imageStraceVersion(image),
      observerImageReference: imageReference,
      observerImageId: image,
    },
    limitations,
  };
  const runningManifest: RunManifestV1 = {
    ...manifestBase,
    status: "running",
    artifacts: [],
  };

  await store.writeJson("target.json", targetConfigV1Schema, loaded.config);
  await store.writeJson("run.json", runManifestV1Schema, runningManifest);

  const profileSeed = createDeveloperProfileSeed();
  const experiments = [
    ...(initializationEnabled(loaded.config.experiments.initialization)
      ? [{ id: "baseline-initialization", tool: undefined }]
      : []),
    ...loaded.config.experiments.tools.map((tool) => ({ id: tool.id, tool })),
  ];
  const phases: PhaseV1[] = [];
  const interfaces: McpInterfaceV1[] = [];
  const sensitivePathsByExperiment = new Map<string, ReadonlySet<string>>();
  const profileRootsByExperiment = new Map<
    string,
    { readonly home: string; readonly workspace: string }
  >();
  const pathMappingsByExperiment = new Map<
    string,
    readonly ObservedPathMapping[]
  >();
  const filesystemStateDeltas: FilesystemStateDeltaV1[] = [];
  let preparedTarget: PreparedTarget | undefined;
  let installObservation: InstallLifecycleObservation | undefined;
  let installDelta: InstallLifecycleDeltaV1 | undefined;
  let observationHealth: ObservationHealthV1 | undefined;

  async function writeCurrentObservationHealth(
    events?: Parameters<typeof writeObservationHealth>[0]["events"],
  ): Promise<ObservationHealthV1> {
    const preferredExperimentIds = [
      ...(preparedTarget?.hostNpmCache === undefined
        ? []
        : ["install-scripts-disabled", "install-scripts-enabled"]),
      ...(installObservation?.experiments.map(
        (experiment) => experiment.experimentId,
      ) ?? []),
      ...experiments.map((experiment) => experiment.id),
    ];
    const discoveredExperimentIds = await discoverStraceExperimentIds(store);
    const experimentIds = [
      ...new Set([...preferredExperimentIds, ...discoveredExperimentIds]),
    ];
    const policyRelevantPathPrefixesByExperiment = new Map<
      string,
      readonly string[]
    >();
    const installExperimentIds = new Set([
      "install-scripts-disabled",
      "install-scripts-enabled",
      ...(installObservation?.experiments.map(
        (experiment) => experiment.experimentId,
      ) ?? []),
    ]);
    for (const experimentId of experimentIds) {
      if (installExperimentIds.has(experimentId)) {
        policyRelevantPathPrefixesByExperiment.set(experimentId, [
          "/opt/target",
          "/sandbox/home/forge",
          "/sandbox/workspace",
        ]);
      }
    }
    return writeObservationHealth({
      store,
      runId,
      experimentIds,
      pathMappingsByExperiment,
      policyRelevantPathPrefixesByExperiment,
      ...(events === undefined ? {} : { events }),
    });
  }

  try {
    preparedTarget = await prepareTarget({
      loaded,
      runId,
      store,
      image,
    });
    await inspectNodePackage({
      store,
      runId,
      targetId: loaded.config.target.id,
      packageRoot: preparedTarget.packageRoot,
      artifactPath: "static/pre-install-inspection.json",
    });
    await runNodeSemanticAnalysis({
      store,
      runId,
      targetId: loaded.config.target.id,
      lexicalInspectionArtifact: "static/pre-install-inspection.json",
      artifactPath: "static/pre-install-semantic-inspection.json",
    });
    let runtimeTarget = preparedTarget;
    let reportProvenance: TargetProvenanceV1 = preparedTarget.provenance;
    if (preparedTarget.hostNpmCache !== undefined) {
      installObservation = await observeInstallLifecycle({
        runId,
        store,
        config: loaded.config,
        preparedTarget,
        image,
        profileSeed,
      });
      phases.push(...installObservation.phases);
      for (const [experimentId, mappings] of
        installObservation.pathMappingsByExperiment) {
        pathMappingsByExperiment.set(experimentId, mappings);
      }

      if (installObservation.scriptsEnabled.outcome.status === "completed") {
        const digest = await digestTargetTree(
          installObservation.scriptsEnabled.hostRoot,
          { includeNodeModules: true },
        );
        reportProvenance = {
          ...preparedTarget.provenance,
          runtimeSnapshot: {
            sourceExperimentId: installObservation.scriptsEnabled.experimentId,
            lifecycleScripts: "enabled",
            treeSha256: digest.sha256,
            fileCount: digest.fileCount,
          },
        };
        runtimeTarget = {
          ...preparedTarget,
          hostRoot: installObservation.scriptsEnabled.hostRoot,
          packageRoot: installObservation.scriptsEnabled.hostPackageRoot,
          provenance: reportProvenance,
          dispose: async () => undefined,
        };
      } else {
        limitations.push(
          "The scripts-enabled install did not complete; runtime experiments use the scripts-disabled prepared snapshot.",
        );
      }
    }
    if (reportProvenance.runtimeSnapshot === undefined) {
      const digest = await digestTargetTree(preparedTarget.hostRoot, {
        includeNodeModules: true,
      });
      reportProvenance = {
        ...reportProvenance,
        runtimeSnapshot: {
          sourceExperimentId: "prepared-scripts-disabled",
          lifecycleScripts: "disabled",
          treeSha256: digest.sha256,
          fileCount: digest.fileCount,
        },
      };
    }
    await store.writeJson(
      "target/provenance.json",
      targetProvenanceV1Schema,
      reportProvenance,
    );
    const staticInspection = await inspectNodePackage({
      store,
      runId,
      targetId: loaded.config.target.id,
      packageRoot: runtimeTarget.packageRoot,
    });
    const semanticAnalysis = await runNodeSemanticAnalysis({
      store,
      runId,
      targetId: loaded.config.target.id,
    });

    for (const experiment of experiments) {
      const profile = await materializeDeveloperProfile(
        store,
        experiment.id,
        profileSeed,
      );
      const invocation = await createDockerMcpInvocation({
        runId,
        experimentId: experiment.id,
        config: loaded.config,
        store,
        profile,
        preparedTarget: runtimeTarget,
        image,
      });
      sensitivePathsByExperiment.set(
        experiment.id,
        new Set(profile.manifest.canaries.map((canary) => canary.path)),
      );
      profileRootsByExperiment.set(experiment.id, profile.manifest.roots);
      pathMappingsByExperiment.set(experiment.id, invocation.pathMappings);
      const beforeFilesystemState = await captureFilesystemState({
        runId,
        experimentId: experiment.id,
        profile,
        label: "before",
      });

      try {
        const result = await runMcpExperiment({
          runId,
          experimentId: experiment.id,
          store,
          server: invocation.server,
          timeoutMs: loaded.config.sandbox.limits.timeoutMs,
          cooldownMs: loaded.config.sandbox.limits.cooldownMs,
          ...(experiment.tool === undefined ? {} : { toolExperiment: experiment.tool }),
        });
        phases.push(...result.phases);
        interfaces.push(result.mcpInterface);
      } finally {
        await removeManagedContainer(invocation.containerName, runId);
        const afterFilesystemState = await captureFilesystemState({
          runId,
          experimentId: experiment.id,
          profile,
          label: "after",
        });
        filesystemStateDeltas.push(
          await persistFilesystemStateEvidence({
            store,
            before: beforeFilesystemState,
            after: afterFilesystemState,
          }),
        );
      }
    }

    const allExperimentIds = [
      ...(installObservation?.experiments.map(
        (experiment) => experiment.experimentId,
      ) ?? []),
      ...experiments.map((experiment) => experiment.id),
    ];
    const events = await normalizeRun({
      store,
      runId,
      experimentIds: allExperimentIds,
      pathMappingsByExperiment,
    });
    observationHealth = await writeCurrentObservationHealth(events);
    if (
      installObservation !== undefined &&
      installObservation.scriptsDisabled.outcome.status === "completed" &&
      installObservation.scriptsEnabled.outcome.status === "completed"
    ) {
      installDelta = await compareInstallLifecycle({
        store,
        runId,
        events,
        controlExperimentId: installObservation.scriptsDisabled.experimentId,
        treatmentExperimentId: installObservation.scriptsEnabled.experimentId,
        includedFileRoots: [
          installObservation.scriptsEnabled.containerRoot,
          installObservation.scriptsEnabled.profile.containerHome,
          installObservation.scriptsEnabled.profile.containerWorkspace,
        ],
      });
    }
    const isolatedToolExperimentIds = new Set(
      loaded.config.experiments.tools.map((experiment) => experiment.id),
    );
    const attributions = await attributeEvents({
      store,
      events,
      phases,
      isolatedToolExperimentIds,
    });
    const findings = await evaluateRuntimeRules({
      store,
      runId,
      config: loaded.config,
      events,
      phases,
      attributions,
      sensitivePathsByExperiment,
      profileRootsByExperiment,
    });
    await writeReport({
      store,
      runId,
      config: loaded.config,
      events,
      phases,
      attributions,
      findings,
      interfaces,
      provenance: reportProvenance,
      staticInspection,
      semanticAnalysis,
      profileRootsByExperiment,
      filesystemStateDeltas,
      observationHealth,
      ...(installObservation === undefined
        ? {}
        : {
            installObservation,
            ...(installDelta === undefined ? {} : { installDelta }),
          }),
      limitations: manifestBase.limitations,
    });

    const completedManifest: RunManifestV1 = {
      ...manifestBase,
      status: "completed",
      completedAt: new Date().toISOString(),
      artifacts: await collectArtifacts(store.runDirectory),
    };
    await store.writeJson("run.json", runManifestV1Schema, completedManifest);
    return { runId, runDirectory: store.runDirectory };
  } catch (error) {
    if (observationHealth === undefined) {
      observationHealth = await writeCurrentObservationHealth().catch(
        () => undefined,
      );
    }
    const failedManifest: RunManifestV1 = {
      ...manifestBase,
      status: "failed",
      completedAt: new Date().toISOString(),
      artifacts: await collectArtifacts(store.runDirectory).catch(() => []),
    };
    await store.writeJson("run.json", runManifestV1Schema, failedManifest);
    throw new AnalysisError(
      `analysis failed; partial evidence is preserved in ${store.runDirectory}`,
      store.runDirectory,
      { cause: error },
    );
  } finally {
    await installObservation?.dispose().catch(() => undefined);
    await preparedTarget?.dispose().catch(() => undefined);
  }
}
