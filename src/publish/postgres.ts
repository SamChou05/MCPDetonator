import { Buffer } from "node:buffer";

import {
  MAX_PUBLICATION_ARTIFACT_COUNT,
  MAX_PUBLICATION_FINDING_COUNT,
} from "./limits.js";

export const POSTGRES_PUBLIC_METADATA_MAX_BYTES = 64 * 1024;

const PUBLIC_METADATA_INPUT_MAX_BYTES = 60 * 1024;
const PUBLIC_METADATA_MAX_DEPTH = 8;
const PUBLIC_METADATA_MAX_NODES = 1_024;
const PUBLIC_METADATA_MAX_STRING_CHARACTERS = 32_768;
const POSTGRES_SCHEMA_LOCK_KEY = 1_180_148_281;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TRANSACTION_GUARDS_SQL = `SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL idle_in_transaction_session_timeout = '120s'`;

export type PublicationStatus = "publishing" | "published";
export type PublicationSeverity = "info" | "low" | "medium" | "high";
export type PublicationConfidence = "low" | "medium" | "high";

export type PublicationJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly PublicationJsonValue[]
  | { readonly [key: string]: PublicationJsonValue };

export type PublicationPublicMetadata = Readonly<
  Record<string, PublicationJsonValue>
>;

export interface PgQueryResultLike {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number | null;
}

export interface PgQueryableLike {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResultLike>;
}

export interface PgClientLike extends PgQueryableLike {
  release(error?: Error): void;
}

