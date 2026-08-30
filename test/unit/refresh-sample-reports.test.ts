import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  observationHealthV1Schema,
  reportV1Schema,
  runManifestV1Schema,
} from "../../src/contracts/v1.js";
// @ts-expect-error The maintainer script is intentionally plain ESM JavaScript.
import * as sampleRefresh from "../../scripts/refresh-sample-reports.mjs";

const { assertSampleContentSafe, refreshSampleReports } = sampleRefresh;

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const observerImageId = `sha256:${"a".repeat(64)}`;
const temporaryRoots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function manifest(
  runId: string,
  targetId: string,
  reportSource: string,
  semanticArtifacts: readonly { path: string; source: string }[],
  imageId = observerImageId,
) {
  return {
    schema: "forge.run/v1",
    runId,
    targetId,
    configSha256: "b".repeat(64),
    status: "completed",
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
      observerImageReference: "forge-sandbox:dev",
      observerImageId: imageId,
    },
    limitations: ["Synthetic refresh-script test manifest."],
    artifacts: [
      {
        path: "report.json",
        sha256: sha256(reportSource),
        mediaType: "application/json",
      },
      ...semanticArtifacts.map((artifact) => ({
        path: artifact.path,
        sha256: sha256(artifact.source),
        mediaType: "application/json",
      })),
    ],
  };
}

function semanticArtifact(
  runId: string,
  targetId: string,
  lexicalInspectionArtifact: string,
): string {
  return `${JSON.stringify(
    {
      schema: "forge.node-semantic-static/v1",
      runId,
      targetId,
      input: { lexicalInspectionArtifact },
    },
    null,
    2,
  )}\n`;
}

function prepareReport(reportSource: string) {
  const report = reportV1Schema.parse(JSON.parse(reportSource));
  // Generic fixtures intentionally exercise the legacy optional-health path.
  // Dedicated observation-health tests attach a manifest-bound artifact below.
  delete report.observationHealth;
  delete report.evidence.observationHealth;
  if (
    report.semanticAnalysis === undefined ||
    report.evidence.semanticInspection === undefined ||
    report.evidence.preInstallSemanticInspection === undefined
  ) {
    throw new Error("sample fixture requires semantic report evidence");
  }
  const semanticArtifacts = [
    {
      path: report.evidence.semanticInspection,
      source: semanticArtifact(
        report.runId,
        report.targetId,
        "static/inspection.json",
      ),
    },
    {
      path: report.evidence.preInstallSemanticInspection,
      source: semanticArtifact(
        report.runId,
        report.targetId,
        "static/pre-install-inspection.json",
      ),
    },
  ];
  report.semanticAnalysis.artifactSha256 = sha256(semanticArtifacts[0]!.source);
  return {
    reportSource: `${JSON.stringify(report, null, 2)}\n`,
    semanticArtifacts,
    runId: report.runId,
  };
}

