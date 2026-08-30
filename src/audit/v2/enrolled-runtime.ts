import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import {
  lstat,
  open,
  opendir,
  readlink,
  realpath,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";

import type { PreparedTarget } from "../../target/prepare.js";
import type { JsonTraversalLimits } from "../../mcp/json-bounds.js";
import { digestCanonicalJson } from "./canonical.js";
import { deepFreezeJson } from "./freeze.js";
import { cloneStrictBoundedJson } from "./strict-clone.js";
import {
  runtimeDescriptorV2Schema,
  type RuntimeDescriptorV2,
} from "./target.js";

export const ENROLLED_TARGET_CONTAINER_ROOT = "/opt/target" as const;
export const ENROLLED_SYNTHETIC_CONTAINER_ROOT = "/forge/synthetic" as const;
export const ENROLLED_NODE_EXECUTABLE = "/usr/local/bin/node" as const;

export const DEFAULT_ENROLLED_APPLICATION_ARGUMENT_LIMITS = Object.freeze({
  maxArguments: 32,
  maxArgumentBytes: 512,
  maxAggregateBytes: 8_192,
});

export const DEFAULT_PREPARED_RUNTIME_TREE_LIMITS = Object.freeze({
  maxEntries: 50_000,
  maxDepth: 64,
  maxDirectoryEntries: 10_000,
  maxPathBytes: 4_096,
  maxFileBytes: 32 * 1_024 * 1_024,
  maxTotalFileBytes: 512 * 1_024 * 1_024,
  maxSymlinkTargetBytes: 4_096,
});

export interface EnrolledApplicationArgumentLimits {
  readonly maxArguments: number;
  readonly maxArgumentBytes: number;
  readonly maxAggregateBytes: number;
}

export interface PreparedRuntimeTreeLimits {
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly maxDirectoryEntries: number;
  readonly maxPathBytes: number;
  readonly maxFileBytes: number;
  readonly maxTotalFileBytes: number;
  readonly maxSymlinkTargetBytes: number;
}

export type EnrolledRuntimeErrorCode =
  | "argument_bounds"
  | "entrypoint_escape"
  | "entrypoint_missing"
  | "entrypoint_native"
  | "entrypoint_symlink"
  | "forbidden_argument"
  | "invalid_descriptor"
  | "invalid_entrypoint"
  | "invalid_host_root"
  | "runtime_tree_changed"
  | "runtime_tree_limit"
  | "runtime_tree_race"
  | "runtime_tree_special_entry"
  | "runtime_tree_symlink_escape";

export class EnrolledRuntimeError extends Error {
  public constructor(
    readonly code: EnrolledRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EnrolledRuntimeError";
  }
}

export interface NormalizedEnrolledNodeInvocation {
  readonly format: "forge.enrolled-node-invocation/v1alpha1";
  readonly transport: "stdio";
  readonly protocol: "mcp";
  readonly descriptorCommand: "node";
  readonly executable: typeof ENROLLED_NODE_EXECUTABLE;
  readonly cwd: typeof ENROLLED_TARGET_CONTAINER_ROOT;
  readonly entrypoint: string;
  readonly applicationArgs: readonly string[];
  readonly environment: Readonly<Record<string, never>>;
  readonly digest: string;
}

export type PreparedRuntimeTreeEntry =
  | {
      readonly path: string;
      readonly kind: "directory";
      readonly mode: number;
    }
  | {
      readonly path: string;
      readonly kind: "file";
      readonly mode: number;
      readonly byteLength: number;
      readonly sha256: string;
    }
  | {
      readonly path: string;
      readonly kind: "symlink";
      readonly mode: number;
      readonly targetByteLength: number;
      readonly targetSha256: string;
    };

export interface PreparedRuntimeTreeSnapshot {
  readonly format: "forge.enrolled-runtime-tree/v1alpha1";
  readonly complete: true;
  readonly scope: "entire_prepared_root";
  readonly specialEntriesRejected: true;
  readonly limits: Readonly<PreparedRuntimeTreeLimits>;
  readonly entries: readonly PreparedRuntimeTreeEntry[];
  readonly summary: {
    readonly entryCount: number;
    readonly directoryCount: number;
    readonly fileCount: number;
    readonly symlinkCount: number;
    readonly fileBytesHashed: number;
    readonly symlinkTargetBytesHashed: number;
    readonly maximumDepth: number;
  };
  readonly treeSha256: string;
  readonly limitations: readonly string[];
}

const runtimeCloneLimits: JsonTraversalLimits = Object.freeze({
  maxDepth: 8,
  maxNodes: 256,
  maxObjectKeys: 16,
  maxStringCharacters: 32_768,
  maxSerializedBytes: 32_768,
});

const supportedEntrypointExtensions = new Set([".cjs", ".js", ".mjs"]);
const forbiddenNodeArgument = /^(?:-e|--eval|-r|--require|--import|--loader|--experimental-loader|--inspect|--inspect-brk|--input-type|--env-file)(?:=|$)/u;
const forbiddenExecutableToken = new Set([
  "bash",
  "dash",
  "ksh",
  "node",
  "npm",
  "npx",
  "sh",
  "zsh",
]);

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function normalizeArgumentLimits(
  overrides: Partial<EnrolledApplicationArgumentLimits> | undefined,
): Readonly<EnrolledApplicationArgumentLimits> {
  const limits = {
    maxArguments:
      overrides?.maxArguments ??
      DEFAULT_ENROLLED_APPLICATION_ARGUMENT_LIMITS.maxArguments,
    maxArgumentBytes:
      overrides?.maxArgumentBytes ??
      DEFAULT_ENROLLED_APPLICATION_ARGUMENT_LIMITS.maxArgumentBytes,
    maxAggregateBytes:
      overrides?.maxAggregateBytes ??
      DEFAULT_ENROLLED_APPLICATION_ARGUMENT_LIMITS.maxAggregateBytes,
  };
  if (!Object.values(limits).every(positiveSafeInteger)) {
    throw new EnrolledRuntimeError(
      "argument_bounds",
      "application argument limits must be positive safe integers",
    );
  }
  return Object.freeze(limits);
}

function normalizeTreeLimits(
  overrides: Partial<PreparedRuntimeTreeLimits> | undefined,
): Readonly<PreparedRuntimeTreeLimits> {
  const limits: PreparedRuntimeTreeLimits = {
    maxEntries:
      overrides?.maxEntries ?? DEFAULT_PREPARED_RUNTIME_TREE_LIMITS.maxEntries,
    maxDepth:
      overrides?.maxDepth ?? DEFAULT_PREPARED_RUNTIME_TREE_LIMITS.maxDepth,
    maxDirectoryEntries:
      overrides?.maxDirectoryEntries ??
      DEFAULT_PREPARED_RUNTIME_TREE_LIMITS.maxDirectoryEntries,
    maxPathBytes:
      overrides?.maxPathBytes ??
      DEFAULT_PREPARED_RUNTIME_TREE_LIMITS.maxPathBytes,
    maxFileBytes:
      overrides?.maxFileBytes ??
      DEFAULT_PREPARED_RUNTIME_TREE_LIMITS.maxFileBytes,
    maxTotalFileBytes:
      overrides?.maxTotalFileBytes ??
      DEFAULT_PREPARED_RUNTIME_TREE_LIMITS.maxTotalFileBytes,
    maxSymlinkTargetBytes:
      overrides?.maxSymlinkTargetBytes ??
      DEFAULT_PREPARED_RUNTIME_TREE_LIMITS.maxSymlinkTargetBytes,
  };
  if (
    !positiveSafeInteger(limits.maxEntries) ||
    !nonnegativeSafeInteger(limits.maxDepth) ||
    !positiveSafeInteger(limits.maxDirectoryEntries) ||
    !positiveSafeInteger(limits.maxPathBytes) ||
    !positiveSafeInteger(limits.maxFileBytes) ||
    !positiveSafeInteger(limits.maxTotalFileBytes) ||
    !positiveSafeInteger(limits.maxSymlinkTargetBytes)
  ) {
    throw new EnrolledRuntimeError(
      "runtime_tree_limit",
      "runtime-tree limits must be safe integers with a non-negative depth and positive remaining ceilings",
    );
  }
  return Object.freeze(limits);
}

function withinRoot(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
  );
}