export interface PgPoolLike extends PgQueryableLike {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

export interface PostgresConnectionOptions {
  readonly connectionString: string;
  readonly applicationName?: string;
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly ssl?: boolean | { readonly rejectUnauthorized: boolean };
}

export interface PostgresPublicationRepositoryOptions {
  readonly ownsPool?: boolean;
}

export interface BeginPublicationInput {
  readonly runId: string;
  readonly targetId: string;
  readonly manifestSchema: "forge.run/v1";
  readonly manifestSha256: string;
  readonly storageBucket: string;
  readonly storagePrefix: string;
  readonly runCreatedAt: string;
  readonly runCompletedAt: string;
  readonly publicMetadata?: PublicationPublicMetadata;
}

export interface PublicationRun {
  readonly runId: string;
  readonly targetId: string;
  readonly manifestSchema: "forge.run/v1";
  readonly manifestSha256: string;
  readonly storageBucket: string;
  readonly storagePrefix: string;
  readonly manifestObjectKey?: string;
  readonly status: PublicationStatus;
  readonly runCreatedAt: string;
  readonly runCompletedAt: string;
  readonly publicationStartedAt: string;
  readonly publishedAt?: string;
  readonly publicMetadata: PublicationPublicMetadata;
}

export interface BeginPublicationResult {
  readonly disposition: "created" | "resumed" | "already_published";
  readonly run: PublicationRun;
}

export interface PublishedArtifactInput {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly storageBucket: string;
  readonly objectKey: string;
  readonly etag?: string;
  readonly publicMetadata?: PublicationPublicMetadata;
}

export interface PublishedFindingInput {
  readonly findingId: string;
  readonly ruleId: string;
  readonly title: string;
  readonly summary: string;
  readonly severity: PublicationSeverity;
  readonly confidence: PublicationConfidence;
  readonly publicMetadata?: PublicationPublicMetadata;
}

export interface FinalizePublicationInput {
  readonly runId: string;
  readonly manifestSha256: string;
  readonly manifestObjectKey: string;
  readonly artifacts: readonly PublishedArtifactInput[];
  readonly findings: readonly PublishedFindingInput[];
}

export interface FinalizePublicationResult {
  readonly disposition: "published" | "already_published";
  readonly run: PublicationRun;
  readonly artifactCount: number;
  readonly findingCount: number;
}

export type PublicationRepositoryErrorCode =
  | "database_invariant"
  | "identity_conflict"
  | "invalid_input"
  | "metadata_conflict"
  | "not_found"
  | "repository_closed";

export class PublicationRepositoryError extends Error {
  public constructor(
    readonly code: PublicationRepositoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PublicationRepositoryError";
  }
}

interface ValidatedMetadata {
  readonly value: PublicationPublicMetadata;
  readonly json: string;
}

interface ValidatedBeginPublicationInput extends BeginPublicationInput {
  readonly publicMetadata: PublicationPublicMetadata;
  readonly publicMetadataJson: string;
}

interface ValidatedPublishedArtifactInput extends PublishedArtifactInput {
  readonly publicMetadata: PublicationPublicMetadata;
  readonly publicMetadataJson: string;
}

interface ValidatedPublishedFindingInput extends PublishedFindingInput {
  readonly publicMetadata: PublicationPublicMetadata;
  readonly publicMetadataJson: string;
}

interface ValidatedFinalizePublicationInput {
  readonly runId: string;
  readonly manifestSha256: string;
  readonly manifestObjectKey: string;
  readonly artifacts: readonly ValidatedPublishedArtifactInput[];
  readonly findings: readonly ValidatedPublishedFindingInput[];
}

const RUN_COLUMNS = `
  run_id AS "runId",
  target_id AS "targetId",
  manifest_schema AS "manifestSchema",
  manifest_sha256 AS "manifestSha256",
  storage_bucket AS "storageBucket",
  storage_prefix AS "storagePrefix",
  manifest_object_key AS "manifestObjectKey",
  status,
  run_created_at AS "runCreatedAt",
  run_completed_at AS "runCompletedAt",
  publication_started_at AS "publicationStartedAt",
  published_at AS "publishedAt",
  public_metadata AS "publicMetadata"
`;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS forge_published_runs (
    run_id TEXT PRIMARY KEY CHECK (length(run_id) BETWEEN 1 AND 256),
    target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 256),
    manifest_schema TEXT NOT NULL CHECK (manifest_schema = 'forge.run/v1'),
    manifest_sha256 CHAR(64) NOT NULL
      CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
    storage_bucket TEXT NOT NULL CHECK (length(storage_bucket) BETWEEN 1 AND 255),
    storage_prefix TEXT NOT NULL CHECK (length(storage_prefix) <= 1024),
    manifest_object_key TEXT CHECK (length(manifest_object_key) BETWEEN 1 AND 2048),
    status TEXT NOT NULL CHECK (status IN ('publishing', 'published')),
    run_created_at TIMESTAMPTZ NOT NULL,
    run_completed_at TIMESTAMPTZ NOT NULL,
    publication_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    public_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      CHECK (
        jsonb_typeof(public_metadata) = 'object' AND
        octet_length(public_metadata::text) <= ${POSTGRES_PUBLIC_METADATA_MAX_BYTES}
      ),
    CHECK (run_completed_at >= run_created_at),
    CHECK (
      (status = 'publishing' AND published_at IS NULL) OR
      (status = 'published' AND published_at IS NOT NULL AND manifest_object_key IS NOT NULL)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS forge_published_artifacts (
    run_id TEXT NOT NULL REFERENCES forge_published_runs(run_id) ON DELETE CASCADE,
    artifact_path TEXT NOT NULL CHECK (length(artifact_path) BETWEEN 1 AND 2048),
    sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    media_type TEXT NOT NULL CHECK (length(media_type) BETWEEN 1 AND 256),
    storage_bucket TEXT NOT NULL CHECK (length(storage_bucket) BETWEEN 1 AND 255),
    object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 2048),
    etag TEXT CHECK (length(etag) BETWEEN 1 AND 512),
    public_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      CHECK (
        jsonb_typeof(public_metadata) = 'object' AND
        octet_length(public_metadata::text) <= ${POSTGRES_PUBLIC_METADATA_MAX_BYTES}
      ),
    PRIMARY KEY (run_id, artifact_path)
  )`,
  `CREATE TABLE IF NOT EXISTS forge_published_findings (
    run_id TEXT NOT NULL REFERENCES forge_published_runs(run_id) ON DELETE CASCADE,
    finding_id TEXT NOT NULL CHECK (length(finding_id) BETWEEN 1 AND 256),
    rule_id TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 256),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 1024),
    summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 16384),
    severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high')),
    confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
    public_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      CHECK (
        jsonb_typeof(public_metadata) = 'object' AND
        octet_length(public_metadata::text) <= ${POSTGRES_PUBLIC_METADATA_MAX_BYTES}
      ),
    PRIMARY KEY (run_id, finding_id)
  )`,
  `CREATE INDEX IF NOT EXISTS forge_published_runs_status_started_idx
    ON forge_published_runs(status, publication_started_at)`,
  `CREATE INDEX IF NOT EXISTS forge_published_runs_target_completed_idx
    ON forge_published_runs(target_id, run_completed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS forge_published_artifacts_sha256_idx
    ON forge_published_artifacts(sha256)`,
  `CREATE INDEX IF NOT EXISTS forge_published_findings_rule_severity_idx
    ON forge_published_findings(rule_id, severity)`,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidInput(message: string): never {
  throw new PublicationRepositoryError("invalid_input", message);
}

function errorForRelease(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isPostgresCompatibleText(value: string): boolean {
  return !value.includes("\0") && isWellFormedUnicode(value);
}

function validateText(
  value: string,
  label: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximumLength ||
    !isPostgresCompatibleText(value)
  ) {
    return invalidInput(`${label} is invalid or exceeds its bounded length`);
  }
  return value;
}

function validateSha256(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value)) {
    return invalidInput(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function validateTimestamp(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !isPostgresCompatibleText(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return invalidInput(`${label} must be a valid timestamp`);
  }
  return new Date(value).toISOString();
}

function validateMetadata(
  input: unknown,
  label: string,
): ValidatedMetadata {
  if (!isRecord(input)) {
    return invalidInput(`${label} must be a JSON object`);
  }
  const source = input;

  let nodeCount = 0;
  let stringCharacters = 0;

  const visit = (value: unknown, depth: number, pointer: string): PublicationJsonValue => {
    nodeCount += 1;
    if (nodeCount > PUBLIC_METADATA_MAX_NODES) {
      return invalidInput(`${label} exceeds the metadata node limit`);
    }
    if (depth > PUBLIC_METADATA_MAX_DEPTH) {
      return invalidInput(`${label} exceeds the metadata depth limit`);
    }

    if (value === null || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        return invalidInput(
          `${label}${pointer} contains a number outside the safe-integer metadata subset`,
        );
      }
      return value;
    }
    if (typeof value === "string") {
      if (!isPostgresCompatibleText(value)) {
        return invalidInput(
          `${label}${pointer} contains PostgreSQL-incompatible Unicode`,
        );
      }
      stringCharacters += value.length;
      if (stringCharacters > PUBLIC_METADATA_MAX_STRING_CHARACTERS) {
        return invalidInput(`${label} exceeds the metadata string limit`);
      }
      return value;
    }
    if (Array.isArray(value)) {
      if (value.length > PUBLIC_METADATA_MAX_NODES) {
        return invalidInput(`${label} exceeds the metadata node limit`);
      }
      const output: PublicationJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined || !("value" in descriptor)) {
          return invalidInput(`${label}${pointer} cannot contain sparse arrays or accessors`);
        }
        output.push(visit(descriptor.value, depth + 1, `${pointer}/${index}`));
      }
      const extraKeys = Object.keys(value).filter(
        (key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length,
      );
      if (extraKeys.length > 0 || Object.getOwnPropertySymbols(value).length > 0) {
        return invalidInput(`${label}${pointer} cannot contain non-index array properties`);
      }
      return output;
    }
    if (!isRecord(value)) {
      return invalidInput(`${label}${pointer} is not JSON-compatible`);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidInput(`${label}${pointer} must use a plain object`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return invalidInput(`${label}${pointer} cannot contain symbol keys`);
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, PublicationJsonValue> = Object.create(null) as Record<
      string,
      PublicationJsonValue
    >;
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return invalidInput(`${label}${pointer} cannot contain hidden properties or accessors`);
      }
      if (!isPostgresCompatibleText(key)) {
        return invalidInput(
          `${label}${pointer} contains a PostgreSQL-incompatible metadata key`,
        );
      }
      stringCharacters += key.length;
      if (stringCharacters > PUBLIC_METADATA_MAX_STRING_CHARACTERS) {
        return invalidInput(`${label} exceeds the metadata string limit`);
      }
      output[key] = visit(
        descriptor.value,
        depth + 1,
        `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      );
    }
    return output;
  };

  const value = visit(source, 0, "");
  if (!isRecord(value)) {
    return invalidInput(`${label} must be a JSON object`);
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > PUBLIC_METADATA_INPUT_MAX_BYTES) {
    return invalidInput(`${label} exceeds the serialized metadata byte limit`);
  }
  return { value, json };
}

