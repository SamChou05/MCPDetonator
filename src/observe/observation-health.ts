import { readdir } from "node:fs/promises";

import {
  observationHealthV1Schema,
  type ObservationHealthV1,
  type ObservedEventV1,
} from "../contracts/v1.js";
import type { EvidenceStore } from "../evidence-store.js";
import {
  classifyPolicyRelevantTraceGaps,
  maxPolicyRelevantTraceGapExamples,
  type ObservedPathMapping,
} from "./strace-normalizer.js";
import { readExperimentStraceDetailed } from "./strace-parser.js";

export const observationHealthArtifactPath = "observation-health.json";

function uniqueExperimentIds(experimentIds: readonly string[]): string[] {
  const unique = [...new Set(experimentIds)];
  if (unique.length !== experimentIds.length) {
    throw new Error("observation health requires unique experiment IDs");
  }
  if (unique.length === 0) {
    throw new Error("observation health requires at least one experiment");
  }
  return unique;
}

export async function discoverStraceExperimentIds(
  store: EvidenceStore,
): Promise<string[]> {
  const entries = await readdir(store.pathFor("raw"), { withFileTypes: true });
  const experimentIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const children = await readdir(store.pathFor(`raw/${entry.name}`), {
      withFileTypes: true,
    }).catch(() => []);
    if (
      children.some(
        (child) => child.isFile() && /^strace\.\d+$/.test(child.name),
      )
    ) {
      experimentIds.push(entry.name);
    }
  }
  return experimentIds.sort((left, right) => left.localeCompare(right));
}

export async function collectObservationHealth(options: {
  readonly store: EvidenceStore;
  readonly runId: string;
  readonly experimentIds: readonly string[];
  readonly pathMappingsByExperiment?: ReadonlyMap<
    string,
    readonly ObservedPathMapping[]
  >;
  readonly policyRelevantPathPrefixesByExperiment?: ReadonlyMap<
    string,
    readonly string[]
  >;
  readonly events?: readonly ObservedEventV1[];
  readonly generatedAt?: string;
}): Promise<ObservationHealthV1> {
  const experimentIds = uniqueExperimentIds(options.experimentIds);
  const knownExperimentIds = new Set(experimentIds);
  if (
    options.events?.some(
      (event) =>
        event.runId !== options.runId ||
        !knownExperimentIds.has(event.experimentId),
    ) === true
  ) {
    throw new Error(
      "canonical events must belong to the observation-health run and experiments",
    );
  }

  const eventCountByExperiment = new Map<string, number>();
  for (const event of options.events ?? []) {
    eventCountByExperiment.set(
      event.experimentId,
      (eventCountByExperiment.get(event.experimentId) ?? 0) + 1,
    );
  }

  const experiments = [];
  for (const experimentId of experimentIds) {
    const parsed = await readExperimentStraceDetailed(
      options.store.pathFor(`raw/${experimentId}`),
      experimentId,
    );
    const relevantPathPrefixes =
      options.policyRelevantPathPrefixesByExperiment?.get(experimentId);
    const syscallCounts = new Map<string, number>();
    for (const record of parsed.records) {
      if (record.kind === "syscall") {
        syscallCounts.set(
          record.syscall,
          (syscallCounts.get(record.syscall) ?? 0) + 1,
        );
      }
    }
    const capturedSyscallCounts = [...syscallCounts]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([syscall, recordCount]) => ({ syscall, recordCount }));
    const policyRelevantGaps = classifyPolicyRelevantTraceGaps(parsed.records, {
      pathMappings:
        options.pathMappingsByExperiment?.get(experimentId) ?? [],
      ...(relevantPathPrefixes === undefined
        ? {}
        : { relevantPathPrefixes }),
      maxExamples: maxPolicyRelevantTraceGapExamples,
    });
    experiments.push({
      experimentId,
      ...parsed.health,
      capturedSyscallCounts,
      canonicalization:
        options.events === undefined
          ? { status: "not_completed" as const }
          : {
              status: "completed" as const,
              emittedEventCount: eventCountByExperiment.get(experimentId) ?? 0,
            },
      policyRelevantGaps,
    });
  }

  const degradedExperimentIds = experiments
    .filter((experiment) => !experiment.integrityComplete)
    .map((experiment) => experiment.experimentId);
  const policyRelevantGapExperimentIds = experiments
    .filter((experiment) => experiment.policyRelevantGaps.recordCount > 0)
    .map((experiment) => experiment.experimentId);

  return observationHealthV1Schema.parse({
    schema: "forge.observation-health/v1",
    runId: options.runId,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    scope: "selected_strace_surface",
    surfaceId: "forge-strace-selected-v1",
    integrityStatus:
      degradedExperimentIds.length === 0 ? "complete" : "degraded",
    canonicalizationExecutionStatus:
      options.events === undefined ? "incomplete" : "completed",
    policyRelevantGapStatus:
      policyRelevantGapExperimentIds.length === 0
        ? "none_observed"
        : "gaps_observed",
    degradedExperimentIds,
    policyRelevantGapExperimentIds,
    experiments,
    limitations: [
      "Integrity accounts only for nonempty lines emitted within Forge's selected strace filter; it does not establish complete syscall, kernel, or userspace coverage.",
      "String truncation counts bounded strace payload rendering and does not alone degrade structural integrity; recognized truncation of a relied-on path or executable is reported as a semantic coverage gap.",
      "Policy-relevant gaps use a bounded selected taxonomy; unclassified parsed syscalls are not proof of irrelevance.",
    ],
  });
}

export async function writeObservationHealth(options: {
  readonly store: EvidenceStore;
  readonly runId: string;
  readonly experimentIds: readonly string[];
  readonly pathMappingsByExperiment?: ReadonlyMap<
    string,
    readonly ObservedPathMapping[]
  >;
  readonly policyRelevantPathPrefixesByExperiment?: ReadonlyMap<
    string,
    readonly string[]
  >;
  readonly events?: readonly ObservedEventV1[];
  readonly generatedAt?: string;
}): Promise<ObservationHealthV1> {
  const health = await collectObservationHealth(options);
  await options.store.writeJson(
    observationHealthArtifactPath,
    observationHealthV1Schema,
    health,
  );
  return health;
}
