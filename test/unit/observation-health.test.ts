import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { observationHealthV1Schema } from "../../src/contracts/v1.js";
import { EvidenceStore } from "../../src/evidence-store.js";
import {
  collectObservationHealth,
  writeObservationHealth,
} from "../../src/observe/observation-health.js";
import { normalizeRun } from "../../src/observe/strace-normalizer.js";

describe("observation health", () => {
  it("separates structural integrity from selected policy-relevant gaps", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-observation-health-"));
    const store = await EvidenceStore.create(root, "run-health");
    const rawDirectory = store.pathFor("raw/health-tool");
    await mkdir(rawDirectory, { recursive: true });
    await writeFile(
      join(rawDirectory, "strace.42"),
      [
        '1700000000.000001 mkdir("/sandbox/workspace/new-directory", 0700) = 0',
        '1700000000.000002 sendto(3<NETLINK:[ROUTE:42]>, "route", 5, 0, {sa_family=AF_NETLINK}, 12) = 5',
        '1700000000.000003 getdents64(4</sandbox/workspace>, [{d_ino=1, d_name="report.txt"}], 32768) = 32',
        "1700000000.000004 io_uring_setup(256, {flags=0}) = -1 EPERM (Operation not permitted)",
        "1700000000.000005 io_uring_setup(256, {flags=0}) = 7",
        "1700000000.000006 io_uring_setup(256, {flags=0}) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)",
        "1700000000.000007 exit_group(0) = ?",
        "1700000000.000008 +++ exited with 0 +++",
      ].join("\n"),
      "utf8",
    );

    const events = await normalizeRun({
      store,
      runId: "run-health",
      experimentIds: ["health-tool"],
    });
    const health = await writeObservationHealth({
      store,
      runId: "run-health",
      experimentIds: ["health-tool"],
      events,
      generatedAt: "2026-08-30T20:00:00.000Z",
    });

    expect(health).toMatchObject({
      schema: "forge.observation-health/v1",
      scope: "selected_strace_surface",
      surfaceId: "forge-strace-selected-v1",
      integrityStatus: "complete",
      canonicalizationExecutionStatus: "completed",
      policyRelevantGapStatus: "gaps_observed",
      degradedExperimentIds: [],
      policyRelevantGapExperimentIds: ["health-tool"],
    });
    expect(health.experiments[0]).toMatchObject({
      experimentId: "health-tool",
      nonemptyLineCount: 8,
      parsedSyscallRecordCount: 7,
      capturedSyscallCounts: [
        { syscall: "exit_group", recordCount: 1 },
        { syscall: "getdents64", recordCount: 1 },
        { syscall: "io_uring_setup", recordCount: 3 },
        { syscall: "mkdir", recordCount: 1 },
        { syscall: "sendto", recordCount: 1 },
      ],
      recognizedExitControlLineCount: 1,
      integrityComplete: true,
      canonicalization: {
        status: "completed",
        emittedEventCount: events.length,
      },
      policyRelevantGaps: {
        recordCount: 5,
        categoryCounts: [
          { category: "filesystem_mutation", recordCount: 1 },
          { category: "opaque_io", recordCount: 2 },
          { category: "failed_capability_probe", recordCount: 1 },
          { category: "alternate_file_access", recordCount: 1 },
        ],
        syscallCounts: [
          { syscall: "getdents64", recordCount: 1 },
          { syscall: "io_uring_setup", recordCount: 3 },
          { syscall: "mkdir", recordCount: 1 },
        ],
        outcomeCounts: [
          { outcome: "succeeded", recordCount: 3 },
          { outcome: "failed", recordCount: 1 },
          { outcome: "unknown", recordCount: 1 },
        ],
        truncatedExampleCount: 0,
      },
    });
    expect(
      events.find((event) => event.effect.kind === "file.read")?.effect,
    ).toEqual({
      kind: "file.read",
      path: "/sandbox/workspace",
      operation: "directory_entries",
      outcome: { status: "succeeded" },
    });
    expect(
      health.experiments[0]?.policyRelevantGaps.syscallCounts.some(
        (row) => row.syscall === "sendto",
      ),
    ).toBe(false);

    const retained = observationHealthV1Schema.parse(
      JSON.parse(
        await readFile(store.pathFor("observation-health.json"), "utf8"),
      ),
    );
    expect(retained).toEqual(health);

    const inconsistentTerminalDetail = structuredClone(health);
    inconsistentTerminalDetail.experiments[0]!.traceFileDetails[0]!.terminalMarker =
      { status: "missing" };
    expect(
      observationHealthV1Schema.safeParse(inconsistentTerminalDetail).success,
    ).toBe(false);

    const mismatchedMissingTerminalExample = structuredClone(health);
    const mismatchedExperiment = mismatchedMissingTerminalExample.experiments[0]!;
    mismatchedExperiment.traceFileDetails[0]!.terminalMarker = {
      status: "missing",
    };
    mismatchedExperiment.terminalMarkerPresentTraceFileCount = 0;
    mismatchedExperiment.missingTerminalMarkerTraceFileCount = 1;
    mismatchedExperiment.missingTerminalMarkerTraceFileRawRefs = [
      "raw/health-tool/strace.99",
    ];
    mismatchedExperiment.integrityComplete = false;
    mismatchedMissingTerminalExample.integrityStatus = "degraded";
    mismatchedMissingTerminalExample.degradedExperimentIds = ["health-tool"];
    expect(
      observationHealthV1Schema.safeParse(mismatchedMissingTerminalExample)
        .success,
    ).toBe(false);

    const uncapturedGapSyscall = structuredClone(health);
    uncapturedGapSyscall.experiments[0]!.policyRelevantGaps.syscallCounts = [
      { syscall: "uncaptured_syscall", recordCount: 2 },
    ];
    expect(
      observationHealthV1Schema.safeParse(uncapturedGapSyscall).success,
    ).toBe(false);

    const excessiveExampleMultiplicity = structuredClone(health);
    const gapExamples =
      excessiveExampleMultiplicity.experiments[0]!.policyRelevantGaps.examples;
    gapExamples[1] = {
      ...gapExamples[0]!,
      rawRef: gapExamples[1]!.rawRef,
    };
    expect(
      observationHealthV1Schema.safeParse(excessiveExampleMultiplicity).success,
    ).toBe(false);

    const crossExperimentRawReference = structuredClone(health);
    crossExperimentRawReference.experiments[0]!.policyRelevantGaps.examples[0]!.rawRef =
      "raw/other-tool/strace.42:1";
    expect(
      observationHealthV1Schema.safeParse(crossExperimentRawReference).success,
    ).toBe(false);
  });

  it("retains explicit incomplete health when an expected trace is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-observation-missing-"));
    const store = await EvidenceStore.create(root, "run-missing");

    const health = await collectObservationHealth({
      store,
      runId: "run-missing",
      experimentIds: ["missing-tool"],
      generatedAt: "2026-08-30T20:00:00.000Z",
    });

    expect(health).toMatchObject({
      integrityStatus: "degraded",
      canonicalizationExecutionStatus: "incomplete",
      policyRelevantGapStatus: "none_observed",
      degradedExperimentIds: ["missing-tool"],
      experiments: [
        {
          experimentId: "missing-tool",
          traceDirectoryPresent: false,
          traceFileCount: 0,
          integrityComplete: false,
          canonicalization: { status: "not_completed" },
        },
      ],
    });

    const impossibleAbsentDirectory = structuredClone(health);
    impossibleAbsentDirectory.experiments[0]!.nonemptyLineCount = 1;
    expect(
      observationHealthV1Schema.safeParse(impossibleAbsentDirectory).success,
    ).toBe(false);

    const impossibleCanonicalEvent = structuredClone(health);
    impossibleCanonicalEvent.experiments[0]!.traceDirectoryPresent = true;
    impossibleCanonicalEvent.experiments[0]!.traceFileCount = 1;
    impossibleCanonicalEvent.experiments[0]!.missingTerminalMarkerTraceFileCount =
      1;
    impossibleCanonicalEvent.experiments[0]!.missingTerminalMarkerTraceFileRawRefs =
      ["raw/missing-tool/strace.42"];
    impossibleCanonicalEvent.experiments[0]!.traceFileDetails = [
      {
        rawRef: "raw/missing-tool/strace.42",
        pid: 42,
        nonemptyLineCount: 0,
        terminalMarker: { status: "missing" },
      },
    ];
    impossibleCanonicalEvent.experiments[0]!.canonicalization = {
      status: "completed",
      emittedEventCount: 1,
    };
    impossibleCanonicalEvent.canonicalizationExecutionStatus = "completed";
    expect(
      observationHealthV1Schema.safeParse(impossibleCanonicalEvent).success,
    ).toBe(false);
  });

  it("rejects health documents whose counters do not partition raw lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-observation-contract-"));
    const store = await EvidenceStore.create(root, "run-contract");
    const health = await collectObservationHealth({
      store,
      runId: "run-contract",
      experimentIds: ["missing-tool"],
      generatedAt: "2026-08-30T20:00:00.000Z",
    });
    const first = health.experiments[0];
    if (first === undefined) {
      throw new Error("expected one health experiment");
    }

    const tampered = {
      ...health,
      experiments: [{ ...first, nonemptyLineCount: 1 }],
    };
    expect(observationHealthV1Schema.safeParse(tampered).success).toBe(false);
  });
});
