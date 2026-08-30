import { S3Client } from "@aws-sdk/client-s3";

import {
  verifyRunBundle,
  type VerifiedRunArtifact,
  type VerifiedRunBundle,
} from "./bundle.js";
import type { PublishConfiguration } from "./config.js";
import {
  PostgresPublicationRepository,
  type BeginPublicationInput,
  type BeginPublicationResult,
  type FinalizePublicationInput,
  type FinalizePublicationResult,
  type PublishedArtifactInput,
  type PublishedFindingInput,
} from "./postgres.js";
import {
  S3ArtifactStore,
  type S3FileArtifactInput,
  type S3ManifestInput,
  type StoredS3Object,
} from "./s3.js";

const DEFAULT_ARTIFACT_CONCURRENCY = 4;
const MAX_ARTIFACT_CONCURRENCY = 16;

export interface PublicationArtifactStore {
  readonly bucket: string;
  readonly prefix: string;
  artifactKey(sha256: string): string;
  manifestKey(runId: string): string;
  validateArtifact(input: S3FileArtifactInput): Promise<void>;
  validateManifest(input: S3ManifestInput): void;
  putArtifact(input: S3FileArtifactInput): Promise<StoredS3Object>;
  putManifest(input: S3ManifestInput): Promise<StoredS3Object>;
}

export interface PublicationRepository {
  validateBeginPublication(input: BeginPublicationInput): void;
  validateFinalization(input: FinalizePublicationInput): void;
  ensureSchema(): Promise<void>;
  beginPublication(
    input: Parameters<PostgresPublicationRepository["beginPublication"]>[0],
  ): Promise<BeginPublicationResult>;
  finalizePublication(
    input: Parameters<PostgresPublicationRepository["finalizePublication"]>[0],
  ): Promise<FinalizePublicationResult>;
}

export interface PublishVerifiedRunOptions {
  artifactStore: PublicationArtifactStore;
  repository: PublicationRepository;
  artifactConcurrency?: number;
}

export interface PublishRunResult {
  readonly status: "published";
  readonly runId: string;
  readonly targetId: string;
  readonly manifestSha256: string;
  readonly manifestObject: StoredS3Object;
  readonly artifactCount: number;
  readonly findingCount: number;
  readonly beginDisposition: BeginPublicationResult["disposition"];
  readonly finalizeDisposition: FinalizePublicationResult["disposition"];
}

function artifactConcurrency(value: number | undefined): number {
  const selected = value ?? DEFAULT_ARTIFACT_CONCURRENCY;
  if (
    !Number.isSafeInteger(selected) ||
    selected < 1 ||
    selected > MAX_ARTIFACT_CONCURRENCY
  ) {
    throw new Error(
      `artifact concurrency must be an integer from 1 to ${MAX_ARTIFACT_CONCURRENCY}`,
    );
  }
  return selected;
}

async function mapWithBoundedConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  const results: Array<R | undefined> = new Array(values.length);
  let nextIndex = 0;
  let firstFailure: unknown;

  const worker = async (): Promise<void> => {
    while (firstFailure === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;

      const value = values[index];
      if (value === undefined) {
        firstFailure = new Error("publication artifact index is unavailable");
        return;
      }
      try {
        results[index] = await operation(value, index);
      } catch (error) {
        firstFailure = error;
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      async () => worker(),
    ),
  );
  if (firstFailure !== undefined) throw firstFailure;

  return results.map((result, index) => {
    if (result === undefined) {
      throw new Error(`publication artifact ${index} did not produce a result`);
    }
    return result;
  });
}

function artifactMetadata(
  bundle: VerifiedRunBundle,
  storedObjects: readonly StoredS3Object[],
): readonly PublishedArtifactInput[] {
  return bundle.artifacts.map((artifact, index) => {
    const stored = storedObjects[index];
    if (stored === undefined) {
      throw new Error(`stored object is missing for ${artifact.logicalPath}`);
    }
    return {
      path: artifact.logicalPath,
      sha256: artifact.verifiedSha256,
      sizeBytes: artifact.sizeBytes,
      mediaType: artifact.mediaType,
      storageBucket: stored.bucket,
      objectKey: stored.key,
      publicMetadata: { kind: artifact.kind },
    };
  });
}

function artifactUploadInput(
  artifact: VerifiedRunArtifact,
): S3FileArtifactInput {
  return {
    sourceHandle: artifact.snapshotHandle,
    sha256: artifact.verifiedSha256,
    sizeBytes: artifact.sizeBytes,
    contentType: artifact.mediaType,
  };
}

