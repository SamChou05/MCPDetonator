import { posix } from "node:path";

import {
  initializationEnabled,
  initializationExpectedScope,
  type ExpectedScopeV1,
  type TargetConfigV1,
} from "./config.js";
import type {
  AttributionV1,
  ObservedEventV1,
  PhaseV1,
} from "./contracts/v1.js";
import {
  destinationMatchesExpectedScope,
  pathMatchesExpectedScope,
} from "./expected-scope.js";
import type {
  NodePackageStaticInspectionV1,
  StaticCapability,
} from "./static/contracts.js";

export const comparedBehaviorCapabilities = [
  "filesystem_access",
  "network_access",
  "process_execution",
] as const satisfies readonly StaticCapability[];

export type ComparedBehaviorCapability =
  (typeof comparedBehaviorCapabilities)[number];

export interface AdvertisedClaimReference {
  readonly evidenceId: string;
  readonly fieldReference: string;
}

export type AdvertisedClaimsByExperiment = ReadonlyMap<
  string,
  ReadonlyMap<
    ComparedBehaviorCapability,
    readonly AdvertisedClaimReference[]
  >
>;

export interface BehaviorProfileRoots {
  readonly home: string;
  readonly workspace: string;
}

export interface BehaviorComparisonRow {
  readonly capability: ComparedBehaviorCapability;
  readonly advertisedState:
    | "claimed"
    | "not_claimed"
    | "not_observed"
    | "not_applicable";
  readonly advertisedClaimReferences: AdvertisedClaimReference[];
  readonly staticState: "found" | "not_found";
  readonly staticSignalIds: string[];
  readonly runtimeState: "observed" | "not_observed";
  readonly runtimeEventIds: string[];
  readonly correlationBasis: "phase_timing_and_process_origin_inference";
  readonly temporalOverlapEventIds: string[];
  readonly operatorScopeState: "configured" | "not_configured";
  readonly withinOperatorScopeEventIds: string[];
  readonly outsideOperatorScopeEventIds: string[];
  readonly unclassifiedRuntimeEventIds: string[];
  readonly interpretation: string;
}

export interface BehaviorComparisonScope {
  readonly experimentId: string;
  readonly kind: "initialization" | "tool";
  readonly toolName?: string;
  readonly rows: BehaviorComparisonRow[];
}

export interface BehaviorComparison {
  readonly scopes: BehaviorComparisonScope[];
  readonly limitations: string[];
}

interface SelectedExperiment {
  readonly experimentId: string;
  readonly kind: "initialization" | "tool";
  readonly toolName?: string;
  readonly expectedScope?: ExpectedScopeV1;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function compareClaimReferences(
  left: AdvertisedClaimReference,
  right: AdvertisedClaimReference,
): number {
  return (
    compareStrings(left.evidenceId, right.evidenceId) ||
    compareStrings(left.fieldReference, right.fieldReference)
  );
}

function stableClaimReferences(
  references: readonly AdvertisedClaimReference[],
): AdvertisedClaimReference[] {
  const byKey = new Map<string, AdvertisedClaimReference>();
  for (const reference of references) {
    const key = JSON.stringify([reference.evidenceId, reference.fieldReference]);
    byKey.set(key, reference);
  }
  return [...byKey.values()].sort(compareClaimReferences);
}

function uniqueById<T>(
  values: readonly T[],
  id: (value: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const identifier = id(value);
    if (result.has(identifier)) {
      throw new Error(`duplicate ${label} '${identifier}'`);
    }
    result.set(identifier, value);
  }
  return result;
}

function pathIsInside(path: string, root: string): boolean {
  const canonicalPath = posix.resolve(path);
  const canonicalRoot = posix.resolve(root);
  const relativePath = posix.relative(canonicalRoot, canonicalPath);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith("../") &&
      !posix.isAbsolute(relativePath))
  );
}

function processIdentity(experimentId: string, processRef: string): string {
  return JSON.stringify([experimentId, processRef]);
}

function selectedEvent(
  event: ObservedEventV1,
  experiment: SelectedExperiment,
  attributionByEventId: ReadonlyMap<string, AttributionV1>,
  phaseById: ReadonlyMap<string, PhaseV1>,
): boolean {
  if (event.experimentId !== experiment.experimentId) {
    return false;
  }
  const attribution = attributionByEventId.get(event.eventId);
  const activePhase =
    attribution?.activePhaseId === undefined
      ? undefined
      : phaseById.get(attribution.activePhaseId);
  if (
    activePhase === undefined ||
    activePhase.experimentId !== experiment.experimentId
  ) {
    return false;
  }

  if (experiment.kind === "initialization") {
    return (
      activePhase.kind === "initialization" || activePhase.kind === "cooldown"
    );
  }
  if (activePhase.kind === "tool") {
    return true;
  }
  if (activePhase.kind !== "cooldown") {
    return false;
  }

  const originPhase =
    attribution?.processOriginPhaseId === undefined
      ? undefined
      : phaseById.get(attribution.processOriginPhaseId);
  return (
    originPhase?.experimentId === experiment.experimentId &&
    originPhase.kind === "tool"
  );
}