function validPreparedHostRoot(value: string): boolean {
  return (
    isAbsolute(value) &&
    resolve(value) === value &&
    dirname(value) !== value &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !containsLoneSurrogate(value) &&
    Buffer.byteLength(value, "utf8") <= 4_096
  );
}

function validateContainerEntrypoint(entrypoint: string): string {
  if (
    entrypoint.includes("\0") ||
    !posix.isAbsolute(entrypoint) ||
    posix.normalize(entrypoint) !== entrypoint ||
    !entrypoint.startsWith(`${ENROLLED_TARGET_CONTAINER_ROOT}/`)
  ) {
    throw new EnrolledRuntimeError(
      "invalid_entrypoint",
      "the enrolled entrypoint must be a normalized absolute path below /opt/target",
    );
  }
  const targetRelative = posix.relative(
    ENROLLED_TARGET_CONTAINER_ROOT,
    entrypoint,
  );
  if (
    targetRelative.length === 0 ||
    targetRelative === ".." ||
    targetRelative.startsWith("../") ||
    posix.isAbsolute(targetRelative)
  ) {
    throw new EnrolledRuntimeError(
      "entrypoint_escape",
      "the enrolled entrypoint escapes the prepared target",
    );
  }
  const extension = posix.extname(entrypoint);
  if (extension === ".node") {
    throw new EnrolledRuntimeError(
      "entrypoint_native",
      "native Node add-ons cannot be enrolled as the server entrypoint",
    );
  }
  if (!supportedEntrypointExtensions.has(extension)) {
    throw new EnrolledRuntimeError(
      "invalid_entrypoint",
      "the enrolled entrypoint must use an exact .js, .mjs, or .cjs extension",
    );
  }
  return targetRelative;
}