function expectedStoredArtifact(
  store: PublicationArtifactStore,
  artifact: VerifiedRunArtifact,
): StoredS3Object {
  return {
    bucket: store.bucket,
    key: store.artifactKey(artifact.verifiedSha256),
    sha256: artifact.verifiedSha256,
    sizeBytes: artifact.sizeBytes,
    created: false,
  };
}

function assertStoredObject(
  actual: StoredS3Object,
  expected: StoredS3Object,
  label: string,
): void {
  if (
    actual.bucket !== expected.bucket ||
    actual.key !== expected.key ||
    actual.sha256 !== expected.sha256 ||
    actual.sizeBytes !== expected.sizeBytes
  ) {
    throw new Error(`${label} returned an unexpected immutable object identity`);
  }
}

function uniqueArtifactsByDigest(
  artifacts: readonly VerifiedRunArtifact[],
): readonly VerifiedRunArtifact[] {
  const unique = new Map<string, VerifiedRunArtifact>();
  for (const artifact of artifacts) {
    if (!unique.has(artifact.verifiedSha256)) {
      unique.set(artifact.verifiedSha256, artifact);
    }
  }
  return [...unique.values()];
}

function findingMetadata(
  bundle: VerifiedRunBundle,
): readonly PublishedFindingInput[] {
  return bundle.report.findings.map((finding) => ({
    findingId: finding.findingId,
    ruleId: finding.ruleId,
    title: finding.title,
    summary: finding.summary,
    severity: finding.severity,
    confidence: finding.confidence,
    publicMetadata: {
      eventIds: finding.eventIds,
      attributionIds: finding.attributionIds,
      limitations: finding.limitations,
    },
  }));
}

