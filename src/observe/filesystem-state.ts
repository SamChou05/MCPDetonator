import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, opendir, readlink } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";

import { z } from "zod";

import type { EvidenceStore } from "../evidence-store.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const absoluteContainerPathSchema = z.string().startsWith("/");
const profileRootSchema = z.enum(["home", "workspace"]);

export const DEFAULT_FILESYSTEM_STATE_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxVisitedEntries: 20_000,
  maxDepth: 64,
  maxDirectoryEntries: 4_096,
  maxHashBytes: 1_048_576,
  maxTotalHashBytes: 67_108_864,
  maxSymlinkTargetBytes: 4_096,
  maxIssues: 1_000,
  maxElapsedMs: 30_000,
});

export const filesystemStateLimitsV1Schema = z
  .object({
    maxEntries: z.number().int().min(2),
    maxVisitedEntries: z.number().int().min(2),
    maxDepth: z.number().int().nonnegative(),
    maxDirectoryEntries: z.number().int().positive(),
    maxHashBytes: z.number().int().positive(),
    maxTotalHashBytes: z.number().int().nonnegative(),
    maxSymlinkTargetBytes: z.number().int().positive(),
    maxIssues: z.number().int().positive(),
    maxElapsedMs: z.number().int().nonnegative(),
  })
  .strict();

const fileContentSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("hashed"),
      sha256: sha256Schema,
    })
    .strict(),
  z.object({ status: z.literal("omitted_size_limit") }).strict(),
  z.object({ status: z.literal("omitted_total_hash_byte_limit") }).strict(),
  z.object({ status: z.literal("omitted_elapsed_time_limit") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);

const symlinkTargetSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("recorded"),
      value: z.string(),
    })
    .strict(),
  z.object({ status: z.literal("omitted_size_limit") }).strict(),
  z.object({ status: z.literal("omitted_elapsed_time_limit") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);

const entryBase = {
  root: profileRootSchema,
  path: absoluteContainerPathSchema,
};

const directoryEntrySchema = z
  .object({
    ...entryBase,
    kind: z.literal("directory"),
    mode: z.number().int().min(0).max(0o7777),
  })
  .strict();

const fileEntrySchema = z
  .object({
    ...entryBase,
    kind: z.literal("file"),
    mode: z.number().int().min(0).max(0o7777),
    size: z.number().int().nonnegative(),
    content: fileContentSchema,
  })
  .strict();

const symlinkEntrySchema = z
  .object({
    ...entryBase,
    kind: z.literal("symlink"),
    target: symlinkTargetSchema,
  })
  .strict();

export const filesystemStateEntryV1Schema = z.discriminatedUnion("kind", [
  directoryEntrySchema,
  fileEntrySchema,
  symlinkEntrySchema,
]);

const snapshotIssueSchema = z
  .object({
    root: profileRootSchema,
    path: absoluteContainerPathSchema,
    operation: z.enum([
      "lstat",
      "validate_metadata",
      "read_directory",
      "hash_file",
      "read_link",
    ]),
    code: z.string().min(1),
  })
  .strict();

const snapshotTruncationSchema = z
  .object({
    root: profileRootSchema,
    path: absoluteContainerPathSchema,
    reason: z.enum([
      "entry_limit",
      "visited_entry_limit",
      "depth_limit",
      "directory_entry_limit",
      "total_hash_byte_limit",
      "issue_limit",
      "elapsed_time_limit",
    ]),
  })
  .strict();

export const filesystemStateSnapshotV1Schema = z
  .object({
    schema: z.literal("forge.filesystem-state/v1"),
    runId: z.string().min(1),
    experimentId: z.string().min(1),
    label: z.enum(["before", "after"]),
    roots: z
      .object({
        home: absoluteContainerPathSchema,
        workspace: absoluteContainerPathSchema,
      })
      .strict(),
    limits: filesystemStateLimitsV1Schema,
    entries: z.array(filesystemStateEntryV1Schema),
    issues: z.array(snapshotIssueSchema),
    truncations: z.array(snapshotTruncationSchema),
    complete: z.boolean(),
    limitations: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const keys = new Set<string>();
    for (const [index, entry] of snapshot.entries.entries()) {
      const key = `${entry.root}\0${entry.path}`;
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          message: "filesystem snapshot entry paths must be unique per root",
          path: ["entries", index, "path"],
        });
      }
      keys.add(key);
    }
    if (snapshot.complete !== (snapshot.issues.length === 0 && snapshot.truncations.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "complete must reflect the absence of issues and truncations",
        path: ["complete"],
      });
    }
  });

