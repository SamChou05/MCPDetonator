import type { TargetConfigV1 } from "./config.js";
import {
  reportV1Schema,
  type AttributionV1,
  type FindingV1,
  type McpInterfaceV1,
  type ObservedEventV1,
  type PhaseV1,
  type ReportV1,
  type TargetProvenanceV1,
} from "./contracts/v1.js";
import type { EvidenceStore } from "./evidence-store.js";
import {
  destinationMatchesExpectedScope,
  pathMatchesExpectedScope,
} from "./expected-scope.js";
import type {
  NodePackageStaticInspectionV1,
  StaticCapability,
} from "./static/contracts.js";
import type { InstallLifecycleObservation } from "./install/lifecycle.js";
import type { InstallLifecycleDeltaV1 } from "./install/delta.js";

const maxExpectedScopeExamples = 25;
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

type ProfileRootsByExperiment = ReadonlyMap<
  string,
  { readonly home: string; readonly workspace: string }
>;

type RuntimeObservation = ReportV1["runtimeObservations"][number];
type ExpectedScopeExample = NonNullable<
  RuntimeObservation["expectedScopeMatches"]
>["examples"][number];

function eventMatchesExpectedScope(
  event: ObservedEventV1,
  expected: TargetConfigV1["experiments"]["tools"][number]["expected"],
): boolean {
  switch (event.effect.kind) {
    case "file.read":
      return pathMatchesExpectedScope(
        event.effect.path,
        expected.fileReads,
        expected.fileReadPrefixes,
      );
    case "file.write":
      return pathMatchesExpectedScope(
        event.effect.path,
        expected.fileWrites,
        expected.fileWritePrefixes,
      );
    case "process.exec":
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
    case "file.write":
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

export function summarizeRuntimeObservations(options: {
  readonly config: TargetConfigV1;
  readonly events: readonly ObservedEventV1[];
  readonly phases: readonly PhaseV1[];
  readonly attributions: readonly AttributionV1[];
}): ReportV1["runtimeObservations"] {
  const attributionByEvent = new Map(
    options.attributions.map((attribution) => [attribution.eventId, attribution]),
  );
  const observations: ReportV1["runtimeObservations"] = [];

  if (options.config.experiments.initialization) {
    const experimentEvents = options.events.filter(
      (event) => event.experimentId === "baseline-initialization",
    );
    const initializationPhase = options.phases.find(
      (phase) =>
        phase.experimentId === "baseline-initialization" &&
        phase.kind === "initialization",
    );
    const initializationEvents =
      initializationPhase === undefined
        ? []
        : experimentEvents.filter(
            (event) =>
              attributionByEvent.get(event.eventId)?.activePhaseId ===
              initializationPhase.phaseId,
          );
    observations.push({
      experimentId: "baseline-initialization",
      kind: "initialization",
      effectCounts: effectCounts(initializationEvents),
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
    observations.push({
      experimentId: experiment.id,
      kind: "tool",
      toolName: experiment.tool,
      effectCounts: effectCounts(toolEvents),
      expectedScopeMatches: {
        eventCount: matchingEvents.length,
        examples,
        examplesTruncated: uniqueExamples.size > examples.length,
      },
    });
  }

  return observations;
}

function pathIsInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
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
  const childProcessRefs = new Set(
    options.events
      .filter(
        (event) =>
          event.effect.kind === "process.start" &&
          event.effect.parentProcessRef !== undefined,
      )
      .map((event) => event.processRef),
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
      event.effect.kind === "file.read" ||
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
      event.effect.outcome.status === "succeeded" &&
      childProcessRefs.has(event.processRef)
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
      "Package-authored source signals compared with analyst-relevant effects from selected initialization, tool, and tool-originated cooldown phases.",
    rows,
    limitations: [
      "The static scan is bounded lexical analysis of package-authored source and excludes dependency source.",
      "Filesystem comparison is limited to normalized reads, writes, and deletes under the synthetic home/workspace roots, so open-only activity is excluded; process comparison excludes the root server exec; network comparison excludes Unix-domain sockets.",
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
  readonly profileRootsByExperiment: ProfileRootsByExperiment;
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
  const canonicalInterface = options.interfaces[0];
  const advertisedTools = (canonicalInterface?.tools ?? []).map((tool) => ({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema,
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
    ...(options.config.experiments.initialization
      ? [
          {
            experimentId: "baseline-initialization",
            kind: "initialization" as const,
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
  const report: ReportV1 = {
    schema: "forge.report/v1",
    runId: options.runId,
    targetId: options.config.target.id,
    generatedAt: new Date().toISOString(),
    summary:
      options.findings.length === 0
        ? "Within the selected experiments and current rule coverage, Forge found no deterministic runtime findings."
        : `Within the selected experiments and current rule coverage, Forge found ${options.findings.length} deterministic runtime ${options.findings.length === 1 ? "finding" : "findings"}.`,
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
    staticAnalysis: summarizeStaticAnalysis(options.staticInspection, runtimeSnapshot),
    staticRuntimeComparison: compareStaticAndRuntime({
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
      ...(options.installDelta === undefined
        ? {}
        : { installDelta: "install/delta.json" }),
    },
    limitations: [...options.limitations],
  };

  await options.store.writeJson("report.json", reportV1Schema, report);
  return report;
}