function normalizedMetadataJson(value: unknown, label: string): string {
  return validateMetadata(value, label).json;
}

function validateBeginInput(
  input: BeginPublicationInput,
): ValidatedBeginPublicationInput {
  const runCreatedAt = validateTimestamp(input.runCreatedAt, "runCreatedAt");
  const runCompletedAt = validateTimestamp(
    input.runCompletedAt,
    "runCompletedAt",
  );
  if (Date.parse(runCompletedAt) < Date.parse(runCreatedAt)) {
    return invalidInput("runCompletedAt cannot precede runCreatedAt");
  }
  if (input.manifestSchema !== "forge.run/v1") {
    return invalidInput("manifestSchema must be forge.run/v1");
  }
  const metadata = validateMetadata(input.publicMetadata ?? {}, "publicMetadata");

  return {
    runId: validateText(input.runId, "runId", 256),
    targetId: validateText(input.targetId, "targetId", 256),
    manifestSchema: input.manifestSchema,
    manifestSha256: validateSha256(
      input.manifestSha256,
      "manifestSha256",
    ),
    storageBucket: validateText(input.storageBucket, "storageBucket", 255),
    storagePrefix: validateText(
      input.storagePrefix,
      "storagePrefix",
      1_024,
      true,
    ),
    runCreatedAt,
    runCompletedAt,
    publicMetadata: metadata.value,
    publicMetadataJson: metadata.json,
  };
}

