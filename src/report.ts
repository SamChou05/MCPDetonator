import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import {
  initializationEnabled,
  initializationExpectedScope,
  type TargetConfigV1,
} from "./config.js";
import {
  compareAdvertisedStaticObservedAndApproved,
  type AdvertisedClaimsByExperiment,
  type ComparedBehaviorCapability,
} from "./behavior-comparison.js";
import {
  reportV1Schema,
  type AttributionV1,
  type FindingV1,
  type McpInterfaceV1,
  type ObservationHealthV1,
  type ObservedEventV1,
  type PhaseV1,
  type ReportV1,
  type TargetProvenanceV1,
} from "./contracts/v1.js";
import { sha256, type EvidenceStore } from "./evidence-store.js";
import {
  destinationMatchesExpectedScope,
  pathMatchesExpectedScope,
} from "./expected-scope.js";
import {
  nodePackageStaticInspectionV1Schema,
  type NodePackageStaticInspectionV1,
  type StaticCapability,
} from "./static/contracts.js";
import {
  verifyNodeSemanticAnalysis,
  type NodeSemanticAnalysisResult,
} from "./static/node-semantic.js";
import {
  nodeSemanticStaticV1Schema,
  type NodeSemanticReportSummaryV1,
} from "./static/semantic-contracts.js";
import type { InstallLifecycleObservation } from "./install/lifecycle.js";
import type { InstallLifecycleDeltaV1 } from "./install/delta.js";
import {
  extractMcpAdvertisedClaims,
  mcpAdvertisedClaimsV1Schema,
  type McpAdvertisedClaimsV1,
} from "./mcp/interface-claims.js";
import {
  assertMcpCatalogWithinLimits,
  MCP_CATALOG_HASH_ALGORITHM,
  MCP_CATALOG_LIMITS,
} from "./mcp/catalog.js";
import type { FilesystemStateDeltaV1 } from "./observe/filesystem-state.js";

const maxExpectedScopeExamples = 25;
const maxFilesystemStateExamples = 50;
const comparedCapabilities = new Set<StaticCapability>([
  "filesystem_access",
  "process_execution",
  "network_access",
]);
const allStaticCapabilities: readonly StaticCapability[] = [
  "filesystem_access",
  "process_execution",
  "network_access",
  "environment_access",
  "dynamic_code_execution",
  "dynamic_module_loading",
  "native_code_loading",
];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function summarizeAdvertisedInterfaces(
  interfaces: readonly McpInterfaceV1[],
): ReportV1["advertisedInterfaceSummary"] {
  if (interfaces.length === 0) {
    return {
      selection: "first_observed_interface",
      catalogHashAlgorithm: MCP_CATALOG_HASH_ALGORITHM,
      catalogLimits: MCP_CATALOG_LIMITS,
      catalogConsistency: "not_observed",
      comparedExperimentIds: [],
      catalogFingerprints: [],
      differingExperimentIds: [],
      duplicateToolNames: [],
      limitations: [
        "No MCP interface completed, so the top-level advertised server and tools use explicit unknown/empty placeholders.",
      ],
    };
  }

  const byExperiment = new Map<string, McpInterfaceV1>();
  for (const mcpInterface of interfaces) {
    if (byExperiment.has(mcpInterface.experimentId)) {
      throw new Error(
        `MCP interfaces contain duplicate experiment ID '${mcpInterface.experimentId}'`,
      );
    }
    byExperiment.set(mcpInterface.experimentId, mcpInterface);
  }
  const source = interfaces[0];
  if (source === undefined) {
    throw new Error("missing first observed MCP interface");
  }
  const fingerprints = new Map(
    interfaces.map((mcpInterface) => [
      mcpInterface.experimentId,
      assertMcpCatalogWithinLimits(mcpInterface.server, mcpInterface.tools),
    ]),
  );
  const sourceFingerprint = fingerprints.get(source.experimentId);
  if (sourceFingerprint === undefined) {
    throw new Error("missing source MCP catalog fingerprint");
  }
  const comparedExperimentIds = [...byExperiment.keys()].sort(compareText);
  const differingExperimentIds = comparedExperimentIds.filter(
    (experimentId) =>
      fingerprints.get(experimentId)?.sha256 !== sourceFingerprint.sha256,
  );
  const catalogFingerprints = comparedExperimentIds.map((experimentId) => {
    const fingerprint = fingerprints.get(experimentId);
    if (fingerprint === undefined) {
      throw new Error(
        `missing MCP catalog fingerprint for experiment '${experimentId}'`,
      );
    }
    return {
      experimentId,
      sha256: fingerprint.sha256,
      orderedSha256: fingerprint.orderedSha256,
    };
  });
  const duplicateToolNames: ReportV1["advertisedInterfaceSummary"]["duplicateToolNames"] = [];
  for (const experimentId of comparedExperimentIds) {
    const mcpInterface = byExperiment.get(experimentId);
    if (mcpInterface === undefined) continue;
    const counts = new Map<string, number>();
    for (const tool of mcpInterface.tools) {
      counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
    }
    const names = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name)
      .sort(compareText);
    if (names.length > 0) duplicateToolNames.push({ experimentId, names });
  }

  return {
    selection: "first_observed_interface",
    catalogHashAlgorithm: MCP_CATALOG_HASH_ALGORITHM,
    catalogLimits: MCP_CATALOG_LIMITS,
    sourceCatalogSha256: sourceFingerprint.sha256,
    sourceOrderedCatalogSha256: sourceFingerprint.orderedSha256,
    sourceExperimentId: source.experimentId,
    catalogConsistency:
      differingExperimentIds.length === 0 ? "consistent" : "drift_detected",
    comparedExperimentIds,
    catalogFingerprints,
    differingExperimentIds,
    duplicateToolNames,
    limitations: [
      "The top-level advertisedServer and advertisedTools are copied from sourceExperimentId; per-experiment interface artifacts remain authoritative when drift or duplicate tool names are reported.",
      "Catalog consistency uses a bounded, tool-order-independent SHA-256 digest of the retained server name/version and each tool's name, title, description, input schema, and annotations; a separate order-sensitive digest binds the selected source interface.",
      "The complete tools/list result is bounded before schema validation, but output schemas and other unretained MCP metadata are not included in interface artifacts, claim extraction, or catalog-drift fingerprints.",
    ],
  };
}