const changedAttributeSchema = z.enum([
  "mode",
  "size",
  "hash_status",
  "sha256",
  "symlink_target_status",
  "symlink_target",
]);

const changedEntrySchema = z
  .object({
    root: profileRootSchema,
    path: absoluteContainerPathSchema,
    before: filesystemStateEntryV1Schema,
    after: filesystemStateEntryV1Schema,
    changed: z.array(changedAttributeSchema).min(1),
  })
  .strict();

const typeChangedEntrySchema = z
  .object({
    root: profileRootSchema,
    path: absoluteContainerPathSchema,
    before: filesystemStateEntryV1Schema,
    after: filesystemStateEntryV1Schema,
  })
  .strict();

const filesystemStateArtifactRefsSchema = z
  .object({
    before: z.string().min(1),
    after: z.string().min(1),
    delta: z.string().min(1),
  })
  .strict();

export const filesystemStateDeltaV1Schema = z
  .object({
    schema: z.literal("forge.filesystem-delta/v1"),
    runId: z.string().min(1),
    experimentId: z.string().min(1),
    artifactRefs: filesystemStateArtifactRefsSchema,
    snapshotsComplete: z
      .object({
        before: z.boolean(),
        after: z.boolean(),
      })
      .strict(),
    changes: z
      .object({
        created: z.array(filesystemStateEntryV1Schema),
        modified: z.array(changedEntrySchema),
        deleted: z.array(filesystemStateEntryV1Schema),
        typeChanged: z.array(typeChangedEntrySchema),
      })
      .strict(),
    limitations: z.array(z.string().min(1)),
  })
  .strict();

export type FilesystemStateLimitsV1 = z.infer<
  typeof filesystemStateLimitsV1Schema
>;
export type FilesystemStateEntryV1 = z.infer<
  typeof filesystemStateEntryV1Schema
>;
export type FilesystemStateSnapshotV1 = z.infer<
  typeof filesystemStateSnapshotV1Schema
>;
export type FilesystemStateDeltaV1 = z.infer<
  typeof filesystemStateDeltaV1Schema
>;
export type FilesystemStateArtifactRefs = z.infer<
  typeof filesystemStateArtifactRefsSchema
>;

export interface FilesystemStateProfile {
  readonly hostHome: string;
  readonly hostWorkspace: string;
  readonly containerHome: string;
  readonly containerWorkspace: string;
}

interface CaptureRoot {
  readonly root: "home" | "workspace";
  readonly hostPath: string;
  readonly containerPath: string;
}