function isToolPhaseTemporalOverlap(
  event: ObservedEventV1,
  experiment: SelectedExperiment,
  attributionByEventId: ReadonlyMap<string, AttributionV1>,
  phaseById: ReadonlyMap<string, PhaseV1>,
): boolean {
  if (experiment.kind !== "tool") {
    return false;
  }
  const attribution = attributionByEventId.get(event.eventId);
  if (attribution?.activePhaseId === undefined) {
    return false;
  }
  const activePhase = phaseById.get(attribution.activePhaseId);
  if (
    activePhase?.experimentId !== experiment.experimentId ||
    activePhase.kind !== "tool"
  ) {
    return false;
  }
  return (
    attribution.reasons.includes("tool_phase_temporal_overlap_only") ||
    attribution.processOriginPhaseId !== attribution.activePhaseId
  );
}

function capabilityForEvent(
  event: ObservedEventV1,
  childProcessIdentities: ReadonlySet<string>,
  roots: BehaviorProfileRoots,
): ComparedBehaviorCapability | undefined {
  switch (event.effect.kind) {
    case "file.open":
    case "file.read":
    case "file.write":
    case "file.delete": {
      const path = event.effect.path;
      return [roots.home, roots.workspace].some((root) =>
        pathIsInside(path, root),
      )
        ? "filesystem_access"
        : undefined;
    }
    case "network.connect_attempt":
    case "network.listen":
      return event.effect.protocol === "unix" ? undefined : "network_access";
    case "process.exec":
      return childProcessIdentities.has(
        processIdentity(event.experimentId, event.processRef),
      )
        ? "process_execution"
        : undefined;
    default:
      return undefined;
  }
}

function filePathMatchesScope(
  event: ObservedEventV1,
  expected: ExpectedScopeV1,
): boolean {
  if (
    event.effect.kind !== "file.open" &&
    event.effect.kind !== "file.read" &&
    event.effect.kind !== "file.write" &&
    event.effect.kind !== "file.delete"
  ) {
    return false;
  }
  const path = posix.resolve(event.effect.path);
  if (event.effect.kind === "file.read") {
    return pathMatchesExpectedScope(
      path,
      expected.fileReads,
      expected.fileReadPrefixes,
    );
  }
  if (event.effect.kind === "file.write" || event.effect.kind === "file.delete") {
    return pathMatchesExpectedScope(
      path,
      expected.fileWrites,
      expected.fileWritePrefixes,
    );
  }

  return (
    pathMatchesExpectedScope(
      path,
      expected.fileReads,
      expected.fileReadPrefixes,
    ) ||
    pathMatchesExpectedScope(
      path,
      expected.fileWrites,
      expected.fileWritePrefixes,
    )
  );
}

function eventMatchesScope(
  event: ObservedEventV1,
  capability: ComparedBehaviorCapability,
  expected: ExpectedScopeV1,
): boolean {
  switch (capability) {
    case "filesystem_access":
      return filePathMatchesScope(event, expected);
    case "network_access":
      return (
        event.effect.kind === "network.connect_attempt" &&
        destinationMatchesExpectedScope(
          event.effect.address,
          event.effect.port,
          expected.networkConnections,
        )
      );
    case "process_execution":
      return (
        event.effect.kind === "process.exec" &&
        pathMatchesExpectedScope(
          event.effect.executable,
          expected.childExecutables,
          expected.childExecutablePrefixes,
        )
      );
  }
}