async function verifyHostEntrypoint(
  preparedTarget: Pick<PreparedTarget, "hostRoot" | "containerRoot">,
  targetRelative: string,
): Promise<void> {
  if (
    preparedTarget.containerRoot !== ENROLLED_TARGET_CONTAINER_ROOT ||
    !validPreparedHostRoot(preparedTarget.hostRoot)
  ) {
    throw new EnrolledRuntimeError(
      "invalid_host_root",
      "the retained prepared target must use an absolute host root mounted at /opt/target",
    );
  }

  let rootMetadata: BigIntStats;
  try {
    rootMetadata = await lstat(preparedTarget.hostRoot, { bigint: true });
  } catch (error) {
    throw new EnrolledRuntimeError(
      "invalid_host_root",
      "the retained prepared target root is unavailable",
      { cause: error },
    );
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new EnrolledRuntimeError(
      "invalid_host_root",
      "the retained prepared target root must be a real directory",
    );
  }

  const segments = targetRelative.split("/");
  let current = preparedTarget.hostRoot;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let metadata: BigIntStats;
    try {
      metadata = await lstat(current, { bigint: true });
    } catch (error) {
      throw new EnrolledRuntimeError(
        "entrypoint_missing",
        "the enrolled entrypoint is unavailable in the retained target",
        { cause: error },
      );
    }
    if (metadata.isSymbolicLink()) {
      throw new EnrolledRuntimeError(
        "entrypoint_symlink",
        "the enrolled entrypoint path cannot contain symbolic links",
      );
    }
    const final = index === segments.length - 1;
    if ((!final && !metadata.isDirectory()) || (final && !metadata.isFile())) {
      throw new EnrolledRuntimeError(
        "invalid_entrypoint",
        "the enrolled entrypoint must resolve through real directories to a regular file",
      );
    }
  }

  const canonicalRoot = await realpath(preparedTarget.hostRoot);
  const canonicalEntrypoint = await realpath(current);
  if (!withinRoot(canonicalRoot, canonicalEntrypoint)) {
    throw new EnrolledRuntimeError(
      "entrypoint_escape",
      "the enrolled entrypoint resolves outside the retained target",
    );
  }
}

