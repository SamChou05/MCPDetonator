import {
  initializationExpectedScope,
  type TargetConfigV1,
} from "./config.js";
import {
  findingV1Schema,
  type AttributionV1,
  type FindingV1,
  type ObservedEventV1,
  type PhaseV1,
} from "./contracts/v1.js";
import type { EvidenceStore } from "./evidence-store.js";
import {
  destinationMatchesExpectedScope,
  isRoutineNameServiceConnection,
  pathMatchesExpectedScope,
} from "./expected-scope.js";

function attributionFor(
  event: ObservedEventV1,
  attributions: ReadonlyMap<string, AttributionV1>,
): AttributionV1 | undefined {
  return attributions.get(event.eventId);
}

function pathIsInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function finding(options: {
  readonly id: string;
  readonly runId: string;
  readonly ruleId: string;
  readonly title: string;
  readonly summary: string;
  readonly severity: FindingV1["severity"];
  readonly events: readonly ObservedEventV1[];
  readonly attributions: ReadonlyMap<string, AttributionV1>;
}): FindingV1 {
  const linkedAttributions = options.events
    .map((event) => options.attributions.get(event.eventId))
    .filter((value): value is AttributionV1 => value !== undefined);
  const confidence: FindingV1["confidence"] = linkedAttributions.every(
    (value) => value.confidence === "high",
  )
    ? "high"
    : linkedAttributions.some((value) => value.confidence === "unattributed")
      ? "low"
      : "medium";

  return findingV1Schema.parse({
    schema: "forge.finding/v1",
    findingId: options.id,
    runId: options.runId,
    ruleId: options.ruleId,
    title: options.title,
    summary: options.summary,
    severity: options.severity,
    confidence,
    eventIds: options.events.map((event) => event.eventId),
    attributionIds: linkedAttributions.map((value) => value.attributionId),
    limitations:
      confidence === "high"
        ? []
        : ["Phase timing and process lineage do not establish unique causality here."],
  });
}