function interpretation(options: {
  readonly kind: SelectedExperiment["kind"];
  readonly advertisedState: BehaviorComparisonRow["advertisedState"];
  readonly staticState: BehaviorComparisonRow["staticState"];
  readonly runtimeEventIds: readonly string[];
  readonly expectedScopeConfigured: boolean;
  readonly withinCount: number;
  readonly outsideCount: number;
  readonly temporalOverlapCount: number;
}): string {
  const advertised =
    options.advertisedState === "not_applicable"
      ? "Initialization has no tool advertisement to compare."
      : options.advertisedState === "not_observed"
        ? "No bounded MCP claim assessment was available for this experiment's configured tool, so advertised capability claims are not observed; this provides no evidence of absence and does not grant or deny authorization."
        : options.advertisedState === "claimed"
          ? "Untrusted MCP tool metadata advertises this capability; that claim does not grant authorization."
          : "No matching claim was found in the bounded MCP tool metadata; that absence does not grant or deny authorization.";
  const staticEvidence =
    options.staticState === "found"
      ? "The bounded package-authored source scan found a matching lexical signal."
      : "The bounded package-authored source scan found no matching lexical signal; this is not proof that the capability is absent.";
  const runtime =
    options.runtimeEventIds.length > 0
      ? `Selected ${options.kind} phases observed ${options.runtimeEventIds.length} matching runtime ${options.runtimeEventIds.length === 1 ? "event" : "events"}, including failed attempts.`
      : `No matching runtime event was observed in the selected ${options.kind} phases; selected non-observation is not proof of absence for other inputs, phases, or environments.`;
  const correlation =
    options.temporalOverlapCount === 0
      ? "Runtime correlation is based on phase timing and inferred process origin, not source-line causality."
      : `${options.temporalOverlapCount} tool-phase ${options.temporalOverlapCount === 1 ? "event is" : "events are"} marked as temporal overlap only because process origin does not uniquely tie ${options.temporalOverlapCount === 1 ? "it" : "them"} to the tool handler.`;
  const scope = options.expectedScopeConfigured
    ? `${options.withinCount} runtime ${options.withinCount === 1 ? "event was" : "events were"} within the operator-authored scope and ${options.outsideCount} ${options.outsideCount === 1 ? "was" : "were"} outside it; advertised claims never enlarge that scope.`
    : "No operator-authored initialization scope was configured, so observed runtime events are unclassified rather than treated as approved.";
  return `${advertised} ${staticEvidence} ${runtime} ${correlation} ${scope}`;
}

