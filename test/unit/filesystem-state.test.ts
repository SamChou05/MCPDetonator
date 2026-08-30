import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

import { EvidenceStore } from "../../src/evidence-store.js";
import {
  captureFilesystemState,
  diffFilesystemState,
  persistFilesystemStateEvidence,
  type FilesystemStateProfile,
  type FilesystemStateSnapshotV1,
} from "../../src/observe/filesystem-state.js";

interface TemporaryProfile {
  readonly root: string;
  readonly profile: FilesystemStateProfile;
}

async function temporaryProfile(): Promise<TemporaryProfile> {
  const root = await mkdtemp(join(tmpdir(), "forge-filesystem-state-"));
  const hostHome = join(root, "home");
  const hostWorkspace = join(root, "workspace");
  await mkdir(hostHome);
  await mkdir(hostWorkspace);
  return {
    root,
    profile: {
      hostHome,
      hostWorkspace,
      containerHome: "/sandbox/home/forge",
      containerWorkspace: "/sandbox/workspace",
    },
  };
}

async function capture(
  profile: FilesystemStateProfile,
  label: "before" | "after",
  limits?: Parameters<typeof captureFilesystemState>[0]["limits"],
): Promise<FilesystemStateSnapshotV1> {
  return captureFilesystemState({
    runId: "run-filesystem-state",
    experimentId: "write-note",
    profile,
    label,
    ...(limits === undefined ? {} : { limits }),
  });
}

function paths(snapshot: FilesystemStateSnapshotV1): string[] {
  return snapshot.entries.map((entry) => entry.path);
}