export async function evaluateRuntimeRules(options: {
  readonly store: EvidenceStore;
  readonly runId: string;
  readonly config: TargetConfigV1;
  readonly events: readonly ObservedEventV1[];
  readonly phases: readonly PhaseV1[];
  readonly attributions: readonly AttributionV1[];
  readonly sensitivePathsByExperiment: ReadonlyMap<string, ReadonlySet<string>>;
  readonly profileRootsByExperiment: ReadonlyMap<
    string,
    { readonly home: string; readonly workspace: string }
  >;
}): Promise<FindingV1[]> {
  const attributionMap = new Map(
    options.attributions.map((attribution) => [attribution.eventId, attribution]),
  );
  const findings: FindingV1[] = [];

  const initializationPhaseIds = new Set(
    options.phases
      .filter(
        (phase) =>
          phase.experimentId === "baseline-initialization" &&
          phase.kind === "initialization",
      )
      .map((phase) => phase.phaseId),
  );
  const initializationCooldownPhaseIds = new Set(
    options.phases
      .filter(
        (phase) =>
          phase.experimentId === "baseline-initialization" &&
          phase.kind === "cooldown",
      )
      .map((phase) => phase.phaseId),
  );
  const initializationEvents = options.events.filter(
    (event) => {
      if (event.experimentId !== "baseline-initialization") {
        return false;
      }
      const attribution = attributionFor(event, attributionMap);
      const activePhaseId = attribution?.activePhaseId ?? "";
      return (
        initializationPhaseIds.has(activePhaseId) ||
        initializationCooldownPhaseIds.has(activePhaseId)
      );
    },
  );
  const initializationSensitivePaths =
    options.sensitivePathsByExperiment.get("baseline-initialization") ?? new Set();
  const sensitiveInitializationEventIds = new Set<string>();
  if (initializationPhaseIds.size > 0) {
    const accessesByPath = new Map<string, ObservedEventV1[]>();
    for (const event of initializationEvents) {
      if (
        event.effect.kind !== "file.read" ||
        event.effect.operation === "directory_entries" ||
        !initializationSensitivePaths.has(event.effect.path)
      ) {
        continue;
      }
      sensitiveInitializationEventIds.add(event.eventId);
      const existing = accessesByPath.get(event.effect.path) ?? [];
      existing.push(event);
      accessesByPath.set(event.effect.path, existing);
    }

    let sensitiveIndex = 0;
    for (const [path, events] of accessesByPath) {
      sensitiveIndex += 1;
      const succeeded = events.some(
        (event) =>
          event.effect.kind === "file.read" &&
          event.effect.outcome.status === "succeeded",
      );
      findings.push(
        finding({
          id: `finding-initialization-sensitive-access-${sensitiveIndex}`,
          runId: options.runId,
          ruleId: "runtime.initialization_sensitive_access",
          title: succeeded
            ? "Initialization read a synthetic credential"
            : "Initialization attempted to read a synthetic credential",
          summary: succeeded
            ? `The MCP read ${path} during initialization or its baseline cooldown, before any tool was called.`
            : `The MCP attempted to read ${path} during initialization or its baseline cooldown, before any tool was called, but the recorded read syscall failed.`,
          severity: "high",
          events,
          attributions: attributionMap,
        }),
      );
    }
  }

  const initializationScope = initializationExpectedScope(
    options.config.experiments.initialization,
  );
  if (initializationScope !== undefined && initializationPhaseIds.size > 0) {
    const profileRoots = options.profileRootsByExperiment.get(
      "baseline-initialization",
    );
    if (profileRoots === undefined) {
      throw new Error(
        "missing sandbox profile roots for experiment 'baseline-initialization'",
      );
    }
    const syntheticRoots = [profileRoots.home, profileRoots.workspace];
    const unexpectedPaths = new Map<
      string,
      {
        readonly kind: "file.read" | "file.write" | "file.delete";
        readonly path: string;
        readonly events: ObservedEventV1[];
      }
    >();

    for (const event of initializationEvents) {
      if (
        event.effect.kind !== "file.read" &&
        event.effect.kind !== "file.write" &&
        event.effect.kind !== "file.delete"
      ) {
        continue;
      }
      const effect = event.effect;
      if (
        effect.kind === "file.read" &&
        effect.operation === "directory_entries"
      ) {
        continue;
      }
      if (sensitiveInitializationEventIds.has(event.eventId)) {
        continue;
      }
      const kind: "file.read" | "file.write" | "file.delete" =
        effect.kind === "file.read"
          ? "file.read"
          : effect.kind === "file.write"
            ? "file.write"
            : "file.delete";
      const allowed =
        kind === "file.read"
          ? initializationScope.fileReads
          : initializationScope.fileWrites;
      const allowedPrefixes =
        kind === "file.read"
          ? initializationScope.fileReadPrefixes
          : initializationScope.fileWritePrefixes;
      if (
        !syntheticRoots.some((root) => pathIsInside(effect.path, root)) ||
        pathMatchesExpectedScope(effect.path, allowed, allowedPrefixes)
      ) {
        continue;
      }
      const key = `${kind}:${effect.path}`;
      const existing = unexpectedPaths.get(key);
      if (existing === undefined) {
        unexpectedPaths.set(key, {
          kind,
          path: effect.path,
          events: [event],
        });
      } else {
        existing.events.push(event);
      }
    }

    let pathIndex = 0;
    for (const unexpected of unexpectedPaths.values()) {
      pathIndex += 1;
      const succeeded = unexpected.events.some(
        (event) =>
          (event.effect.kind === "file.read" ||
            event.effect.kind === "file.write" ||
            event.effect.kind === "file.delete") &&
          event.effect.outcome.status === "succeeded",
      );
      findings.push(
        finding({
          id: `finding-initialization-file-scope-${pathIndex}`,
          runId: options.runId,
          ruleId: "runtime.initialization_file_scope_exceeded",
          title: "Initialization exceeded its analyst-expected filesystem scope",
          summary: `Initialization ${succeeded ? "performed" : "attempted"} ${unexpected.kind} on ${unexpected.path}, which was not included in the configured expected scope.${succeeded ? "" : " The recorded syscall failed."}`,
          severity: "medium",
          events: unexpected.events,
          attributions: attributionMap,
        }),
      );
    }

    const childProcessRefs = new Set(
      options.events
        .filter(
          (event) =>
            event.experimentId === "baseline-initialization" &&
            event.effect.kind === "process.start" &&
            event.effect.parentProcessRef !== undefined,
        )
        .map((event) => event.processRef),
    );
    const unexpectedExecs = initializationEvents.filter(
      (event) =>
        event.effect.kind === "process.exec" &&
        event.effect.outcome.status === "succeeded" &&
        childProcessRefs.has(event.processRef) &&
        !pathMatchesExpectedScope(
          event.effect.executable,
          initializationScope.childExecutables,
          initializationScope.childExecutablePrefixes,
        ),
    );
    for (let index = 0; index < unexpectedExecs.length; index += 1) {
      const event = unexpectedExecs[index];
      if (event?.effect.kind !== "process.exec") {
        continue;
      }
      findings.push(
        finding({
          id: `finding-initialization-unexpected-exec-${index + 1}`,
          runId: options.runId,
          ruleId: "runtime.initialization_unexpected_process_exec",
          title: "Initialization launched an unexpected executable",
          summary: `Initialization executed ${event.effect.executable}, which was not included in the configured expected scope.`,
          severity: "medium",
          events: [event],
          attributions: attributionMap,
        }),
      );
    }

    const unexpectedConnections = initializationEvents.filter(
      (event) =>
        event.effect.kind === "network.connect_attempt" &&
        !isRoutineNameServiceConnection(event.effect) &&
        !destinationMatchesExpectedScope(
          event.effect.address,
          event.effect.port,
          initializationScope.networkConnections,
        ),
    );
    for (let index = 0; index < unexpectedConnections.length; index += 1) {
      const event = unexpectedConnections[index];
      if (event?.effect.kind !== "network.connect_attempt") {
        continue;
      }
      const outcome =
        event.effect.outcome.status === "failed"
          ? ` The sandbox blocked or failed the attempt with ${event.effect.outcome.errno}.`
          : " The connection syscall succeeded.";
      findings.push(
        finding({
          id: `finding-initialization-network-${index + 1}`,
          runId: options.runId,
          ruleId: "runtime.initialization_unexpected_network_attempt",
          title: "Initialization attempted an unexpected network connection",
          summary: `Initialization attempted ${event.effect.address}${event.effect.port === undefined ? "" : `:${event.effect.port}`}, which was not included in the configured expected scope.${outcome}`,
          severity: "medium",
          events: [event],
          attributions: attributionMap,
        }),
      );
    }
  }

  for (const experiment of options.config.experiments.tools) {
    const toolPhase = options.phases.find(
      (phase) => phase.experimentId === experiment.id && phase.kind === "tool",
    );
    if (toolPhase === undefined) {
      continue;
    }

    const activeEvents = options.events.filter(
      (event) =>
        event.experimentId === experiment.id &&
        attributionFor(event, attributionMap)?.activePhaseId === toolPhase.phaseId,
    );
    const sensitivePaths = options.sensitivePathsByExperiment.get(experiment.id) ?? new Set();
    const profileRoots = options.profileRootsByExperiment.get(experiment.id);
    if (profileRoots === undefined) {
      throw new Error(`missing sandbox profile roots for experiment '${experiment.id}'`);
    }
    const syntheticRoots = [profileRoots.home, profileRoots.workspace];

    const unexpectedPaths = new Map<string, ObservedEventV1[]>();
    for (const event of activeEvents) {
      if (
        event.effect.kind !== "file.read" &&
        event.effect.kind !== "file.write" &&
        event.effect.kind !== "file.delete"
      ) {
        continue;
      }
      if (
        event.effect.kind === "file.read" &&
        event.effect.operation === "directory_entries"
      ) {
        continue;
      }
      const allowed =
        event.effect.kind === "file.read"
          ? experiment.expected.fileReads
          : experiment.expected.fileWrites;
      const allowedPrefixes =
        event.effect.kind === "file.read"
          ? experiment.expected.fileReadPrefixes
          : experiment.expected.fileWritePrefixes;
      const path = event.effect.path;
      if (
        !syntheticRoots.some((root) => pathIsInside(path, root)) ||
        pathMatchesExpectedScope(path, allowed, allowedPrefixes)
      ) {
        continue;
      }
      const key = `${event.effect.kind}:${path}`;
      const existing = unexpectedPaths.get(key) ?? [];
      existing.push(event);
      unexpectedPaths.set(key, existing);
    }

    let pathIndex = 0;
    for (const [key, events] of unexpectedPaths) {
      pathIndex += 1;
      const [kind, ...pathParts] = key.split(":");
      const path = pathParts.join(":");
      const isSensitive = sensitivePaths.has(path);
      const succeeded = events.some(
        (event) =>
          (event.effect.kind === "file.read" ||
            event.effect.kind === "file.write" ||
            event.effect.kind === "file.delete") &&
          event.effect.outcome.status === "succeeded",
      );
      const sensitiveTitle =
        kind === "file.read"
          ? succeeded
            ? "Tool read an unrelated synthetic credential"
            : "Tool attempted to read an unrelated synthetic credential"
          : kind === "file.delete"
            ? succeeded
              ? "Tool deleted an unrelated synthetic credential"
              : "Tool attempted to delete an unrelated synthetic credential"
            : succeeded
              ? "Tool modified an unrelated synthetic credential"
              : "Tool attempted to modify an unrelated synthetic credential";
      findings.push(
        finding({
          id: `finding-${experiment.id}-file-scope-${pathIndex}`,
          runId: options.runId,
          ruleId: "runtime.file_scope_exceeded",
          title: isSensitive
            ? sensitiveTitle
            : "Tool exceeded its analyst-expected filesystem scope",
          summary: `${experiment.tool} ${succeeded ? "performed" : "attempted"} ${kind} on ${path}, which was not included in the configured expected scope.${succeeded ? "" : " The recorded syscall failed."}`,
          severity: isSensitive ? "high" : "medium",
          events,
          attributions: attributionMap,
        }),
      );
    }

    const unexpectedExecs = activeEvents.filter(
      (event) =>
        event.effect.kind === "process.exec" &&
        event.effect.outcome.status === "succeeded" &&
        !pathMatchesExpectedScope(
          event.effect.executable,
          experiment.expected.childExecutables,
          experiment.expected.childExecutablePrefixes,
        ),
    );
    for (let index = 0; index < unexpectedExecs.length; index += 1) {
      const event = unexpectedExecs[index];
      if (event?.effect.kind !== "process.exec") {
        continue;
      }
      findings.push(
        finding({
          id: `finding-${experiment.id}-unexpected-exec-${index + 1}`,
          runId: options.runId,
          ruleId: "runtime.unexpected_process_exec",
          title: "Tool launched an unexpected executable",
          summary: `${experiment.tool} executed ${event.effect.executable}, which was not included in the configured expected scope.`,
          severity: "medium",
          events: [event],
          attributions: attributionMap,
        }),
      );
    }

    const unexpectedConnections = activeEvents.filter(
      (event) =>
        event.effect.kind === "network.connect_attempt" &&
        !isRoutineNameServiceConnection(event.effect) &&
        !destinationMatchesExpectedScope(
          event.effect.address,
          event.effect.port,
          experiment.expected.networkConnections,
        ),
    );
    for (let index = 0; index < unexpectedConnections.length; index += 1) {
      const event = unexpectedConnections[index];
      if (event?.effect.kind !== "network.connect_attempt") {
        continue;
      }
      const outcome =
        event.effect.outcome.status === "failed"
          ? ` The sandbox blocked or failed the attempt with ${event.effect.outcome.errno}.`
          : " The connection syscall succeeded.";
      findings.push(
        finding({
          id: `finding-${experiment.id}-network-${index + 1}`,
          runId: options.runId,
          ruleId: "runtime.unexpected_network_attempt",
          title: "Tool attempted an unexpected network connection",
          summary: `${experiment.tool} attempted ${event.effect.address}${event.effect.port === undefined ? "" : `:${event.effect.port}`}, which was not included in the configured expected scope.${outcome}`,
          severity: "medium",
          events: [event],
          attributions: attributionMap,
        }),
      );
    }

    const cooldownPhase = options.phases.find(
      (phase) =>
        phase.experimentId === experiment.id && phase.kind === "cooldown",
    );
    if (cooldownPhase === undefined) {
      continue;
    }
    const postReturnEvents = options.events.filter((event) => {
      if (event.experimentId !== experiment.id) {
        return false;
      }
      const attribution = attributionFor(event, attributionMap);
      if (
        attribution?.activePhaseId !== cooldownPhase.phaseId ||
        attribution.processOriginPhaseId !== toolPhase.phaseId
      ) {
        return false;
      }
      switch (event.effect.kind) {
        case "file.read":
        case "file.write":
        case "file.delete": {
          const path = event.effect.path;
          return syntheticRoots.some((root) => pathIsInside(path, root));
        }
        case "network.connect_attempt":
          return !isRoutineNameServiceConnection(event.effect);
        case "network.listen":
          return true;
        case "process.exec":
          return event.effect.outcome.status === "succeeded";
        default:
          return false;
      }
    });
    if (postReturnEvents.length > 0) {
      const effectKinds = [
        ...new Set(postReturnEvents.map((event) => event.effect.kind)),
      ].sort();
      findings.push(
        finding({
          id: `finding-${experiment.id}-post-return-activity`,
          runId: options.runId,
          ruleId: "runtime.post_return_activity",
          title: "A tool-originated process acted after the tool returned",
          summary: `${experiment.tool} returned before ${postReturnEvents.length} tool-originated ${postReturnEvents.length === 1 ? "effect" : "effects"} occurred during cooldown (${effectKinds.join(", ")}).`,
          severity: "medium",
          events: postReturnEvents,
          attributions: attributionMap,
        }),
      );
    }
  }

  await options.store.writeJsonl("findings.jsonl", findingV1Schema, findings);
  return findings;
}