function validateApplicationArgument(argument: string): void {
  if (
    argument.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(argument) ||
    argument.includes("\\") ||
    containsLoneSurrogate(argument)
  ) {
    throw new EnrolledRuntimeError(
      "forbidden_argument",
      "application arguments must be non-empty literal single-line Linux tokens",
    );
  }
  if (forbiddenNodeArgument.test(argument)) {
    throw new EnrolledRuntimeError(
      "forbidden_argument",
      "Node eval, preload, loader, inspector, and environment-file flags are not enrolled application arguments",
    );
  }
  const token = argument.includes("=")
    ? argument.slice(argument.indexOf("=") + 1)
    : argument;
  const executableToken = posix.basename(token).toLowerCase();
  if (forbiddenExecutableToken.has(executableToken)) {
    throw new EnrolledRuntimeError(
      "forbidden_argument",
      "shell, package-manager, and executable tokens are not inert application arguments",
    );
  }
  const pathParts = token.split("/");
  if (pathParts.includes("..")) {
    throw new EnrolledRuntimeError(
      "forbidden_argument",
      "application arguments cannot contain path traversal",
    );
  }
  if (
    posix.isAbsolute(token) &&
    token !== ENROLLED_TARGET_CONTAINER_ROOT &&
    token !== ENROLLED_SYNTHETIC_CONTAINER_ROOT &&
    !token.startsWith(`${ENROLLED_TARGET_CONTAINER_ROOT}/`) &&
    !token.startsWith(`${ENROLLED_SYNTHETIC_CONTAINER_ROOT}/`)
  ) {
    throw new EnrolledRuntimeError(
      "forbidden_argument",
      "absolute application paths must stay inside enrolled target or synthetic-resource mounts",
    );
  }
}

function invocationProjection(
  value: Omit<NormalizedEnrolledNodeInvocation, "digest">,
): Omit<NormalizedEnrolledNodeInvocation, "digest"> {
  return value;
}

/**
 * Validate a package-authored descriptor and bind it to the controller's real
 * direct Node invocation. This validation is intentionally narrower than the
 * generic V1 runtime schema and must be repeated before every sandbox start.
 */
export async function validateEnrolledNodeRuntime(options: {
  readonly preparedTarget: Pick<PreparedTarget, "hostRoot" | "containerRoot">;
  readonly descriptor: RuntimeDescriptorV2 | unknown;
  readonly argumentLimits?: Partial<EnrolledApplicationArgumentLimits>;
}): Promise<Readonly<NormalizedEnrolledNodeInvocation>> {
  let descriptor: RuntimeDescriptorV2;
  try {
    descriptor = runtimeDescriptorV2Schema.parse(
      cloneStrictBoundedJson(
        options.descriptor,
        runtimeCloneLimits,
        "enrolled Node runtime descriptor",
      ).clone,
    );
  } catch (error) {
    throw new EnrolledRuntimeError(
      "invalid_descriptor",
      "the enrolled runtime descriptor is not bounded exact V2 STDIO data",
      { cause: error },
    );
  }
  if (
    descriptor.transport !== "stdio" ||
    descriptor.protocol !== "mcp" ||
    descriptor.command !== "node" ||
    descriptor.cwd !== ENROLLED_TARGET_CONTAINER_ROOT ||
    Object.keys(descriptor.environment).length !== 0 ||
    descriptor.args.length === 0
  ) {
    throw new EnrolledRuntimeError(
      "invalid_descriptor",
      "enrolled runtimes require literal node over MCP STDIO, /opt/target cwd, an empty target environment, and one entrypoint",
    );
  }

  const entrypoint = descriptor.args[0];
  if (entrypoint === undefined) {
    throw new EnrolledRuntimeError(
      "invalid_entrypoint",
      "the enrolled runtime descriptor omitted its entrypoint",
    );
  }
  const targetRelative = validateContainerEntrypoint(entrypoint);
  await verifyHostEntrypoint(options.preparedTarget, targetRelative);

  const limits = normalizeArgumentLimits(options.argumentLimits);
  const applicationArgs = descriptor.args.slice(1);
  if (applicationArgs.length > limits.maxArguments) {
    throw new EnrolledRuntimeError(
      "argument_bounds",
      "the enrolled runtime has too many application arguments",
    );
  }
  let aggregateBytes = 0;
  for (const argument of applicationArgs) {
    const bytes = Buffer.byteLength(argument, "utf8");
    if (bytes > limits.maxArgumentBytes) {
      throw new EnrolledRuntimeError(
        "argument_bounds",
        "an enrolled application argument exceeds its byte ceiling",
      );
    }
    if (bytes > limits.maxAggregateBytes - aggregateBytes) {
      throw new EnrolledRuntimeError(
        "argument_bounds",
        "enrolled application arguments exceed their aggregate byte ceiling",
      );
    }
    validateApplicationArgument(argument);
    aggregateBytes += bytes;
  }

  const projection = invocationProjection({
    format: "forge.enrolled-node-invocation/v1alpha1",
    transport: "stdio",
    protocol: "mcp",
    descriptorCommand: "node",
    executable: ENROLLED_NODE_EXECUTABLE,
    cwd: ENROLLED_TARGET_CONTAINER_ROOT,
    entrypoint,
    applicationArgs,
    environment: {},
  });
  const normalized: NormalizedEnrolledNodeInvocation = {
    ...projection,
    digest: digestCanonicalJson(
      "forge.enrolled-node-invocation",
      "v1alpha1",
      projection,
    ),
  };
  return deepFreezeJson(normalized);
}