function validateArtifacts(
  artifacts: readonly PublishedArtifactInput[],
): readonly ValidatedPublishedArtifactInput[] {
  if (!Array.isArray(artifacts) || artifacts.length > MAX_PUBLICATION_ARTIFACT_COUNT) {
    return invalidInput(
      `artifacts must contain at most ${MAX_PUBLICATION_ARTIFACT_COUNT} rows`,
    );
  }
  const seenPaths = new Set<string>();
  return artifacts.map((artifact, index) => {
    const path = validateText(artifact.path, `artifacts[${index}].path`, 2_048);
    if (seenPaths.has(path)) {
      return invalidInput(`artifact path is duplicated: ${path}`);
    }
    seenPaths.add(path);
    if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) {
      return invalidInput(`artifacts[${index}].sizeBytes must be a safe nonnegative integer`);
    }
    const metadata = validateMetadata(
      artifact.publicMetadata ?? {},
      `artifacts[${index}].publicMetadata`,
    );
    const etag =
      artifact.etag === undefined
        ? undefined
        : validateText(artifact.etag, `artifacts[${index}].etag`, 512);
    return {
      path,
      sha256: validateSha256(
        artifact.sha256,
        `artifacts[${index}].sha256`,
      ),
      sizeBytes: artifact.sizeBytes,
      mediaType: validateText(
        artifact.mediaType,
        `artifacts[${index}].mediaType`,
        256,
      ),
      storageBucket: validateText(
        artifact.storageBucket,
        `artifacts[${index}].storageBucket`,
        255,
      ),
      objectKey: validateText(
        artifact.objectKey,
        `artifacts[${index}].objectKey`,
        2_048,
      ),
      ...(etag === undefined ? {} : { etag }),
      publicMetadata: metadata.value,
      publicMetadataJson: metadata.json,
    };
  });
}

function validateFindings(
  findings: readonly PublishedFindingInput[],
): readonly ValidatedPublishedFindingInput[] {
  if (!Array.isArray(findings) || findings.length > MAX_PUBLICATION_FINDING_COUNT) {
    return invalidInput(
      `findings must contain at most ${MAX_PUBLICATION_FINDING_COUNT} rows`,
    );
  }
  const seenIds = new Set<string>();
  return findings.map((finding, index) => {
    const findingId = validateText(
      finding.findingId,
      `findings[${index}].findingId`,
      256,
    );
    if (seenIds.has(findingId)) {
      return invalidInput(`finding ID is duplicated: ${findingId}`);
    }
    seenIds.add(findingId);
    if (!["info", "low", "medium", "high"].includes(finding.severity)) {
      return invalidInput(`findings[${index}].severity is invalid`);
    }
    if (!["low", "medium", "high"].includes(finding.confidence)) {
      return invalidInput(`findings[${index}].confidence is invalid`);
    }
    const metadata = validateMetadata(
      finding.publicMetadata ?? {},
      `findings[${index}].publicMetadata`,
    );
    return {
      findingId,
      ruleId: validateText(
        finding.ruleId,
        `findings[${index}].ruleId`,
        256,
      ),
      title: validateText(finding.title, `findings[${index}].title`, 1_024),
      summary: validateText(
        finding.summary,
        `findings[${index}].summary`,
        16_384,
      ),
      severity: finding.severity,
      confidence: finding.confidence,
      publicMetadata: metadata.value,
      publicMetadataJson: metadata.json,
    };
  });
}

function validateFinalizeInput(
  input: FinalizePublicationInput,
): ValidatedFinalizePublicationInput {
  return {
    runId: validateText(input.runId, "runId", 256),
    manifestSha256: validateSha256(
      input.manifestSha256,
      "manifestSha256",
    ),
    manifestObjectKey: validateText(
      input.manifestObjectKey,
      "manifestObjectKey",
      2_048,
    ),
    artifacts: validateArtifacts(input.artifacts),
    findings: validateFindings(input.findings),
  };
}

function requireString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new PublicationRepositoryError(
      "database_invariant",
      `database returned an invalid ${key}`,
    );
  }
  return value;
}

function optionalString(
  row: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  return requireString(row, key);
}

function databaseTimestamp(
  row: Record<string, unknown>,
  key: string,
  optional = false,
): string | undefined {
  const value = row[key];
  if (optional && (value === null || value === undefined)) {
    return undefined;
  }
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new PublicationRepositoryError(
      "database_invariant",
      `database returned an invalid ${key}`,
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new PublicationRepositoryError(
      "database_invariant",
      `database returned an invalid ${key}`,
    );
  }
  return parsed.toISOString();
}

function rowToRun(row: Record<string, unknown>): PublicationRun {
  const status = row.status;
  if (status !== "publishing" && status !== "published") {
    throw new PublicationRepositoryError(
      "database_invariant",
      "database returned an invalid publication status",
    );
  }
  const manifestSchema = requireString(row, "manifestSchema");
  if (manifestSchema !== "forge.run/v1") {
    throw new PublicationRepositoryError(
      "database_invariant",
      "database returned an unsupported manifest schema",
    );
  }
  const manifestObjectKey = optionalString(row, "manifestObjectKey");
  const publishedAt = databaseTimestamp(row, "publishedAt", true);
  if (
    (status === "published" &&
      (manifestObjectKey === undefined || publishedAt === undefined)) ||
    (status === "publishing" && publishedAt !== undefined)
  ) {
    throw new PublicationRepositoryError(
      "database_invariant",
      "database returned an inconsistent publication state",
    );
  }
  const runCreatedAt = databaseTimestamp(row, "runCreatedAt");
  const runCompletedAt = databaseTimestamp(row, "runCompletedAt");
  const publicationStartedAt = databaseTimestamp(row, "publicationStartedAt");
  if (
    runCreatedAt === undefined ||
    runCompletedAt === undefined ||
    publicationStartedAt === undefined
  ) {
    throw new PublicationRepositoryError(
      "database_invariant",
      "database returned incomplete publication timestamps",
    );
  }
  const publicMetadata = validateMetadata(
    row.publicMetadata,
    "database publicMetadata",
  ).value;

  return {
    runId: requireString(row, "runId"),
    targetId: requireString(row, "targetId"),
    manifestSchema,
    manifestSha256: validateSha256(
      requireString(row, "manifestSha256"),
      "database manifestSha256",
    ),
    storageBucket: requireString(row, "storageBucket"),
    storagePrefix:
      typeof row.storagePrefix === "string"
        ? row.storagePrefix
        : requireString(row, "storagePrefix"),
    ...(manifestObjectKey === undefined ? {} : { manifestObjectKey }),
    status,
    runCreatedAt,
    runCompletedAt,
    publicationStartedAt,
    ...(publishedAt === undefined ? {} : { publishedAt }),
    publicMetadata,
  };
}

