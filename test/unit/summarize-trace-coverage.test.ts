import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  observationHealthV1Schema,
  runManifestV1Schema,
  type ObservationHealthV1,
} from "../../src/contracts/v1.js";
// @ts-expect-error The bounded maintainer CLI is intentionally plain ESM JavaScript.
import * as traceCoverage from "../../scripts/summarize-trace-coverage.mjs";

const {
  MAX_OBSERVATION_HEALTH_BYTES,
  MAX_RUN_MANIFEST_BYTES,
  serializeTraceCoverageSummary,
  summarizeTraceCoverage,
} = traceCoverage;

type ExperimentHealth = ObservationHealthV1["experiments"][number];
type GapCategory =
  ExperimentHealth["policyRelevantGaps"]["categoryCounts"][number]["category"];
type GapOutcome =
  ExperimentHealth["policyRelevantGaps"]["outcomeCounts"][number]["outcome"];

interface GapSpec {
  readonly category: GapCategory;
  readonly syscall: string;
  readonly outcome: GapOutcome;
  readonly recordCount: number;
}

interface ExperimentOptions {
  readonly experimentId: string;
  readonly capturedSyscallCounts: readonly {
    readonly syscall: string;
    readonly recordCount: number;
  }[];
  readonly gaps?: readonly GapSpec[];
  readonly integrityComplete?: boolean;
  readonly canonicalization?: "completed" | "not_completed";
  readonly emittedEventCount?: number;
}

const temporaryRoots: string[] = [];

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addCount(counts: Map<string, number>, key: string, count: number): void {
  counts.set(key, (counts.get(key) ?? 0) + count);
}

function rows(
  counts: ReadonlyMap<string, number>,
  key: "category" | "syscall" | "outcome",
  order?: readonly string[],
): Record<string, string | number>[] {
  const values = [...counts].sort(([left], [right]) =>
    order === undefined
      ? compareStrings(left, right)
      : order.indexOf(left) - order.indexOf(right),
  );
  return values.map(([value, recordCount]) => ({ [key]: value, recordCount }));
}

function experiment(options: ExperimentOptions): ExperimentHealth {
  const capturedSyscallCounts = [...options.capturedSyscallCounts].sort(
    (left, right) => compareStrings(left.syscall, right.syscall),
  );
  const parsedSyscallRecordCount = capturedSyscallCounts.reduce(
    (sum, row) => sum + row.recordCount,
    0,
  );
  const gaps = options.gaps ?? [];
  const categoryCounts = new Map<string, number>();
  const syscallCounts = new Map<string, number>();
  const outcomeCounts = new Map<string, number>();
  const examples: Array<{
    category: GapCategory;
    syscall: string;
    rawRef: string;
    outcome: GapOutcome;
  }> = [];
  let gapRecordCount = 0;
  for (const gap of gaps) {
    addCount(categoryCounts, gap.category, gap.recordCount);
    addCount(syscallCounts, gap.syscall, gap.recordCount);
    addCount(outcomeCounts, gap.outcome, gap.recordCount);
    for (
      let index = 0;
      index < gap.recordCount && examples.length < 25;
      index += 1
    ) {
      examples.push({
        category: gap.category,
        syscall: gap.syscall,
        rawRef: `raw/${options.experimentId}/strace.100:${gapRecordCount + index + 1}`,
        outcome: gap.outcome,
      });
    }
    gapRecordCount += gap.recordCount;
  }

  const integrityComplete = options.integrityComplete ?? true;
  const traceRawRef = `raw/${options.experimentId}/strace.100`;
  return {
    experimentId: options.experimentId,
    traceDirectoryPresent: true,
    traceFileCount: 1,
    nonemptyLineCount: parsedSyscallRecordCount,
    parsedRecordCount: parsedSyscallRecordCount,
    parsedSyscallRecordCount,
    parsedSignalTerminationRecordCount: 0,
    capturedSyscallCounts,
    recognizedControlLineCount: 0,
    recognizedExitControlLineCount: 0,
    recognizedSignalDeliveryControlLineCount: 0,
    unfinishedLineCount: 0,
    resumedLineCount: 0,
    malformedLineCount: 0,
    stringTruncationIndicatorCount: 0,
    stringTruncationLineCount: 0,
    unfinishedRawRefs: [],
    resumedRawRefs: [],
    malformedRawRefs: [],
    stringTruncationRawRefs: [],
    terminalMarkerPresentTraceFileCount: integrityComplete ? 1 : 0,
    missingTerminalMarkerTraceFileCount: integrityComplete ? 0 : 1,
    missingTerminalMarkerTraceFileRawRefs: integrityComplete ? [] : [traceRawRef],
    traceFileDetails: [
      {
        rawRef: traceRawRef,
        pid: 100,
        nonemptyLineCount: parsedSyscallRecordCount,
        terminalMarker: integrityComplete
          ? {
              status: "present",
              kind: "exit",
              rawRef: `${traceRawRef}:${parsedSyscallRecordCount}`,
            }
          : { status: "missing" },
      },
    ],
    traceFileDetailOmittedCount: 0,
    integrityComplete,
    canonicalization:
      (options.canonicalization ?? "completed") === "completed"
        ? {
            status: "completed",
            emittedEventCount: options.emittedEventCount ?? 0,
          }
        : { status: "not_completed" },
    policyRelevantGaps: {
      recordCount: gapRecordCount,
      categoryCounts: rows(categoryCounts, "category") as ExperimentHealth["policyRelevantGaps"]["categoryCounts"],
      syscallCounts: rows(syscallCounts, "syscall") as ExperimentHealth["policyRelevantGaps"]["syscallCounts"],
      outcomeCounts: rows(
        outcomeCounts,
        "outcome",
        ["succeeded", "failed", "unknown"],
      ) as ExperimentHealth["policyRelevantGaps"]["outcomeCounts"],
      examples,
      truncatedExampleCount: gapRecordCount - examples.length,
    },
  };
}

