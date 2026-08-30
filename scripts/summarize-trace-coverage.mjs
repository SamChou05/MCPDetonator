import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = resolve(dirname(scriptPath), "..");

export const MAX_TRACE_COVERAGE_RUNS = 128;
export const MAX_RUN_MANIFEST_BYTES = 8 * 1_024 * 1_024;
export const MAX_OBSERVATION_HEALTH_BYTES = 16 * 1_024 * 1_024;
export const MAX_TOTAL_RUN_MANIFEST_BYTES = 64 * 1_024 * 1_024;
export const MAX_TOTAL_OBSERVATION_HEALTH_BYTES = 64 * 1_024 * 1_024;
export const MAX_TRACE_COVERAGE_EXPERIMENTS = 4_096;

const OBSERVATION_HEALTH_ARTIFACT = "observation-health.json";
const RUN_MANIFEST_ARTIFACT = "run.json";
const RUN_DIRECTORY_NAME = /^run-[A-Za-z0-9-]+$/u;
const GAP_OUTCOME_ORDER = ["succeeded", "failed", "unknown"];
const EXPERIMENT_COHORT_ORDER = [
  "install_lifecycle",
  "baseline_initialization",
  "tool",
];

let currentModulesPromise;

async function loadCurrentModules() {
  currentModulesPromise ??= (async () => {
    let tsImport;
    try {
      // Load source contracts when development dependencies are present so a
      // stale ignored dist/ directory cannot silently validate corpus input.
      ({ tsImport } = await import("tsx/esm/api"));
    } catch (sourceLoaderError) {
      try {
        const [contracts, strictJson] = await Promise.all([
          import("../dist/contracts/v1.js"),
          import("../dist/audit/v2/strict-json.js"),
        ]);
        return { contracts, strictJson };
      } catch (distError) {
        throw new AggregateError(
          [sourceLoaderError, distError],
          "could not load current Forge contracts; run npm install or npm run build",
        );
      }
    }

    // Once the source loader is available, source failures must not fall back
    // to potentially stale build output.
    const [contracts, strictJson] = await Promise.all([
      tsImport("../src/contracts/v1.ts", import.meta.url),
      tsImport("../src/audit/v2/strict-json.ts", import.meta.url),
    ]);
    return { contracts, strictJson };
  })();

  const modules = await currentModulesPromise;
  if (
    modules.contracts.observationHealthV1Schema === undefined ||
    modules.contracts.runManifestV1Schema === undefined ||
    typeof modules.strictJson.parseStrictJson !== "function"
  ) {
    throw new Error(
      "loaded Forge modules do not expose the run/health schemas and strict JSON parser",
    );
  }
  return modules;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left, right) {
  return (
    sameFileIdentity(left, right) &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isContainedOneLevel(parent, child) {
  const childRelative = relative(parent, child);
  return (
    childRelative !== "" &&
    childRelative !== ".." &&
    !childRelative.startsWith(`..${sep}`) &&
    !isAbsolute(childRelative) &&
    !childRelative.includes(sep)
  );
}

function assertNoTraversalSegments(argument) {
  if (typeof argument !== "string" || argument.length === 0) {
    throw new Error("run directory arguments must be nonempty strings");
  }
  if (argument.includes("\0")) {
    throw new Error("run directory arguments cannot contain NUL bytes");
  }
  if (argument.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")) {
    throw new Error(`run directory traversal is not allowed: ${argument}`);
  }
}

async function checkedRunsRoot(projectRoot) {
  const lexicalRunsRoot = join(projectRoot, "runs");
  const metadata = await lstat(lexicalRunsRoot, { bigint: true }).catch(
    (error) => {
      throw new Error("Forge runs root is not a readable directory", {
        cause: error,
      });
    },
  );
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Forge runs root must be a non-symlink directory");
  }
  const canonicalRunsRoot = await realpath(lexicalRunsRoot);
  const canonicalMetadata = await lstat(canonicalRunsRoot, { bigint: true });
  if (
    !canonicalMetadata.isDirectory() ||
    !sameFileIdentity(metadata, canonicalMetadata)
  ) {
    throw new Error("Forge runs root changed while it was being verified");
  }
  return { lexicalRunsRoot, canonicalRunsRoot, metadata };
}

async function checkedRunDirectory(projectRoot, runsRoot, argument) {
  assertNoTraversalSegments(argument);
  const lexicalDirectory = resolve(projectRoot, argument);
  if (
    !isContainedOneLevel(runsRoot.lexicalRunsRoot, lexicalDirectory) ||
    !RUN_DIRECTORY_NAME.test(relative(runsRoot.lexicalRunsRoot, lexicalDirectory))
  ) {
    throw new Error(
      `trace coverage input must be an explicit runs/run-* directory: ${argument}`,
    );
  }

  const before = await lstat(lexicalDirectory, { bigint: true }).catch(
    (error) => {
      throw new Error(`run directory is not readable: ${argument}`, {
        cause: error,
      });
    },
  );
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`run directory must be a non-symlink directory: ${argument}`);
  }

  const canonicalDirectory = await realpath(lexicalDirectory);
  if (!isContainedOneLevel(runsRoot.canonicalRunsRoot, canonicalDirectory)) {
    throw new Error(`run directory resolves outside the Forge runs root: ${argument}`);
  }
  const canonicalMetadata = await lstat(canonicalDirectory, { bigint: true });
  if (
    !canonicalMetadata.isDirectory() ||
    !sameFileIdentity(before, canonicalMetadata)
  ) {
    throw new Error(`run directory changed while it was being verified: ${argument}`);
  }

  return {
    argument,
    lexicalDirectory,
    canonicalDirectory,
    runId: relative(runsRoot.canonicalRunsRoot, canonicalDirectory),
    metadata: before,
  };
}