function assertRunIdentity(
  actual: PublicationRun,
  expected: ValidatedBeginPublicationInput,
): void {
  if (actual.manifestSha256 !== expected.manifestSha256) {
    throw new PublicationRepositoryError(
      "identity_conflict",
      `run ${expected.runId} already exists with a different manifest digest`,
    );
  }
  if (
    actual.runId !== expected.runId ||
    actual.targetId !== expected.targetId ||
    actual.manifestSchema !== expected.manifestSchema ||
    actual.storageBucket !== expected.storageBucket ||
    actual.storagePrefix !== expected.storagePrefix ||
    actual.runCreatedAt !== expected.runCreatedAt ||
    actual.runCompletedAt !== expected.runCompletedAt ||
    normalizedMetadataJson(actual.publicMetadata, "database publicMetadata") !==
      expected.publicMetadataJson
  ) {
    throw new PublicationRepositoryError(
      "identity_conflict",
      `run ${expected.runId} already exists with different publication identity metadata`,
    );
  }
}

function firstRow(result: PgQueryResultLike): Record<string, unknown> | undefined {
  return result.rows[0];
}

function requireSingleRow(
  result: PgQueryResultLike,
  operation: string,
): Record<string, unknown> {
  const row = firstRow(result);
  if (result.rowCount !== 1 || row === undefined) {
    throw new PublicationRepositoryError(
      "database_invariant",
      `${operation} did not return exactly one row`,
    );
  }
  return row;
}

function numericCount(result: PgQueryResultLike, label: string): number {
  const row = requireSingleRow(result, `${label} count query`);
  const value = row.count;
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new PublicationRepositoryError(
      "database_invariant",
      `database returned an invalid ${label} count`,
    );
  }
  return count;
}

function artifactMatches(
  row: Record<string, unknown>,
  artifact: ValidatedPublishedArtifactInput,
): boolean {
  const storedSize =
    typeof row.sizeBytes === "number" ? row.sizeBytes : Number(row.sizeBytes);
  return (
    row.path === artifact.path &&
    row.sha256 === artifact.sha256 &&
    storedSize === artifact.sizeBytes &&
    row.mediaType === artifact.mediaType &&
    row.storageBucket === artifact.storageBucket &&
    row.objectKey === artifact.objectKey &&
    (row.etag ?? undefined) === artifact.etag &&
    normalizedMetadataJson(row.publicMetadata, "stored artifact publicMetadata") ===
      artifact.publicMetadataJson
  );
}

function findingMatches(
  row: Record<string, unknown>,
  finding: ValidatedPublishedFindingInput,
): boolean {
  return (
    row.findingId === finding.findingId &&
    row.ruleId === finding.ruleId &&
    row.title === finding.title &&
    row.summary === finding.summary &&
    row.severity === finding.severity &&
    row.confidence === finding.confidence &&
    normalizedMetadataJson(row.publicMetadata, "stored finding publicMetadata") ===
      finding.publicMetadataJson
  );
}

function assertArtifactSetMatches(
  rows: readonly Record<string, unknown>[],
  artifacts: readonly ValidatedPublishedArtifactInput[],
): void {
  const byPath = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (typeof row.path !== "string" || byPath.has(row.path)) {
      throw new PublicationRepositoryError(
        "database_invariant",
        "stored publication contains an invalid or duplicate artifact path",
      );
    }
    byPath.set(row.path, row);
  }
  if (
    byPath.size !== artifacts.length ||
    artifacts.some((artifact) => {
      const row = byPath.get(artifact.path);
      return row === undefined || !artifactMatches(row, artifact);
    })
  ) {
    throw new PublicationRepositoryError(
      "metadata_conflict",
      "stored publication contains a different artifact set",
    );
  }
}