export function compareAdvertisedStaticObservedAndApproved(options: {
  readonly config: TargetConfigV1;
  readonly advertisedClaimsByExperiment: AdvertisedClaimsByExperiment;
  readonly staticInspection: NodePackageStaticInspectionV1;
  readonly events: readonly ObservedEventV1[];
  readonly phases: readonly PhaseV1[];
  readonly attributions: readonly AttributionV1[];
  readonly profileRootsByExperiment: ReadonlyMap<
    string,
    BehaviorProfileRoots
  >;
}): BehaviorComparison {
  const phaseById = uniqueById(
    options.phases,
    (phase) => phase.phaseId,
    "phase ID",
  );
  const eventById = uniqueById(
    options.events,
    (event) => event.eventId,
    "event ID",
  );
  const attributionByEventId = uniqueById(
    options.attributions,
    (attribution) => attribution.eventId,
    "attribution event ID",
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
  const staticSignalIdsByCapability = new Map<
    ComparedBehaviorCapability,
    string[]
  >();
  for (const signal of options.staticInspection.source.signals) {
    if (
      !comparedBehaviorCapabilities.some(
        (capability) => capability === signal.capability,
      )
    ) {
      continue;
    }
    const capability = signal.capability as ComparedBehaviorCapability;
    const ids = staticSignalIdsByCapability.get(capability) ?? [];
    ids.push(signal.signalId);
    staticSignalIdsByCapability.set(capability, ids);
  }

  const experiments: SelectedExperiment[] = [];
  if (initializationEnabled(options.config.experiments.initialization)) {
    const expectedScope = initializationExpectedScope(
      options.config.experiments.initialization,
    );
    experiments.push({
      experimentId: "baseline-initialization",
      kind: "initialization",
      ...(expectedScope === undefined ? {} : { expectedScope }),
    });
  }
  for (const experiment of [...options.config.experiments.tools].sort(
    (left, right) =>
      compareStrings(left.id, right.id) || compareStrings(left.tool, right.tool),
  )) {
    experiments.push({
      experimentId: experiment.id,
      kind: "tool",
      toolName: experiment.tool,
      expectedScope: experiment.expected,
    });
  }

  const scopes = experiments.map((experiment): BehaviorComparisonScope => {
    const roots = options.profileRootsByExperiment.get(experiment.experimentId);
    if (roots === undefined) {
      throw new Error(
        `missing sandbox profile roots for experiment '${experiment.experimentId}'`,
      );
    }
    const runtimeEventsByCapability = new Map<
      ComparedBehaviorCapability,
      ObservedEventV1[]
    >();
    for (const event of eventById.values()) {
      if (
        !selectedEvent(
          event,
          experiment,
          attributionByEventId,
          phaseById,
        )
      ) {
        continue;
      }
      const capability = capabilityForEvent(
        event,
        childProcessIdentities,
        roots,
      );
      if (capability === undefined) {
        continue;
      }
      const events = runtimeEventsByCapability.get(capability) ?? [];
      events.push(event);
      runtimeEventsByCapability.set(capability, events);
    }

    const rows = comparedBehaviorCapabilities.map(
      (capability): BehaviorComparisonRow => {
        const claimsForExperiment =
          experiment.toolName === undefined
            ? undefined
            : options.advertisedClaimsByExperiment.get(experiment.experimentId);
        const claimReferences = stableClaimReferences(
          claimsForExperiment?.get(capability) ?? [],
        );
        const advertisedState: BehaviorComparisonRow["advertisedState"] =
          experiment.toolName === undefined
            ? "not_applicable"
            : claimsForExperiment === undefined
              ? "not_observed"
              : claimReferences.length > 0
                ? "claimed"
                : "not_claimed";
        const staticSignalIds = sortedUnique(
          staticSignalIdsByCapability.get(capability) ?? [],
        );
        const staticState: BehaviorComparisonRow["staticState"] =
          staticSignalIds.length > 0 ? "found" : "not_found";
        const runtimeEvents = runtimeEventsByCapability.get(capability) ?? [];
        const runtimeEventIds = sortedUnique(
          runtimeEvents.map((event) => event.eventId),
        );
        const temporalOverlapEventIds = sortedUnique(
          runtimeEvents
            .filter((event) =>
              isToolPhaseTemporalOverlap(
                event,
                experiment,
                attributionByEventId,
                phaseById,
              ),
            )
            .map((event) => event.eventId),
        );
        const expectedScope = experiment.expectedScope;
        const withinOperatorScopeEventIds =
          expectedScope === undefined
            ? []
            : sortedUnique(
                runtimeEvents
                  .filter((event) =>
                    eventMatchesScope(event, capability, expectedScope),
                  )
                  .map((event) => event.eventId),
              );
        const withinIds = new Set(withinOperatorScopeEventIds);
        const outsideOperatorScopeEventIds =
          expectedScope === undefined
            ? []
            : runtimeEventIds.filter((eventId) => !withinIds.has(eventId));
        const unclassifiedRuntimeEventIds =
          expectedScope === undefined ? runtimeEventIds : [];

        return {
          capability,
          advertisedState,
          advertisedClaimReferences: claimReferences,
          staticState,
          staticSignalIds,
          runtimeState:
            runtimeEventIds.length > 0 ? "observed" : "not_observed",
          runtimeEventIds,
          correlationBasis: "phase_timing_and_process_origin_inference",
          temporalOverlapEventIds,
          operatorScopeState:
            expectedScope === undefined
              ? "not_configured"
              : "configured",
          withinOperatorScopeEventIds,
          outsideOperatorScopeEventIds,
          unclassifiedRuntimeEventIds,
          interpretation: interpretation({
            kind: experiment.kind,
            advertisedState,
            staticState,
            runtimeEventIds,
            expectedScopeConfigured: expectedScope !== undefined,
            withinCount: withinOperatorScopeEventIds.length,
            outsideCount: outsideOperatorScopeEventIds.length,
            temporalOverlapCount: temporalOverlapEventIds.length,
          }),
        };
      },
    );

    return {
      experimentId: experiment.experimentId,
      kind: experiment.kind,
      ...(experiment.toolName === undefined
        ? {}
        : { toolName: experiment.toolName }),
      rows,
    };
  });

  return {
    scopes,
    limitations: [
      "Advertised claims are untrusted MCP metadata, static signals are bounded lexical evidence, and neither is authorization.",
      "An advertised state of not_observed means no per-experiment claim assessment was available for the configured tool; not_claimed means an available bounded assessment produced no matching claim.",
      "Runtime comparison covers selected lifecycle phases and inputs only; non-observation is not proof of universal absence.",
      "Runtime correlation uses phase timing and inferred process origin; temporalOverlapEventIds retain active tool-phase observations that are not unique causal attribution to the tool handler.",
      "Filesystem runtime evidence is limited to synthetic home/workspace roots, root-server exec is excluded, and Unix-domain socket activity is excluded.",
      "A file.open event does not encode access mode, so it is within configured scope when its path is allowed for either reading or writing.",
      "A file.delete event is evaluated against configured write scope because the current operator scope has no separate delete permission.",
      "Network listen events are runtime network evidence but outside configured networkConnections because the current operator scope cannot express listeners.",
    ],
  };
}