export async function publishVerifiedRun(
  bundle: VerifiedRunBundle,
  options: PublishVerifiedRunOptions,
): Promise<PublishRunResult> {
  const completedAt = bundle.manifest.completedAt;
  if (bundle.manifest.status !== "completed" || completedAt === undefined) {
    throw new Error("only a verified completed run can be published");
  }
  const concurrency = artifactConcurrency(options.artifactConcurrency);
  const beginInput: BeginPublicationInput = {
    runId: bundle.manifest.runId,
    targetId: bundle.manifest.targetId,
    manifestSchema: bundle.manifest.schema,
    manifestSha256: bundle.manifestSha256,
    storageBucket: options.artifactStore.bucket,
    storagePrefix: options.artifactStore.prefix,
    runCreatedAt: bundle.manifest.createdAt,
    runCompletedAt: completedAt,
    publicMetadata: {
      configSha256: bundle.manifest.configSha256,
      forgeVersion: bundle.manifest.toolchain.forgeVersion,
      observerImageId: bundle.manifest.toolchain.observerImageId,
      reportSha256: bundle.reportArtifact.verifiedSha256,
      sandboxProfile: bundle.manifest.sandboxPolicy.profile,
    },
  };

  const uniqueArtifacts = uniqueArtifactsByDigest(bundle.artifacts);
  const uploadInputs = uniqueArtifacts.map(artifactUploadInput);
  await mapWithBoundedConcurrency(
    uploadInputs,
    concurrency,
    async (input) => {
      await options.artifactStore.validateArtifact(input);
      return true;
    },
  );
  const manifestInput: S3ManifestInput = {
    runId: bundle.manifest.runId,
    bytes: bundle.manifestBytes,
    sha256: bundle.manifestSha256,
  };
  options.artifactStore.validateManifest(manifestInput);

  const expectedUniqueStoredArtifacts = uniqueArtifacts.map((artifact) =>
    expectedStoredArtifact(options.artifactStore, artifact),
  );
  const expectedByDigest = new Map(
    uniqueArtifacts.map((artifact, index) => [
      artifact.verifiedSha256,
      expectedUniqueStoredArtifacts[index]!,
    ]),
  );
  const expectedStoredArtifacts = bundle.artifacts.map((artifact) => {
    const stored = expectedByDigest.get(artifact.verifiedSha256);
    if (stored === undefined) {
      throw new Error(`planned object is missing for ${artifact.logicalPath}`);
    }
    return stored;
  });
  const findings = findingMetadata(bundle);
  const plannedFinalization: FinalizePublicationInput = {
    runId: bundle.manifest.runId,
    manifestSha256: bundle.manifestSha256,
    manifestObjectKey: options.artifactStore.manifestKey(bundle.manifest.runId),
    artifacts: artifactMetadata(bundle, expectedStoredArtifacts),
    findings,
  };

  // Validate every S3 key/body and every value destined for Postgres before
  // schema creation, publication intent, or object-store writes.
  options.repository.validateBeginPublication(beginInput);
  options.repository.validateFinalization(plannedFinalization);

  await options.repository.ensureSchema();
  const begun = await options.repository.beginPublication(beginInput);

  const uniqueStoredArtifacts = await mapWithBoundedConcurrency(
    uploadInputs,
    concurrency,
    async (input, index) => {
      const stored = await options.artifactStore.putArtifact(input);
      assertStoredObject(
        stored,
        expectedUniqueStoredArtifacts[index]!,
        `artifact ${index}`,
      );
      return stored;
    },
  );
  const storedByDigest = new Map(
    uniqueArtifacts.map((artifact, index) => [
      artifact.verifiedSha256,
      uniqueStoredArtifacts[index]!,
    ]),
  );
  const storedArtifacts = bundle.artifacts.map((artifact) => {
    const stored = storedByDigest.get(artifact.verifiedSha256);
    if (stored === undefined) {
      throw new Error(`stored object is missing for ${artifact.logicalPath}`);
    }
    return stored;
  });

  // This is deliberately the last object-store write. The per-run manifest is
  // an artifact-completeness marker. Postgres status remains query authority.
  const manifestObject = await options.artifactStore.putManifest(manifestInput);
  const expectedManifestObject: StoredS3Object = {
    bucket: options.artifactStore.bucket,
    key: plannedFinalization.manifestObjectKey,
    sha256: bundle.manifestSha256,
    sizeBytes: bundle.manifestBytes.byteLength,
    created: false,
  };
  assertStoredObject(manifestObject, expectedManifestObject, "manifest");

  const finalized = await options.repository.finalizePublication({
    runId: bundle.manifest.runId,
    manifestSha256: bundle.manifestSha256,
    manifestObjectKey: manifestObject.key,
    artifacts: artifactMetadata(bundle, storedArtifacts),
    findings,
  });

  return {
    status: "published",
    runId: bundle.manifest.runId,
    targetId: bundle.manifest.targetId,
    manifestSha256: bundle.manifestSha256,
    manifestObject,
    artifactCount: finalized.artifactCount,
    findingCount: finalized.findingCount,
    beginDisposition: begun.disposition,
    finalizeDisposition: finalized.disposition,
  };
}

export async function publishRun(
  runDirectory: string,
  options: PublishVerifiedRunOptions,
): Promise<PublishRunResult> {
  const bundle = await verifyRunBundle(runDirectory);
  let publicationError: unknown;
  try {
    return await publishVerifiedRun(bundle, options);
  } catch (error) {
    publicationError = error;
    throw error;
  } finally {
    try {
      await bundle.close();
    } catch (closeError) {
      if (publicationError !== undefined) {
        throw new AggregateError(
          [publicationError, closeError],
          "run publication and snapshot cleanup both failed",
        );
      }
      throw closeError;
    }
  }
}

export async function publishRunToConfiguredInfrastructure(
  runDirectory: string,
  configuration: PublishConfiguration,
): Promise<PublishRunResult> {
  const s3Client = new S3Client({
    region: configuration.s3Region,
    forcePathStyle: configuration.s3ForcePathStyle,
    ...(configuration.s3Endpoint === undefined
      ? {}
      : { endpoint: configuration.s3Endpoint }),
  });
  let repository: PostgresPublicationRepository | undefined;
  let publicationError: unknown;

  try {
    repository = await PostgresPublicationRepository.connect({
      connectionString: configuration.databaseUrl,
      applicationName: "forge-publish-run",
      maxConnections: 4,
      connectionTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
    });
    return await publishRun(runDirectory, {
      artifactStore: new S3ArtifactStore({
        client: s3Client,
        bucket: configuration.s3Bucket,
        prefix: configuration.s3Prefix,
      }),
      repository,
    });
  } catch (error) {
    publicationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await repository?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      s3Client.destroy();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        publicationError === undefined
          ? cleanupErrors
          : [publicationError, ...cleanupErrors],
        "configured run publication cleanup failed",
      );
    }
  }
}