function assertFindingSetMatches(
  rows: readonly Record<string, unknown>[],
  findings: readonly ValidatedPublishedFindingInput[],
): void {
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (typeof row.findingId !== "string" || byId.has(row.findingId)) {
      throw new PublicationRepositoryError(
        "database_invariant",
        "stored publication contains an invalid or duplicate finding ID",
      );
    }
    byId.set(row.findingId, row);
  }
  if (
    byId.size !== findings.length ||
    findings.some((finding) => {
      const row = byId.get(finding.findingId);
      return row === undefined || !findingMatches(row, finding);
    })
  ) {
    throw new PublicationRepositoryError(
      "metadata_conflict",
      "stored publication contains a different finding set",
    );
  }
}

export class PostgresPublicationRepository {
  private readonly ownsPool: boolean;
  private closed = false;
  private schemaReady = false;

  public constructor(
    private readonly pool: PgPoolLike,
    options: PostgresPublicationRepositoryOptions = {},
  ) {
    this.ownsPool = options.ownsPool ?? false;
  }

  public static async connect(
    options: PostgresConnectionOptions,
  ): Promise<PostgresPublicationRepository> {
    if (typeof options.connectionString !== "string" || options.connectionString.length === 0) {
      return invalidInput("connectionString is required");
    }
    const moduleSpecifier = "pg";
    const imported: unknown = await import(moduleSpecifier);
    if (!isRecord(imported)) {
      throw new PublicationRepositoryError(
        "database_invariant",
        "pg did not expose a module object",
      );
    }
    const defaultExport = isRecord(imported.default) ? imported.default : undefined;
    const PoolConstructor = imported.Pool ?? defaultExport?.Pool;
    if (typeof PoolConstructor !== "function") {
      throw new PublicationRepositoryError(
        "database_invariant",
        "pg did not expose Pool",
      );
    }

    const poolConfig: Record<string, unknown> = {
      connectionString: options.connectionString,
      application_name: options.applicationName ?? "forge-run-publisher",
    };
    if (options.maxConnections !== undefined) {
      if (!Number.isInteger(options.maxConnections) || options.maxConnections < 1) {
        return invalidInput("maxConnections must be a positive integer");
      }
      poolConfig.max = options.maxConnections;
    }
    if (options.connectionTimeoutMs !== undefined) {
      if (!Number.isInteger(options.connectionTimeoutMs) || options.connectionTimeoutMs < 1) {
        return invalidInput("connectionTimeoutMs must be a positive integer");
      }
      poolConfig.connectionTimeoutMillis = options.connectionTimeoutMs;
    }
    if (options.idleTimeoutMs !== undefined) {
      if (!Number.isInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 1) {
        return invalidInput("idleTimeoutMs must be a positive integer");
      }
      poolConfig.idleTimeoutMillis = options.idleTimeoutMs;
    }
    if (options.ssl !== undefined) {
      poolConfig.ssl = options.ssl;
    }

    const PoolClass = PoolConstructor as new (
      config: Record<string, unknown>,
    ) => PgPoolLike;
    return new PostgresPublicationRepository(new PoolClass(poolConfig), {
      ownsPool: true,
    });
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new PublicationRepositoryError(
        "repository_closed",
        "Postgres publication repository is closed",
      );
    }
  }

  public validateBeginPublication(input: BeginPublicationInput): void {
    this.assertOpen();
    validateBeginInput(input);
  }

  public validateFinalization(input: FinalizePublicationInput): void {
    this.assertOpen();
    validateFinalizeInput(input);
  }

  public async ensureSchema(): Promise<void> {
    this.assertOpen();
    if (this.schemaReady) {
      return;
    }

    const client = await this.pool.connect();
    let transactionStarted = false;
    let poisonedConnection: Error | undefined;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(TRANSACTION_GUARDS_SQL);
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        POSTGRES_SCHEMA_LOCK_KEY,
      ]);
      for (const statement of SCHEMA_STATEMENTS) {
        await client.query(statement);
      }
      await client.query("COMMIT");
      transactionStarted = false;
      this.schemaReady = true;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          poisonedConnection = errorForRelease(rollbackError);
          throw new AggregateError(
            [error, rollbackError],
            "Postgres schema initialization and rollback both failed",
          );
        }
      }
      throw error;
    } finally {
      client.release(poisonedConnection);
    }
  }

  public async getPublication(runId: string): Promise<PublicationRun | undefined> {
    this.assertOpen();
    const validatedRunId = validateText(runId, "runId", 256);
    const result = await this.pool.query(
      `SELECT ${RUN_COLUMNS}
       FROM forge_published_runs
       WHERE run_id = $1`,
      [validatedRunId],
    );
    if (result.rowCount === 0) {
      return undefined;
    }
    return rowToRun(requireSingleRow(result, "publication lookup"));
  }

  public async beginPublication(
    input: BeginPublicationInput,
  ): Promise<BeginPublicationResult> {
    this.assertOpen();
    const validated = validateBeginInput(input);
    const client = await this.pool.connect();
    let transactionStarted = false;
    let poisonedConnection: Error | undefined;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(TRANSACTION_GUARDS_SQL);
      const inserted = await client.query(
        `INSERT INTO forge_published_runs (
           run_id, target_id, manifest_schema, manifest_sha256,
           storage_bucket, storage_prefix, status,
           run_created_at, run_completed_at, public_metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, 'publishing', $7, $8, $9::jsonb)
         ON CONFLICT (run_id) DO NOTHING
         RETURNING ${RUN_COLUMNS}`,
        [
          validated.runId,
          validated.targetId,
          validated.manifestSchema,
          validated.manifestSha256,
          validated.storageBucket,
          validated.storagePrefix,
          validated.runCreatedAt,
          validated.runCompletedAt,
          validated.publicMetadataJson,
        ],
      );

      let result: BeginPublicationResult;
      if (inserted.rowCount === 1) {
        const run = rowToRun(requireSingleRow(inserted, "publication insert"));
        assertRunIdentity(run, validated);
        if (run.status !== "publishing") {
          throw new PublicationRepositoryError(
            "database_invariant",
            "a new publication was not created in publishing state",
          );
        }
        result = { disposition: "created", run };
      } else {
        const existingResult = await client.query(
          `SELECT ${RUN_COLUMNS}
           FROM forge_published_runs
           WHERE run_id = $1`,
          [validated.runId],
        );
        if (existingResult.rowCount === 0) {
          throw new PublicationRepositoryError(
            "database_invariant",
            "publication disappeared after an insert conflict",
          );
        }
        const run = rowToRun(
          requireSingleRow(existingResult, "publication conflict lookup"),
        );
        assertRunIdentity(run, validated);
        result = {
          disposition:
            run.status === "published" ? "already_published" : "resumed",
          run,
        };
      }

      await client.query("COMMIT");
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          poisonedConnection = errorForRelease(rollbackError);
          throw new AggregateError(
            [error, rollbackError],
            "Postgres publication begin and rollback both failed",
          );
        }
      }
      throw error;
    } finally {
      client.release(poisonedConnection);
    }
  }

  private async insertOrVerifyArtifact(
    client: PgClientLike,
    runId: string,
    artifact: ValidatedPublishedArtifactInput,
  ): Promise<void> {
    const inserted = await client.query(
      `INSERT INTO forge_published_artifacts (
         run_id, artifact_path, sha256, size_bytes, media_type,
         storage_bucket, object_key, etag, public_metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (run_id, artifact_path) DO NOTHING
       RETURNING
         artifact_path AS "path", sha256, size_bytes AS "sizeBytes",
         media_type AS "mediaType", storage_bucket AS "storageBucket",
         object_key AS "objectKey", etag, public_metadata AS "publicMetadata"`,
      [
        runId,
        artifact.path,
        artifact.sha256,
        artifact.sizeBytes,
        artifact.mediaType,
        artifact.storageBucket,
        artifact.objectKey,
        artifact.etag ?? null,
        artifact.publicMetadataJson,
      ],
    );
    if (
      inserted.rowCount === 1 &&
      artifactMatches(
        requireSingleRow(inserted, "artifact insert"),
        artifact,
      )
    ) {
      return;
    }
    if (inserted.rowCount === 1) {
      throw new PublicationRepositoryError(
        "database_invariant",
        `database transformed artifact metadata for ${artifact.path}`,
      );
    }

    const existing = await client.query(
      `SELECT
         artifact_path AS "path", sha256, size_bytes AS "sizeBytes",
         media_type AS "mediaType", storage_bucket AS "storageBucket",
         object_key AS "objectKey", etag, public_metadata AS "publicMetadata"
       FROM forge_published_artifacts
       WHERE run_id = $1 AND artifact_path = $2`,
      [runId, artifact.path],
    );
    const row = firstRow(existing);
    if (existing.rowCount !== 1 || row === undefined || !artifactMatches(row, artifact)) {
      throw new PublicationRepositoryError(
        "metadata_conflict",
        `artifact metadata conflicts with the existing row for ${artifact.path}`,
      );
    }
  }

  private async insertOrVerifyFinding(
    client: PgClientLike,
    runId: string,
    finding: ValidatedPublishedFindingInput,
  ): Promise<void> {
    const inserted = await client.query(
      `INSERT INTO forge_published_findings (
         run_id, finding_id, rule_id, title, summary, severity, confidence,
         public_metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (run_id, finding_id) DO NOTHING
       RETURNING
         finding_id AS "findingId", rule_id AS "ruleId", title, summary,
         severity, confidence, public_metadata AS "publicMetadata"`,
      [
        runId,
        finding.findingId,
        finding.ruleId,
        finding.title,
        finding.summary,
        finding.severity,
        finding.confidence,
        finding.publicMetadataJson,
      ],
    );
    if (
      inserted.rowCount === 1 &&
      findingMatches(
        requireSingleRow(inserted, "finding insert"),
        finding,
      )
    ) {
      return;
    }
    if (inserted.rowCount === 1) {
      throw new PublicationRepositoryError(
        "database_invariant",
        `database transformed finding metadata for ${finding.findingId}`,
      );
    }

    const existing = await client.query(
      `SELECT
         finding_id AS "findingId", rule_id AS "ruleId", title, summary,
         severity, confidence, public_metadata AS "publicMetadata"
       FROM forge_published_findings
       WHERE run_id = $1 AND finding_id = $2`,
      [runId, finding.findingId],
    );
    const row = firstRow(existing);
    if (existing.rowCount !== 1 || row === undefined || !findingMatches(row, finding)) {
      throw new PublicationRepositoryError(
        "metadata_conflict",
        `finding metadata conflicts with the existing row for ${finding.findingId}`,
      );
    }
  }

  public async finalizePublication(
    input: FinalizePublicationInput,
  ): Promise<FinalizePublicationResult> {
    this.assertOpen();
    const validated = validateFinalizeInput(input);
    const {
      runId,
      manifestSha256,
      manifestObjectKey,
      artifacts,
      findings,
    } = validated;

    const client = await this.pool.connect();
    let transactionStarted = false;
    let poisonedConnection: Error | undefined;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(TRANSACTION_GUARDS_SQL);
      const locked = await client.query(
        `SELECT ${RUN_COLUMNS}
         FROM forge_published_runs
         WHERE run_id = $1
         FOR UPDATE`,
        [runId],
      );
      if (locked.rowCount === 0) {
        throw new PublicationRepositoryError(
          "not_found",
          `publication ${runId} must be begun before finalization`,
        );
      }
      const current = rowToRun(
        requireSingleRow(locked, "publication finalization lookup"),
      );
      if (current.manifestSha256 !== manifestSha256) {
        throw new PublicationRepositoryError(
          "identity_conflict",
          `run ${runId} has a different manifest digest`,
        );
      }
      if (
        current.manifestObjectKey !== undefined &&
        current.manifestObjectKey !== manifestObjectKey
      ) {
        throw new PublicationRepositoryError(
          "identity_conflict",
          `run ${runId} has a different manifest object key`,
        );
      }
      for (const artifact of artifacts) {
        if (artifact.storageBucket !== current.storageBucket) {
          throw new PublicationRepositoryError(
            "identity_conflict",
            `artifact ${artifact.path} names a different storage bucket`,
          );
        }
      }

      if (current.status === "published") {
        const storedArtifacts = await client.query(
          `SELECT
             artifact_path AS "path", sha256, size_bytes AS "sizeBytes",
             media_type AS "mediaType", storage_bucket AS "storageBucket",
             object_key AS "objectKey", etag,
             public_metadata AS "publicMetadata"
           FROM forge_published_artifacts
           WHERE run_id = $1`,
          [runId],
        );
        const storedFindings = await client.query(
          `SELECT
             finding_id AS "findingId", rule_id AS "ruleId", title, summary,
             severity, confidence, public_metadata AS "publicMetadata"
           FROM forge_published_findings
           WHERE run_id = $1`,
          [runId],
        );
        assertArtifactSetMatches(storedArtifacts.rows, artifacts);
        assertFindingSetMatches(storedFindings.rows, findings);
        await client.query("COMMIT");
        transactionStarted = false;
        return {
          disposition: "already_published",
          run: current,
          artifactCount: artifacts.length,
          findingCount: findings.length,
        };
      }

      for (const artifact of artifacts) {
        await this.insertOrVerifyArtifact(client, runId, artifact);
      }
      for (const finding of findings) {
        await this.insertOrVerifyFinding(client, runId, finding);
      }

      const artifactCount = numericCount(
        await client.query(
          `SELECT COUNT(*)::integer AS count
           FROM forge_published_artifacts
           WHERE run_id = $1`,
          [runId],
        ),
        "artifact",
      );
      const findingCount = numericCount(
        await client.query(
          `SELECT COUNT(*)::integer AS count
           FROM forge_published_findings
           WHERE run_id = $1`,
          [runId],
        ),
        "finding",
      );
      if (artifactCount !== artifacts.length || findingCount !== findings.length) {
        throw new PublicationRepositoryError(
          "metadata_conflict",
          "stored publication metadata contains a different artifact or finding set",
        );
      }

      const updated = await client.query(
        `UPDATE forge_published_runs
         SET manifest_object_key = $3,
             status = 'published',
             published_at = COALESCE(published_at, NOW())
         WHERE run_id = $1
           AND manifest_sha256 = $2
           AND (manifest_object_key IS NULL OR manifest_object_key = $3)
         RETURNING ${RUN_COLUMNS}`,
        [runId, manifestSha256, manifestObjectKey],
      );
      const run = rowToRun(
        requireSingleRow(updated, "publication finalization update"),
      );
      if (run.status !== "published") {
        throw new PublicationRepositoryError(
          "database_invariant",
          "publication finalization did not return published state",
        );
      }
      await client.query("COMMIT");
      transactionStarted = false;
      return {
        disposition: "published",
        run,
        artifactCount,
        findingCount,
      };
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          poisonedConnection = errorForRelease(rollbackError);
          throw new AggregateError(
            [error, rollbackError],
            "Postgres publication finalization and rollback both failed",
          );
        }
      }
      throw error;
    } finally {
      client.release(poisonedConnection);
    }
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.ownsPool) {
      await this.pool.end();
    }
    this.closed = true;
  }
}