function reportWithObservationHealth(reportSource: string) {
  const report = reportV1Schema.parse(JSON.parse(reportSource));
  const experimentIds = report.experiments.map(
    (experiment) => experiment.experimentId,
  );
  const health = observationHealthV1Schema.parse({
    schema: "forge.observation-health/v1",
    runId: report.runId,
    generatedAt: report.generatedAt,
    scope: "selected_strace_surface",
    surfaceId: "forge-strace-selected-v1",
    integrityStatus: "complete",
    canonicalizationExecutionStatus: "completed",
    policyRelevantGapStatus: "none_observed",
    degradedExperimentIds: [],
    policyRelevantGapExperimentIds: [],
    experiments: report.experiments.map((experiment, index) => {
      const pid = 100 + index;
      const rawRef = `raw/${experiment.experimentId}/strace.${pid}`;
      return {
        experimentId: experiment.experimentId,
        traceDirectoryPresent: true,
        traceFileCount: 1,
        nonemptyLineCount: 2,
        parsedRecordCount: 1,
        parsedSyscallRecordCount: 1,
        parsedSignalTerminationRecordCount: 0,
        capturedSyscallCounts: [{ syscall: "read", recordCount: 1 }],
        recognizedControlLineCount: 1,
        recognizedExitControlLineCount: 1,
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
        terminalMarkerPresentTraceFileCount: 1,
        missingTerminalMarkerTraceFileCount: 0,
        missingTerminalMarkerTraceFileRawRefs: [],
        traceFileDetails: [
          {
            rawRef,
            pid,
            nonemptyLineCount: 2,
            terminalMarker: {
              status: "present" as const,
              kind: "exit" as const,
              rawRef: `${rawRef}:2`,
            },
          },
        ],
        traceFileDetailOmittedCount: 0,
        integrityComplete: true,
        canonicalization: {
          status: "completed" as const,
          emittedEventCount: experiment.eventCount,
        },
        policyRelevantGaps: {
          recordCount: 0,
          categoryCounts: [],
          syscallCounts: [],
          outcomeCounts: [],
          examples: [],
          truncatedExampleCount: 0,
        },
      };
    }),
    limitations: ["Synthetic complete trace health for the refresh-script test."],
  });
  report.observationHealth = {
    scope: health.scope,
    surfaceId: health.surfaceId,
    integrityStatus: health.integrityStatus,
    canonicalizationExecutionStatus: health.canonicalizationExecutionStatus,
    policyRelevantGapStatus: health.policyRelevantGapStatus,
    experimentIds,
    degradedExperimentIds: [],
    policyRelevantGapExperimentIds: [],
    policyRelevantGapRecordCount: 0,
    policyRelevantGapOutcomeCounts: [],
    stringTruncationLineCount: 0,
    artifact: "observation-health.json",
  };
  report.evidence.observationHealth = "observation-health.json";
  return {
    reportSource: `${JSON.stringify(reportV1Schema.parse(report), null, 2)}\n`,
    healthSource: `${JSON.stringify(health, null, 2)}\n`,
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-refresh-samples-"));
  temporaryRoots.push(root);
  const sampleRoot = join(root, "examples", "reports");
  const [deceptiveReportSource, filesystemReportSource] = await Promise.all([
    readFile(
      join(
        repositoryRoot,
        "examples",
        "reports",
        "deceptive-control.report.json",
      ),
      "utf8",
    ),
    readFile(
      join(
        repositoryRoot,
        "examples",
        "reports",
        "official-filesystem.report.json",
      ),
      "utf8",
    ),
  ]);
  const deceptive = prepareReport(deceptiveReportSource);
  const filesystem = prepareReport(filesystemReportSource);
  const deceptiveReport = deceptive.reportSource;
  const filesystemReport = filesystem.reportSource;
  const deceptiveRunId = deceptive.runId;
  const filesystemRunId = filesystem.runId;
  const deceptiveDirectory = join(root, "runs", deceptiveRunId);
  const filesystemDirectory = join(root, "runs", filesystemRunId);
  await Promise.all([
    mkdir(sampleRoot, { recursive: true }),
    mkdir(deceptiveDirectory, { recursive: true }),
    mkdir(filesystemDirectory, { recursive: true }),
    mkdir(join(deceptiveDirectory, "static"), { recursive: true }),
    mkdir(join(filesystemDirectory, "static"), { recursive: true }),
  ]);
  const readme = [
    "# Sample reports",
    "",
    "- `deceptive-control.report.json` is the report from `run-old-deceptive`.",
    "- `official-filesystem.report.json` is the report from `run-old-filesystem`.",
    "",
  ].join("\n");

  await Promise.all([
    writeFile(join(deceptiveDirectory, "report.json"), deceptiveReport, "utf8"),
    writeFile(
      join(deceptiveDirectory, "run.json"),
      `${JSON.stringify(
        manifest(
          deceptiveRunId,
          "deceptive-document-summarizer",
          deceptiveReport,
          deceptive.semanticArtifacts,
        ),
        null,
        2,
      )}\n`,
      "utf8",
    ),
    writeFile(join(filesystemDirectory, "report.json"), filesystemReport, "utf8"),
    writeFile(
      join(filesystemDirectory, "run.json"),
      `${JSON.stringify(
        manifest(
          filesystemRunId,
          "official-filesystem",
          filesystemReport,
          filesystem.semanticArtifacts,
        ),
        null,
        2,
      )}\n`,
      "utf8",
    ),
    writeFile(join(sampleRoot, "deceptive-control.report.json"), "old deceptive\n"),
    writeFile(
      join(sampleRoot, "official-filesystem.report.json"),
      "old filesystem\n",
    ),
    writeFile(join(sampleRoot, "README.md"), readme, "utf8"),
    ...deceptive.semanticArtifacts.map((artifact) =>
      writeFile(join(deceptiveDirectory, artifact.path), artifact.source, "utf8"),
    ),
    ...filesystem.semanticArtifacts.map((artifact) =>
      writeFile(join(filesystemDirectory, artifact.path), artifact.source, "utf8"),
    ),
  ]);

  return {
    root,
    sampleRoot,
    deceptiveDirectory,
    filesystemDirectory,
    deceptiveReport,
    filesystemReport,
    deceptiveSemanticArtifacts: deceptive.semanticArtifacts,
    filesystemSemanticArtifacts: filesystem.semanticArtifacts,
    readme,
    deceptiveRunId,
    filesystemRunId,
  };
}

type RefreshFixture = Awaited<ReturnType<typeof createFixture>>;

async function attachDeceptiveObservationHealth(
  fixture: RefreshFixture,
  options: { includeManifestArtifact?: boolean; mediaType?: string } = {},
) {
  const withHealth = reportWithObservationHealth(fixture.deceptiveReport);
  fixture.deceptiveReport = withHealth.reportSource;
  const healthArtifact = {
    path: "observation-health.json",
    source: withHealth.healthSource,
  };
  const runManifest = manifest(
    fixture.deceptiveRunId,
    "deceptive-document-summarizer",
    withHealth.reportSource,
    options.includeManifestArtifact === false
      ? fixture.deceptiveSemanticArtifacts
      : [...fixture.deceptiveSemanticArtifacts, healthArtifact],
  );
  const healthRow = runManifest.artifacts.find(
    (artifact) => artifact.path === healthArtifact.path,
  );
  if (healthRow !== undefined && options.mediaType !== undefined) {
    healthRow.mediaType = options.mediaType;
  }
  await Promise.all([
    writeFile(
      join(fixture.deceptiveDirectory, "report.json"),
      withHealth.reportSource,
      "utf8",
    ),
    writeFile(
      join(fixture.deceptiveDirectory, "run.json"),
      `${JSON.stringify(runManifest, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      join(fixture.deceptiveDirectory, healthArtifact.path),
      healthArtifact.source,
      "utf8",
    ),
  ]);
  return withHealth;
}

const schemas = {
  reportV1Schema,
  runManifestV1Schema,
  observationHealthV1Schema,
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("sample report refresher", () => {
  it("validates a paired run and atomically replaces all sample documents", async () => {
    const fixture = await createFixture();
    const result = await refreshSampleReports({
      projectRoot: fixture.root,
      sampleRoot: fixture.sampleRoot,
      args: [
        `runs/${fixture.deceptiveRunId}`,
        `runs/${fixture.filesystemRunId}`,
      ],
      schemas,
    });

    expect(result).toEqual({
      deceptiveRunId: fixture.deceptiveRunId,
      filesystemRunId: fixture.filesystemRunId,
      observerImageId,
    });
    await expect(
      readFile(join(fixture.sampleRoot, "deceptive-control.report.json"), "utf8"),
    ).resolves.toBe(fixture.deceptiveReport);
    await expect(
      readFile(
        join(fixture.sampleRoot, "official-filesystem.report.json"),
        "utf8",
      ),
    ).resolves.toBe(fixture.filesystemReport);
    const refreshedReadme = await readFile(
      join(fixture.sampleRoot, "README.md"),
      "utf8",
    );
    expect(refreshedReadme).toContain(
      `report from \`${fixture.deceptiveRunId}\``,
    );
    expect(refreshedReadme).toContain(
      `report from \`${fixture.filesystemRunId}\``,
    );
    expect((await readdir(fixture.sampleRoot)).sort()).toEqual([
      "README.md",
      "deceptive-control.report.json",
      "official-filesystem.report.json",
    ]);
  });

  it("accepts a valid manifest-bound optional observation-health artifact", async () => {
    const fixture = await createFixture();
    await attachDeceptiveObservationHealth(fixture);

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).resolves.toMatchObject({ deceptiveRunId: fixture.deceptiveRunId });
    const refreshed = reportV1Schema.parse(
      JSON.parse(
        await readFile(
          join(fixture.sampleRoot, "deceptive-control.report.json"),
          "utf8",
        ),
      ),
    );
    expect(refreshed.observationHealth).toMatchObject({
      integrityStatus: "complete",
      canonicalizationExecutionStatus: "completed",
      policyRelevantGapStatus: "none_observed",
      artifact: "observation-health.json",
    });
  });

  it("requires exactly one manifest-bound JSON observation-health artifact", async () => {
    const absentFixture = await createFixture();
    await attachDeceptiveObservationHealth(absentFixture, {
      includeManifestArtifact: false,
    });

    await expect(
      refreshSampleReports({
        projectRoot: absentFixture.root,
        sampleRoot: absentFixture.sampleRoot,
        args: [
          `runs/${absentFixture.deceptiveRunId}`,
          `runs/${absentFixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("exactly one observation-health artifact");
    await expect(
      readFile(
        join(absentFixture.sampleRoot, "deceptive-control.report.json"),
        "utf8",
      ),
    ).resolves.toBe("old deceptive\n");

    const wrongMediaFixture = await createFixture();
    await attachDeceptiveObservationHealth(wrongMediaFixture, {
      mediaType: "text/plain",
    });
    await expect(
      refreshSampleReports({
        projectRoot: wrongMediaFixture.root,
        sampleRoot: wrongMediaFixture.sampleRoot,
        args: [
          `runs/${wrongMediaFixture.deceptiveRunId}`,
          `runs/${wrongMediaFixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("observation-health artifact is not JSON");
  });

  it("rejects observation-health bytes that no longer match the manifest", async () => {
    const fixture = await createFixture();
    const withHealth = await attachDeceptiveObservationHealth(fixture);
    await writeFile(
      join(fixture.deceptiveDirectory, "observation-health.json"),
      `${withHealth.healthSource}\n`,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow(
      "does not bind its observation-health artifact to the manifest",
    );
  });

  it("rejects observation-health summary and canonical-event contradictions", async () => {
    const summaryFixture = await createFixture();
    await attachDeceptiveObservationHealth(summaryFixture);
    const contradictoryReport = reportV1Schema.parse(
      JSON.parse(summaryFixture.deceptiveReport),
    );
    if (contradictoryReport.observationHealth === undefined) {
      throw new Error("fixture lacks observation health");
    }
    contradictoryReport.observationHealth.stringTruncationLineCount = 1;
    const contradictoryReportSource = `${JSON.stringify(
      reportV1Schema.parse(contradictoryReport),
      null,
      2,
    )}\n`;
    const summaryManifestPath = join(summaryFixture.deceptiveDirectory, "run.json");
    const summaryManifest = runManifestV1Schema.parse(
      JSON.parse(await readFile(summaryManifestPath, "utf8")),
    );
    const summaryReportRow = summaryManifest.artifacts.find(
      (artifact) => artifact.path === "report.json",
    );
    if (summaryReportRow === undefined) throw new Error("missing report row");
    summaryReportRow.sha256 = sha256(contradictoryReportSource);
    await Promise.all([
      writeFile(
        join(summaryFixture.deceptiveDirectory, "report.json"),
        contradictoryReportSource,
        "utf8",
      ),
      writeFile(
        summaryManifestPath,
        `${JSON.stringify(summaryManifest, null, 2)}\n`,
        "utf8",
      ),
    ]);

    await expect(
      refreshSampleReports({
        projectRoot: summaryFixture.root,
        sampleRoot: summaryFixture.sampleRoot,
        args: [
          `runs/${summaryFixture.deceptiveRunId}`,
          `runs/${summaryFixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow(
      "observation-health identity and counters do not match report.json",
    );

    const eventFixture = await createFixture();
    const withHealth = await attachDeceptiveObservationHealth(eventFixture);
    const contradictoryHealth = observationHealthV1Schema.parse(
      JSON.parse(withHealth.healthSource),
    );
    const firstCanonicalization = contradictoryHealth.experiments[0]
      ?.canonicalization;
    if (firstCanonicalization?.status !== "completed") {
      throw new Error("fixture lacks completed canonicalization");
    }
    firstCanonicalization.emittedEventCount += 1;
    const contradictoryHealthSource = `${JSON.stringify(
      observationHealthV1Schema.parse(contradictoryHealth),
      null,
      2,
    )}\n`;
    const eventManifestPath = join(eventFixture.deceptiveDirectory, "run.json");
    const eventManifest = runManifestV1Schema.parse(
      JSON.parse(await readFile(eventManifestPath, "utf8")),
    );
    const healthRow = eventManifest.artifacts.find(
      (artifact) => artifact.path === "observation-health.json",
    );
    if (healthRow === undefined) throw new Error("missing health row");
    healthRow.sha256 = sha256(contradictoryHealthSource);
    await Promise.all([
      writeFile(
        join(eventFixture.deceptiveDirectory, "observation-health.json"),
        contradictoryHealthSource,
        "utf8",
      ),
      writeFile(
        eventManifestPath,
        `${JSON.stringify(eventManifest, null, 2)}\n`,
        "utf8",
      ),
    ]);
    await expect(
      refreshSampleReports({
        projectRoot: eventFixture.root,
        sampleRoot: eventFixture.sampleRoot,
        args: [
          `runs/${eventFixture.deceptiveRunId}`,
          `runs/${eventFixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow(
      "observation-health canonical event counts do not match report.json",
    );
  });

  it("rejects mismatched observer images before changing destinations", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.filesystemDirectory, "run.json"),
      `${JSON.stringify(
        manifest(
          fixture.filesystemRunId,
          "official-filesystem",
          fixture.filesystemReport,
          fixture.filesystemSemanticArtifacts,
          `sha256:${"c".repeat(64)}`,
        ),
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("same immutable observer image");
    await expect(
      readFile(join(fixture.sampleRoot, "deceptive-control.report.json"), "utf8"),
    ).resolves.toBe("old deceptive\n");
    await expect(
      readFile(
        join(fixture.sampleRoot, "official-filesystem.report.json"),
        "utf8",
      ),
    ).resolves.toBe("old filesystem\n");
    await expect(
      readFile(join(fixture.sampleRoot, "README.md"), "utf8"),
    ).resolves.toBe(fixture.readme);
  });

  it("rejects a report that no longer matches its manifest hash", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.deceptiveDirectory, "report.json"),
      `${fixture.deceptiveReport}\n`,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("does not bind report.json to its manifest");
    await expect(
      readFile(join(fixture.sampleRoot, "deceptive-control.report.json"), "utf8"),
    ).resolves.toBe("old deceptive\n");
    expect((await readdir(fixture.sampleRoot)).sort()).toEqual([
      "README.md",
      "deceptive-control.report.json",
      "official-filesystem.report.json",
    ]);
  });

  it("requires exactly one JSON report.json manifest row", async () => {
    const duplicateFixture = await createFixture();
    const duplicateManifestPath = join(
      duplicateFixture.deceptiveDirectory,
      "run.json",
    );
    const duplicateManifest = runManifestV1Schema.parse(
      JSON.parse(await readFile(duplicateManifestPath, "utf8")),
    );
    const reportRow = duplicateManifest.artifacts.find(
      (artifact) => artifact.path === "report.json",
    );
    if (reportRow === undefined) throw new Error("missing report row");
    duplicateManifest.artifacts.push({ ...reportRow });
    await writeFile(
      duplicateManifestPath,
      `${JSON.stringify(duplicateManifest, null, 2)}\n`,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: duplicateFixture.root,
        sampleRoot: duplicateFixture.sampleRoot,
        args: [
          `runs/${duplicateFixture.deceptiveRunId}`,
          `runs/${duplicateFixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("must bind exactly one report.json artifact");

    const mediaFixture = await createFixture();
    const mediaManifestPath = join(mediaFixture.deceptiveDirectory, "run.json");
    const mediaManifest = runManifestV1Schema.parse(
      JSON.parse(await readFile(mediaManifestPath, "utf8")),
    );
    const mediaReportRow = mediaManifest.artifacts.find(
      (artifact) => artifact.path === "report.json",
    );
    if (mediaReportRow === undefined) throw new Error("missing report row");
    mediaReportRow.mediaType = "text/plain";
    await writeFile(
      mediaManifestPath,
      `${JSON.stringify(mediaManifest, null, 2)}\n`,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: mediaFixture.root,
        sampleRoot: mediaFixture.sampleRoot,
        args: [
          `runs/${mediaFixture.deceptiveRunId}`,
          `runs/${mediaFixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("report.json artifact is not JSON");
  });

  it("enforces explicit byte caps before parsing run, report, and semantic JSON", async () => {
    const cases = [
      {
        artifactPath: (fixture: RefreshFixture) =>
          join(fixture.deceptiveDirectory, "run.json"),
        maximumBytes: 8 * 1_024 * 1_024,
      },
      {
        artifactPath: (fixture: RefreshFixture) =>
          join(fixture.deceptiveDirectory, "report.json"),
        maximumBytes: 64 * 1_024 * 1_024,
      },
      {
        artifactPath: (fixture: RefreshFixture) =>
          join(
            fixture.deceptiveDirectory,
            fixture.deceptiveSemanticArtifacts[0]!.path,
          ),
        maximumBytes: 16 * 1_024 * 1_024,
      },
    ];

    for (const testCase of cases) {
      const fixture = await createFixture();
      await truncate(testCase.artifactPath(fixture), testCase.maximumBytes + 1);
      await expect(
        refreshSampleReports({
          projectRoot: fixture.root,
          sampleRoot: fixture.sampleRoot,
          args: [
            `runs/${fixture.deceptiveRunId}`,
            `runs/${fixture.filesystemRunId}`,
          ],
          schemas,
        }),
      ).rejects.toThrow(
        `exceeds the ${testCase.maximumBytes}-byte parsing limit`,
      );
    }
  });

  it("does not follow a report.json symlink", async () => {
    const fixture = await createFixture();
    const outsideReport = join(fixture.root, "outside-report.json");
    await writeFile(outsideReport, fixture.deceptiveReport, "utf8");
    await rm(join(fixture.deceptiveDirectory, "report.json"));
    await symlink(outsideReport, join(fixture.deceptiveDirectory, "report.json"));

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("report.json is not a readable regular file");
    await expect(
      readFile(join(fixture.sampleRoot, "deceptive-control.report.json"), "utf8"),
    ).resolves.toBe("old deceptive\n");
  });

  it("requires both semantic artifact rows with JSON media types", async () => {
    const fixture = await createFixture();
    const manifestPath = join(fixture.deceptiveDirectory, "run.json");
    const runManifest = runManifestV1Schema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    const preInstallPath = fixture.deceptiveSemanticArtifacts[1]!.path;
    runManifest.artifacts = runManifest.artifacts.filter(
      (artifact) => artifact.path !== preInstallPath,
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify(runManifest, null, 2)}\n`,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("exactly one pre-install semantic artifact");

    const restoredManifest = manifest(
      fixture.deceptiveRunId,
      "deceptive-document-summarizer",
      fixture.deceptiveReport,
      fixture.deceptiveSemanticArtifacts,
    );
    const selectedPath = fixture.deceptiveSemanticArtifacts[0]!.path;
    const selectedRow = restoredManifest.artifacts.find(
      (artifact) => artifact.path === selectedPath,
    );
    if (selectedRow === undefined) throw new Error("missing selected artifact row");
    selectedRow.mediaType = "text/plain";
    await writeFile(
      manifestPath,
      `${JSON.stringify(restoredManifest, null, 2)}\n`,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("selected semantic artifact is not JSON");
  });

  it("binds selected semantic bytes to both the manifest and report summary", async () => {
    const fixture = await createFixture();
    const selected = fixture.deceptiveSemanticArtifacts[0]!;
    const changedSource = `${selected.source}\n`;
    await writeFile(
      join(fixture.deceptiveDirectory, selected.path),
      changedSource,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow(
      "does not bind its selected semantic artifact to the manifest",
    );

    const manifestPath = join(fixture.deceptiveDirectory, "run.json");
    const runManifest = runManifestV1Schema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    const selectedRow = runManifest.artifacts.find(
      (artifact) => artifact.path === selected.path,
    );
    if (selectedRow === undefined) throw new Error("missing selected artifact row");
    selectedRow.sha256 = sha256(changedSource);
    await writeFile(
      manifestPath,
      `${JSON.stringify(runManifest, null, 2)}\n`,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("does not match the report summary");
  });

  it("rejects semantic identity drift and paths resolving outside the run", async () => {
    const fixture = await createFixture();
    const preInstall = fixture.deceptiveSemanticArtifacts[1]!;
    const changed = JSON.parse(preInstall.source) as {
      input: { lexicalInspectionArtifact: string };
    };
    changed.input.lexicalInspectionArtifact = "static/inspection.json";
    const changedSource = `${JSON.stringify(changed, null, 2)}\n`;
    await writeFile(
      join(fixture.deceptiveDirectory, preInstall.path),
      changedSource,
      "utf8",
    );
    const manifestPath = join(fixture.deceptiveDirectory, "run.json");
    const runManifest = runManifestV1Schema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    const preInstallRow = runManifest.artifacts.find(
      (artifact) => artifact.path === preInstall.path,
    );
    if (preInstallRow === undefined) throw new Error("missing pre-install row");
    preInstallRow.sha256 = sha256(changedSource);
    await writeFile(
      manifestPath,
      `${JSON.stringify(runManifest, null, 2)}\n`,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("pre-install semantic artifact identity is inconsistent");

    const escapeFixture = await createFixture();
    const outsideStaticDirectory = join(escapeFixture.root, "outside-static");
    await mkdir(outsideStaticDirectory);
    await Promise.all(
      escapeFixture.filesystemSemanticArtifacts.map((artifact) =>
        writeFile(
          join(outsideStaticDirectory, artifact.path.split("/").at(-1)!),
          artifact.source,
          "utf8",
        ),
      ),
    );
    const staticDirectory = join(escapeFixture.filesystemDirectory, "static");
    await rm(staticDirectory, { recursive: true });
    await symlink(outsideStaticDirectory, staticDirectory, "dir");

    await expect(
      refreshSampleReports({
        projectRoot: escapeFixture.root,
        sampleRoot: escapeFixture.sampleRoot,
        args: [
          `runs/${escapeFixture.deceptiveRunId}`,
          `runs/${escapeFixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("semantic artifact path resolves outside its Forge run");
  });

  it("rejects an incomplete run before changing destinations", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.deceptiveDirectory, "run.json"),
      `${JSON.stringify(
        {
          ...manifest(
            fixture.deceptiveRunId,
            "deceptive-document-summarizer",
            fixture.deceptiveReport,
            fixture.deceptiveSemanticArtifacts,
          ),
          status: "failed",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("is not a completed Forge analysis");
    await expect(
      readFile(join(fixture.sampleRoot, "deceptive-control.report.json"), "utf8"),
    ).resolves.toBe("old deceptive\n");
  });

  it("validates README markers before changing destinations", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.sampleRoot, "README.md"),
      "# Missing sample identifiers\n",
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("README run identifier lines are missing");
    await expect(
      readFile(join(fixture.sampleRoot, "deceptive-control.report.json"), "utf8"),
    ).resolves.toBe("old deceptive\n");
    await expect(
      readFile(
        join(fixture.sampleRoot, "official-filesystem.report.json"),
        "utf8",
      ),
    ).resolves.toBe("old filesystem\n");
    expect((await readdir(fixture.sampleRoot)).sort()).toEqual([
      "README.md",
      "deceptive-control.report.json",
      "official-filesystem.report.json",
    ]);
  });

  it("rejects high-confidence host and secret patterns but permits container paths", () => {
    expect(() =>
      assertSampleContentSafe(
        "/sandbox/home/forge/.ssh/id_ed25519 and /home/node/runtime.txt",
        "sample",
      ),
    ).not.toThrow();
    expect(() =>
      assertSampleContentSafe("/Users/alice/project/report.json", "sample"),
    ).toThrow("macOS host home path");
    expect(() =>
      assertSampleContentSafe(
        "github_pat_abcdefghijklmnopqrstuvwxyz0123456789",
        "sample",
      ),
    ).toThrow("GitHub token");
    expect(() =>
      assertSampleContentSafe(
        "-----BEGIN ENCRYPTED PRIVATE KEY-----",
        "sample",
      ),
    ).toThrow("private key");
  });
});
