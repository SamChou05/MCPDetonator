import { z } from "zod";

import type { ObservedEventV1 } from "../contracts/v1.js";
import type { EvidenceStore } from "../evidence-store.js";

const eventIdsByCategorySchema = z
  .object({
    processExec: z.array(z.string().min(1)),
    fileRead: z.array(z.string().min(1)),
    fileWrite: z.array(z.string().min(1)),
    fileDelete: z.array(z.string().min(1)),
    network: z.array(z.string().min(1)),
  })
  .strict();

export const installLifecycleDeltaV1Schema = z
  .object({
    schema: z.literal("forge.install-delta/v1"),
    runId: z.string().min(1),
    controlExperimentId: z.string().min(1),
    treatmentExperimentId: z.string().min(1),
    treatmentOnly: eventIdsByCategorySchema,
    controlOnly: eventIdsByCategorySchema,
    limitations: z.array(z.string().min(1)),
  })
  .strict();

export type InstallLifecycleDeltaV1 = z.infer<
  typeof installLifecycleDeltaV1Schema
>;

type DeltaCategory = keyof InstallLifecycleDeltaV1["treatmentOnly"];

interface ComparableEvent {
  readonly event: ObservedEventV1;
  readonly category: DeltaCategory;
  readonly fingerprint: string;
}

function fileInsideRoots(path: string, roots: readonly string[]): boolean {
  return roots.some(
    (root) => path === root || path.startsWith(`${root.replace(/\/$/, "")}/`),
  );
}

function normalizedExecArgs(args: readonly string[]): string[] {
  return args.map((argument) =>
    argument.startsWith("--ignore-scripts=")
      ? "--ignore-scripts=<control-variable>"
      : argument,
  );
}

function comparableEvent(
  event: ObservedEventV1,
  includedFileRoots: readonly string[],
): ComparableEvent | undefined {
  const effect = event.effect;
  // Directory enumeration is retained as the closest V1 event shape and is
  // separately declared as a trace-coverage gap. It is not evidence that file
  // contents were read, so do not label it as an install fileRead delta.
  if (
    effect.kind === "file.read" &&
    effect.operation === "directory_entries"
  ) {
    return undefined;
  }
  if (effect.kind === "process.exec" && effect.outcome.status === "succeeded") {
    return {
      event,
      category: "processExec",
      fingerprint: JSON.stringify({
        kind: effect.kind,
        executable: effect.executable,
        args: normalizedExecArgs(effect.args),
        outcome: effect.outcome,
      }),
    };
  }
  if (
    (effect.kind === "file.read" ||
      effect.kind === "file.write" ||
      effect.kind === "file.delete") &&
    fileInsideRoots(effect.path, includedFileRoots)
  ) {
    const category: DeltaCategory =
      effect.kind === "file.read"
        ? "fileRead"
        : effect.kind === "file.write"
          ? "fileWrite"
          : "fileDelete";
    return {
      event,
      category,
      fingerprint: JSON.stringify({
        kind: effect.kind,
        path: effect.path,
        ...(effect.kind === "file.read" || effect.kind === "file.write"
          ? { operation: effect.operation ?? "content" }
          : {}),
        outcome: effect.outcome,
      }),
    };
  }
  if (
    effect.kind === "network.connect_attempt" ||
    effect.kind === "network.listen"
  ) {
    return {
      event,
      category: "network",
      fingerprint: JSON.stringify(effect),
    };
  }
  return undefined;
}

function emptyCategories(): InstallLifecycleDeltaV1["treatmentOnly"] {
  return {
    processExec: [],
    fileRead: [],
    fileWrite: [],
    fileDelete: [],
    network: [],
  };
}

function directionalDifference(
  candidates: readonly ComparableEvent[],
  comparison: readonly ComparableEvent[],
): InstallLifecycleDeltaV1["treatmentOnly"] {
  const remaining = new Map<string, number>();
  for (const entry of comparison) {
    remaining.set(entry.fingerprint, (remaining.get(entry.fingerprint) ?? 0) + 1);
  }
  const result = emptyCategories();
  for (const entry of candidates) {
    const count = remaining.get(entry.fingerprint) ?? 0;
    if (count > 0) {
      remaining.set(entry.fingerprint, count - 1);
    } else {
      result[entry.category].push(entry.event.eventId);
    }
  }
  return result;
}

export async function compareInstallLifecycle(options: {
  readonly store: EvidenceStore;
  readonly runId: string;
  readonly events: readonly ObservedEventV1[];
  readonly controlExperimentId: string;
  readonly treatmentExperimentId: string;
  readonly includedFileRoots: readonly string[];
}): Promise<InstallLifecycleDeltaV1> {
  const comparable = (experimentId: string) =>
    options.events
      .filter((event) => event.experimentId === experimentId)
      .map((event) => comparableEvent(event, options.includedFileRoots))
      .filter((entry): entry is ComparableEvent => entry !== undefined);
  const control = comparable(options.controlExperimentId);
  const treatment = comparable(options.treatmentExperimentId);
  const delta: InstallLifecycleDeltaV1 = {
    schema: "forge.install-delta/v1",
    runId: options.runId,
    controlExperimentId: options.controlExperimentId,
    treatmentExperimentId: options.treatmentExperimentId,
    treatmentOnly: directionalDifference(treatment, control),
    controlOnly: directionalDifference(control, treatment),
    limitations: [
      "A/B differences are observations, not proof that an install script is malicious.",
      "Package-manager nondeterminism can create differences unrelated to lifecycle scripts.",
      "File deltas are limited to the prepared target and synthetic profile roots.",
      "A complete comparison status means supported canonical-event differencing completed; observation health may still report policy-relevant trace records that lack a lossless canonical event.",
    ],
  };
  await options.store.writeJson(
    "install/delta.json",
    installLifecycleDeltaV1Schema,
    delta,
  );
  return delta;
}