async function readBoundedRegularFile(path, maximumBytes, label) {
  const visibleBefore = await lstat(path, { bigint: true }).catch((error) => {
    throw new Error(`${label} is not a readable regular file`, { cause: error });
  });
  if (!visibleBefore.isFile() || visibleBefore.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink regular file`);
  }
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("this platform does not provide O_NOFOLLOW");
  }

  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    throw new Error(`${label} is not a readable regular file`, { cause: error });
  }

  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFileState(visibleBefore, before)) {
      throw new Error(`${label} changed while it was being verified`);
    }
    if (
      before.size < 0n ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      before.size > BigInt(maximumBytes)
    ) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte parsing limit`);
    }

    const expectedSize = Number(before.size);
    const bytes = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const result = await handle.read(bytes, offset, expectedSize - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const extraResult = await handle.read(extra, 0, 1, expectedSize);
    const [after, visibleAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]).catch((error) => {
      throw new Error(`${label} changed while it was being verified`, {
        cause: error,
      });
    });
    if (
      offset !== expectedSize ||
      extraResult.bytesRead !== 0 ||
      !visibleAfter.isFile() ||
      !sameFileState(before, after) ||
      !sameFileState(before, visibleAfter)
    ) {
      throw new Error(`${label} changed while it was being verified`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function assertRunDirectoryStable(runDirectory) {
  const [canonicalAfter, visibleAfter] = await Promise.all([
    realpath(runDirectory.lexicalDirectory),
    lstat(runDirectory.lexicalDirectory, { bigint: true }),
  ]).catch((error) => {
    throw new Error(
      `run directory changed while it was being read: ${runDirectory.argument}`,
      { cause: error },
    );
  });
  if (
    canonicalAfter !== runDirectory.canonicalDirectory ||
    !visibleAfter.isDirectory() ||
    !sameFileIdentity(runDirectory.metadata, visibleAfter)
  ) {
    throw new Error(
      `run directory changed while it was being read: ${runDirectory.argument}`,
    );
  }
}

function checkedAdd(left, right, label) {
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    left < 0 ||
    right < 0 ||
    left > Number.MAX_SAFE_INTEGER - right
  ) {
    throw new Error(`${label} exceeds the non-negative safe integer range`);
  }
  return left + right;
}

function addCount(counts, key, count, label) {
  counts.set(key, checkedAdd(counts.get(key) ?? 0, count, label));
}

function sumRows(rows, label) {
  return rows.reduce(
    (sum, row) => checkedAdd(sum, row.recordCount, label),
    0,
  );
}

function sortedCountRows(counts, keyName, preferredOrder) {
  const keys = [...counts.keys()].sort(
    preferredOrder === undefined
      ? compareStrings
      : (left, right) => preferredOrder.indexOf(left) - preferredOrder.indexOf(right),
  );
  return keys.map((key) => ({ [keyName]: key, recordCount: counts.get(key) }));
}

function assertPartition(rows, expected, label) {
  if (sumRows(rows, `${label} row total`) !== expected) {
    throw new Error(`${label} rows do not form an exact aggregate partition`);
  }
}

function experimentCohort(experimentId) {
  if (experimentId.startsWith("install-")) return "install_lifecycle";
  if (experimentId === "baseline-initialization") {
    return "baseline_initialization";
  }
  return "tool";
}

function emptyCohortAggregate(cohort) {
  return {
    cohort,
    runIds: new Set(),
    experimentCount: 0,
    degradedExperimentCount: 0,
    completedCanonicalizationExperimentCount: 0,
    policyRelevantGapExperimentCount: 0,
    traceFileCount: 0,
    nonemptyTraceLineCount: 0,
    parsedTraceRecordCount: 0,
    capturedSyscallRecordCount: 0,
    completedCanonicalizationEmittedEventCount: 0,
    policyRelevantGapRecordCount: 0,
    stringTruncationLineCount: 0,
    capturedSyscalls: new Map(),
    gapCategories: new Map(),
    gapSyscalls: new Map(),
    gapOutcomes: new Map(),
  };
}

function addExperimentToCohort(aggregate, runId, experiment) {
  const label = `${aggregate.cohort} cohort`;
  aggregate.runIds.add(runId);
  aggregate.experimentCount = checkedAdd(
    aggregate.experimentCount,
    1,
    `${label} experiment count`,
  );
  if (!experiment.integrityComplete) {
    aggregate.degradedExperimentCount = checkedAdd(
      aggregate.degradedExperimentCount,
      1,
      `${label} degraded experiment count`,
    );
  }
  if (experiment.policyRelevantGaps.recordCount > 0) {
    aggregate.policyRelevantGapExperimentCount = checkedAdd(
      aggregate.policyRelevantGapExperimentCount,
      1,
      `${label} gap experiment count`,
    );
  }
  aggregate.traceFileCount = checkedAdd(
    aggregate.traceFileCount,
    experiment.traceFileCount,
    `${label} trace-file count`,
  );
  aggregate.nonemptyTraceLineCount = checkedAdd(
    aggregate.nonemptyTraceLineCount,
    experiment.nonemptyLineCount,
    `${label} nonempty trace-line count`,
  );
  aggregate.parsedTraceRecordCount = checkedAdd(
    aggregate.parsedTraceRecordCount,
    experiment.parsedRecordCount,
    `${label} parsed trace-record count`,
  );
  aggregate.stringTruncationLineCount = checkedAdd(
    aggregate.stringTruncationLineCount,
    experiment.stringTruncationLineCount,
    `${label} string-truncation line count`,
  );
  for (const row of experiment.capturedSyscallCounts) {
    addCount(
      aggregate.capturedSyscalls,
      row.syscall,
      row.recordCount,
      `${label} captured syscall ${row.syscall} count`,
    );
    aggregate.capturedSyscallRecordCount = checkedAdd(
      aggregate.capturedSyscallRecordCount,
      row.recordCount,
      `${label} captured syscall record count`,
    );
  }
  const gaps = experiment.policyRelevantGaps;
  aggregate.policyRelevantGapRecordCount = checkedAdd(
    aggregate.policyRelevantGapRecordCount,
    gaps.recordCount,
    `${label} selected gap record count`,
  );
  for (const row of gaps.categoryCounts) {
    addCount(
      aggregate.gapCategories,
      row.category,
      row.recordCount,
      `${label} gap category ${row.category} count`,
    );
  }
  for (const row of gaps.syscallCounts) {
    addCount(
      aggregate.gapSyscalls,
      row.syscall,
      row.recordCount,
      `${label} gap syscall ${row.syscall} count`,
    );
  }
  for (const row of gaps.outcomeCounts) {
    addCount(
      aggregate.gapOutcomes,
      row.outcome,
      row.recordCount,
      `${label} gap outcome ${row.outcome} count`,
    );
  }
  if (experiment.canonicalization.status === "completed") {
    aggregate.completedCanonicalizationExperimentCount = checkedAdd(
      aggregate.completedCanonicalizationExperimentCount,
      1,
      `${label} completed canonicalization experiment count`,
    );
    aggregate.completedCanonicalizationEmittedEventCount = checkedAdd(
      aggregate.completedCanonicalizationEmittedEventCount,
      experiment.canonicalization.emittedEventCount,
      `${label} emitted event count`,
    );
  }
}

function renderGapCounts(categoryCounts, syscallCounts, outcomeCounts) {
  return {
    categoryCounts: sortedCountRows(categoryCounts, "category"),
    syscallCounts: sortedCountRows(syscallCounts, "syscall"),
    outcomeCounts: sortedCountRows(
      outcomeCounts,
      "outcome",
      GAP_OUTCOME_ORDER,
    ),
  };
}

function renderCohortAggregate(aggregate) {
  const capturedSyscallCounts = sortedCountRows(
    aggregate.capturedSyscalls,
    "syscall",
  );
  const policyRelevantGapCounts = renderGapCounts(
    aggregate.gapCategories,
    aggregate.gapSyscalls,
    aggregate.gapOutcomes,
  );
  assertPartition(
    capturedSyscallCounts,
    aggregate.capturedSyscallRecordCount,
    `${aggregate.cohort} captured syscall counts`,
  );
  assertPartition(
    policyRelevantGapCounts.categoryCounts,
    aggregate.policyRelevantGapRecordCount,
    `${aggregate.cohort} gap category counts`,
  );
  assertPartition(
    policyRelevantGapCounts.syscallCounts,
    aggregate.policyRelevantGapRecordCount,
    `${aggregate.cohort} gap syscall counts`,
  );
  assertPartition(
    policyRelevantGapCounts.outcomeCounts,
    aggregate.policyRelevantGapRecordCount,
    `${aggregate.cohort} gap outcome counts`,
  );
  return {
    cohort: aggregate.cohort,
    runCount: aggregate.runIds.size,
    experimentCount: aggregate.experimentCount,
    degradedExperimentCount: aggregate.degradedExperimentCount,
    completedCanonicalizationExperimentCount:
      aggregate.completedCanonicalizationExperimentCount,
    incompleteCanonicalizationExperimentCount:
      aggregate.experimentCount -
      aggregate.completedCanonicalizationExperimentCount,
    policyRelevantGapExperimentCount:
      aggregate.policyRelevantGapExperimentCount,
    totals: {
      traceFileCount: aggregate.traceFileCount,
      nonemptyTraceLineCount: aggregate.nonemptyTraceLineCount,
      parsedTraceRecordCount: aggregate.parsedTraceRecordCount,
      capturedSyscallRecordCount: aggregate.capturedSyscallRecordCount,
      completedCanonicalizationEmittedEventCount:
        aggregate.completedCanonicalizationEmittedEventCount,
      policyRelevantGapRecordCount: aggregate.policyRelevantGapRecordCount,
      stringTruncationLineCount: aggregate.stringTruncationLineCount,
    },
    capturedSyscallCounts,
    policyRelevantGapCounts,
  };
}

function renderExperimentRow(runId, experiment) {
  const gapCategories = new Map(
    experiment.policyRelevantGaps.categoryCounts.map((row) => [
      row.category,
      row.recordCount,
    ]),
  );
  const gapSyscalls = new Map(
    experiment.policyRelevantGaps.syscallCounts.map((row) => [
      row.syscall,
      row.recordCount,
    ]),
  );
  const gapOutcomes = new Map(
    experiment.policyRelevantGaps.outcomeCounts.map((row) => [
      row.outcome,
      row.recordCount,
    ]),
  );
  return {
    runId,
    experimentId: experiment.experimentId,
    cohort: experimentCohort(experiment.experimentId),
    integrityStatus: experiment.integrityComplete ? "complete" : "degraded",
    canonicalizationExecutionStatus:
      experiment.canonicalization.status === "completed"
        ? "completed"
        : "incomplete",
    policyRelevantGapStatus:
      experiment.policyRelevantGaps.recordCount === 0
        ? "none_observed"
        : "gaps_observed",
    traceFileCount: experiment.traceFileCount,
    nonemptyTraceLineCount: experiment.nonemptyLineCount,
    parsedTraceRecordCount: experiment.parsedRecordCount,
    capturedSyscallRecordCount: experiment.parsedSyscallRecordCount,
    completedCanonicalizationEmittedEventCount:
      experiment.canonicalization.status === "completed"
        ? experiment.canonicalization.emittedEventCount
        : 0,
    policyRelevantGapRecordCount:
      experiment.policyRelevantGaps.recordCount,
    stringTruncationLineCount: experiment.stringTruncationLineCount,
    capturedSyscallCounts: experiment.capturedSyscallCounts.map((row) => ({
      syscall: row.syscall,
      recordCount: row.recordCount,
    })),
    policyRelevantGapCounts: renderGapCounts(
      gapCategories,
      gapSyscalls,
      gapOutcomes,
    ),
  };
}

function parseBoundedJson(bytes, maximumBytes, label, modules) {
  try {
    return modules.strictJson.parseStrictJson(bytes, {
      maxBytes: maximumBytes,
      maxDepth: 32,
      maxNodes: 1_000_000,
      maxTotalStringCharacters: maximumBytes,
      maxKeyCharacters: 256,
      maxArrayItems: 100_000,
      maxObjectKeys: 256,
    });
  } catch (error) {
    throw new Error(`${label} is not valid bounded JSON`, { cause: error });
  }
}

function parseManifest(bytes, runDirectory, modules) {
  const raw = parseBoundedJson(
    bytes,
    MAX_RUN_MANIFEST_BYTES,
    `run ${runDirectory.runId} run.json`,
    modules,
  );
  let manifest;
  try {
    manifest = modules.contracts.runManifestV1Schema.parse(raw);
  } catch (error) {
    throw new Error(
      `run ${runDirectory.runId} run.json does not satisfy forge.run/v1`,
      { cause: error },
    );
  }
  if (manifest.runId !== runDirectory.runId) {
    throw new Error(
      `run directory identity ${runDirectory.runId} does not match manifest runId ${manifest.runId}`,
    );
  }
  if (manifest.status === "running") {
    throw new Error(`run ${runDirectory.runId} manifest is not terminal`);
  }
  const healthRows = manifest.artifacts.filter(
    (artifact) => artifact.path === OBSERVATION_HEALTH_ARTIFACT,
  );
  if (healthRows.length !== 1) {
    throw new Error(
      `run ${runDirectory.runId} manifest must bind exactly one observation-health.json artifact`,
    );
  }
  const healthRow = healthRows[0];
  if (healthRow.mediaType !== "application/json") {
    throw new Error(
      `run ${runDirectory.runId} manifest must label observation-health.json as application/json`,
    );
  }
  return { manifest, healthRow };
}

function parseHealth(bytes, runDirectory, modules) {
  const raw = parseBoundedJson(
    bytes,
    MAX_OBSERVATION_HEALTH_BYTES,
    `run ${runDirectory.runId} observation-health.json`,
    modules,
  );

  let health;
  try {
    health = modules.contracts.observationHealthV1Schema.parse(raw);
  } catch (error) {
    throw new Error(
      `run ${runDirectory.runId} observation-health.json does not satisfy forge.observation-health/v1`,
      { cause: error },
    );
  }
  if (health.runId !== runDirectory.runId) {
    throw new Error(
      `run directory identity ${runDirectory.runId} does not match observation-health runId ${health.runId}`,
    );
  }
  return health;
}

async function loadRunEvidence(projectRoot, runsRoot, argument, modules) {
  const runDirectory = await checkedRunDirectory(projectRoot, runsRoot, argument);
  const manifestBytes = await readBoundedRegularFile(
    join(runDirectory.canonicalDirectory, RUN_MANIFEST_ARTIFACT),
    MAX_RUN_MANIFEST_BYTES,
    `run ${runDirectory.runId} run.json`,
  );
  const { manifest, healthRow } = parseManifest(
    manifestBytes,
    runDirectory,
    modules,
  );
  const healthBytes = await readBoundedRegularFile(
    join(runDirectory.canonicalDirectory, OBSERVATION_HEALTH_ARTIFACT),
    MAX_OBSERVATION_HEALTH_BYTES,
    `run ${runDirectory.runId} observation-health.json`,
  );
  const healthSha256 = createHash("sha256").update(healthBytes).digest("hex");
  if (healthSha256 !== healthRow.sha256) {
    throw new Error(
      `run ${runDirectory.runId} observation-health.json SHA-256 does not match run.json`,
    );
  }
  await assertRunDirectoryStable(runDirectory);
  return {
    manifestBytesRead: manifestBytes.byteLength,
    healthBytesRead: healthBytes.byteLength,
    manifest,
    health: parseHealth(healthBytes, runDirectory, modules),
  };
}

function aggregateHealth(runEvidence) {
  const capturedSyscalls = new Map();
  const gapCategories = new Map();
  const gapSyscalls = new Map();
  const gapOutcomes = new Map();
  const runs = [];
  const experiments = [];
  const cohortAggregates = new Map(
    EXPERIMENT_COHORT_ORDER.map((cohort) => [
      cohort,
      emptyCohortAggregate(cohort),
    ]),
  );
  let experimentCount = 0;
  let totalTraceFileCount = 0;
  let totalNonemptyLineCount = 0;
  let totalParsedRecordCount = 0;
  let totalCapturedSyscallRecordCount = 0;
  let totalCompletedEmittedEventCount = 0;
  let totalGapRecordCount = 0;
  let totalStringTruncationLineCount = 0;

  for (const evidence of runEvidence) {
    const { health, manifest } = evidence;
    let runTraceFileCount = 0;
    let runCapturedSyscallRecordCount = 0;
    let runCompletedEmittedEventCount = 0;
    let runGapRecordCount = 0;
    let completedCanonicalizationExperimentCount = 0;

    experimentCount = checkedAdd(
      experimentCount,
      health.experiments.length,
      "aggregate experiment count",
    );
    if (experimentCount > MAX_TRACE_COVERAGE_EXPERIMENTS) {
      throw new Error(
        `trace coverage corpus exceeds the ${MAX_TRACE_COVERAGE_EXPERIMENTS}-experiment limit`,
      );
    }

    for (const experiment of health.experiments) {
      const cohort = experimentCohort(experiment.experimentId);
      const cohortAggregate = cohortAggregates.get(cohort);
      if (cohortAggregate === undefined) {
        throw new Error(`unsupported trace coverage experiment cohort: ${cohort}`);
      }
      addExperimentToCohort(cohortAggregate, health.runId, experiment);
      experiments.push(renderExperimentRow(health.runId, experiment));
      runTraceFileCount = checkedAdd(
        runTraceFileCount,
        experiment.traceFileCount,
        `run ${health.runId} trace-file count`,
      );
      totalNonemptyLineCount = checkedAdd(
        totalNonemptyLineCount,
        experiment.nonemptyLineCount,
        "aggregate nonempty trace-line count",
      );
      totalParsedRecordCount = checkedAdd(
        totalParsedRecordCount,
        experiment.parsedRecordCount,
        "aggregate parsed trace-record count",
      );
      totalStringTruncationLineCount = checkedAdd(
        totalStringTruncationLineCount,
        experiment.stringTruncationLineCount,
        "aggregate string-truncation line count",
      );

      for (const row of experiment.capturedSyscallCounts) {
        addCount(
          capturedSyscalls,
          row.syscall,
          row.recordCount,
          `captured syscall ${row.syscall} count`,
        );
        runCapturedSyscallRecordCount = checkedAdd(
          runCapturedSyscallRecordCount,
          row.recordCount,
          `run ${health.runId} captured syscall count`,
        );
      }
      const gaps = experiment.policyRelevantGaps;
      runGapRecordCount = checkedAdd(
        runGapRecordCount,
        gaps.recordCount,
        `run ${health.runId} selected gap count`,
      );
      for (const row of gaps.categoryCounts) {
        addCount(
          gapCategories,
          row.category,
          row.recordCount,
          `gap category ${row.category} count`,
        );
      }
      for (const row of gaps.syscallCounts) {
        addCount(
          gapSyscalls,
          row.syscall,
          row.recordCount,
          `gap syscall ${row.syscall} count`,
        );
      }
      for (const row of gaps.outcomeCounts) {
        addCount(
          gapOutcomes,
          row.outcome,
          row.recordCount,
          `gap outcome ${row.outcome} count`,
        );
      }
      if (experiment.canonicalization.status === "completed") {
        completedCanonicalizationExperimentCount = checkedAdd(
          completedCanonicalizationExperimentCount,
          1,
          `run ${health.runId} completed canonicalization experiment count`,
        );
        runCompletedEmittedEventCount = checkedAdd(
          runCompletedEmittedEventCount,
          experiment.canonicalization.emittedEventCount,
          `run ${health.runId} emitted event count`,
        );
      }
    }

    totalTraceFileCount = checkedAdd(
      totalTraceFileCount,
      runTraceFileCount,
      "aggregate trace-file count",
    );
    totalCapturedSyscallRecordCount = checkedAdd(
      totalCapturedSyscallRecordCount,
      runCapturedSyscallRecordCount,
      "aggregate captured syscall record count",
    );
    totalCompletedEmittedEventCount = checkedAdd(
      totalCompletedEmittedEventCount,
      runCompletedEmittedEventCount,
      "aggregate emitted event count",
    );
    totalGapRecordCount = checkedAdd(
      totalGapRecordCount,
      runGapRecordCount,
      "aggregate selected gap record count",
    );
    runs.push({
      runId: health.runId,
      targetId: manifest.targetId,
      manifestStatus: manifest.status,
      integrityStatus: health.integrityStatus,
      canonicalizationExecutionStatus: health.canonicalizationExecutionStatus,
      policyRelevantGapStatus: health.policyRelevantGapStatus,
      experimentCount: health.experiments.length,
      degradedExperimentCount: health.degradedExperimentIds.length,
      completedCanonicalizationExperimentCount,
      incompleteCanonicalizationExperimentCount:
        health.experiments.length - completedCanonicalizationExperimentCount,
      traceFileCount: runTraceFileCount,
      capturedSyscallRecordCount: runCapturedSyscallRecordCount,
      completedCanonicalizationEmittedEventCount: runCompletedEmittedEventCount,
      policyRelevantGapRecordCount: runGapRecordCount,
    });
  }

  const capturedSyscallCounts = sortedCountRows(
    capturedSyscalls,
    "syscall",
  );
  const policyRelevantGapCounts = renderGapCounts(
    gapCategories,
    gapSyscalls,
    gapOutcomes,
  );
  assertPartition(
    capturedSyscallCounts,
    totalCapturedSyscallRecordCount,
    "captured syscall counts",
  );
  assertPartition(
    policyRelevantGapCounts.categoryCounts,
    totalGapRecordCount,
    "gap category counts",
  );
  assertPartition(
    policyRelevantGapCounts.syscallCounts,
    totalGapRecordCount,
    "gap syscall counts",
  );
  assertPartition(
    policyRelevantGapCounts.outcomeCounts,
    totalGapRecordCount,
    "gap outcome counts",
  );

  runs.sort((left, right) => compareStrings(left.runId, right.runId));
  experiments.sort(
    (left, right) =>
      compareStrings(left.runId, right.runId) ||
      compareStrings(left.experimentId, right.experimentId),
  );
  const cohorts = EXPERIMENT_COHORT_ORDER.map((cohort) => {
    const aggregate = cohortAggregates.get(cohort);
    if (aggregate === undefined) {
      throw new Error(`missing trace coverage cohort aggregate: ${cohort}`);
    }
    return renderCohortAggregate(aggregate);
  });
  const cohortExperimentCount = cohorts.reduce(
    (sum, cohort) =>
      checkedAdd(sum, cohort.experimentCount, "cohort experiment count"),
    0,
  );
  if (cohortExperimentCount !== experimentCount) {
    throw new Error("experiment cohorts do not exactly partition the corpus");
  }
  const cohortTotalChecks = [
    ["traceFileCount", totalTraceFileCount],
    ["nonemptyTraceLineCount", totalNonemptyLineCount],
    ["parsedTraceRecordCount", totalParsedRecordCount],
    ["capturedSyscallRecordCount", totalCapturedSyscallRecordCount],
    [
      "completedCanonicalizationEmittedEventCount",
      totalCompletedEmittedEventCount,
    ],
    ["policyRelevantGapRecordCount", totalGapRecordCount],
    ["stringTruncationLineCount", totalStringTruncationLineCount],
  ];
  for (const [field, expected] of cohortTotalChecks) {
    const actual = cohorts.reduce(
      (sum, cohort) =>
        checkedAdd(sum, cohort.totals[field], `cohort ${field} total`),
      0,
    );
    if (actual !== expected) {
      throw new Error(`experiment cohorts do not exactly partition ${field}`);
    }
  }
  return {
    schema: "forge.trace-coverage-summary/v1",
    scope: "selected_strace_surface",
    surfaceId: "forge-strace-selected-v1",
    runCount: runs.length,
    experimentCount,
    runs,
    cohorts,
    experiments,
    totals: {
      traceFileCount: totalTraceFileCount,
      nonemptyTraceLineCount: totalNonemptyLineCount,
      parsedTraceRecordCount: totalParsedRecordCount,
      capturedSyscallRecordCount: totalCapturedSyscallRecordCount,
      completedCanonicalizationEmittedEventCount:
        totalCompletedEmittedEventCount,
      policyRelevantGapRecordCount: totalGapRecordCount,
      stringTruncationLineCount: totalStringTruncationLineCount,
    },
    capturedSyscallCounts,
    policyRelevantGapCounts,
  };
}

export function serializeTraceCoverageSummary(summary) {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

export async function summarizeTraceCoverage(options = {}) {
  const runDirectories = options.runDirectories ?? process.argv.slice(2);
  if (!Array.isArray(runDirectories) || runDirectories.length === 0) {
    throw new Error(
      "usage: node scripts/summarize-trace-coverage.mjs <runs/run-id> [<runs/run-id> ...]",
    );
  }
  if (runDirectories.length > MAX_TRACE_COVERAGE_RUNS) {
    throw new Error(
      `trace coverage corpus exceeds the ${MAX_TRACE_COVERAGE_RUNS}-run limit`,
    );
  }

  const projectRoot = resolve(options.projectRoot ?? defaultProjectRoot);
  const [runsRoot, modules] = await Promise.all([
    checkedRunsRoot(projectRoot),
    loadCurrentModules(),
  ]);
  const runEvidence = [];
  const runIds = new Set();
  let totalManifestBytes = 0;
  let totalHealthBytes = 0;
  for (const argument of runDirectories) {
    const loaded = await loadRunEvidence(
      projectRoot,
      runsRoot,
      argument,
      modules,
    );
    if (runIds.has(loaded.health.runId)) {
      throw new Error(`duplicate run identity in trace corpus: ${loaded.health.runId}`);
    }
    runIds.add(loaded.health.runId);
    totalManifestBytes = checkedAdd(
      totalManifestBytes,
      loaded.manifestBytesRead,
      "total run-manifest input bytes",
    );
    if (totalManifestBytes > MAX_TOTAL_RUN_MANIFEST_BYTES) {
      throw new Error(
        `trace coverage corpus exceeds the ${MAX_TOTAL_RUN_MANIFEST_BYTES}-byte total manifest limit`,
      );
    }
    totalHealthBytes = checkedAdd(
      totalHealthBytes,
      loaded.healthBytesRead,
      "total observation-health input bytes",
    );
    if (totalHealthBytes > MAX_TOTAL_OBSERVATION_HEALTH_BYTES) {
      throw new Error(
        `trace coverage corpus exceeds the ${MAX_TOTAL_OBSERVATION_HEALTH_BYTES}-byte total input limit`,
      );
    }
    runEvidence.push(loaded);
  }

  return aggregateHealth(runEvidence);
}

async function main() {
  const summary = await summarizeTraceCoverage();
  process.stdout.write(serializeTraceCoverageSummary(summary));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`trace coverage summary failed: ${message}\n`);
    process.exitCode = 1;
  }
}