interface CaptureContext {
  readonly limits: FilesystemStateLimitsV1;
  readonly entries: FilesystemStateEntryV1[];
  readonly issues: z.infer<typeof snapshotIssueSchema>[];
  readonly truncations: z.infer<typeof snapshotTruncationSchema>[];
  readonly truncationKeys: Set<string>;
  readonly startedAtNanoseconds: bigint;
  visitedEntries: number;
  hashBytesConsumed: number;
  stopped: boolean;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function entryKey(entry: Pick<FilesystemStateEntryV1, "root" | "path">): string {
  return `${entry.root}\0${entry.path}`;
}

function compareLocated(
  left: { readonly root: "home" | "workspace"; readonly path: string },
  right: { readonly root: "home" | "workspace"; readonly path: string },
): number {
  return compareText(entryKey(left), entryKey(right));
}

function recordTruncation(
  context: CaptureContext,
  value: z.infer<typeof snapshotTruncationSchema>,
): void {
  const key = `${entryKey(value)}\0${value.reason}`;
  if (context.truncationKeys.has(key)) {
    return;
  }
  context.truncationKeys.add(key);
  context.truncations.push(value);
}

function elapsedLimitReached(context: CaptureContext): boolean {
  if (context.limits.maxElapsedMs === 0) {
    return true;
  }
  const elapsedNanoseconds = process.hrtime.bigint() - context.startedAtNanoseconds;
  const limitNanoseconds = BigInt(context.limits.maxElapsedMs) * 1_000_000n;
  return elapsedNanoseconds >= limitNanoseconds;
}

function withinElapsedLimit(
  root: CaptureRoot,
  containerPath: string,
  context: CaptureContext,
): boolean {
  if (!elapsedLimitReached(context)) {
    return true;
  }
  recordTruncation(context, {
    root: root.root,
    path: containerPath,
    reason: "elapsed_time_limit",
  });
  context.stopped = true;
  return false;
}

function reserveVisit(
  root: CaptureRoot,
  containerPath: string,
  context: CaptureContext,
): boolean {
  if (context.stopped || !withinElapsedLimit(root, containerPath, context)) {
    return false;
  }
  if (context.visitedEntries >= context.limits.maxVisitedEntries) {
    recordTruncation(context, {
      root: root.root,
      path: containerPath,
      reason: "visited_entry_limit",
    });
    context.stopped = true;
    return false;
  }
  context.visitedEntries += 1;
  return true;
}

function recordIssue(
  context: CaptureContext,
  value: z.infer<typeof snapshotIssueSchema>,
): void {
  if (context.issues.length < context.limits.maxIssues) {
    context.issues.push(value);
    return;
  }
  recordTruncation(context, {
    root: value.root,
    path: value.path,
    reason: "issue_limit",
  });
  context.stopped = true;
}

function portableErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]+$/.test(error.code)
  ) {
    return error.code;
  }
  return "UNKNOWN";
}

function validateContainerRoot(path: string, label: string): void {
  if (
    !posix.isAbsolute(path) ||
    path.includes("\0") ||
    path.split("/").includes("..") ||
    posix.normalize(path) !== path
  ) {
    throw new Error(`${label} must be a normalized absolute container path`);
  }
}

function captureRoots(profile: FilesystemStateProfile): CaptureRoot[] {
  if (!isAbsolute(profile.hostHome) || !isAbsolute(profile.hostWorkspace)) {
    throw new Error("filesystem state host roots must be absolute paths");
  }
  validateContainerRoot(profile.containerHome, "containerHome");
  validateContainerRoot(profile.containerWorkspace, "containerWorkspace");
  if (profile.containerHome === profile.containerWorkspace) {
    throw new Error("filesystem state container roots must be distinct");
  }
  return [
    {
      root: "home",
      hostPath: profile.hostHome,
      containerPath: profile.containerHome,
    },
    {
      root: "workspace",
      hostPath: profile.hostWorkspace,
      containerPath: profile.containerWorkspace,
    },
  ];
}

function snapshotLimitations(limits: FilesystemStateLimitsV1): string[] {
  return [
    `Snapshots retain at most ${limits.maxEntries} entries and visit at most ${limits.maxVisitedEntries} candidate entries across both profile roots, descend at most ${limits.maxDepth} components, and omit a directory's children when it exceeds ${limits.maxDirectoryEntries} immediate entries.`,
    `Regular files at or below ${limits.maxHashBytes} bytes are eligible for SHA-256 hashing, with at most ${limits.maxTotalHashBytes} bytes read across the snapshot; omitted content retains size and mode, so same-size content changes can be missed.`,
    `Symlink targets larger than ${limits.maxSymlinkTargetBytes} bytes are omitted; stationary entries identified as symlinks are recorded without following their targets.`,
    `At most ${limits.maxIssues} per-entry access failures are retained; issue-budget exhaustion is recorded as truncation evidence.`,
    `The ${limits.maxElapsedMs} ms elapsed-time budget is checked between filesystem operations and hash chunks; one blocking filesystem operation cannot be preempted.`,
    "Timestamps, ownership, extended attributes, ACLs, sparse layout, and special filesystem objects are not recorded.",
    "Traversal assumes the isolated profile is quiescent after container cleanup. Node.js pathname APIs cannot eliminate TOCTOU replacement races: a directory replaced by a symlink after classification but before opening could be followed outside the intended root.",
  ];
}