type ProfileRootsByExperiment = ReadonlyMap<
  string,
  { readonly home: string; readonly workspace: string }
>;

type RuntimeObservation = ReportV1["runtimeObservations"][number];
type ExpectedScopeExample = NonNullable<
  RuntimeObservation["expectedScopeMatches"]
>["examples"][number];

function comparisonClaimsByExperiment(
  config: TargetConfigV1,
  claims: McpAdvertisedClaimsV1,
): AdvertisedClaimsByExperiment {
  const interfaceByExperiment = new Map(
    claims.interfaces.map((analysis) => [analysis.experimentId, analysis]),
  );
  if (interfaceByExperiment.size !== claims.interfaces.length) {
    throw new Error("advertised claim analyses contain duplicate experiment IDs");
  }

  const result = new Map<
    string,
    Map<
      ComparedBehaviorCapability,
      { readonly evidenceId: string; readonly fieldReference: string }[]
    >
  >();
  for (const experiment of config.experiments.tools) {
    const analysis = interfaceByExperiment.get(experiment.id);
    const matchingAssessments =
      analysis?.capabilityAssessments.filter(
        (assessment) => assessment.toolName === experiment.tool,
      ) ?? [];
    if (matchingAssessments.length === 0) {
      continue;
    }
    const byCapability = new Map<
      ComparedBehaviorCapability,
      { readonly evidenceId: string; readonly fieldReference: string }[]
    >();
    for (const assessment of matchingAssessments) {
      if (
        assessment.status !== "claim_identified"
      ) {
        continue;
      }
      const references = byCapability.get(assessment.capability) ?? [];
      references.push(
        ...assessment.evidence.map((evidence) => ({
          evidenceId: evidence.evidenceId,
          fieldReference: evidence.pointer,
        })),
      );
      byCapability.set(assessment.capability, references);
    }
    result.set(experiment.id, byCapability);
  }
  return result;
}

function eventMatchesExpectedScope(
  event: ObservedEventV1,
  expected: TargetConfigV1["experiments"]["tools"][number]["expected"],
): boolean {
  switch (event.effect.kind) {
    case "file.read":
      if (
        event.effect.operation === "directory_entries" ||
        event.effect.outcome.status !== "succeeded"
      ) {
        return false;
      }
      return pathMatchesExpectedScope(
        event.effect.path,
        expected.fileReads,
        expected.fileReadPrefixes,
      );
    case "file.write":
      if (event.effect.outcome.status !== "succeeded") {
        return false;
      }
      return pathMatchesExpectedScope(
        event.effect.path,
        expected.fileWrites,
        expected.fileWritePrefixes,
      );
    case "file.delete":
      if (event.effect.outcome.status !== "succeeded") {
        return false;
      }
      return pathMatchesExpectedScope(
        event.effect.path,
        expected.fileWrites,
        expected.fileWritePrefixes,
      );
    case "process.exec":
      if (event.effect.outcome.status !== "succeeded") {
        return false;
      }
      return pathMatchesExpectedScope(
        event.effect.executable,
        expected.childExecutables,
        expected.childExecutablePrefixes,
      );
    case "network.connect_attempt":
      return destinationMatchesExpectedScope(
        event.effect.address,
        event.effect.port,
        expected.networkConnections,
      );
    default:
      return false;
  }
}

function expectedScopeExampleKey(event: ObservedEventV1): string {
  switch (event.effect.kind) {
    case "file.read":
      return `${event.effect.kind}:${event.effect.operation ?? "content"}:${event.effect.path}`;
    case "file.write":
      return `${event.effect.kind}:${event.effect.operation ?? "content"}:${event.effect.path}`;
    case "file.delete":
      return `${event.effect.kind}:${event.effect.path}`;
    case "process.exec":
      return `${event.effect.kind}:${event.effect.executable}:${JSON.stringify(event.effect.args)}`;
    case "network.connect_attempt":
      return `${event.effect.kind}:${event.effect.protocol}:${event.effect.address}:${event.effect.port ?? ""}`;
    default:
      return event.eventId;
  }
}

