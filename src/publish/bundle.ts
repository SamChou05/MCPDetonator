import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  win32,
} from "node:path";

import {
  observationHealthV1Schema,
  reportV1Schema,
  runManifestV1Schema,
  type ObservationHealthV1,
  type ReportV1,
  type RunManifestV1,
} from "../contracts/v1.js";
import {
  MAX_PUBLICATION_ARTIFACT_BYTES,
  MAX_PUBLICATION_ARTIFACT_COUNT,
  MAX_PUBLICATION_FINDING_COUNT,
  MAX_PUBLICATION_TOTAL_ARTIFACT_BYTES,
  MAX_PUBLICATION_VERIFICATION_MS,
} from "./limits.js";

const MAX_MANIFEST_BYTES = 8 * 1_024 * 1_024;
const MAX_REPORT_BYTES = 64 * 1_024 * 1_024;
const MAX_OBSERVATION_HEALTH_BYTES = 16 * 1_024 * 1_024;

export type VerifiedRunArtifactKind = "report" | "evidence";

export interface VerifiedRunArtifact {
  readonly logicalPath: string;
  readonly sourcePath: string;
  readonly kind: VerifiedRunArtifactKind;
  readonly mediaType: string;
  readonly declaredSha256: string;
  readonly verifiedSha256: string;
  readonly sizeBytes: number;
  /** Read-only, unlinked publisher snapshot; never reopened through the run path. */
  readonly snapshotHandle: FileHandle;
}

export interface VerifiedRunBundle {
  readonly runDirectory: string;
  readonly manifestPath: string;
  /** Exact run.json bytes, retained for manifest-last publication. */
  readonly manifestBytes: Uint8Array;
  readonly manifestSha256: string;
  readonly manifest: RunManifestV1;
  /** Exact verified report.json bytes retained for disclosure-safe projections. */
  readonly reportBytes: Uint8Array;
  readonly report: ReportV1;
  readonly reportArtifact: VerifiedRunArtifact;
  readonly artifacts: readonly VerifiedRunArtifact[];
  /** Release the anonymous artifact snapshots when publication is complete. */
  close(): Promise<void>;
}

export class RunBundleVerificationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunBundleVerificationError";
  }
}

interface InspectedFile {
  readonly sourcePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly bytes?: Buffer;
  readonly snapshotHandle?: FileHandle;
}

interface InspectRegularFileOptions {
  readonly captureLimitBytes?: number;
  readonly maximumBytes?: number;
  readonly snapshotDirectory?: string;
  readonly deadlineMs: number;
}

function verificationError(
  message: string,
  cause?: unknown,
): RunBundleVerificationError {
  return cause === undefined
    ? new RunBundleVerificationError(message)
    : new RunBundleVerificationError(message, { cause });
}

function containedPath(runDirectory: string, logicalPath: string): string {
  if (
    logicalPath.includes("\0") ||
    logicalPath.includes("\\") ||
    isAbsolute(logicalPath) ||
    win32.isAbsolute(logicalPath)
  ) {
    throw verificationError(
      `artifact path '${logicalPath}' must use relative forward-slash syntax`,
    );
  }

  const segments = logicalPath.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw verificationError(
      `artifact path '${logicalPath}' contains traversal or non-canonical segments`,
    );
  }

  const sourcePath = resolve(runDirectory, ...segments);
  const relation = relative(runDirectory, sourcePath);
  if (
    relation.length === 0 ||
    relation === ".." ||
    relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relation)
  ) {
    throw verificationError(
      `artifact path '${logicalPath}' escapes the run directory`,
    );
  }
  return sourcePath;
}