async function hashRegularFile(
  hostPath: string,
  initial: Stats,
  withinTime: () => boolean,
): Promise<
  | {
      readonly status: "hashed";
      readonly sha256: string;
      readonly bytesRead: number;
    }
  | {
      readonly status: "failed";
      readonly code: string;
      readonly bytesRead: number;
    }
  | { readonly status: "elapsed"; readonly bytesRead: number }
> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let offset = 0;
  try {
    handle = await open(hostPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== initial.dev ||
      before.ino !== initial.ino ||
      before.size !== initial.size ||
      (before.mode & 0o7777) !== (initial.mode & 0o7777)
    ) {
      return {
        status: "failed",
        code: "CHANGED_DURING_CAPTURE",
        bytesRead: offset,
      };
    }

    const hash = createHash("sha256");
    while (offset < before.size) {
      if (!withinTime()) {
        return { status: "elapsed", bytesRead: offset };
      }
      const remaining = before.size - offset;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1_024, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }

    if (!withinTime()) {
      return { status: "elapsed", bytesRead: offset };
    }

    const after = await handle.stat();
    if (
      offset !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      (after.mode & 0o7777) !== (before.mode & 0o7777) ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      return {
        status: "failed",
        code: "CHANGED_DURING_CAPTURE",
        bytesRead: offset,
      };
    }
    if (!withinTime()) {
      return { status: "elapsed", bytesRead: offset };
    }
    return { status: "hashed", sha256: hash.digest("hex"), bytesRead: offset };
  } catch (error) {
    return {
      status: "failed",
      code: portableErrorCode(error),
      bytesRead: offset,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function inspectEntry(
  root: CaptureRoot,
  hostPath: string,
  containerPath: string,
  context: CaptureContext,
): Promise<FilesystemStateEntryV1 | undefined> {
  let metadata: Stats;
  try {
    metadata = await lstat(hostPath);
  } catch (error) {
    recordIssue(context, {
      root: root.root,
      path: containerPath,
      operation: "lstat",
      code: portableErrorCode(error),
    });
    withinElapsedLimit(root, containerPath, context);
    return undefined;
  }

  if (metadata.isDirectory()) {
    const entry: FilesystemStateEntryV1 = {
      root: root.root,
      path: containerPath,
      kind: "directory",
      mode: metadata.mode & 0o7777,
    };
    withinElapsedLimit(root, containerPath, context);
    return entry;
  }

  if (metadata.isFile()) {
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) {
      recordIssue(context, {
        root: root.root,
        path: containerPath,
        operation: "validate_metadata",
        code: "UNSAFE_FILE_SIZE",
      });
      withinElapsedLimit(root, containerPath, context);
      return undefined;
    }
    const entry: FilesystemStateEntryV1 = {
      root: root.root,
      path: containerPath,
      kind: "file",
      mode: metadata.mode & 0o7777,
      size: metadata.size,
      content:
        metadata.size <= context.limits.maxHashBytes
          ? { status: "unavailable" }
          : { status: "omitted_size_limit" },
    };
    if (!withinElapsedLimit(root, containerPath, context)) {
      entry.content = { status: "omitted_elapsed_time_limit" };
      return entry;
    }
    if (
      metadata.size <= context.limits.maxHashBytes &&
      metadata.size >
        context.limits.maxTotalHashBytes - context.hashBytesConsumed
    ) {
      entry.content = { status: "omitted_total_hash_byte_limit" };
      recordTruncation(context, {
        root: root.root,
        path: containerPath,
        reason: "total_hash_byte_limit",
      });
      return entry;
    }
    if (metadata.size <= context.limits.maxHashBytes) {
      const result = await hashRegularFile(
        hostPath,
        metadata,
        () => withinElapsedLimit(root, containerPath, context),
      );
      context.hashBytesConsumed += result.bytesRead;
      if (result.status === "hashed") {
        entry.content = { status: "hashed", sha256: result.sha256 };
      } else if (result.status === "elapsed") {
        entry.content = { status: "omitted_elapsed_time_limit" };
      } else {
        recordIssue(context, {
          root: root.root,
          path: containerPath,
          operation: "hash_file",
          code: result.code,
        });
        withinElapsedLimit(root, containerPath, context);
      }
    }
    return entry;
  }

  if (metadata.isSymbolicLink()) {
    let target: FilesystemStateEntryV1 & { readonly kind: "symlink" };
    if (!withinElapsedLimit(root, containerPath, context)) {
      return {
        root: root.root,
        path: containerPath,
        kind: "symlink",
        target: { status: "omitted_elapsed_time_limit" },
      };
    }
    try {
      const value = await readlink(hostPath);
      target = {
        root: root.root,
        path: containerPath,
        kind: "symlink",
        target:
          Buffer.byteLength(value, "utf8") <= context.limits.maxSymlinkTargetBytes
            ? { status: "recorded", value }
            : { status: "omitted_size_limit" },
      };
      if (!withinElapsedLimit(root, containerPath, context)) {
        target = {
          root: root.root,
          path: containerPath,
          kind: "symlink",
          target: { status: "omitted_elapsed_time_limit" },
        };
      }
    } catch (error) {
      target = {
        root: root.root,
        path: containerPath,
        kind: "symlink",
        target: { status: "unavailable" },
      };
      recordIssue(context, {
        root: root.root,
        path: containerPath,
        operation: "read_link",
        code: portableErrorCode(error),
      });
      if (!withinElapsedLimit(root, containerPath, context)) {
        target = {
          root: root.root,
          path: containerPath,
          kind: "symlink",
          target: { status: "omitted_elapsed_time_limit" },
        };
      }
    }
    return target;
  }

  withinElapsedLimit(root, containerPath, context);
  return undefined;
}

async function boundedDirectoryNames(
  root: CaptureRoot,
  hostPath: string,
  containerPath: string,
  context: CaptureContext,
): Promise<{ readonly names: string[]; readonly exceeded: boolean } | undefined> {
  const names: string[] = [];
  if (!withinElapsedLimit(root, containerPath, context)) {
    return undefined;
  }
  try {
    const directory = await opendir(hostPath);
    for await (const entry of directory) {
      if (!withinElapsedLimit(root, containerPath, context)) {
        return undefined;
      }
      names.push(entry.name);
      if (names.length > context.limits.maxDirectoryEntries) {
        return { names: [], exceeded: true };
      }
    }
  } catch (error) {
    recordIssue(context, {
      root: root.root,
      path: containerPath,
      operation: "read_directory",
      code: portableErrorCode(error),
    });
    withinElapsedLimit(root, containerPath, context);
    return undefined;
  }
  if (!withinElapsedLimit(root, containerPath, context)) {
    return undefined;
  }
  names.sort(compareText);
  return { names, exceeded: false };
}

async function walkDirectory(
  root: CaptureRoot,
  hostPath: string,
  containerPath: string,
  depth: number,
  context: CaptureContext,
): Promise<void> {
  if (context.stopped) return;
  const listing = await boundedDirectoryNames(
    root,
    hostPath,
    containerPath,
    context,
  );
  if (listing === undefined) return;
  if (listing.exceeded) {
    recordTruncation(context, {
      root: root.root,
      path: containerPath,
      reason: "directory_entry_limit",
    });
    return;
  }
  if (depth >= context.limits.maxDepth && listing.names.length > 0) {
    recordTruncation(context, {
      root: root.root,
      path: containerPath,
      reason: "depth_limit",
    });
    return;
  }

  for (const name of listing.names) {
    if (context.entries.length >= context.limits.maxEntries) {
      recordTruncation(context, {
        root: root.root,
        path: containerPath,
        reason: "entry_limit",
      });
      context.stopped = true;
      return;
    }
    const childHostPath = join(hostPath, name);
    const childContainerPath = posix.join(containerPath, name);
    if (!reserveVisit(root, childContainerPath, context)) {
      return;
    }
    const child = await inspectEntry(
      root,
      childHostPath,
      childContainerPath,
      context,
    );
    if (child === undefined) {
      if (context.stopped) return;
      continue;
    }
    context.entries.push(child);
    if (context.stopped) return;
    if (child.kind === "directory") {
      await walkDirectory(
        root,
        childHostPath,
        childContainerPath,
        depth + 1,
        context,
      );
      if (context.stopped) return;
    }
  }
}

export async function captureFilesystemState(options: {
  readonly runId: string;
  readonly experimentId: string;
  readonly profile: FilesystemStateProfile;
  readonly label: "before" | "after";
  readonly limits?: Partial<FilesystemStateLimitsV1>;
}): Promise<FilesystemStateSnapshotV1> {
  const limits = filesystemStateLimitsV1Schema.parse({
    ...DEFAULT_FILESYSTEM_STATE_LIMITS,
    ...options.limits,
  });
  const roots = captureRoots(options.profile);
  const context: CaptureContext = {
    limits,
    entries: [],
    issues: [],
    truncations: [],
    truncationKeys: new Set(),
    startedAtNanoseconds: process.hrtime.bigint(),
    visitedEntries: 0,
    hashBytesConsumed: 0,
    stopped: false,
  };
  const directories: Array<{ readonly root: CaptureRoot }> = [];

  // Capture both roots before descendants so a tight global entry bound still
  // represents home and workspace independently.
  for (const root of roots) {
    if (!reserveVisit(root, root.containerPath, context)) {
      break;
    }
    const entry = await inspectEntry(
      root,
      root.hostPath,
      root.containerPath,
      context,
    );
    if (entry !== undefined) {
      context.entries.push(entry);
      if (entry.kind === "directory") directories.push({ root });
    }
    if (context.stopped) break;
  }
  for (const { root } of directories) {
    await walkDirectory(root, root.hostPath, root.containerPath, 0, context);
    if (context.stopped) break;
  }

  context.entries.sort(compareLocated);
  context.issues.sort(compareLocated);
  context.truncations.sort(compareLocated);
  return filesystemStateSnapshotV1Schema.parse({
    schema: "forge.filesystem-state/v1",
    runId: options.runId,
    experimentId: options.experimentId,
    label: options.label,
    roots: {
      home: options.profile.containerHome,
      workspace: options.profile.containerWorkspace,
    },
    limits,
    entries: context.entries,
    issues: context.issues,
    truncations: context.truncations,
    complete: context.issues.length === 0 && context.truncations.length === 0,
    limitations: snapshotLimitations(limits),
  });
}

export function filesystemStateArtifactRefs(
  experimentId: string,
): FilesystemStateArtifactRefs {
  if (!/^[a-z][a-z0-9-]*$/.test(experimentId)) {
    throw new Error("filesystem state experiment id is not artifact-path safe");
  }
  const base = `runtime/filesystem-state/${experimentId}`;
  return {
    before: `${base}/before.json`,
    after: `${base}/after.json`,
    delta: `${base}/delta.json`,
  };
}

function entryMap(
  entries: readonly FilesystemStateEntryV1[],
): Map<string, FilesystemStateEntryV1> {
  return new Map(entries.map((entry) => [entryKey(entry), entry]));
}

function changedAttributes(
  before: FilesystemStateEntryV1,
  after: FilesystemStateEntryV1,
): z.infer<typeof changedAttributeSchema>[] {
  if (before.kind !== after.kind) return [];
  if (before.kind === "directory" && after.kind === "directory") {
    return before.mode === after.mode ? [] : ["mode"];
  }
  if (before.kind === "file" && after.kind === "file") {
    const changes: z.infer<typeof changedAttributeSchema>[] = [];
    if (before.mode !== after.mode) changes.push("mode");
    if (before.size !== after.size) changes.push("size");
    if (before.content.status !== after.content.status) {
      changes.push("hash_status");
    } else if (
      before.content.status === "hashed" &&
      after.content.status === "hashed" &&
      before.content.sha256 !== after.content.sha256
    ) {
      changes.push("sha256");
    }
    return changes;
  }
  if (before.kind === "symlink" && after.kind === "symlink") {
    if (before.target.status !== after.target.status) {
      return ["symlink_target_status"];
    }
    if (
      before.target.status === "recorded" &&
      after.target.status === "recorded" &&
      before.target.value !== after.target.value
    ) {
      return ["symlink_target"];
    }
  }
  return [];
}

function sameCaptureLimits(
  left: FilesystemStateLimitsV1,
  right: FilesystemStateLimitsV1,
): boolean {
  return (
    left.maxEntries === right.maxEntries &&
    left.maxVisitedEntries === right.maxVisitedEntries &&
    left.maxDepth === right.maxDepth &&
    left.maxDirectoryEntries === right.maxDirectoryEntries &&
    left.maxHashBytes === right.maxHashBytes &&
    left.maxTotalHashBytes === right.maxTotalHashBytes &&
    left.maxSymlinkTargetBytes === right.maxSymlinkTargetBytes &&
    left.maxIssues === right.maxIssues &&
    left.maxElapsedMs === right.maxElapsedMs
  );
}

export function diffFilesystemState(
  beforeInput: FilesystemStateSnapshotV1,
  afterInput: FilesystemStateSnapshotV1,
): FilesystemStateDeltaV1 {
  const before = filesystemStateSnapshotV1Schema.parse(beforeInput);
  const after = filesystemStateSnapshotV1Schema.parse(afterInput);
  if (before.label !== "before" || after.label !== "after") {
    throw new Error("filesystem state diff requires before and after snapshots");
  }
  if (before.runId !== after.runId || before.experimentId !== after.experimentId) {
    throw new Error("filesystem state snapshots must belong to the same run and experiment");
  }
  if (
    before.roots.home !== after.roots.home ||
    before.roots.workspace !== after.roots.workspace
  ) {
    throw new Error("filesystem state snapshots must use the same container roots");
  }
  if (!sameCaptureLimits(before.limits, after.limits)) {
    throw new Error("filesystem state snapshots must use identical capture limits");
  }

  const beforeByPath = entryMap(before.entries);
  const afterByPath = entryMap(after.entries);
  const created: FilesystemStateEntryV1[] = [];
  const modified: z.infer<typeof changedEntrySchema>[] = [];
  const deleted: FilesystemStateEntryV1[] = [];
  const typeChanged: z.infer<typeof typeChangedEntrySchema>[] = [];
  const keys = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort(
    compareText,
  );

  for (const key of keys) {
    const previous = beforeByPath.get(key);
    const current = afterByPath.get(key);
    if (previous === undefined && current !== undefined) {
      created.push(current);
    } else if (previous !== undefined && current === undefined) {
      deleted.push(previous);
    } else if (previous !== undefined && current !== undefined) {
      if (previous.kind !== current.kind) {
        typeChanged.push({
          root: previous.root,
          path: previous.path,
          before: previous,
          after: current,
        });
      } else {
        const changed = changedAttributes(previous, current);
        if (changed.length > 0) {
          modified.push({
            root: previous.root,
            path: previous.path,
            before: previous,
            after: current,
            changed,
          });
        }
      }
    }
  }

  const complete = before.complete && after.complete;
  return filesystemStateDeltaV1Schema.parse({
    schema: "forge.filesystem-delta/v1",
    runId: before.runId,
    experimentId: before.experimentId,
    artifactRefs: filesystemStateArtifactRefs(before.experimentId),
    snapshotsComplete: {
      before: before.complete,
      after: after.complete,
    },
    changes: { created, modified, deleted, typeChanged },
    limitations: [
      "The delta compares retained filesystem state across the isolated experiment window; it does not identify the responsible process, source line, or exact lifecycle phase, and an empty delta means only that retained fields did not differ.",
      "The delta compares only the bounded fields retained by both snapshots; omitted or unavailable content and metadata can hide changes.",
      ...(complete
        ? []
        : [
            "At least one snapshot has access issues or truncation, so any created, modified, deleted, or type-changed classification may reflect missing or inconsistent observation rather than a filesystem mutation; hash-status and symlink-target-status changes are especially observational.",
          ]),
    ],
  });
}

export async function persistFilesystemStateEvidence(options: {
  readonly store: EvidenceStore;
  readonly before: FilesystemStateSnapshotV1;
  readonly after: FilesystemStateSnapshotV1;
}): Promise<FilesystemStateDeltaV1> {
  const before = filesystemStateSnapshotV1Schema.parse(options.before);
  const after = filesystemStateSnapshotV1Schema.parse(options.after);
  const delta = diffFilesystemState(before, after);
  await options.store.writeJson(
    delta.artifactRefs.before,
    filesystemStateSnapshotV1Schema,
    before,
  );
  await options.store.writeJson(
    delta.artifactRefs.after,
    filesystemStateSnapshotV1Schema,
    after,
  );
  await options.store.writeJson(
    delta.artifactRefs.delta,
    filesystemStateDeltaV1Schema,
    delta,
  );
  return delta;
}
