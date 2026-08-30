import { createHash } from "node:crypto";

import {
  artifactReferenceV2Schema,
  syntheticResourceManifestV2Schema,
  V2_CONTRACT_LIMITS,
  type ArtifactReferenceV2,
  type SyntheticResourceManifestV2,
} from "../../contracts/v2/index.js";
import { canonicalizeJson } from "./canonical.js";
import { exactByteArrayView } from "./bytes.js";
import { V2CompileError } from "./errors.js";
import { deepFreezeJson } from "./freeze.js";
import { parseStrictJson } from "./strict-json.js";
import {
  cloneStrictBoundedJson,
  V2_ARTIFACT_CLONE_LIMITS,
} from "./strict-clone.js";

export const V2_RESOURCE_MATERIALIZATION_LIMITS = Object.freeze({
  maxInstances: V2_CONTRACT_LIMITS.arrayItems,
  maxFileBytes: 4 * 1_024 * 1_024,
  maxTotalBytes: 16 * 1_024 * 1_024,
});

class SnapshotReadonlyMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;
  readonly #copy: (value: V) => V;

  public constructor(
    entries: Iterable<readonly [K, V]>,
    copy: (value: V) => V,
  ) {
    this.#copy = copy;
    this.#values = new Map(
      [...entries].map(([key, value]) => [key, copy(value)] as const),
    );
    Object.freeze(this);
  }

  public get size(): number {
    return this.#values.size;
  }

  public get(key: K): V | undefined {
    const value = this.#values.get(key);
    return value === undefined ? undefined : this.#copy(value);
  }

  public has(key: K): boolean {
    return this.#values.has(key);
  }

  public *entries(): MapIterator<[K, V]> {
    for (const [key, value] of this.#values) yield [key, this.#copy(value)];
  }

  public *keys(): MapIterator<K> {
    yield* this.#values.keys();
  }

  public *values(): MapIterator<V> {
    for (const value of this.#values.values()) yield this.#copy(value);
  }

  public forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#values) {
      callbackfn.call(thisArg, this.#copy(value), key, this);
    }
  }

  public [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  public get [Symbol.toStringTag](): string {
    return "SnapshotReadonlyMap";
  }
}

export interface ArtifactReferenceInput {
  readonly artifactId: string;
  readonly kind: ArtifactReferenceV2["kind"];
  readonly mediaType: ArtifactReferenceV2["mediaType"];
}

export interface SyntheticResourceTemplate {
  readonly alias: string;
  readonly resourceClass: SyntheticResourceManifestV2["instances"][number]["resourceClass"];
  readonly mediaType:
    | "application/json"
    | "application/vnd.forge.synthetic-resource+json"
    | "text/plain; charset=utf-8";
  readonly content: string;
}

export interface ResourceCaseIdentity {
  readonly caseId: string;
  readonly repetition: number;
  readonly aliases: readonly string[];
}

export interface MaterializedSyntheticResources {
  readonly manifest: SyntheticResourceManifestV2;
  readonly bytesByResourceId: ReadonlyMap<string, Uint8Array>;
  readonly resourcesByCaseId: ReadonlyMap<
    string,
    ReadonlyMap<string, { readonly alias: string; readonly containerPath: string }>
  >;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function artifactReferenceFromBytes(
  input: ArtifactReferenceInput,
  bytes: Uint8Array,
): ArtifactReferenceV2 {
  const exactBytes = exactByteArrayView(bytes, "artifact bytes");
  if (exactBytes.byteLength > V2_CONTRACT_LIMITS.artifactBytes) {
    throw new V2CompileError(
      "bounds_exceeded",
      "artifact bytes exceed the V2 contract ceiling",
    );
  }
  return artifactReferenceV2Schema.parse({
    artifactId: input.artifactId,
    kind: input.kind,
    mediaType: input.mediaType,
    byteLength: exactBytes.byteLength,
    sha256: sha256Bytes(exactBytes),
  });
}

export function verifyArtifactReference(
  expected: ArtifactReferenceV2,
  bytes: Uint8Array,
): ArtifactReferenceV2 {
  const exactBytes = exactByteArrayView(bytes, "artifact bytes");
  if (exactBytes.byteLength > V2_CONTRACT_LIMITS.artifactBytes) {
    throw new V2CompileError(
      "bounds_exceeded",
      "artifact bytes exceed the V2 contract ceiling",
    );
  }
  const parsed = artifactReferenceV2Schema.parse(
    cloneStrictBoundedJson(
      expected,
      V2_ARTIFACT_CLONE_LIMITS,
      "V2 artifact reference",
    ).clone,
  );
  if (exactBytes.byteLength !== parsed.byteLength) {
    throw new V2CompileError(
      "artifact_mismatch",
      `artifact '${parsed.artifactId}' byte length does not match its reference`,
    );
  }
  const recomputed = artifactReferenceV2Schema.parse({
    ...parsed,
    byteLength: exactBytes.byteLength,
    sha256: sha256Bytes(exactBytes),
  });
  if (
    recomputed.sha256 !== parsed.sha256 ||
    recomputed.byteLength !== parsed.byteLength
  ) {
    throw new V2CompileError(
      "artifact_mismatch",
      `artifact '${parsed.artifactId}' bytes do not match its reference`,
    );
  }
  return recomputed;
}

function canonicalResourceBytes(resource: SyntheticResourceTemplate): Uint8Array {
  if (resource.mediaType === "text/plain; charset=utf-8") {
    return Buffer.from(resource.content, "utf8");
  }
  const parsed = parseStrictJson(resource.content);
  return Buffer.from(canonicalizeJson(parsed), "utf8");
}

function resourceId(
  manifestId: string,
  caseId: string,
  repetition: number,
  alias: string,
): string {
  const identity = Buffer.from(
    `${manifestId}\0${caseId}\0${repetition}\0${alias}`,
    "utf8",
  );
  return `resource-${sha256Bytes(identity).slice(0, 32)}`;
}

export function materializeSyntheticResources(input: {
  readonly manifestId: string;
  readonly resources: readonly SyntheticResourceTemplate[];
  readonly cases: readonly ResourceCaseIdentity[];
  readonly maxFileBytes: number;
  readonly maxWritableBytes: number;
  readonly maxWritableFiles: number;
}): MaterializedSyntheticResources {
  for (const [name, value] of Object.entries({
    maxFileBytes: input.maxFileBytes,
    maxWritableBytes: input.maxWritableBytes,
    maxWritableFiles: input.maxWritableFiles,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new V2CompileError(
        "bounds_exceeded",
        `${name} must be a positive safe integer`,
      );
    }
  }
  const effectiveMaxFileBytes = Math.min(
    input.maxFileBytes,
    V2_RESOURCE_MATERIALIZATION_LIMITS.maxFileBytes,
  );
  const effectiveMaxWritableBytes = Math.min(
    input.maxWritableBytes,
    V2_RESOURCE_MATERIALIZATION_LIMITS.maxTotalBytes,
  );
  const effectiveMaxWritableFiles = Math.min(
    input.maxWritableFiles,
    V2_RESOURCE_MATERIALIZATION_LIMITS.maxInstances,
  );
  const resources = [...input.resources].sort((left, right) =>
    left.alias < right.alias ? -1 : left.alias > right.alias ? 1 : 0,
  );
  const aliases = new Set<string>();
  for (const resource of resources) {
    if (aliases.has(resource.alias)) {
      throw new V2CompileError(
        "duplicate_id",
        `duplicate synthetic resource alias '${resource.alias}'`,
      );
    }
    aliases.add(resource.alias);
  }

  const instances: SyntheticResourceManifestV2["instances"] = [];
  const bytesByResourceId = new Map<string, Uint8Array>();
  const resourcesByCaseId = new Map<
    string,
    ReadonlyMap<string, { readonly alias: string; readonly containerPath: string }>
  >();
  let totalBytes = 0;

  let requestedInstanceCount = 0;
  for (const caseIdentity of input.cases) {
    requestedInstanceCount += new Set(caseIdentity.aliases).size;
    if (requestedInstanceCount > effectiveMaxWritableFiles) {
      throw new V2CompileError(
        "bounds_exceeded",
        "synthetic resources exceed the effective instance ceiling",
      );
    }
  }

  for (const caseIdentity of input.cases) {
    const caseResources = new Map<
      string,
      { readonly alias: string; readonly containerPath: string }
    >();
    const requestedAliases = new Set(caseIdentity.aliases);
    for (const alias of requestedAliases) {
      if (!aliases.has(alias)) {
        throw new V2CompileError(
          "resource_unknown",
          `unknown synthetic resource alias '${alias}'`,
        );
      }
    }
    for (const resource of resources) {
      if (!requestedAliases.has(resource.alias)) continue;
      const bytes = canonicalResourceBytes(resource);
      if (bytes.byteLength > effectiveMaxFileBytes) {
        throw new V2CompileError(
          "bounds_exceeded",
          `synthetic resource '${resource.alias}' exceeds maxFileBytes`,
        );
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > effectiveMaxWritableBytes) {
        throw new V2CompileError(
          "bounds_exceeded",
          "synthetic resources exceed maxWritableBytes",
        );
      }
      if (instances.length >= effectiveMaxWritableFiles) {
        throw new V2CompileError(
          "bounds_exceeded",
          "synthetic resources exceed maxWritableFiles",
        );
      }

      const id = resourceId(
        input.manifestId,
        caseIdentity.caseId,
        caseIdentity.repetition,
        resource.alias,
      );
      const containerPath = `/forge/synthetic/${id}`;
      const artifact = artifactReferenceFromBytes(
        {
          artifactId: id,
          kind: "synthetic_resource",
          mediaType: resource.mediaType,
        },
        bytes,
      );
      instances.push({
        resourceId: id,
        caseId: caseIdentity.caseId,
        alias: resource.alias,
        repetition: caseIdentity.repetition,
        resourceClass: resource.resourceClass,
        artifact,
        containerPath,
      });
      bytesByResourceId.set(id, bytes);
      caseResources.set(resource.alias, {
        alias: resource.alias,
        containerPath,
      });
    }
    resourcesByCaseId.set(
      caseIdentity.caseId,
      new SnapshotReadonlyMap(
        [...caseResources.entries()].map(([alias, resource]) => [
          alias,
          Object.freeze({ ...resource }),
        ] as const),
        (resource) => resource,
      ),
    );
  }

  const manifest = deepFreezeJson(
    syntheticResourceManifestV2Schema.parse({
      format: "forge.synthetic-resource-manifest/v2",
      manifestId: input.manifestId,
      instances,
    }),
  );
  const immutableBytes = new SnapshotReadonlyMap(
    bytesByResourceId,
    (bytes) => new Uint8Array(bytes),
  );
  const immutableResources = new SnapshotReadonlyMap(
    resourcesByCaseId,
    (resources) => resources,
  );
  return Object.freeze({
    manifest,
    bytesByResourceId: immutableBytes,
    resourcesByCaseId: immutableResources,
  });
}
