import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  EnrolledRuntimeError,
  snapshotPreparedRuntimeTree,
  validateEnrolledNodeRuntime,
  verifyPreparedRuntimeTree,
} from "../../src/audit/v2/enrolled-runtime.js";
import { digestCanonicalJson } from "../../src/audit/v2/canonical.js";
import { normalizedNodeInvocationV2AlphaSchema } from "../../src/contracts/v2/enrollment.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function targetFixture(): Promise<{
  readonly root: string;
  readonly preparedTarget: {
    readonly hostRoot: string;
    readonly containerRoot: "/opt/target";
  };
}> {
  const root = await mkdtemp(join(tmpdir(), "forge-enrolled-runtime-test-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "server.js"), "process.stdin.resume();\n");
  return {
    root,
    preparedTarget: { hostRoot: root, containerRoot: "/opt/target" },
  };
}

function descriptor(
  args: readonly string[] = ["/opt/target/dist/server.js", "stdio"],
  command = "node",
): unknown {
  return {
    transport: "stdio",
    protocol: "mcp",
    command,
    args: [...args],
    cwd: "/opt/target",
    environment: {},
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("enrolled Node STDIO runtime validation", () => {
  it("normalizes the exact direct Node invocation and binds its digest", async () => {
    const fixture = await targetFixture();
    const first = await validateEnrolledNodeRuntime({
      preparedTarget: fixture.preparedTarget,
      descriptor: descriptor([
        "/opt/target/dist/server.js",
        "stdio",
        "/forge/synthetic/probe-input",
      ]),
    });
    const second = await validateEnrolledNodeRuntime({
      preparedTarget: fixture.preparedTarget,
      descriptor: descriptor([
        "/opt/target/dist/server.js",
        "stdio",
        "/forge/synthetic/probe-input",
      ]),
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      format: "forge.enrolled-node-invocation/v1alpha1",
      descriptorCommand: "node",
      executable: "/usr/local/bin/node",
      cwd: "/opt/target",
      entrypoint: "/opt/target/dist/server.js",
      applicationArgs: ["stdio", "/forge/synthetic/probe-input"],
      environment: {},
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.applicationArgs)).toBe(true);
    expect(normalizedNodeInvocationV2AlphaSchema.parse(first)).toEqual(first);
    const { digest: _digest, ...projection } = first;
    expect(first.digest).toBe(
      digestCanonicalJson(
        "forge.enrolled-node-invocation",
        "v1alpha1",
        projection,
      ),
    );
    const different = await validateEnrolledNodeRuntime({
      preparedTarget: fixture.preparedTarget,
      descriptor: descriptor(["/opt/target/dist/server.js", "different"]),
    });
    expect(different.digest).not.toBe(first.digest);
  });

  it("rejects traversal, non-normal paths, native entrypoints, and symlink components", async () => {
    const fixture = await targetFixture();
    await writeFile(join(fixture.root, "dist", "native.node"), "not native");
    await symlink("server.js", join(fixture.root, "dist", "linked.js"));
    await symlink("dist", join(fixture.root, "linked-dist"));

    const cases: Array<{
      readonly entrypoint: string;
      readonly code:
        | "entrypoint_native"
        | "entrypoint_symlink"
        | "invalid_entrypoint";
    }> = [
      {
        entrypoint: "/opt/target/../outside.js",
        code: "invalid_entrypoint",
      },
      {
        entrypoint: "/opt/target//dist/server.js",
        code: "invalid_entrypoint",
      },
      {
        entrypoint: "/opt/target/dist/native.node",
        code: "entrypoint_native",
      },
      {
        entrypoint: "/opt/target/dist/linked.js",
        code: "entrypoint_symlink",
      },
      {
        entrypoint: "/opt/target/linked-dist/server.js",
        code: "entrypoint_symlink",
      },
    ];

    for (const candidate of cases) {
      await expect(
        validateEnrolledNodeRuntime({
          preparedTarget: fixture.preparedTarget,
          descriptor: descriptor([candidate.entrypoint]),
        }),
      ).rejects.toMatchObject({ code: candidate.code });
    }
  });

  it("rejects shell/package-manager commands and Node execution flags", async () => {
    const fixture = await targetFixture();
    for (const command of ["npx", "sh", "/usr/local/bin/node"]) {
      await expect(
        validateEnrolledNodeRuntime({
          preparedTarget: fixture.preparedTarget,
          descriptor: descriptor(["/opt/target/dist/server.js"], command),
        }),
      ).rejects.toMatchObject({ code: "invalid_descriptor" });
    }

    for (const argument of [
      "--eval=process.exit()",
      "--require=./preload.cjs",
      "--loader=./loader.mjs",
      "npx",
      "/bin/sh",
    ]) {
      await expect(
        validateEnrolledNodeRuntime({
          preparedTarget: fixture.preparedTarget,
          descriptor: descriptor(["/opt/target/dist/server.js", argument]),
        }),
      ).rejects.toMatchObject({ code: "forbidden_argument" });
    }
  });

  it("bounds literal application arguments and rejects path escapes", async () => {
    const fixture = await targetFixture();
    for (const argument of [
      "../outside",
      "--file=../../outside",
      "/etc/passwd",
      "line\nfeed",
      "windows\\path",
    ]) {
      await expect(
        validateEnrolledNodeRuntime({
          preparedTarget: fixture.preparedTarget,
          descriptor: descriptor(["/opt/target/dist/server.js", argument]),
        }),
      ).rejects.toMatchObject({ code: "forbidden_argument" });
    }

    await expect(
      validateEnrolledNodeRuntime({
        preparedTarget: fixture.preparedTarget,
        descriptor: descriptor(["/opt/target/dist/server.js", "one", "two"]),
        argumentLimits: {
          maxArguments: 1,
          maxArgumentBytes: 8,
          maxAggregateBytes: 8,
        },
      }),
    ).rejects.toMatchObject({ code: "argument_bounds" });
  });

  it("rejects descriptor accessors without invoking them", async () => {
    const fixture = await targetFixture();
    const candidate = descriptor() as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(candidate, "command", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "node";
      },
    });

    await expect(
      validateEnrolledNodeRuntime({
        preparedTarget: fixture.preparedTarget,
        descriptor: candidate,
      }),
    ).rejects.toMatchObject({ code: "invalid_descriptor" });
    expect(getterCalls).toBe(0);
  });
});

describe("bounded prepared runtime-tree snapshots", () => {
  it("hashes regular files and symlink targets without following links", async () => {
    const fixture = await targetFixture();
    await writeFile(join(fixture.root, "data.txt"), "synthetic data\n");
    await symlink("data.txt", join(fixture.root, "data-link"));

    const snapshot = await snapshotPreparedRuntimeTree(fixture.root);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.treeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.summary).toMatchObject({
      entryCount: 5,
      directoryCount: 2,
      fileCount: 2,
      symlinkCount: 1,
      maximumDepth: 2,
    });
    expect(
      snapshot.entries.find((entry) => entry.path === "data-link"),
    ).toMatchObject({
      kind: "symlink",
      targetByteLength: Buffer.byteLength("data.txt"),
      targetSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    await expect(
      verifyPreparedRuntimeTree(fixture.root, snapshot),
    ).resolves.toEqual(snapshot);
  });

  it("detects fresh file and symlink-target changes", async () => {
    const fixture = await targetFixture();
    await writeFile(join(fixture.root, "other.txt"), "other\n");
    await symlink("dist/server.js", join(fixture.root, "server-link"));
    const snapshot = await snapshotPreparedRuntimeTree(fixture.root);

    await writeFile(join(fixture.root, "dist", "server.js"), "changed\n");
    await expect(
      verifyPreparedRuntimeTree(fixture.root, snapshot),
    ).rejects.toMatchObject({ code: "runtime_tree_changed" });

    const second = await snapshotPreparedRuntimeTree(fixture.root);
    await rm(join(fixture.root, "server-link"));
    await symlink("other.txt", join(fixture.root, "server-link"));
    await expect(
      verifyPreparedRuntimeTree(fixture.root, second),
    ).rejects.toMatchObject({ code: "runtime_tree_changed" });
  });

  it("rejects symlink escapes without reading the target", async () => {
    const fixture = await targetFixture();
    const outside = await mkdtemp(join(tmpdir(), "forge-enrolled-outside-"));
    temporaryRoots.push(outside);
    await writeFile(join(outside, "secret.txt"), "must not be read");
    await symlink(
      join(outside, "secret.txt"),
      join(fixture.root, "escape-link"),
    );

    await expect(
      snapshotPreparedRuntimeTree(fixture.root),
    ).rejects.toMatchObject({ code: "runtime_tree_symlink_escape" });
  });

  it("rejects special filesystem entries", async () => {
    const fixture = await targetFixture();
    const fifo = join(fixture.root, "runtime.pipe");
    await execFileAsync("mkfifo", [fifo]);

    await expect(
      snapshotPreparedRuntimeTree(fixture.root),
    ).rejects.toMatchObject({ code: "runtime_tree_special_entry" });
  });

  it("fails closed on entry, depth, per-file, aggregate, and directory-width ceilings", async () => {
    const fixture = await targetFixture();
    await mkdir(join(fixture.root, "deep", "nested"), { recursive: true });
    await writeFile(join(fixture.root, "wide-a.txt"), "aaaa");
    await writeFile(join(fixture.root, "wide-b.txt"), "bbbb");

    const cases = [
      { maxEntries: 2 },
      { maxDepth: 1 },
      { maxDirectoryEntries: 2 },
      { maxFileBytes: 3 },
      { maxTotalFileBytes: 4 },
    ];
    for (const limits of cases) {
      await expect(
        snapshotPreparedRuntimeTree(fixture.root, limits),
      ).rejects.toMatchObject({ code: "runtime_tree_limit" });
    }
  });

  it("rejects a forged expected snapshot before freshness comparison", async () => {
    const fixture = await targetFixture();
    const snapshot = await snapshotPreparedRuntimeTree(fixture.root);
    const forged = {
      ...snapshot,
      summary: { ...snapshot.summary, fileCount: snapshot.summary.fileCount + 1 },
    };

    await expect(
      verifyPreparedRuntimeTree(fixture.root, forged),
    ).rejects.toBeInstanceOf(EnrolledRuntimeError);
  });
});
