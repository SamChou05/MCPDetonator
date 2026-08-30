import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { Readable } from "node:stream";

import {
  HeadObjectCommand,
  PutObjectCommand,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";

const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/u;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PREFIX_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._=-]{0,127}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export interface S3CommandClient {
  send(command: PutObjectCommand | HeadObjectCommand): Promise<unknown>;
}

export interface S3ArtifactStoreOptions {
  client: S3CommandClient;
  bucket: string;
  prefix?: string;
}

export interface S3FileArtifactInput {
  /** Read-only publisher snapshot created while the artifact digest was verified. */
  sourceHandle: FileHandle;
  sha256: string;
  sizeBytes: number;
  contentType: string;
}

export interface S3ManifestInput {
  runId: string;
  bytes: Uint8Array;
  sha256: string;
  contentType?: string;
}

export interface StoredS3Object {
  bucket: string;
  key: string;
  sha256: string;
  sizeBytes: number;
  created: boolean;
}

export class S3ArtifactStoreError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "S3ArtifactStoreError";
  }
}

function normalizeSha256(value: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new S3ArtifactStoreError("SHA-256 must be exactly 64 hexadecimal characters");
  }

  return value.toLowerCase();
}

function validateRunId(value: string): string {
  if (!RUN_ID_PATTERN.test(value)) {
    throw new S3ArtifactStoreError(
      "run ID must be 1-128 safe characters beginning with an alphanumeric character",
    );
  }

  return value;
}

function normalizePrefix(value: string | undefined): string {
  if (value === undefined || value === "") {
    return "";
  }

  if (
    value.length > 512 ||
    value.trim() !== value ||
    value.includes("\\") ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new S3ArtifactStoreError("S3 prefix contains unsafe or unsupported characters");
  }

  const stripped = value.replace(/^\/+|\/+$/gu, "");
  if (stripped === "") {
    return "";
  }

  const segments = stripped.split(/\/+/u);
  for (const segment of segments) {
    if (
      segment === "." ||
      segment === ".." ||
      !PREFIX_SEGMENT_PATTERN.test(segment)
    ) {
      throw new S3ArtifactStoreError(
        `S3 prefix segment ${JSON.stringify(segment)} is unsafe or unsupported`,
      );
    }
  }

  const normalized = segments.join("/");
  if (normalized.length > 512) {
    throw new S3ArtifactStoreError("normalized S3 prefix exceeds 512 characters");
  }

  return normalized;
}

function validateBucket(value: string): string {
  if (
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value ||
    value.includes("/") ||
    value.includes("\\") ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new S3ArtifactStoreError("S3 bucket name is empty, unsafe, or unsupported");
  }

  return value;
}

function validateSizeBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new S3ArtifactStoreError("object size must be a non-negative safe integer");
  }

  return value;
}

function validateContentType(value: string): string {
  if (
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new S3ArtifactStoreError("content type is empty, unsafe, or unsupported");
  }

  return value;
}

function checksumBase64(sha256: string): string {
  return Buffer.from(sha256, "hex").toString("base64");
}

function isConditionalConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const record = error as Record<string, unknown>;
  if (
    record.name === "PreconditionFailed" ||
    record.name === "ConditionalRequestConflict"
  ) {
    return true;
  }

  const metadata = record["$metadata"];
  if (typeof metadata !== "object" || metadata === null) {
    return false;
  }

  const statusCode = (metadata as Record<string, unknown>).httpStatusCode;
  return statusCode === 409 || statusCode === 412;
}

function isMissingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const record = error as Record<string, unknown>;
  if (record.name === "NotFound" || record.name === "NoSuchKey") {
    return true;
  }
  const metadata = record["$metadata"];
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as Record<string, unknown>).httpStatusCode === 404
  );
}

function metadataSha256(output: HeadObjectCommandOutput): string | undefined {
  for (const [key, value] of Object.entries(output.Metadata ?? {})) {
    if (key.toLowerCase() === "forge-sha256" && typeof value === "string") {
      return value.toLowerCase();
    }
  }

  return undefined;
}

function storedObject(
  bucket: string,
  key: string,
  sha256: string,
  sizeBytes: number,
  created: boolean,
): StoredS3Object {
  return {
    bucket,
    key,
    sha256,
    sizeBytes,
    created,
  };
}

export class S3ArtifactStore {
  public readonly bucket: string;
  public readonly prefix: string;

  readonly #client: S3CommandClient;

  public constructor(options: S3ArtifactStoreOptions) {
    this.#client = options.client;
    this.bucket = validateBucket(options.bucket);
    this.prefix = normalizePrefix(options.prefix);
  }

