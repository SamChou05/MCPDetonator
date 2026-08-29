import type { TargetConfigV1 } from "./config.js";
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
  pathMatchesExpectedScope,
} from "./expected-scope.js";

function attributionFor(
  event: ObservedEventV1,
  attributions: ReadonlyMap<string, AttributionV1>,
): AttributionV1 | undefined {
  return attributions.get(event.eventId);
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
    const syntheticRoots = [profileRoots.home, profileRoots.workspace].map((root) =>
      root.endsWith("/") ? root : `${root}/`,
    );

    const unexpectedPaths = new Map<string, ObservedEventV1[]>();
    for (const event of activeEvents) {
      if (event.effect.kind !== "file.read" && event.effect.kind !== "file.write") {
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
        !syntheticRoots.some((root) => path.startsWith(root)) ||
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
      findings.push(
        finding({
          id: `finding-${experiment.id}-file-scope-${pathIndex}`,
          runId: options.runId,
          ruleId: "runtime.file_scope_exceeded",
          title: isSensitive
            ? "Tool read an unrelated synthetic credential"
            : "Tool exceeded its analyst-expected filesystem scope",
          summary: `${experiment.tool} performed ${kind} on ${path}, which was not included in the configured expected scope.`,
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
  }

  await options.store.writeJsonl("findings.jsonl", findingV1Schema, findings);
  return findings;
}