describe("filesystem state evidence", () => {
  it("detects a same-size content modification by SHA-256", async () => {
    const temporary = await temporaryProfile();
    try {
      const note = join(temporary.profile.hostWorkspace, "note.txt");
      await writeFile(note, "alpha");
      const before = await capture(temporary.profile, "before");

      await writeFile(note, "bravo");
      const after = await capture(temporary.profile, "after");
      const delta = diffFilesystemState(before, after);

      expect(delta.changes.modified).toHaveLength(1);
      expect(delta.changes.modified[0]).toMatchObject({
        root: "workspace",
        path: "/sandbox/workspace/note.txt",
        changed: ["sha256"],
        before: { kind: "file", size: 5, content: { status: "hashed" } },
        after: { kind: "file", size: 5, content: { status: "hashed" } },
      });
      const change = delta.changes.modified[0];
      if (change?.before.kind !== "file" || change.after.kind !== "file") {
        throw new Error("expected a file modification");
      }
      expect(change.before.content).not.toEqual(change.after.content);
    } finally {
      await rm(temporary.root, { recursive: true, force: true });
    }
  });

  it("classifies created and deleted entries", async () => {
    const temporary = await temporaryProfile();
    try {
      const removed = join(temporary.profile.hostHome, "removed.txt");
      const created = join(temporary.profile.hostWorkspace, "created.txt");
      await writeFile(removed, "remove me");
      const before = await capture(temporary.profile, "before");

      await unlink(removed);
      await writeFile(created, "new file");
      const after = await capture(temporary.profile, "after");
      const delta = diffFilesystemState(before, after);

      expect(delta.changes.created.map((entry) => entry.path)).toEqual([
        "/sandbox/workspace/created.txt",
      ]);
      expect(delta.changes.deleted.map((entry) => entry.path)).toEqual([
        "/sandbox/home/forge/removed.txt",
      ]);
      expect(delta.changes.modified).toEqual([]);
      expect(delta.changes.typeChanged).toEqual([]);
    } finally {
      await rm(temporary.root, { recursive: true, force: true });
    }
  });

  it("distinguishes mode changes from type changes", async () => {
    const temporary = await temporaryProfile();
    try {
      const modePath = join(temporary.profile.hostWorkspace, "mode.txt");
      const typePath = join(temporary.profile.hostWorkspace, "switch");
      await writeFile(modePath, "mode");
      await chmod(modePath, 0o600);
      await writeFile(typePath, "file first");
      const before = await capture(temporary.profile, "before");

      await chmod(modePath, 0o644);
      await unlink(typePath);
      await mkdir(typePath);
      const after = await capture(temporary.profile, "after");
      const delta = diffFilesystemState(before, after);

      expect(delta.changes.modified).toMatchObject([
        {
          path: "/sandbox/workspace/mode.txt",
          changed: ["mode"],
          before: { kind: "file", mode: 0o600 },
          after: { kind: "file", mode: 0o644 },
        },
      ]);
      expect(delta.changes.typeChanged).toMatchObject([
        {
          path: "/sandbox/workspace/switch",
          before: { kind: "file" },
          after: { kind: "directory" },
        },
      ]);
    } finally {
      await rm(temporary.root, { recursive: true, force: true });
    }
  });

  it("records symlinks without following their targets", async () => {
    const temporary = await temporaryProfile();
    try {
      const outside = join(temporary.root, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "secret.txt"), "must not be hashed");
      await symlink(outside, join(temporary.profile.hostWorkspace, "linked"));

      const snapshot = await capture(temporary.profile, "before");
      expect(snapshot.entries).toContainEqual({
        root: "workspace",
        path: "/sandbox/workspace/linked",
        kind: "symlink",
        target: { status: "recorded", value: outside },
      });
      expect(paths(snapshot)).not.toContain("/sandbox/workspace/linked/secret.txt");
      expect(JSON.stringify(snapshot)).not.toContain("must not be hashed");
      expect(snapshot.limitations).toContain(
        "Symlink targets larger than 4096 bytes are omitted; stationary entries identified as symlinks are recorded without following their targets.",
      );
      expect(snapshot.limitations).toContain(
        "Traversal assumes the isolated profile is quiescent after container cleanup. Node.js pathname APIs cannot eliminate TOCTOU replacement races: a directory replaced by a symlink after classification but before opening could be followed outside the intended root.",
      );
    } finally {
      await rm(temporary.root, { recursive: true, force: true });
    }
  });

  it("produces stable, code-unit-sorted snapshots without timestamps", async () => {
    const temporary = await temporaryProfile();
    try {
      await writeFile(join(temporary.profile.hostWorkspace, "z.txt"), "z");
      await writeFile(join(temporary.profile.hostWorkspace, "A.txt"), "A");
      await mkdir(join(temporary.profile.hostHome, "nested"));
      await writeFile(
        join(temporary.profile.hostHome, "nested", "b.txt"),
        "b",
      );

      const first = await capture(temporary.profile, "before");
      const second = await capture(temporary.profile, "before");
      expect(second).toEqual(first);
      expect(paths(first)).toEqual([...paths(first)].sort());
      expect(JSON.stringify(first.entries)).not.toMatch(
        /mtime|ctime|birthtime|timestamp/i,
      );
    } finally {
      await rm(temporary.root, { recursive: true, force: true });
    }
  });

  it("makes hash, directory, depth, and global entry bounds explicit", async () => {
    const temporary = await temporaryProfile();
    try {
      await writeFile(join(temporary.profile.hostHome, "a.txt"), "12345");
      await writeFile(join(temporary.profile.hostHome, "b.txt"), "second");
      const nested = join(temporary.profile.hostWorkspace, "nested");
      await mkdir(nested);
      await writeFile(join(nested, "child.txt"), "child");

      const directoryBound = await capture(temporary.profile, "before", {
        maxDirectoryEntries: 1,
        maxHashBytes: 4,
      });
      expect(paths(directoryBound)).toEqual([
        "/sandbox/home/forge",
        "/sandbox/workspace",
        "/sandbox/workspace/nested",
        "/sandbox/workspace/nested/child.txt",
      ]);
      expect(directoryBound.truncations).toEqual([
        {
          root: "home",
          path: "/sandbox/home/forge",
          reason: "directory_entry_limit",
        },
      ]);

      const hashBound = await capture(temporary.profile, "before", {
        maxHashBytes: 4,
      });
      expect(hashBound.entries).toContainEqual({
        root: "home",
        path: "/sandbox/home/forge/a.txt",
        kind: "file",
        mode: expect.any(Number),
        size: 5,
        content: { status: "omitted_size_limit" },
      });

      const depthBound = await capture(temporary.profile, "before", {
        maxDepth: 1,
      });
      expect(paths(depthBound)).not.toContain(
        "/sandbox/workspace/nested/child.txt",
      );
      expect(depthBound.truncations).toContainEqual({
        root: "workspace",
        path: "/sandbox/workspace/nested",
        reason: "depth_limit",
      });

      const entryBound = await capture(temporary.profile, "before", {
        maxEntries: 3,
      });
      expect(entryBound.entries).toHaveLength(3);
      expect(entryBound.truncations).toContainEqual({
        root: "home",
        path: "/sandbox/home/forge",
        reason: "entry_limit",
      });
      expect(entryBound.complete).toBe(false);
    } finally {
      await rm(temporary.root, { recursive: true, force: true });
    }
  });

  it("continues across a missing root and retains a bounded issue", async () => {
    const temporary = await temporaryProfile();
    try {
      await rm(temporary.profile.hostWorkspace, { recursive: true });
      await writeFile(join(temporary.profile.hostHome, "visible.txt"), "visible");

      const snapshot = await capture(temporary.profile, "before");
      expect(paths(snapshot)).toContain("/sandbox/home/forge/visible.txt");
      expect(snapshot.issues).toEqual([
        {
          root: "workspace",
          path: "/sandbox/workspace",
          operation: "lstat",
          code: "ENOENT",
        },
      ]);
      expect(snapshot.complete).toBe(false);
    } finally {
      await rm(temporary.root, { recursive: true, force: true });
    }
  });

  it("records an unsafe regular-file size as bounded per-entry evidence", async () => {
    const temporary = await temporaryProfile();
    try {
      const oversized = join(temporary.profile.hostWorkspace, "oversized.bin");
      await writeFile(oversized, "small fixture with mocked metadata");
      const actual = await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
      const unsafeLstat = (async (path: Parameters<typeof lstat>[0]) => {
        const metadata = await actual.lstat(path);
        if (String(path) !== oversized) return metadata;
        return new Proxy(metadata, {
          get(target, property, receiver) {
            return property === "size"
              ? Number.MAX_SAFE_INTEGER + 1
              : Reflect.get(target, property, receiver);
          },
        }) as Stats;
      }) as typeof lstat;
      let snapshot: FilesystemStateSnapshotV1 | undefined;

      await vi.mocked(lstat).withImplementation(unsafeLstat, async () => {
        snapshot = await capture(temporary.profile, "before");
      });

      expect(snapshot?.entries).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "/sandbox/workspace/oversized.bin" }),
        ]),
      );
      expect(snapshot?.issues).toContainEqual({
        root: "workspace",
        path: "/sandbox/workspace/oversized.bin",
        operation: "validate_metadata",
        code: "UNSAFE_FILE_SIZE",
      });
      expect(snapshot?.complete).toBe(false);
    } finally {
      await rm(temporary.root, { recursive: true, force: true });
    }
  });

  it("stops at the visited-entry budget even when retained-entry capacity remains", async () => {
    const temporary = await temporaryProfile();
    try {
      await writeFile(join(temporary.profile.hostHome, "a.txt"), "a");
      await writeFile(join(temporary.profile.hostHome, "b.txt"), "b");

      const snapshot = await capture(temporary.profile, "before", {
        maxEntries: 10,
        maxVisitedEntries: 3,
      });

      expect(paths(snapshot)).toEqual([
        "/sandbox/home/forge",
        "/sandbox/home/forge/a.txt",
        "/sandbox/workspace",
      ]);
      expect(snapshot.truncations).toEqual([
        {
          root: "home",
          path: "/sandbox/home/forge/b.txt",
          reason: "visited_entry_limit",
        },
      ]);
      expect(snapshot.complete).toBe(false);
    } finally {
      await rm(temporary.root, { recursive: true, force: true });
    }
  });

  it("bounds aggregate hash reads and records per-file omission evidence", async () => {
    const temporary = await temporaryProfile();
    try {
      await writeFile(join(temporary.profile.hostHome, "a.txt"), "aaaa");
      await writeFile(join(temporary.profile.hostHome, "b.txt"), "bbbb");

      const snapshot = await capture(temporary.profile, "before", {
        maxHashBytes: 16,
        maxTotalHashBytes: 4,
      });
      const files = snapshot.entries.filter((entry) => entry.kind === "file");

      expect(files).toMatchObject([
        {
          path: "/sandbox/home/forge/a.txt",
          content: { status: "hashed" },
        },
        {
          path: "/sandbox/home/forge/b.txt",
          content: { status: "omitted_total_hash_byte_limit" },
        },
      ]);
      expect(snapshot.truncations).toEqual([
        {
          root: "home",
          path: "/sandbox/home/forge/b.txt",
          reason: "total_hash_byte_limit",
        },
      ]);
      expect(snapshot.complete).toBe(false);
    } finally {
      await rm(temporary.root, { recursive: true, force: true });
    }
  });

  it("bounds retained access issues and records where issue evidence stopped", async () => {
    const temporary = await temporaryProfile();
    try {
      await rm(temporary.profile.hostHome, { recursive: true });
      await rm(temporary.profile.hostWorkspace, { recursive: true });

      const snapshot = await capture(temporary.profile, "before", {
        maxIssues: 1,
      });

      expect(snapshot.issues).toEqual([
        {
          root: "home",
          path: "/sandbox/home/forge",
          operation: "lstat",
          code: "ENOENT",
        },
      ]);
      expect(snapshot.truncations).toEqual([
        {
          root: "workspace",
          path: "/sandbox/workspace",
          reason: "issue_limit",
        },
      ]);
      expect(snapshot.complete).toBe(false);
    } finally {
      await rm(temporary.root, { recursive: true, force: true });
    }
  });

  it("records stable best-effort elapsed-time truncation evidence", async () => {
    const temporary = await temporaryProfile();
    try {
      const first = await capture(temporary.profile, "before", {
        maxElapsedMs: 0,
      });
      const second = await capture(temporary.profile, "before", {
        maxElapsedMs: 0,
      });

      expect(second).toEqual(first);
      expect(first.entries).toEqual([]);
      expect(first.truncations).toEqual([
        {
          root: "home",
          path: "/sandbox/home/forge",
          reason: "elapsed_time_limit",
        },
      ]);
      expect(first.complete).toBe(false);
      expect(first.limitations).toContain(
        "The 0 ms elapsed-time budget is checked between filesystem operations and hash chunks; one blocking filesystem operation cannot be preempted.",
      );
    } finally {
      await rm(temporary.root, { recursive: true, force: true });
    }
  });

  it("rejects incompatible capture limits and describes empty deltas without inventing change", async () => {
    const temporary = await temporaryProfile();
    try {
      const before = await capture(temporary.profile, "before");
      const matchingAfter = await capture(temporary.profile, "after");
      const incompatibleAfter = await capture(temporary.profile, "after", {
        maxHashBytes: 8,
      });

      expect(() => diffFilesystemState(before, incompatibleAfter)).toThrow(
        "filesystem state snapshots must use identical capture limits",
      );
      const delta = diffFilesystemState(before, matchingAfter);
      expect(delta.changes).toEqual({
        created: [],
        modified: [],
        deleted: [],
        typeChanged: [],
      });
      expect(delta.limitations[0]).toContain(
        "an empty delta means only that retained fields did not differ",
      );
      expect(delta.limitations[0]).not.toContain("establishes that state changed");
    } finally {
      await rm(temporary.root, { recursive: true, force: true });
    }
  });

  it("qualifies observational modifications when a snapshot is incomplete", async () => {
    const temporary = await temporaryProfile();
    try {
      const unchanged = join(temporary.profile.hostHome, "b.txt");
      await writeFile(unchanged, "bbbb");
      const limits = { maxHashBytes: 16, maxTotalHashBytes: 4 };
      const before = await capture(temporary.profile, "before", limits);

      await writeFile(join(temporary.profile.hostHome, "a.txt"), "aaaa");
      const after = await capture(temporary.profile, "after", limits);
      const delta = diffFilesystemState(before, after);

      expect(delta.snapshotsComplete).toEqual({ before: true, after: false });
      expect(delta.changes.modified).toContainEqual(
        expect.objectContaining({
          path: "/sandbox/home/forge/b.txt",
          changed: ["hash_status"],
        }),
      );
      expect(delta.limitations).toContain(
        "At least one snapshot has access issues or truncation, so any created, modified, deleted, or type-changed classification may reflect missing or inconsistent observation rather than a filesystem mutation; hash-status and symlink-target-status changes are especially observational.",
      );
    } finally {
      await rm(temporary.root, { recursive: true, force: true });
    }
  });

  it("persists validated evidence at stable per-experiment references", async () => {
    const temporary = await temporaryProfile();
    const output = await mkdtemp(join(tmpdir(), "forge-filesystem-evidence-"));
    try {
      const before = await capture(temporary.profile, "before");
      await writeFile(
        join(temporary.profile.hostWorkspace, "result.txt"),
        "result",
      );
      const after = await capture(temporary.profile, "after");
      const store = await EvidenceStore.create(output, "run-filesystem-state");
      const delta = await persistFilesystemStateEvidence({ store, before, after });

      expect(delta.artifactRefs).toEqual({
        before: "runtime/filesystem-state/write-note/before.json",
        after: "runtime/filesystem-state/write-note/after.json",
        delta: "runtime/filesystem-state/write-note/delta.json",
      });
      const persisted = JSON.parse(
        await readFile(store.pathFor(delta.artifactRefs.delta), "utf8"),
      ) as unknown;
      expect(persisted).toEqual(delta);
      expect(delta.limitations[0]).toContain(
        "does not identify the responsible process, source line, or exact lifecycle phase",
      );
    } finally {
      await rm(temporary.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });
});