async function checkedArtifactPath(
  runDirectory: string,
  logicalPath: string,
): Promise<{
  readonly sourcePath: string;
  readonly state: BigIntStats;
}> {
  const sourcePath = containedPath(runDirectory, logicalPath);
  const segments = logicalPath.split("/");
  let current = runDirectory;
  let state: BigIntStats | undefined;

  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    try {
      state = await lstat(current, { bigint: true });
    } catch (error) {
      throw verificationError(
        `artifact '${logicalPath}' is missing or unreadable`,
        error,
      );
    }

    if (state.isSymbolicLink()) {
      throw verificationError(
        `artifact '${logicalPath}' contains a symbolic-link path component`,
      );
    }
    const finalComponent = index === segments.length - 1;
    if (!finalComponent && !state.isDirectory()) {
      throw verificationError(
        `artifact '${logicalPath}' has a non-directory parent component`,
      );
    }
    if (finalComponent && !state.isFile()) {
      throw verificationError(`artifact '${logicalPath}' is not a regular file`);
    }
  }

  if (state === undefined) {
    throw verificationError(`artifact '${logicalPath}' has no path components`);
  }

  let canonicalSource: string;
  try {
    canonicalSource = await realpath(sourcePath);
  } catch (error) {
    throw verificationError(
      `artifact '${logicalPath}' cannot be resolved`,
      error,
    );
  }
  const canonicalRelation = relative(runDirectory, canonicalSource);
  if (
    canonicalRelation === ".." ||
    canonicalRelation.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    ) ||
    isAbsolute(canonicalRelation)
  ) {
    throw verificationError(
      `artifact '${logicalPath}' resolves outside the run directory`,
    );
  }

  return { sourcePath, state };
}