function safeBigIntSize(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EnrolledRuntimeError(
      "runtime_tree_limit",
      `${label} has an unsafe byte length`,
    );
  }
  return Number(value);
}

function modeBits(metadata: BigIntStats): number {
  return Number(metadata.mode & 0o7777n);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function hashRegularFile(
  path: string,
  initial: BigIntStats,
): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameIdentity(initial, before)) {
      throw new EnrolledRuntimeError(
        "runtime_tree_race",
        "a runtime-tree file changed between classification and opening",
      );
    }
    const size = safeBigIntSize(before.size, "runtime-tree file");
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < size) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1_024, size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (offset !== size || !sameIdentity(before, after)) {
      throw new EnrolledRuntimeError(
        "runtime_tree_race",
        "a runtime-tree file changed while it was being hashed",
      );
    }
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof EnrolledRuntimeError) throw error;
    throw new EnrolledRuntimeError(
      "runtime_tree_race",
      "a runtime-tree file could not be opened without following links",
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function treeProjection(
  snapshot: Pick<
    PreparedRuntimeTreeSnapshot,
    | "complete"
    | "entries"
    | "format"
    | "limits"
    | "scope"
    | "specialEntriesRejected"
    | "summary"
  >,
): Pick<
  PreparedRuntimeTreeSnapshot,
  | "complete"
  | "entries"
  | "format"
  | "limits"
  | "scope"
  | "specialEntriesRejected"
  | "summary"
> {
  return {
    format: snapshot.format,
    complete: snapshot.complete,
    scope: snapshot.scope,
    specialEntriesRejected: snapshot.specialEntriesRejected,
    limits: snapshot.limits,
    entries: snapshot.entries,
    summary: snapshot.summary,
  };
}

/**
 * Snapshot the exact retained runtime mounted into Docker, including installed
 * dependencies. Symlinks are recorded by bounded target hash and never
 * followed. Any special entry or work-ceiling overflow rejects the snapshot.
 */
export async function snapshotPreparedRuntimeTree(
  rootInput: string,
  limitOverrides?: Partial<PreparedRuntimeTreeLimits>,
): Promise<Readonly<PreparedRuntimeTreeSnapshot>> {
  if (!validPreparedHostRoot(rootInput)) {
    throw new EnrolledRuntimeError(
      "invalid_host_root",
      "the prepared runtime-tree root must be a bounded normalized absolute non-root path",
    );
  }
  const root = resolve(rootInput);
  const limits = normalizeTreeLimits(limitOverrides);
  let rootMetadata: BigIntStats;
  try {
    rootMetadata = await lstat(root, { bigint: true });
  } catch (error) {
    throw new EnrolledRuntimeError(
      "invalid_host_root",
      "the prepared runtime-tree root is unavailable",
      { cause: error },
    );
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new EnrolledRuntimeError(
      "invalid_host_root",
      "the prepared runtime-tree root must be a real directory",
    );
  }

  const entries: PreparedRuntimeTreeEntry[] = [];
  let directoryCount = 0;
  let fileCount = 0;
  let symlinkCount = 0;
  let fileBytesHashed = 0;
  let symlinkTargetBytesHashed = 0;
  let maximumDepth = 0;

  const reserveEntry = (path: string, depth: number): void => {
    if (entries.length >= limits.maxEntries) {
      throw new EnrolledRuntimeError(
        "runtime_tree_limit",
        "the prepared runtime tree exceeds its entry ceiling",
      );
    }
    if (depth > limits.maxDepth) {
      throw new EnrolledRuntimeError(
        "runtime_tree_limit",
        "the prepared runtime tree exceeds its depth ceiling",
      );
    }
    if (Buffer.byteLength(path, "utf8") > limits.maxPathBytes) {
      throw new EnrolledRuntimeError(
        "runtime_tree_limit",
        "a prepared runtime-tree path exceeds its byte ceiling",
      );
    }
    maximumDepth = Math.max(maximumDepth, depth);
  };

  const walk = async (
    hostPath: string,
    relativePath: string,
    depth: number,
    initial: BigIntStats,
  ): Promise<void> => {
    reserveEntry(relativePath, depth);
    if (initial.isDirectory()) {
      directoryCount += 1;
      entries.push({
        path: relativePath,
        kind: "directory",
        mode: modeBits(initial),
      });

      const names: string[] = [];
      let directory: Awaited<ReturnType<typeof opendir>> | undefined;
      try {
        directory = await opendir(hostPath);
        for await (const entry of directory) {
          if (names.length >= limits.maxDirectoryEntries) {
            throw new EnrolledRuntimeError(
              "runtime_tree_limit",
              "a prepared runtime-tree directory exceeds its immediate-entry ceiling",
            );
          }
          if (
            entry.name.length === 0 ||
            entry.name === "." ||
            entry.name === ".." ||
            entry.name.includes("/") ||
            entry.name.includes("\0") ||
            containsLoneSurrogate(entry.name)
          ) {
            throw new EnrolledRuntimeError(
              "runtime_tree_special_entry",
              "the prepared runtime tree contains an invalid directory entry name",
            );
          }
          names.push(entry.name);
        }
      } catch (error) {
        if (error instanceof EnrolledRuntimeError) throw error;
        throw new EnrolledRuntimeError(
          "runtime_tree_race",
          "a prepared runtime-tree directory could not be read",
          { cause: error },
        );
      } finally {
        await directory?.close().catch(() => undefined);
      }
      names.sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      for (const name of names) {
        const childHostPath = join(hostPath, name);
        const childRelativePath =
          relativePath === "." ? name : `${relativePath}/${name}`;
        let child: BigIntStats;
        try {
          child = await lstat(childHostPath, { bigint: true });
        } catch (error) {
          throw new EnrolledRuntimeError(
            "runtime_tree_race",
            "a prepared runtime-tree entry disappeared during traversal",
            { cause: error },
          );
        }
        await walk(childHostPath, childRelativePath, depth + 1, child);
      }
      const after = await lstat(hostPath, { bigint: true }).catch(
        (error: unknown) => {
          throw new EnrolledRuntimeError(
            "runtime_tree_race",
            "a prepared runtime-tree directory disappeared during traversal",
            { cause: error },
          );
        },
      );
      if (!after.isDirectory() || !sameIdentity(initial, after)) {
        throw new EnrolledRuntimeError(
          "runtime_tree_race",
          "a prepared runtime-tree directory changed during traversal",
        );
      }
      return;
    }

    if (initial.isFile()) {
      const byteLength = safeBigIntSize(initial.size, "runtime-tree file");
      if (byteLength > limits.maxFileBytes) {
        throw new EnrolledRuntimeError(
          "runtime_tree_limit",
          "a prepared runtime-tree file exceeds its byte ceiling",
        );
      }
      if (byteLength > limits.maxTotalFileBytes - fileBytesHashed) {
        throw new EnrolledRuntimeError(
          "runtime_tree_limit",
          "the prepared runtime tree exceeds its aggregate file-byte ceiling",
        );
      }
      const sha256 = await hashRegularFile(hostPath, initial);
      fileBytesHashed += byteLength;
      fileCount += 1;
      entries.push({
        path: relativePath,
        kind: "file",
        mode: modeBits(initial),
        byteLength,
        sha256,
      });
      return;
    }

    if (initial.isSymbolicLink()) {
      let targetBytes: Buffer;
      try {
        targetBytes = await readlink(hostPath, { encoding: "buffer" });
      } catch (error) {
        throw new EnrolledRuntimeError(
          "runtime_tree_race",
          "a prepared runtime-tree symlink changed during capture",
          { cause: error },
        );
      }
      if (targetBytes.byteLength > limits.maxSymlinkTargetBytes) {
        throw new EnrolledRuntimeError(
          "runtime_tree_limit",
          "a prepared runtime-tree symlink target exceeds its byte ceiling",
        );
      }
      let target: string;
      try {
        target = new TextDecoder("utf-8", { fatal: true }).decode(targetBytes);
      } catch (error) {
        throw new EnrolledRuntimeError(
          "runtime_tree_special_entry",
          "a prepared runtime-tree symlink target is not valid UTF-8",
          { cause: error },
        );
      }
      const lexicalTarget = resolve(dirname(hostPath), target);
      if (posix.isAbsolute(target) || !withinRoot(root, lexicalTarget)) {
        throw new EnrolledRuntimeError(
          "runtime_tree_symlink_escape",
          "a prepared runtime-tree symlink target escapes the retained root",
        );
      }
      const after = await lstat(hostPath, { bigint: true }).catch(
        (error: unknown) => {
          throw new EnrolledRuntimeError(
            "runtime_tree_race",
            "a prepared runtime-tree symlink disappeared during capture",
            { cause: error },
          );
        },
      );
      if (!after.isSymbolicLink() || !sameIdentity(initial, after)) {
        throw new EnrolledRuntimeError(
          "runtime_tree_race",
          "a prepared runtime-tree symlink changed during capture",
        );
      }
      symlinkTargetBytesHashed += targetBytes.byteLength;
      symlinkCount += 1;
      entries.push({
        path: relativePath,
        kind: "symlink",
        mode: modeBits(initial),
        targetByteLength: targetBytes.byteLength,
        targetSha256: createHash("sha256").update(targetBytes).digest("hex"),
      });
      return;
    }

    throw new EnrolledRuntimeError(
      "runtime_tree_special_entry",
      "the prepared runtime tree contains a socket, FIFO, device, or unsupported special entry",
    );
  };

  await walk(root, ".", 0, rootMetadata);
  const summary = {
    entryCount: entries.length,
    directoryCount,
    fileCount,
    symlinkCount,
    fileBytesHashed,
    symlinkTargetBytesHashed,
    maximumDepth,
  };
  const projection = treeProjection({
    format: "forge.enrolled-runtime-tree/v1alpha1",
    complete: true,
    scope: "entire_prepared_root",
    specialEntriesRejected: true,
    limits,
    entries,
    summary,
  });
  const snapshot: PreparedRuntimeTreeSnapshot = {
    ...projection,
    treeSha256: digestCanonicalJson(
      "forge.enrolled-runtime-tree",
      "v1alpha1",
      projection,
    ),
    limitations: [
      "The retained tree is bounded and complete within its recorded ceilings; any ceiling overflow rejects enrollment rather than producing a partial snapshot.",
      "Regular files are opened with O_NOFOLLOW and checked before and after hashing; symlink targets are hashed without being followed, and special entries are rejected.",
      "Node pathname traversal cannot provide race-free openat-style directory walking. Snapshotting assumes the controller-owned retained tree is quiescent, and freshness must be checked again before discovery and dispatch.",
      "Ownership, ACLs, extended attributes, sparse layout, mount identity, and executable semantics beyond permission mode are not assessed.",
    ],
  };
  return deepFreezeJson(snapshot);
}

/** Re-snapshot the retained tree under the exact enrolled limits and compare it. */
export async function verifyPreparedRuntimeTree(
  root: string,
  expected: PreparedRuntimeTreeSnapshot,
): Promise<Readonly<PreparedRuntimeTreeSnapshot>> {
  let expectedDigest: string;
  try {
    expectedDigest = digestCanonicalJson(
      "forge.enrolled-runtime-tree",
      "v1alpha1",
      treeProjection(expected),
    );
  } catch (error) {
    throw new EnrolledRuntimeError(
      "runtime_tree_changed",
      "the enrolled runtime-tree snapshot is not canonical bounded data",
      { cause: error },
    );
  }
  if (expectedDigest !== expected.treeSha256 || expected.complete !== true) {
    throw new EnrolledRuntimeError(
      "runtime_tree_changed",
      "the enrolled runtime-tree snapshot digest or completion claim is invalid",
    );
  }
  const fresh = await snapshotPreparedRuntimeTree(root, expected.limits);
  if (fresh.treeSha256 !== expected.treeSha256) {
    throw new EnrolledRuntimeError(
      "runtime_tree_changed",
      "the retained prepared runtime tree differs from its enrolled snapshot",
    );
  }
  return fresh;
}