function effectCounts(events: readonly ObservedEventV1[]): RuntimeObservation["effectCounts"] {
  const counts = new Map<ObservedEventV1["effect"]["kind"], number>();
  for (const event of events) {
    counts.set(event.effect.kind, (counts.get(event.effect.kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([effectKind, count]) => ({ effectKind, count }));
}

function fileOperationCounts(
  events: readonly ObservedEventV1[],
): NonNullable<RuntimeObservation["fileOperationCounts"]> {
  const counts = new Map<
    string,
    NonNullable<RuntimeObservation["fileOperationCounts"]>[number]
  >();
  for (const event of events) {
    if (
      event.effect.kind !== "file.read" &&
      event.effect.kind !== "file.write"
    ) {
      continue;
    }
    const operation = event.effect.operation ?? "content";
    const key = `${event.effect.kind}:${operation}`;
    const existing = counts.get(key);
    counts.set(key, {
      effectKind: event.effect.kind,
      operation,
      count: (existing?.count ?? 0) + 1,
    });
  }
  return [...counts.values()].sort(
    (left, right) =>
      left.effectKind.localeCompare(right.effectKind) ||
      left.operation.localeCompare(right.operation),
  );
}

function summarizeFilesystemStateDelta(
  delta: FilesystemStateDeltaV1 | undefined,
): NonNullable<RuntimeObservation["filesystemStateDelta"]> | undefined {
  if (delta === undefined) {
    return undefined;
  }
  const allExamples: NonNullable<
    RuntimeObservation["filesystemStateDelta"]
  >["examples"] = [
    ...delta.changes.created.map((entry) => ({
      change: "created" as const,
      path: entry.path,
      afterKind: entry.kind,
    })),
    ...delta.changes.modified.map((entry) => ({
      change: "modified" as const,
      path: entry.path,
      beforeKind: entry.before.kind,
      afterKind: entry.after.kind,
      changedAttributes: entry.changed,
    })),
    ...delta.changes.deleted.map((entry) => ({
      change: "deleted" as const,
      path: entry.path,
      beforeKind: entry.kind,
    })),
    ...delta.changes.typeChanged.map((entry) => ({
      change: "type_changed" as const,
      path: entry.path,
      beforeKind: entry.before.kind,
      afterKind: entry.after.kind,
    })),
  ];
  allExamples.sort(
    (left, right) =>
      compareText(left.path, right.path) || compareText(left.change, right.change),
  );
  const examples = allExamples.slice(0, maxFilesystemStateExamples);
  const examplesTruncated = examples.length < allExamples.length;

  return {
    scope: "isolated_experiment_window",
    attribution: "experiment_only",
    snapshotsComplete: delta.snapshotsComplete,
    changeCounts: {
      created: delta.changes.created.length,
      modified: delta.changes.modified.length,
      deleted: delta.changes.deleted.length,
      typeChanged: delta.changes.typeChanged.length,
    },
    examples,
    examplesTruncated,
    artifactRefs: delta.artifactRefs,
    limitations: [
      ...delta.limitations,
      ...(examplesTruncated
        ? [
            `The report includes the first ${maxFilesystemStateExamples} state changes in stable path order; the complete delta remains in ${delta.artifactRefs.delta}.`,
          ]
        : []),
    ],
  };
}

export function summarizeRuntimeObservations(options: {
  readonly config: TargetConfigV1;
  readonly events: readonly ObservedEventV1[];
  readonly phases: readonly PhaseV1[];
  readonly attributions: readonly AttributionV1[];
  readonly filesystemStateDeltas?: readonly FilesystemStateDeltaV1[];
}): ReportV1["runtimeObservations"] {
  const attributionByEvent = new Map(
    options.attributions.map((attribution) => [attribution.eventId, attribution]),
  );
  const observations: ReportV1["runtimeObservations"] = [];
  const filesystemStateByExperiment = new Map<string, FilesystemStateDeltaV1>();
  for (const delta of options.filesystemStateDeltas ?? []) {
    if (filesystemStateByExperiment.has(delta.experimentId)) {
      throw new Error(
        `duplicate filesystem state delta for experiment '${delta.experimentId}'`,
      );
    }
    filesystemStateByExperiment.set(delta.experimentId, delta);
  }

  if (initializationEnabled(options.config.experiments.initialization)) {
    const experimentEvents = options.events.filter(
      (event) => event.experimentId === "baseline-initialization",
    );
    const baselinePhases = options.phases.filter(
      (phase) =>
        phase.experimentId === "baseline-initialization" &&
        (phase.kind === "initialization" || phase.kind === "cooldown"),
    );
    const baselinePhaseIds = new Set(
      baselinePhases.map((phase) => phase.phaseId),
    );
    const initializationEvents =
      baselinePhases.length === 0
        ? []
        : experimentEvents.filter(
            (event) =>
              attributionByEvent.get(event.eventId)?.activePhaseId !== undefined &&
              baselinePhaseIds.has(
                attributionByEvent.get(event.eventId)?.activePhaseId ?? "",
              ),
          );
    const filesystemStateDelta = summarizeFilesystemStateDelta(
      filesystemStateByExperiment.get("baseline-initialization"),
    );
    observations.push({
      experimentId: "baseline-initialization",
      kind: "initialization",
      effectCounts: effectCounts(initializationEvents),
      fileOperationCounts: fileOperationCounts(initializationEvents),
      phaseBreakdown: baselinePhases.map((phase) => {
        const phaseEvents = experimentEvents.filter(
          (event) =>
            attributionByEvent.get(event.eventId)?.activePhaseId === phase.phaseId,
        );
        return {
          phaseId: phase.phaseId,
          name: phase.name,
          ...(phase.stage === undefined ? {} : { stage: phase.stage }),
          effectCounts: effectCounts(phaseEvents),
          fileOperationCounts: fileOperationCounts(phaseEvents),
        };
      }),
      ...(filesystemStateDelta === undefined
        ? {}
        : { filesystemStateDelta }),
    });
  }

  for (const experiment of options.config.experiments.tools) {
    const experimentEvents = options.events.filter(
      (event) => event.experimentId === experiment.id,
    );
    const toolPhase = options.phases.find(
      (phase) => phase.experimentId === experiment.id && phase.kind === "tool",
    );
    const toolEvents =
      toolPhase === undefined
        ? []
        : experimentEvents.filter(
            (event) =>
              attributionByEvent.get(event.eventId)?.activePhaseId ===
              toolPhase.phaseId,
          );
    const matchingEvents =
      toolEvents
        .filter((event) => eventMatchesExpectedScope(event, experiment.expected))
        .sort((left, right) => left.sequence - right.sequence);
    const uniqueExamples = new Map<string, ExpectedScopeExample>();
    for (const event of matchingEvents) {
      const key = expectedScopeExampleKey(event);
      if (uniqueExamples.has(key)) {
        continue;
      }
      const attribution = attributionByEvent.get(event.eventId);
      uniqueExamples.set(key, {
        eventId: event.eventId,
        effect: event.effect,
        attributionConfidence: attribution?.confidence ?? "unattributed",
        rawRef: event.source.rawRef,
      });
    }
    const examples = [...uniqueExamples.values()].slice(0, maxExpectedScopeExamples);
    const filesystemStateDelta = summarizeFilesystemStateDelta(
      filesystemStateByExperiment.get(experiment.id),
    );
    observations.push({
      experimentId: experiment.id,
      kind: "tool",
      toolName: experiment.tool,
      effectCounts: effectCounts(toolEvents),
      fileOperationCounts: fileOperationCounts(toolEvents),
      expectedScopeMatches: {
        eventCount: matchingEvents.length,
        examples,
        examplesTruncated: uniqueExamples.size > examples.length,
      },
      ...(filesystemStateDelta === undefined
        ? {}
        : { filesystemStateDelta }),
    });
  }

  return observations;
}

function pathIsInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function processIdentity(experimentId: string, processRef: string): string {
  return JSON.stringify([experimentId, processRef]);
}

export function compareStaticAndRuntime(options: {
  readonly staticInspection: NodePackageStaticInspectionV1;
  readonly events: readonly ObservedEventV1[];
  readonly phases: readonly PhaseV1[];
  readonly attributions: readonly AttributionV1[];
  readonly profileRootsByExperiment: ProfileRootsByExperiment;
}): ReportV1["staticRuntimeComparison"] {
  const signalsByCapability = new Map<StaticCapability, string[]>();
  for (const signal of options.staticInspection.source.signals) {
    const signalIds = signalsByCapability.get(signal.capability) ?? [];
    signalIds.push(signal.signalId);
    signalsByCapability.set(signal.capability, signalIds);
  }

  const phaseById = new Map(options.phases.map((phase) => [phase.phaseId, phase]));
  const attributionByEvent = new Map(
    options.attributions.map((attribution) => [attribution.eventId, attribution]),
  );
  const childProcessIdentities = new Set(
    options.events
      .filter(
        (event) =>
          event.effect.kind === "process.start" &&
          event.effect.parentProcessRef !== undefined,
      )
      .map((event) => processIdentity(event.experimentId, event.processRef)),
  );
  const runtimeEventsByCapability = new Map<
    StaticCapability,
    ObservedEventV1[]
  >();

  function selectedPhaseEvent(event: ObservedEventV1): boolean {
    const attribution = attributionByEvent.get(event.eventId);
    const activePhase =
      attribution?.activePhaseId === undefined
        ? undefined
        : phaseById.get(attribution.activePhaseId);
    if (activePhase?.kind === "initialization" || activePhase?.kind === "tool") {
      return true;
    }
    if (activePhase?.kind !== "cooldown") {
      return false;
    }
    if (event.experimentId === "baseline-initialization") {
      return true;
    }
    const originPhase =
      attribution?.processOriginPhaseId === undefined
        ? undefined
        : phaseById.get(attribution.processOriginPhaseId);
    return originPhase?.kind === "tool";
  }

  function addRuntimeEvent(
    capability: StaticCapability,
    event: ObservedEventV1,
  ): void {
    const events = runtimeEventsByCapability.get(capability) ?? [];
    events.push(event);
    runtimeEventsByCapability.set(capability, events);
  }

  for (const event of options.events) {
    if (!selectedPhaseEvent(event)) {
      continue;
    }
    if (
      (event.effect.kind === "file.read" &&
        event.effect.operation !== "directory_entries") ||
      event.effect.kind === "file.write" ||
      event.effect.kind === "file.delete"
    ) {
      const roots = options.profileRootsByExperiment.get(event.experimentId);
      const path = event.effect.path;
      if (
        roots !== undefined &&
        [roots.home, roots.workspace].some((root) => pathIsInside(path, root))
      ) {
        addRuntimeEvent("filesystem_access", event);
      }
      continue;
    }
    if (
      event.effect.kind === "process.exec" &&
      childProcessIdentities.has(
        processIdentity(event.experimentId, event.processRef),
      )
    ) {
      addRuntimeEvent("process_execution", event);
      continue;
    }
    if (
      (event.effect.kind === "network.connect_attempt" ||
        event.effect.kind === "network.listen") &&
      event.effect.protocol !== "unix"
    ) {
      addRuntimeEvent("network_access", event);
    }
  }

  const rows: ReportV1["staticRuntimeComparison"]["rows"] =
    allStaticCapabilities.map((capability) => {
      const staticSignalIds = [...(signalsByCapability.get(capability) ?? [])].sort();
      const staticSignal = staticSignalIds.length > 0 ? "found" : "not_found";
      if (!comparedCapabilities.has(capability)) {
        return {
          capability,
          staticSignal,
          runtimeObservation: "not_comparable" as const,
          staticSignalIds,
          runtimeEventIds: [],
          interpretation:
            "The current syscall evidence does not directly confirm or refute this static capability.",
        };
      }

      const runtimeEventIds = [
        ...new Set(
          (runtimeEventsByCapability.get(capability) ?? []).map(
            (event) => event.eventId,
          ),
        ),
      ].sort();
      const runtimeObservation =
        runtimeEventIds.length > 0 ? "observed" : "not_observed";
      const interpretation =
        staticSignal === "found" && runtimeObservation === "observed"
          ? "Package-authored source contains matching capability signals and selected runtime phases observed the behavior."
          : staticSignal === "found"
            ? "Package-authored source contains matching capability signals, but the selected runtime phases did not observe the behavior."
            : runtimeObservation === "observed"
              ? "Selected runtime phases observed the behavior without a matching signal in the bounded package-authored source scan."
              : "Neither the bounded package-authored source scan nor the selected runtime phases produced matching evidence.";
      return {
        capability,
        staticSignal,
        runtimeObservation,
        staticSignalIds,
        runtimeEventIds,
        interpretation,
      };
    });

  return {
    scope:
      "Package-authored source signals compared with analyst-relevant effects from selected initialization, the baseline pre-tool observation window, tool calls, and tool-originated cooldown phases.",
    rows,
    limitations: [
      "The static scan is bounded lexical analysis of package-authored source and excludes dependency source.",
      "Runtime comparison includes supported failed attempts. Filesystem comparison is limited to normalized reads, writes, and deletes under the synthetic home/workspace roots, so open-only activity is excluded; process comparison excludes the root server exec; network comparison excludes Unix-domain sockets.",
      "Environment, dynamic-code, dynamic-module, and native-code capabilities are not directly comparable with the current normalized runtime evidence.",
      "Agreement or disagreement is evidence about selected inputs, not a verdict about intent or safety.",
    ],
  };
}

function summarizeStaticAnalysis(
  inspection: NodePackageStaticInspectionV1,
  runtimeSnapshot: NonNullable<TargetProvenanceV1["runtimeSnapshot"]>,
): ReportV1["staticAnalysis"] {
  const manifest =
    inspection.manifest.status === "parsed"
      ? {
          status: inspection.manifest.status,
          ...(inspection.manifest.claims.name === undefined
            ? {}
            : { name: inspection.manifest.claims.name }),
          ...(inspection.manifest.claims.version === undefined
            ? {}
            : { version: inspection.manifest.claims.version }),
          evidence: inspection.manifest.evidence,
        }
      : {
          status: inspection.manifest.status,
          ...(inspection.manifest.status === "missing"
            ? {}
            : { error: inspection.manifest.error }),
          ...(inspection.manifest.status === "invalid" &&
          inspection.manifest.evidence !== undefined
            ? { evidence: inspection.manifest.evidence }
            : {}),
        };
  const dependencyCounts: ReportV1["staticAnalysis"]["dependencyCounts"] = {
    runtime: 0,
    development: 0,
    optional: 0,
    peer: 0,
  };
  const installLifecycleScripts: ReportV1["staticAnalysis"]["installLifecycleScripts"] =
    [];
  if (inspection.manifest.status === "parsed") {
    for (const dependency of inspection.manifest.claims.dependencies) {
      dependencyCounts[dependency.kind] += 1;
    }
    for (const script of inspection.manifest.claims.scripts) {
      if (script.installLifecycle) {
        installLifecycleScripts.push({
          name: script.name,
          command: script.command,
          evidence: inspection.manifest.evidence,
        });
      }
    }
  }

  const signals = new Map<
    StaticCapability,
    NodePackageStaticInspectionV1["source"]["signals"]
  >();
  for (const signal of inspection.source.signals) {
    const existing = signals.get(signal.capability) ?? [];
    signals.set(signal.capability, [...existing, signal]);
  }

  return {
    snapshot: {
      basis: "selected-runtime-snapshot",
      sourceExperimentId: runtimeSnapshot.sourceExperimentId,
      lifecycleScripts: runtimeSnapshot.lifecycleScripts,
      treeSha256: runtimeSnapshot.treeSha256,
      fileCount: runtimeSnapshot.fileCount,
    },
    manifest,
    installLifecycleScripts,
    dependencyCounts,
    lockfiles: inspection.lockfiles.map((lockfile) => ({
      path: lockfile.path,
      format: lockfile.format,
      ...(lockfile.sha256 === undefined ? {} : { sha256: lockfile.sha256 }),
      ...(lockfile.evidence === undefined ? {} : { evidence: lockfile.evidence }),
    })),
    capabilitySignals: [...signals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([capability, grouped]) => ({
        capability,
        count: grouped.length,
        signalIds: grouped.map((signal) => signal.signalId),
        evidence: grouped.map((signal) => signal.evidence),
      })),
    sourceCoverage: {
      candidateFiles: inspection.source.candidateFiles,
      scannedFiles: inspection.source.scannedFiles.length,
      skippedFiles: inspection.source.skippedFiles.length,
    },
    limitations: inspection.limitations,
  };
}

export function summarizeNodeSemanticAnalysis(
  result: NodeSemanticAnalysisResult,
): NodeSemanticReportSummaryV1 {
  const capabilityCounts = new Map<StaticCapability, number>();
  const handlerReachability: NodeSemanticReportSummaryV1["handlerReachability"] = {
    directHandler: 0,
    boundedCallPath: 0,
    notIdentified: 0,
    notAssessed: result.analysis.callsites.length,
  };
  for (const callsite of result.analysis.callsites) {
    capabilityCounts.set(
      callsite.capability,
      (capabilityCounts.get(callsite.capability) ?? 0) + 1,
    );
  }
  return {
    status: result.analysis.status,
    artifactPath: result.artifactPath,
    artifactSha256: result.artifactSha256,
    analyzer: result.analysis.analyzer,
    sourceSetSha256: result.analysis.input.sourceSetSha256,
    coverage: result.analysis.coverage,
    callsiteCount: result.analysis.callsites.length,
    capabilityCallsites: [...capabilityCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([capability, count]) => ({ capability, count })),
    handlerReachability,
    truncations: result.analysis.truncations,
    ...(result.analysis.failure === undefined
      ? {}
      : { failure: result.analysis.failure }),
    limitations: result.analysis.limitations,
  };
}

async function verifySemanticReportInput(options: {
  readonly store: EvidenceStore;
  readonly inspection: NodePackageStaticInspectionV1;
  readonly result: NodeSemanticAnalysisResult;
}): Promise<void> {
  if (options.result.artifactPath !== "static/semantic-inspection.json") {
    throw new Error("report semantic summary requires the selected snapshot artifact");
  }
  const artifactBytes = await readFile(
    options.store.pathFor(options.result.artifactPath),
  );
  if (sha256(artifactBytes) !== options.result.artifactSha256) {
    throw new Error("semantic artifact digest changed before report construction");
  }
  const retained = nodeSemanticStaticV1Schema.parse(
    JSON.parse(artifactBytes.toString("utf8")),
  );
  if (!isDeepStrictEqual(retained, options.result.analysis)) {
    throw new Error("semantic report input differs from the retained artifact");
  }
  const lexicalArtifact = retained.input.lexicalInspectionArtifact;
  if (lexicalArtifact !== "static/inspection.json") {
    throw new Error("selected semantic evidence names the wrong lexical snapshot");
  }
  const lexicalBytes = await readFile(options.store.pathFor(lexicalArtifact));
  verifyNodeSemanticAnalysis({
    analysis: retained,
    inspection: options.inspection,
    lexicalInspectionArtifact: lexicalArtifact,
    lexicalInspectionSha256: sha256(lexicalBytes),
  });
  const preSemanticBytes = await readFile(
    options.store.pathFor("static/pre-install-semantic-inspection.json"),
  );
  const preSemantic = nodeSemanticStaticV1Schema.parse(
    JSON.parse(preSemanticBytes.toString("utf8")),
  );
  const preLexicalArtifact = preSemantic.input.lexicalInspectionArtifact;
  if (preLexicalArtifact !== "static/pre-install-inspection.json") {
    throw new Error("pre-install semantic evidence names the wrong lexical snapshot");
  }
  const preLexicalBytes = await readFile(
    options.store.pathFor(preLexicalArtifact),
  );
  const preInspection = nodePackageStaticInspectionV1Schema.parse(
    JSON.parse(preLexicalBytes.toString("utf8")),
  );
  verifyNodeSemanticAnalysis({
    analysis: preSemantic,
    inspection: preInspection,
    lexicalInspectionArtifact: preLexicalArtifact,
    lexicalInspectionSha256: sha256(preLexicalBytes),
  });
}

export function assertReportStaticIdentity(options: {
  readonly runId: string;
  readonly targetId: string;
  readonly inspection: NodePackageStaticInspectionV1;
  readonly semanticAnalysis?: NodeSemanticAnalysisResult;
}): void {
  if (
    options.inspection.runId !== options.runId ||
    options.inspection.targetId !== options.targetId
  ) {
    throw new Error("static inspection does not belong to the report run and target");
  }
  if (
    options.semanticAnalysis !== undefined &&
    (options.semanticAnalysis.analysis.runId !== options.runId ||
      options.semanticAnalysis.analysis.targetId !== options.targetId)
  ) {
    throw new Error("semantic inspection does not belong to the report run and target");
  }
}

export async function writeReport(options: {
  readonly store: EvidenceStore;
  readonly runId: string;
  readonly config: TargetConfigV1;
  readonly events: readonly ObservedEventV1[];
  readonly phases: readonly PhaseV1[];
  readonly attributions: readonly AttributionV1[];
  readonly findings: readonly FindingV1[];
  readonly interfaces: readonly McpInterfaceV1[];
  readonly provenance: TargetProvenanceV1;
  readonly staticInspection: NodePackageStaticInspectionV1;
  readonly semanticAnalysis?: NodeSemanticAnalysisResult;
  readonly profileRootsByExperiment: ProfileRootsByExperiment;
  readonly filesystemStateDeltas?: readonly FilesystemStateDeltaV1[];
  readonly observationHealth?: ObservationHealthV1;
  readonly installObservation?: InstallLifecycleObservation;
  readonly installDelta?: InstallLifecycleDeltaV1;
  readonly limitations: readonly string[];
}): Promise<ReportV1> {
  const runtimeSnapshot = options.provenance.runtimeSnapshot;
  if (runtimeSnapshot === undefined) {
    throw new Error(
      "report generation requires provenance for the selected runtime snapshot",
    );
  }
  assertReportStaticIdentity({
    runId: options.runId,
    targetId: options.config.target.id,
    inspection: options.staticInspection,
    ...(options.semanticAnalysis === undefined
      ? {}
      : { semanticAnalysis: options.semanticAnalysis }),
  });
  if (options.semanticAnalysis !== undefined) {
    await verifySemanticReportInput({
      store: options.store,
      inspection: options.staticInspection,
      result: options.semanticAnalysis,
    });
  }
  const canonicalInterface = options.interfaces[0];
  const advertisedInterfaceSummary = summarizeAdvertisedInterfaces(
    options.interfaces,
  );
  const advertisedClaims = extractMcpAdvertisedClaims(
    options.runId,
    options.interfaces,
  );
  await options.store.writeJson(
    "mcp/advertised-claims.json",
    mcpAdvertisedClaimsV1Schema,
    advertisedClaims,
  );
  const initializationScope = initializationExpectedScope(
    options.config.experiments.initialization,
  );
  const advertisedTools = (canonicalInterface?.tools ?? []).map((tool) => ({
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
  }));
  const experiments: ReportV1["experiments"] = [
    ...(options.installObservation?.experiments.map((experiment) => ({
        experimentId: experiment.experimentId,
        kind: "install" as const,
        lifecycleScripts:
          experiment.mode === "scripts-enabled"
            ? ("enabled" as const)
            : ("disabled" as const),
        status: experiment.outcome.status,
        eventCount: options.events.filter(
          (event) => event.experimentId === experiment.experimentId,
        ).length,
      })) ?? []),
    ...(initializationEnabled(options.config.experiments.initialization)
      ? [
          {
            experimentId: "baseline-initialization",
            kind: "initialization" as const,
            ...(initializationScope === undefined
              ? {}
              : { expected: initializationScope }),
            eventCount: options.events.filter(
              (event) => event.experimentId === "baseline-initialization",
            ).length,
          },
        ]
      : []),
    ...options.config.experiments.tools.map((experiment) => ({
      experimentId: experiment.id,
      kind: "tool" as const,
      toolName: experiment.tool,
      input: experiment.input,
      expected: experiment.expected,
      eventCount: options.events.filter((event) => event.experimentId === experiment.id)
        .length,
    })),
  ];
  if (
    options.observationHealth !== undefined &&
    options.observationHealth.runId !== options.runId
  ) {
    throw new Error("observation health does not belong to the report run");
  }
  if (options.observationHealth !== undefined) {
    const healthExperimentIds = options.observationHealth.experiments.map(
      (experiment) => experiment.experimentId,
    );
    const reportExperimentIds = experiments.map(
      (experiment) => experiment.experimentId,
    );
    if (
      healthExperimentIds.length !== reportExperimentIds.length ||
      healthExperimentIds.some(
        (experimentId, index) =>
          experimentId !== reportExperimentIds[index],
      )
    ) {
      throw new Error(
        "observation health must exactly cover report experiments in order",
      );
    }
    for (const [index, experimentHealth] of
      options.observationHealth.experiments.entries()) {
      const canonicalization = experimentHealth.canonicalization;
      if (
        canonicalization.status === "completed" &&
        canonicalization.emittedEventCount !== experiments[index]?.eventCount
      ) {
        throw new Error(
          "observation-health canonical event counts must match report experiments",
        );
      }
    }
  }
  const observationCoveragePartial =
    options.observationHealth !== undefined &&
    (options.observationHealth.integrityStatus !== "complete" ||
      options.observationHealth.canonicalizationExecutionStatus !==
        "completed" ||
      options.observationHealth.policyRelevantGapStatus !== "none_observed");
  const findingSummary =
    options.findings.length === 0
      ? "Within the selected experiments and current rule coverage, Forge found no deterministic runtime findings."
      : `Within the selected experiments and current rule coverage, Forge found ${options.findings.length} deterministic runtime ${options.findings.length === 1 ? "finding" : "findings"}.`;
  const report: ReportV1 = {
    schema: "forge.report/v1",
    runId: options.runId,
    targetId: options.config.target.id,
    generatedAt: new Date().toISOString(),
    summary: observationCoveragePartial
      ? `${findingSummary} Observation coverage is partial; see observation-health.json for structural trace health and policy-relevant canonicalization gaps.`
      : findingSummary,
    ...(options.observationHealth === undefined
      ? {}
      : {
          observationHealth: {
            scope: options.observationHealth.scope,
            surfaceId: options.observationHealth.surfaceId,
            integrityStatus: options.observationHealth.integrityStatus,
            canonicalizationExecutionStatus:
              options.observationHealth.canonicalizationExecutionStatus,
            policyRelevantGapStatus:
              options.observationHealth.policyRelevantGapStatus,
            experimentIds: options.observationHealth.experiments.map(
              (experiment) => experiment.experimentId,
            ),
            degradedExperimentIds: [
              ...options.observationHealth.degradedExperimentIds,
            ],
            policyRelevantGapExperimentIds: [
              ...options.observationHealth.policyRelevantGapExperimentIds,
            ],
            policyRelevantGapRecordCount:
              options.observationHealth.experiments.reduce(
                (sum, experiment) =>
                  sum + experiment.policyRelevantGaps.recordCount,
                0,
              ),
            policyRelevantGapOutcomeCounts: [
              "succeeded",
              "failed",
              "unknown",
            ].flatMap((outcome) => {
              const recordCount = options.observationHealth?.experiments.reduce(
                (sum, experiment) =>
                  sum +
                  (experiment.policyRelevantGaps.outcomeCounts.find(
                    (row) => row.outcome === outcome,
                  )?.recordCount ?? 0),
                0,
              ) ?? 0;
              return recordCount === 0
                ? []
                : [
                    {
                      outcome: outcome as "succeeded" | "failed" | "unknown",
                      recordCount,
                    },
                  ];
            }),
            stringTruncationLineCount:
              options.observationHealth.experiments.reduce(
                (sum, experiment) =>
                  sum + experiment.stringTruncationLineCount,
                0,
              ),
            artifact: "observation-health.json" as const,
          },
        }),
    artifactProvenance: options.provenance,
    sandboxPolicy: {
      profile: options.config.sandbox.profile,
      network: options.config.sandbox.network,
    },
    advertisedServer: canonicalInterface?.server ?? {
      name: "unknown-server",
      version: "unknown-version",
    },
    advertisedTools,
    advertisedInterfaceSummary,
    advertisedClaims,
    staticAnalysis: summarizeStaticAnalysis(options.staticInspection, runtimeSnapshot),
    ...(options.semanticAnalysis === undefined
      ? {}
      : {
          semanticAnalysis: summarizeNodeSemanticAnalysis(
            options.semanticAnalysis,
          ),
        }),
    staticRuntimeComparison: compareStaticAndRuntime({
      staticInspection: options.staticInspection,
      events: options.events,
      phases: options.phases,
      attributions: options.attributions,
      profileRootsByExperiment: options.profileRootsByExperiment,
    }),
    behaviorComparison: compareAdvertisedStaticObservedAndApproved({
      config: options.config,
      advertisedClaimsByExperiment: comparisonClaimsByExperiment(
        options.config,
        advertisedClaims,
      ),
      staticInspection: options.staticInspection,
      events: options.events,
      phases: options.phases,
      attributions: options.attributions,
      profileRootsByExperiment: options.profileRootsByExperiment,
    }),
    experiments,
    runtimeObservations: summarizeRuntimeObservations({
      config: options.config,
      events: options.events,
      phases: options.phases,
      attributions: options.attributions,
      ...(options.filesystemStateDeltas === undefined
        ? {}
        : { filesystemStateDeltas: options.filesystemStateDeltas }),
    }),
    installLifecycle:
      options.installObservation === undefined
        ? {
            status: "not_run",
            reason:
              "The supplied target did not provide a reusable npm lock and cache for the controlled install comparison.",
            limitations: [
              "Runtime behavior does not include consumer-install lifecycle coverage for this target.",
            ],
          }
        : {
            status: "observed",
            experiments: options.installObservation.experiments.map(
              (experiment) => ({
                experimentId: experiment.experimentId,
                lifecycleScripts:
                  experiment.mode === "scripts-enabled" ? "enabled" : "disabled",
                outcome: experiment.outcome.status,
                eventCount: options.events.filter(
                  (event) => event.experimentId === experiment.experimentId,
                ).length,
                metadata: `raw/${experiment.experimentId}/install.json`,
              }),
            ),
            comparisonStatus:
              options.installDelta === undefined ? "inconclusive" : "complete",
            ...(options.installDelta === undefined
              ? {}
              : {
                  delta: {
                    controlExperimentId:
                      options.installDelta.controlExperimentId,
                    treatmentExperimentId:
                      options.installDelta.treatmentExperimentId,
                    treatmentOnly: options.installDelta.treatmentOnly,
                    controlOnly: options.installDelta.controlOnly,
                  },
                }),
            limitations:
              options.installDelta === undefined
                ? [
                    "The install A/B comparison is inconclusive because one or both experiments did not complete.",
                  ]
                : options.installDelta.limitations,
          },
    findings: [...options.findings],
    evidence: {
      manifest: "run.json",
      events: "events.jsonl",
      phases: "phases.jsonl",
      attributions: "attributions.jsonl",
      findings: "findings.jsonl",
      targetProvenance: "target/provenance.json",
      staticInspection: "static/inspection.json",
      preInstallStaticInspection: "static/pre-install-inspection.json",
      ...(options.semanticAnalysis === undefined
        ? {}
        : {
            semanticInspection: options.semanticAnalysis.artifactPath,
            preInstallSemanticInspection:
              "static/pre-install-semantic-inspection.json",
          }),
      advertisedClaims: "mcp/advertised-claims.json",
      ...(options.observationHealth === undefined
        ? {}
        : { observationHealth: "observation-health.json" as const }),
      ...(options.installDelta === undefined
        ? {}
        : { installDelta: "install/delta.json" }),
      ...((options.filesystemStateDeltas?.length ?? 0) === 0
        ? {}
        : { filesystemStateRoot: "runtime/filesystem-state" }),
    },
    limitations: [...options.limitations],
  };

  await options.store.writeJson("report.json", reportV1Schema, report);
  return report;
}