function sameFileState(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function inspectRegularFile(
  runDirectory: string,
  logicalPath: string,
  options: InspectRegularFileOptions,
): Promise<InspectedFile> {
  if (Date.now() > options.deadlineMs) {
    throw verificationError("run bundle verification exceeded its time limit");
  }
  const checked = await checkedArtifactPath(runDirectory, logicalPath);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      checked.sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw verificationError(
      `artifact '${logicalPath}' could not be opened without following links`,
      error,
    );
  }

  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFileState(checked.state, before)) {
      throw verificationError(
        `artifact '${logicalPath}' changed while it was being verified`,
      );
    }
    if (before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw verificationError(
        `artifact '${logicalPath}' has an unsupported file size`,
      );
    }
    const expectedSizeBytes = Number(before.size);
    if (
      options.captureLimitBytes !== undefined &&
      expectedSizeBytes > options.captureLimitBytes
    ) {
      throw verificationError(
        `artifact '${logicalPath}' exceeds the ${options.captureLimitBytes}-byte parsing limit`,
      );
    }
    if (
      options.maximumBytes !== undefined &&
      expectedSizeBytes > options.maximumBytes
    ) {
      throw verificationError(
        `artifact '${logicalPath}' exceeds its bounded publication size`,
      );
    }

    const hash = createHash("sha256");
    const captured: Buffer[] | undefined =
      options.captureLimitBytes === undefined ? undefined : [];
    let snapshotWriter: FileHandle | undefined;
    let snapshotReader: FileHandle | undefined;
    let snapshotPath: string | undefined;
    if (options.snapshotDirectory !== undefined) {
      snapshotPath = join(options.snapshotDirectory, `${randomUUID()}.snapshot`);
      try {
        snapshotWriter = await open(
          snapshotPath,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        throw verificationError(
          `artifact '${logicalPath}' could not create a private snapshot`,
          error,
        );
      }
    }
    let sizeBytes = 0;
    try {
      const stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) {
        if (Date.now() > options.deadlineMs) {
          throw verificationError("run bundle verification exceeded its time limit");
        }
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeBytes += bytes.byteLength;
        if (
          !Number.isSafeInteger(sizeBytes) ||
          (options.captureLimitBytes !== undefined &&
            sizeBytes > options.captureLimitBytes) ||
          (options.maximumBytes !== undefined &&
            sizeBytes > options.maximumBytes)
        ) {
          throw verificationError(
            `artifact '${logicalPath}' exceeded its bounded read size`,
          );
        }
        hash.update(bytes);
        captured?.push(Buffer.from(bytes));
        if (snapshotWriter !== undefined) {
          let offset = 0;
          while (offset < bytes.byteLength) {
            const written = await snapshotWriter.write(
              bytes,
              offset,
              bytes.byteLength - offset,
              null,
            );
            if (written.bytesWritten <= 0) {
              throw verificationError(
                `artifact '${logicalPath}' snapshot write made no progress`,
              );
            }
            offset += written.bytesWritten;
          }
        }
      }

      const after = await handle.stat({ bigint: true });
      if (!sameFileState(before, after) || sizeBytes !== Number(after.size)) {
        throw verificationError(
          `artifact '${logicalPath}' changed while it was being verified`,
        );
      }

      if (snapshotWriter !== undefined && snapshotPath !== undefined) {
        await snapshotWriter.sync();
        await snapshotWriter.close();
        snapshotWriter = undefined;
        snapshotReader = await open(
          snapshotPath,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const snapshotState = await snapshotReader.stat();
        if (!snapshotState.isFile() || snapshotState.size !== sizeBytes) {
          throw verificationError(
            `artifact '${logicalPath}' private snapshot is inconsistent`,
          );
        }
        await snapshotReader.chmod(0o400);
        await unlink(snapshotPath);
        snapshotPath = undefined;
      }

      return {
        sourcePath: checked.sourcePath,
        sha256: hash.digest("hex"),
        sizeBytes,
        ...(captured === undefined ? {} : { bytes: Buffer.concat(captured) }),
        ...(snapshotReader === undefined ? {} : { snapshotHandle: snapshotReader }),
      };
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      try {
        await snapshotReader?.close();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      try {
        await snapshotWriter?.close();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      if (snapshotPath !== undefined) {
        try {
          await unlink(snapshotPath);
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          `artifact '${logicalPath}' verification and snapshot cleanup both failed`,
        );
      }
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function parseJsonBytes(bytes: Buffer, label: string): unknown {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw verificationError(`${label} is not valid UTF-8`, error);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw verificationError(`${label} is not valid JSON`, error);
  }
}

function parseManifest(bytes: Buffer): RunManifestV1 {
  try {
    return runManifestV1Schema.parse(parseJsonBytes(bytes, "run.json"));
  } catch (error) {
    if (error instanceof RunBundleVerificationError) throw error;
    throw verificationError("run.json does not satisfy forge.run/v1", error);
  }
}

function parseReport(bytes: Buffer): ReportV1 {
  try {
    return reportV1Schema.parse(parseJsonBytes(bytes, "report.json"));
  } catch (error) {
    if (error instanceof RunBundleVerificationError) throw error;
    throw verificationError("report.json does not satisfy forge.report/v1", error);
  }
}

function parseObservationHealth(bytes: Buffer): ObservationHealthV1 {
  try {
    return observationHealthV1Schema.parse(
      parseJsonBytes(bytes, "observation-health.json"),
    );
  } catch (error) {
    if (error instanceof RunBundleVerificationError) throw error;
    throw verificationError(
      "observation-health.json does not satisfy forge.observation-health/v1",
      error,
    );
  }
}

function assertObservationHealthIdentity(
  report: ReportV1,
  health: ObservationHealthV1,
): void {
  const summary = report.observationHealth;
  if (summary === undefined) {
    return;
  }
  const experimentIds = health.experiments.map(
    (experiment) => experiment.experimentId,
  );
  const policyRelevantGapRecordCount = health.experiments.reduce(
    (sum, experiment) => sum + experiment.policyRelevantGaps.recordCount,
    0,
  );
  const stringTruncationLineCount = health.experiments.reduce(
    (sum, experiment) => sum + experiment.stringTruncationLineCount,
    0,
  );
  const policyRelevantGapOutcomeCounts = [
    "succeeded",
    "failed",
    "unknown",
  ].flatMap((outcome) => {
    const recordCount = health.experiments.reduce(
      (sum, experiment) =>
        sum +
        (experiment.policyRelevantGaps.outcomeCounts.find(
          (row) => row.outcome === outcome,
        )?.recordCount ?? 0),
      0,
    );
    return recordCount === 0 ? [] : [{ outcome, recordCount }];
  });
  const sameJson = (left: unknown, right: unknown): boolean =>
    JSON.stringify(left) === JSON.stringify(right);
  if (
    health.runId !== report.runId ||
    health.scope !== summary.scope ||
    health.surfaceId !== summary.surfaceId ||
    health.integrityStatus !== summary.integrityStatus ||
    health.canonicalizationExecutionStatus !==
      summary.canonicalizationExecutionStatus ||
    health.policyRelevantGapStatus !== summary.policyRelevantGapStatus ||
    !sameJson(experimentIds, summary.experimentIds) ||
    !sameJson(health.degradedExperimentIds, summary.degradedExperimentIds) ||
    !sameJson(
      health.policyRelevantGapExperimentIds,
      summary.policyRelevantGapExperimentIds,
    ) ||
    policyRelevantGapRecordCount !== summary.policyRelevantGapRecordCount ||
    !sameJson(
      policyRelevantGapOutcomeCounts,
      summary.policyRelevantGapOutcomeCounts,
    ) ||
    stringTruncationLineCount !== summary.stringTruncationLineCount
  ) {
    throw verificationError(
      "observation-health.json identity and counters do not match report.json",
    );
  }

  for (const [index, experiment] of health.experiments.entries()) {
    if (
      experiment.canonicalization.status === "completed" &&
      experiment.canonicalization.emittedEventCount !==
        report.experiments[index]?.eventCount
    ) {
      throw verificationError(
        "observation-health.json canonical event counts do not match report.json",
      );
    }
  }
}

function assertReportEvidenceCoverage(
  runDirectory: string,
  report: ReportV1,
  manifestPaths: ReadonlySet<string>,
): void {
  if (report.evidence.manifest !== "run.json") {
    throw verificationError(
      "report.json must bind its manifest evidence reference to run.json",
    );
  }

  const exactReferences = [
    report.evidence.events,
    report.evidence.phases,
    report.evidence.attributions,
    report.evidence.findings,
    report.evidence.targetProvenance,
    report.evidence.staticInspection,
    report.evidence.preInstallStaticInspection,
    report.evidence.semanticInspection,
    report.evidence.preInstallSemanticInspection,
    report.evidence.installDelta,
    report.evidence.advertisedClaims,
    report.evidence.observationHealth,
    ...report.runtimeObservations.flatMap((observation) => {
      const refs = observation.filesystemStateDelta?.artifactRefs;
      return refs === undefined ? [] : [refs.before, refs.after, refs.delta];
    }),
  ].filter((reference): reference is string => reference !== undefined);

  for (const reference of new Set(exactReferences)) {
    containedPath(runDirectory, reference);
    if (!manifestPaths.has(reference)) {
      throw verificationError(
        `report.json references unmanifested evidence artifact '${reference}'`,
      );
    }
  }

  const filesystemStateRoot = report.evidence.filesystemStateRoot;
  if (filesystemStateRoot !== undefined) {
    containedPath(runDirectory, filesystemStateRoot);
    const prefix = `${filesystemStateRoot}/`;
    if (![...manifestPaths].some((path) => path.startsWith(prefix))) {
      throw verificationError(
        `report.json references unmanifested evidence root '${filesystemStateRoot}'`,
      );
    }
  }
}

/**
 * Verify a completed local Forge V1 run before any remote publication begins.
 * Only manifest-listed artifacts are returned; unrelated sandbox contents are
 * intentionally ignored because current run bundles can retain them locally.
 */
export async function verifyRunBundle(
  runDirectoryInput: string,
): Promise<VerifiedRunBundle> {
  const deadlineMs = Date.now() + MAX_PUBLICATION_VERIFICATION_MS;
  let runDirectory: string;
  try {
    runDirectory = await realpath(resolve(runDirectoryInput));
  } catch (error) {
    throw verificationError("run directory does not exist or cannot be resolved", error);
  }

  let directoryState: Awaited<ReturnType<typeof lstat>>;
  try {
    directoryState = await lstat(runDirectory);
  } catch (error) {
    throw verificationError("run directory cannot be inspected", error);
  }
  if (!directoryState.isDirectory()) {
    throw verificationError("run directory is not a directory");
  }

  const inspectedManifest = await inspectRegularFile(
    runDirectory,
    "run.json",
    {
      captureLimitBytes: MAX_MANIFEST_BYTES,
      maximumBytes: MAX_MANIFEST_BYTES,
      deadlineMs,
    },
  );
  if (inspectedManifest.bytes === undefined) {
    throw verificationError("run.json bytes were not captured");
  }
  const manifest = parseManifest(inspectedManifest.bytes);
  if (manifest.status !== "completed" || manifest.completedAt === undefined) {
    throw verificationError("run.json does not describe a completed Forge run");
  }
  if (Date.parse(manifest.completedAt) < Date.parse(manifest.createdAt)) {
    throw verificationError("run.json completion timestamp precedes creation");
  }
  if (manifest.artifacts.length > MAX_PUBLICATION_ARTIFACT_COUNT) {
    throw verificationError(
      `run.json exceeds the ${MAX_PUBLICATION_ARTIFACT_COUNT}-artifact publication limit`,
    );
  }

  const seenPaths = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (seenPaths.has(artifact.path)) {
      throw verificationError(
        `run.json contains duplicate artifact path '${artifact.path}'`,
      );
    }
    seenPaths.add(artifact.path);
  }

  const reportReferences = manifest.artifacts.filter(
    (artifact) =>
      artifact.path === "report.json" && artifact.mediaType === "application/json",
  );
  if (reportReferences.length !== 1) {
    throw verificationError(
      "run.json must bind exactly one application/json report.json artifact",
    );
  }

  const verifiedArtifacts: VerifiedRunArtifact[] = [];
  const snapshotHandles: FileHandle[] = [];
  let snapshotsTransferred = false;
  const snapshotDirectory = await mkdtemp(
    join(tmpdir(), "forge-publisher-snapshots-"),
  );
  try {
    let reportBytes: Buffer | undefined;
    let observationHealthBytes: Buffer | undefined;
    let totalArtifactBytes = 0;
    for (const artifact of manifest.artifacts) {
      const isReport = artifact.path === "report.json";
      const isObservationHealth =
        artifact.path === "observation-health.json";
      const remainingTotalBytes =
        MAX_PUBLICATION_TOTAL_ARTIFACT_BYTES - totalArtifactBytes;
      const maximumBytes = Math.min(
        MAX_PUBLICATION_ARTIFACT_BYTES,
        remainingTotalBytes,
        isReport ? MAX_REPORT_BYTES : Number.MAX_SAFE_INTEGER,
      );
      const inspected = await inspectRegularFile(
        runDirectory,
        artifact.path,
        {
          ...(isReport
            ? { captureLimitBytes: MAX_REPORT_BYTES }
            : isObservationHealth
              ? { captureLimitBytes: MAX_OBSERVATION_HEALTH_BYTES }
              : {}),
          maximumBytes,
          snapshotDirectory,
          deadlineMs,
        },
      );
      if (inspected.snapshotHandle === undefined) {
        throw verificationError(
          `artifact '${artifact.path}' private snapshot is unavailable`,
        );
      }
      snapshotHandles.push(inspected.snapshotHandle);
      totalArtifactBytes += inspected.sizeBytes;
      if (inspected.sha256 !== artifact.sha256) {
        throw verificationError(
          `artifact '${artifact.path}' SHA-256 does not match run.json`,
        );
      }
      if (isReport) reportBytes = inspected.bytes;
      if (isObservationHealth) observationHealthBytes = inspected.bytes;
      verifiedArtifacts.push({
        logicalPath: artifact.path,
        sourcePath: inspected.sourcePath,
        kind: isReport ? "report" : "evidence",
        mediaType: artifact.mediaType,
        declaredSha256: artifact.sha256,
        verifiedSha256: inspected.sha256,
        sizeBytes: inspected.sizeBytes,
        snapshotHandle: inspected.snapshotHandle,
      });
    }

    if (reportBytes === undefined) {
      throw verificationError("verified report.json bytes are unavailable");
    }
    const report = parseReport(reportBytes);
    if (report.findings.length > MAX_PUBLICATION_FINDING_COUNT) {
      throw verificationError(
        `report.json exceeds the ${MAX_PUBLICATION_FINDING_COUNT}-finding publication limit`,
      );
    }
    if (
      report.runId !== manifest.runId ||
      report.targetId !== manifest.targetId
    ) {
      throw verificationError(
        "report.json run and target identity do not match run.json",
      );
    }
    assertReportEvidenceCoverage(runDirectory, report, seenPaths);
    if (report.observationHealth !== undefined) {
      if (observationHealthBytes === undefined) {
        throw verificationError(
          "verified observation-health.json bytes are unavailable",
        );
      }
      const observationHealthArtifact = verifiedArtifacts.find(
        (artifact) =>
          artifact.logicalPath === report.evidence.observationHealth,
      );
      if (observationHealthArtifact?.mediaType !== "application/json") {
        throw verificationError(
          "run.json must label observation-health.json as application/json",
        );
      }
      assertObservationHealthIdentity(
        report,
        parseObservationHealth(observationHealthBytes),
      );
    }

    const reportArtifact = verifiedArtifacts.find(
      (artifact) => artifact.kind === "report",
    );
    if (reportArtifact === undefined) {
      throw verificationError("verified report.json artifact is unavailable");
    }

    let remainingHandles = [...snapshotHandles];
    let activeClose: Promise<void> | undefined;
    const close = async (): Promise<void> => {
      if (activeClose !== undefined) return activeClose;
      if (remainingHandles.length === 0) return;
      activeClose = (async () => {
        const closing = remainingHandles;
        const results = await Promise.allSettled(
          closing.map(async (handle) => handle.close()),
        );
        remainingHandles = closing.filter(
          (_handle, index) => results[index]?.status === "rejected",
        );
        const failures = results
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )
          .map((result) => result.reason);
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            "failed to close run publication snapshots",
          );
        }
      })();
      try {
        await activeClose;
      } finally {
        if (remainingHandles.length > 0) activeClose = undefined;
      }
    };

    snapshotsTransferred = true;
    return {
      runDirectory,
      manifestPath: inspectedManifest.sourcePath,
      manifestBytes: inspectedManifest.bytes,
      manifestSha256: inspectedManifest.sha256,
      manifest,
      reportBytes,
      report,
      reportArtifact,
      artifacts: verifiedArtifacts,
      close,
    };
  } catch (error) {
    const cleanupFailures = (
      await Promise.allSettled(
        snapshotHandles.map(async (handle) => handle.close()),
      )
    )
      .filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      )
      .map((result) => result.reason);
    try {
      await rmdir(snapshotDirectory);
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "run bundle verification and snapshot cleanup both failed",
      );
    }
    throw error;
  } finally {
    if (snapshotsTransferred) {
      try {
        await rmdir(snapshotDirectory);
      } catch (cleanupError) {
        const closeFailures = (
          await Promise.allSettled(
            snapshotHandles.map(async (handle) => handle.close()),
          )
        )
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )
          .map((result) => result.reason);
        throw new AggregateError(
          [cleanupError, ...closeFailures],
          "private snapshot directory cleanup failed",
        );
      }
    }
  }
}