function health(
  runId: string,
  experiments: readonly ExperimentHealth[],
): ObservationHealthV1 {
  const degradedExperimentIds = experiments
    .filter((value) => !value.integrityComplete)
    .map((value) => value.experimentId);
  const policyRelevantGapExperimentIds = experiments
    .filter((value) => value.policyRelevantGaps.recordCount > 0)
    .map((value) => value.experimentId);
  return observationHealthV1Schema.parse({
    schema: "forge.observation-health/v1",
    runId,
    generatedAt: "2026-08-30T00:00:00.000Z",
    scope: "selected_strace_surface",
    surfaceId: "forge-strace-selected-v1",
    integrityStatus:
      degradedExperimentIds.length === 0 ? "complete" : "degraded",
    canonicalizationExecutionStatus: experiments.every(
      (value) => value.canonicalization.status === "completed",
    )
      ? "completed"
      : "incomplete",
    policyRelevantGapStatus:
      policyRelevantGapExperimentIds.length === 0
        ? "none_observed"
        : "gaps_observed",
    degradedExperimentIds,
    policyRelevantGapExperimentIds,
    experiments,
    limitations: ["Synthetic trace-coverage aggregator fixture."],
  });
}

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forge-trace-summary-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "runs"));
  return root;
}

async function writeManifest(
  directory: string,
  runId: string,
  healthBytes: string | Uint8Array,
  options: {
    readonly manifestRunId?: string;
    readonly artifacts?: readonly {
      readonly path: string;
      readonly sha256: string;
      readonly mediaType: string;
    }[];
    readonly status?: "running" | "completed" | "failed" | "timed_out";
  } = {},
): Promise<void> {
  const manifestRunId = options.manifestRunId ?? runId;
  const manifest = runManifestV1Schema.parse({
    schema: "forge.run/v1",
    runId: manifestRunId,
    targetId: `target-${manifestRunId}`,
    configSha256: "a".repeat(64),
    status: options.status ?? "completed",
    createdAt: "2026-08-30T00:00:00.000Z",
    completedAt: "2026-08-30T00:00:01.000Z",
    sandboxPolicy: {
      profile: "developer-v1",
      network: "blocked",
      timeoutMs: 10_000,
    },
    toolchain: {
      forgeVersion: "0.1.0",
      nodeVersion: process.version,
      observerImageReference: "forge-sandbox:test",
      observerImageId: `sha256:${"b".repeat(64)}`,
    },
    limitations: ["Synthetic trace-coverage manifest fixture."],
    artifacts:
      options.artifacts ??
      [
        {
          path: "observation-health.json",
          sha256: sha256(healthBytes),
          mediaType: "application/json",
        },
      ],
  });
  await writeFile(
    join(directory, "run.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function writeRunSource(
  root: string,
  runId: string,
  source: string | Uint8Array,
): Promise<string> {
  const directory = join(root, "runs", runId);
  await mkdir(directory);
  await writeFile(join(directory, "observation-health.json"), source);
  await writeManifest(directory, runId, source);
  return directory;
}

async function writeRun(
  root: string,
  runId: string,
  document: unknown,
): Promise<string> {
  return writeRunSource(root, runId, `${JSON.stringify(document, null, 2)}\n`);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("trace coverage corpus summary", () => {
  it("aggregates exact counts and emits input-order-independent sorted JSON", async () => {
    const root = await projectRoot();
    await writeRun(
      root,
      "run-b",
      health("run-b", [
        experiment({
          experimentId: "install-scripts-enabled",
          capturedSyscallCounts: [{ syscall: "write", recordCount: 3 }],
          gaps: [
            {
              category: "data_transfer",
              syscall: "write",
              outcome: "succeeded",
              recordCount: 2,
            },
          ],
          integrityComplete: false,
          canonicalization: "not_completed",
        }),
        experiment({
          experimentId: "tool-read",
          capturedSyscallCounts: [{ syscall: "read", recordCount: 1 }],
          gaps: [
            {
              category: "opaque_io",
              syscall: "read",
              outcome: "unknown",
              recordCount: 1,
            },
          ],
          canonicalization: "not_completed",
        }),
      ]),
    );
    await writeRun(
      root,
      "run-a",
      health("run-a", [
        experiment({
          experimentId: "baseline-initialization",
          capturedSyscallCounts: [{ syscall: "openat", recordCount: 2 }],
          gaps: [
            {
              category: "filesystem_mutation",
              syscall: "openat",
              outcome: "failed",
              recordCount: 1,
            },
          ],
          emittedEventCount: 1,
        }),
      ]),
    );

    const forward = await summarizeTraceCoverage({
      projectRoot: root,
      runDirectories: ["runs/run-b", "runs/run-a"],
    });
    const reverse = await summarizeTraceCoverage({
      projectRoot: root,
      runDirectories: ["runs/run-a", "runs/run-b"],
    });

    expect(serializeTraceCoverageSummary(forward)).toBe(
      serializeTraceCoverageSummary(reverse),
    );
    expect(forward).toMatchObject({
      schema: "forge.trace-coverage-summary/v1",
      runCount: 2,
      experimentCount: 3,
      runs: [
        {
          runId: "run-a",
          targetId: "target-run-a",
          manifestStatus: "completed",
          integrityStatus: "complete",
          canonicalizationExecutionStatus: "completed",
          policyRelevantGapStatus: "gaps_observed",
          completedCanonicalizationExperimentCount: 1,
          incompleteCanonicalizationExperimentCount: 0,
          capturedSyscallRecordCount: 2,
          completedCanonicalizationEmittedEventCount: 1,
          policyRelevantGapRecordCount: 1,
        },
        {
          runId: "run-b",
          targetId: "target-run-b",
          manifestStatus: "completed",
          integrityStatus: "degraded",
          canonicalizationExecutionStatus: "incomplete",
          policyRelevantGapStatus: "gaps_observed",
          completedCanonicalizationExperimentCount: 0,
          incompleteCanonicalizationExperimentCount: 2,
          capturedSyscallRecordCount: 4,
          completedCanonicalizationEmittedEventCount: 0,
          policyRelevantGapRecordCount: 3,
        },
      ],
      totals: {
        traceFileCount: 3,
        nonemptyTraceLineCount: 6,
        parsedTraceRecordCount: 6,
        capturedSyscallRecordCount: 6,
        completedCanonicalizationEmittedEventCount: 1,
        policyRelevantGapRecordCount: 4,
      },
      cohorts: [
        {
          cohort: "install_lifecycle",
          runCount: 1,
          experimentCount: 1,
          degradedExperimentCount: 1,
          completedCanonicalizationExperimentCount: 0,
          incompleteCanonicalizationExperimentCount: 1,
          policyRelevantGapExperimentCount: 1,
          totals: {
            capturedSyscallRecordCount: 3,
            policyRelevantGapRecordCount: 2,
          },
          capturedSyscallCounts: [{ syscall: "write", recordCount: 3 }],
          policyRelevantGapCounts: {
            categoryCounts: [{ category: "data_transfer", recordCount: 2 }],
            syscallCounts: [{ syscall: "write", recordCount: 2 }],
            outcomeCounts: [{ outcome: "succeeded", recordCount: 2 }],
          },
        },
        {
          cohort: "baseline_initialization",
          runCount: 1,
          experimentCount: 1,
          degradedExperimentCount: 0,
          completedCanonicalizationExperimentCount: 1,
          incompleteCanonicalizationExperimentCount: 0,
          policyRelevantGapExperimentCount: 1,
          totals: {
            capturedSyscallRecordCount: 2,
            policyRelevantGapRecordCount: 1,
          },
        },
        {
          cohort: "tool",
          runCount: 1,
          experimentCount: 1,
          degradedExperimentCount: 0,
          completedCanonicalizationExperimentCount: 0,
          incompleteCanonicalizationExperimentCount: 1,
          policyRelevantGapExperimentCount: 1,
          totals: {
            capturedSyscallRecordCount: 1,
            policyRelevantGapRecordCount: 1,
          },
        },
      ],
      experiments: [
        {
          runId: "run-a",
          experimentId: "baseline-initialization",
          cohort: "baseline_initialization",
          integrityStatus: "complete",
          canonicalizationExecutionStatus: "completed",
          capturedSyscallRecordCount: 2,
          policyRelevantGapRecordCount: 1,
        },
        {
          runId: "run-b",
          experimentId: "install-scripts-enabled",
          cohort: "install_lifecycle",
          integrityStatus: "degraded",
          canonicalizationExecutionStatus: "incomplete",
          capturedSyscallRecordCount: 3,
          policyRelevantGapRecordCount: 2,
        },
        {
          runId: "run-b",
          experimentId: "tool-read",
          cohort: "tool",
          integrityStatus: "complete",
          canonicalizationExecutionStatus: "incomplete",
          capturedSyscallRecordCount: 1,
          policyRelevantGapRecordCount: 1,
        },
      ],
      capturedSyscallCounts: [
        { syscall: "openat", recordCount: 2 },
        { syscall: "read", recordCount: 1 },
        { syscall: "write", recordCount: 3 },
      ],
      policyRelevantGapCounts: {
        categoryCounts: [
          { category: "data_transfer", recordCount: 2 },
          { category: "filesystem_mutation", recordCount: 1 },
          { category: "opaque_io", recordCount: 1 },
        ],
        syscallCounts: [
          { syscall: "openat", recordCount: 1 },
          { syscall: "read", recordCount: 1 },
          { syscall: "write", recordCount: 2 },
        ],
        outcomeCounts: [
          { outcome: "succeeded", recordCount: 2 },
          { outcome: "failed", recordCount: 1 },
          { outcome: "unknown", recordCount: 1 },
        ],
      },
    });
  });

  it("rejects traversal and directories outside the explicit runs root", async () => {
    const root = await projectRoot();
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: ["runs/../outside/run-escape"],
      }),
    ).rejects.toThrow("traversal is not allowed");
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: [resolve(root, "outside", "run-escape")],
      }),
    ).rejects.toThrow("explicit runs/run-* directory");
  });

  it("rejects symlinked run directories and symlinked health artifacts", async () => {
    const root = await projectRoot();
    const realDirectory = await writeRun(
      root,
      "run-real",
      health("run-real", [
        experiment({
          experimentId: "exp-real",
          capturedSyscallCounts: [{ syscall: "read", recordCount: 1 }],
        }),
      ]),
    );
    await symlink(realDirectory, join(root, "runs", "run-link"), "dir");
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: ["runs/run-link"],
      }),
    ).rejects.toThrow("non-symlink directory");

    const linkedDirectory = join(root, "runs", "run-health-link");
    await mkdir(linkedDirectory);
    const externalHealth = join(root, "external-health.json");
    await writeFile(
      externalHealth,
      `${JSON.stringify(
        health("run-health-link", [
          experiment({
            experimentId: "exp-link",
            capturedSyscallCounts: [{ syscall: "read", recordCount: 1 }],
          }),
        ]),
      )}\n`,
    );
    const externalHealthBytes = await readFile(externalHealth);
    await writeManifest(
      linkedDirectory,
      "run-health-link",
      externalHealthBytes,
    );
    await symlink(
      externalHealth,
      join(linkedDirectory, "observation-health.json"),
    );
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: ["runs/run-health-link"],
      }),
    ).rejects.toThrow("non-symlink regular file");

    const manifestLinkDirectory = await writeRun(
      root,
      "run-manifest-link",
      health("run-manifest-link", [
        experiment({
          experimentId: "exp-manifest-link",
          capturedSyscallCounts: [{ syscall: "read", recordCount: 1 }],
        }),
      ]),
    );
    const manifestPath = join(manifestLinkDirectory, "run.json");
    const externalManifest = join(root, "external-run.json");
    await writeFile(externalManifest, await readFile(manifestPath));
    await unlink(manifestPath);
    await symlink(externalManifest, manifestPath);
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: ["runs/run-manifest-link"],
      }),
    ).rejects.toThrow("non-symlink regular file");
  });

  it("rejects nonregular and oversized health artifacts before parsing", async () => {
    const root = await projectRoot();
    const nonregularDirectory = join(root, "runs", "run-nonregular");
    await mkdir(join(nonregularDirectory, "observation-health.json"), {
      recursive: true,
    });
    await writeManifest(nonregularDirectory, "run-nonregular", "not-a-file");
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: ["runs/run-nonregular"],
      }),
    ).rejects.toThrow("non-symlink regular file");

    const oversizedHealth = Buffer.alloc(
      MAX_OBSERVATION_HEALTH_BYTES + 1,
      0x20,
    );
    await writeRunSource(root, "run-oversized", oversizedHealth);
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: ["runs/run-oversized"],
      }),
    ).rejects.toThrow("byte parsing limit");

    const oversizedManifestDirectory = await writeRun(
      root,
      "run-oversized-manifest",
      health("run-oversized-manifest", [
        experiment({
          experimentId: "exp-oversized-manifest",
          capturedSyscallCounts: [{ syscall: "read", recordCount: 1 }],
        }),
      ]),
    );
    await writeFile(
      join(oversizedManifestDirectory, "run.json"),
      Buffer.alloc(MAX_RUN_MANIFEST_BYTES + 1, 0x20),
    );
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: ["runs/run-oversized-manifest"],
      }),
    ).rejects.toThrow("byte parsing limit");
  });

  it("rejects duplicate run identities even when path spellings differ", async () => {
    const root = await projectRoot();
    const directory = await writeRun(
      root,
      "run-duplicate",
      health("run-duplicate", [
        experiment({
          experimentId: "exp-duplicate",
          capturedSyscallCounts: [{ syscall: "read", recordCount: 1 }],
        }),
      ]),
    );
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: ["runs/run-duplicate", directory],
      }),
    ).rejects.toThrow("duplicate run identity");
  });

  it("requires a terminal identity-matched manifest and exactly one JSON health row", async () => {
    const root = await projectRoot();
    const mismatchDirectory = await writeRun(
      root,
      "run-manifest-mismatch",
      health("run-manifest-mismatch", [
        experiment({
          experimentId: "exp-manifest-mismatch",
          capturedSyscallCounts: [{ syscall: "read", recordCount: 1 }],
        }),
      ]),
    );
    const mismatchHealth = await readFile(
      join(mismatchDirectory, "observation-health.json"),
    );
    await writeManifest(
      mismatchDirectory,
      "run-manifest-mismatch",
      mismatchHealth,
      { manifestRunId: "run-other" },
    );
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: ["runs/run-manifest-mismatch"],
      }),
    ).rejects.toThrow("does not match manifest runId");

    const missingDirectory = await writeRun(
      root,
      "run-missing-row",
      health("run-missing-row", [
        experiment({
          experimentId: "exp-missing-row",
          capturedSyscallCounts: [{ syscall: "read", recordCount: 1 }],
        }),
      ]),
    );
    const missingHealth = await readFile(
      join(missingDirectory, "observation-health.json"),
    );
    await writeManifest(missingDirectory, "run-missing-row", missingHealth, {
      artifacts: [],
    });
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: ["runs/run-missing-row"],
      }),
    ).rejects.toThrow("exactly one observation-health.json artifact");

    const mediaDirectory = await writeRun(
      root,
      "run-wrong-media",
      health("run-wrong-media", [
        experiment({
          experimentId: "exp-wrong-media",
          capturedSyscallCounts: [{ syscall: "read", recordCount: 1 }],
        }),
      ]),
    );
    const mediaHealth = await readFile(
      join(mediaDirectory, "observation-health.json"),
    );
    await writeManifest(mediaDirectory, "run-wrong-media", mediaHealth, {
      artifacts: [
        {
          path: "observation-health.json",
          sha256: sha256(mediaHealth),
          mediaType: "text/plain",
        },
      ],
    });
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: ["runs/run-wrong-media"],
      }),
    ).rejects.toThrow("as application/json");

    const runningDirectory = await writeRun(
      root,
      "run-running",
      health("run-running", [
        experiment({
          experimentId: "exp-running",
          capturedSyscallCounts: [{ syscall: "read", recordCount: 1 }],
        }),
      ]),
    );
    const runningHealth = await readFile(
      join(runningDirectory, "observation-health.json"),
    );
    await writeManifest(runningDirectory, "run-running", runningHealth, {
      status: "running",
    });
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: ["runs/run-running"],
      }),
    ).rejects.toThrow("manifest is not terminal");
  });

  it("rejects health bytes that no longer match the manifest SHA-256", async () => {
    const root = await projectRoot();
    const directory = await writeRun(
      root,
      "run-tampered",
      health("run-tampered", [
        experiment({
          experimentId: "exp-tampered",
          capturedSyscallCounts: [{ syscall: "read", recordCount: 1 }],
        }),
      ]),
    );
    const healthPath = join(directory, "observation-health.json");
    const original = await readFile(healthPath);
    await writeFile(healthPath, Buffer.concat([original, Buffer.from(" \n")]));
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: ["runs/run-tampered"],
      }),
    ).rejects.toThrow("SHA-256 does not match run.json");
  });

  it("fails closed on malformed, schema-invalid, and mismatched health", async () => {
    const root = await projectRoot();
    await writeRunSource(root, "run-malformed", "{\"schema\":");
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: ["runs/run-malformed"],
      }),
    ).rejects.toThrow("not valid bounded JSON");

    const invalid = structuredClone(
      health("run-invalid", [
        experiment({
          experimentId: "exp-invalid",
          capturedSyscallCounts: [{ syscall: "read", recordCount: 1 }],
        }),
      ]),
    );
    invalid.experiments[0]!.parsedSyscallRecordCount = 2;
    await writeRun(root, "run-invalid", invalid);
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: ["runs/run-invalid"],
      }),
    ).rejects.toThrow("does not satisfy forge.observation-health/v1");

    await writeRun(
      root,
      "run-mismatch",
      health("run-other", [
        experiment({
          experimentId: "exp-mismatch",
          capturedSyscallCounts: [{ syscall: "read", recordCount: 1 }],
        }),
      ]),
    );
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: ["runs/run-mismatch"],
      }),
    ).rejects.toThrow("does not match observation-health runId");
  });

  it("rejects aggregate count arithmetic beyond the safe integer range", async () => {
    const root = await projectRoot();
    for (const runId of ["run-huge-a", "run-huge-b"]) {
      await writeRun(
        root,
        runId,
        health(runId, [
          experiment({
            experimentId: `exp-${runId}`,
            capturedSyscallCounts: [
              { syscall: "read", recordCount: Number.MAX_SAFE_INTEGER },
            ],
            canonicalization: "not_completed",
          }),
        ]),
      );
    }
    await expect(
      summarizeTraceCoverage({
        projectRoot: root,
        runDirectories: ["runs/run-huge-a", "runs/run-huge-b"],
      }),
    ).rejects.toThrow("safe integer range");
  });
});