  public artifactKey(sha256: string): string {
    const normalizedDigest = normalizeSha256(sha256);
    return this.#underPrefix(
      `objects/sha256/${normalizedDigest.slice(0, 2)}/${normalizedDigest}`,
    );
  }

  public manifestKey(runId: string): string {
    return this.#underPrefix(`runs/${validateRunId(runId)}/run.json`);
  }

  public async validateArtifact(input: S3FileArtifactInput): Promise<void> {
    await this.#validateArtifact(input);
  }

  public validateManifest(input: S3ManifestInput): void {
    this.#validateManifest(input);
  }

  public async putArtifact(input: S3FileArtifactInput): Promise<StoredS3Object> {
    const validated = await this.#validateArtifact(input);
    const body = input.sourceHandle.createReadStream({
      autoClose: false,
      start: 0,
      end: validated.sizeBytes === 0 ? undefined : validated.sizeBytes - 1,
    });
    try {
      return await this.#putImmutable({
        key: this.artifactKey(validated.sha256),
        body,
        contentType: validated.contentType,
        sha256: validated.sha256,
        sizeBytes: validated.sizeBytes,
      });
    } finally {
      body.destroy();
    }
  }

  public async putManifest(input: S3ManifestInput): Promise<StoredS3Object> {
    const validated = this.#validateManifest(input);

    return this.#putImmutable({
      key: this.manifestKey(validated.runId),
      body: validated.body,
      contentType: validated.contentType,
      sha256: validated.sha256,
      sizeBytes: validated.body.byteLength,
    });
  }

  async #validateArtifact(input: S3FileArtifactInput): Promise<{
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly contentType: string;
  }> {
    if (
      typeof input.sourceHandle !== "object" ||
      input.sourceHandle === null ||
      typeof input.sourceHandle.stat !== "function" ||
      typeof input.sourceHandle.createReadStream !== "function"
    ) {
      throw new S3ArtifactStoreError(
        "artifact source must be an open publisher snapshot handle",
      );
    }
    const sha256 = normalizeSha256(input.sha256);
    const sizeBytes = validateSizeBytes(input.sizeBytes);
    const contentType = validateContentType(input.contentType);
    let source: Awaited<ReturnType<FileHandle["stat"]>>;
    try {
      source = await input.sourceHandle.stat();
    } catch (error) {
      throw new S3ArtifactStoreError(
        "artifact publisher snapshot is closed or unreadable",
        { cause: error },
      );
    }
    if (!source.isFile()) {
      throw new S3ArtifactStoreError("artifact snapshot must be a regular file");
    }
    if (source.size !== sizeBytes) {
      throw new S3ArtifactStoreError(
        `artifact snapshot size changed before upload: expected ${sizeBytes}, found ${source.size}`,
      );
    }
    return { sha256, sizeBytes, contentType };
  }

  #validateManifest(input: S3ManifestInput): {
    readonly runId: string;
    readonly body: Buffer;
    readonly sha256: string;
    readonly contentType: string;
  } {
    const runId = validateRunId(input.runId);
    const sha256 = normalizeSha256(input.sha256);
    const contentType = validateContentType(
      input.contentType ?? "application/json",
    );
    const body = Buffer.from(input.bytes);
    const actualSha256 = createHash("sha256").update(body).digest("hex");

    if (actualSha256 !== sha256) {
      throw new S3ArtifactStoreError(
        `manifest SHA-256 mismatch: expected ${sha256}, calculated ${actualSha256}`,
      );
    }
    return { runId, body, sha256, contentType };
  }

  async #putImmutable(input: {
    key: string;
    body: Readable | Uint8Array;
    contentType: string;
    sha256: string;
    sizeBytes: number;
  }): Promise<StoredS3Object> {
    const existing = await this.#findExisting(
      input.key,
      input.sha256,
      input.sizeBytes,
    );
    if (existing !== undefined) return existing;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      Body: input.body,
      ContentLength: input.sizeBytes,
      ContentType: input.contentType,
      ChecksumSHA256: checksumBase64(input.sha256),
      IfNoneMatch: "*",
      Metadata: {
        "forge-sha256": input.sha256,
        "forge-size-bytes": String(input.sizeBytes),
      },
    });

    try {
      await this.#client.send(command);
      return storedObject(
        this.bucket,
        input.key,
        input.sha256,
        input.sizeBytes,
        true,
      );
    } catch (error) {
      if (!isConditionalConflict(error)) {
        throw new S3ArtifactStoreError(
          `failed to upload immutable S3 object ${input.key}`,
          { cause: error },
        );
      }

      return this.#verifyExisting(input.key, input.sha256, input.sizeBytes);
    }
  }

  async #verifyExisting(
    key: string,
    expectedSha256: string,
    expectedSizeBytes: number,
  ): Promise<StoredS3Object> {
    const existing = await this.#findExisting(
      key,
      expectedSha256,
      expectedSizeBytes,
    );
    if (existing === undefined) {
      throw new S3ArtifactStoreError(
        `immutable S3 object ${key} reported a create conflict but is not visible`,
      );
    }
    return existing;
  }

  async #findExisting(
    key: string,
    expectedSha256: string,
    expectedSizeBytes: number,
  ): Promise<StoredS3Object | undefined> {
    let output: HeadObjectCommandOutput;
    try {
      output = (await this.#client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ChecksumMode: "ENABLED",
        }),
      )) as HeadObjectCommandOutput;
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      throw new S3ArtifactStoreError(
        `immutable S3 object ${key} could not be checked before upload`,
        { cause: error },
      );
    }

    const actualSha256 = metadataSha256(output);
    const contentLengthMatches = output.ContentLength === expectedSizeBytes;
    const checksumMatches =
      output.ChecksumSHA256 === checksumBase64(expectedSha256);

    if (
      actualSha256 !== expectedSha256 ||
      !contentLengthMatches ||
      !checksumMatches
    ) {
      throw new S3ArtifactStoreError(
        `immutable S3 object collision at ${key}: existing digest, service checksum, or length does not match`,
      );
    }

    return storedObject(
      this.bucket,
      key,
      expectedSha256,
      expectedSizeBytes,
      false,
    );
  }

  #underPrefix(suffix: string): string {
    return this.prefix === "" ? suffix : `${this.prefix}/${suffix}`;
  }
}
