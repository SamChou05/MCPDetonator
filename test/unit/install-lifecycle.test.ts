import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TargetConfigV1 } from "../../src/config.js";
import { EvidenceStore } from "../../src/evidence-store.js";
import {
  createInstallContainerInvocation,
  npmCiArguments,
  observeInstallLifecycle,
  type InstallContainerInvocation,
} from "../../src/install/lifecycle.js";
import { materializeDeveloperProfile } from "../../src/sandbox/profile.js";
import type { PreparedTarget } from "../../src/target/prepare.js";

const hash = "a".repeat(64);

const config: TargetConfigV1 = {
  schema: "forge.target/v1",
  target: {
    id: "arbitrary-target",
    source: { type: "npm", package: "arbitrary-package", version: "1.2.3" },
    runtime: {
      transport: "stdio",
      command: "node",
      args: ["/opt/target/server.js"],
      cwd: "/opt/target",
      env: {},
    },
  },
  sandbox: {
    profile: "developer-v1",
    network: "blocked",
    limits: {
      timeoutMs: 2_000,
      installTimeoutMs: 60_000,
      cooldownMs: 0,
      memoryMb: 256,
      cpus: 1,
      pids: 64,
    },
  },
  experiments: {
    initialization: true,
    tools: [
      {
        id: "arbitrary-tool",
        tool: "arbitrary_tool",
        input: {},
        expected: {
          fileReads: [],
          fileReadPrefixes: [],
          fileWrites: [],
          fileWritePrefixes: [],
          networkConnections: [],
          childExecutables: [],
          childExecutablePrefixes: [],
        },
      },
    ],
    workflows: [],
  },
};

function preparedTarget(options: {
  readonly hostRoot: string;
  readonly packageRoot: string;
  readonly hostNpmCache?: string;
}): PreparedTarget {
  return {
    hostRoot: options.hostRoot,
    packageRoot: options.packageRoot,
    ...(options.hostNpmCache === undefined
      ? {}
      : { hostNpmCache: options.hostNpmCache }),
    containerRoot: "/opt/target",
    provenance: {
      schema: "forge.target-provenance/v1",
      runId: "run-install-test",
      targetId: "arbitrary-target",
      preparedAt: "2026-08-29T12:00:00.000Z",
      containerRoot: "/opt/target",
      containerPackageRoot:
        "/opt/target/node_modules/arbitrary-package",
      source: {
        type: "npm",
        package: "arbitrary-package",
        requestedVersion: "1.2.3",
        resolvedVersion: "1.2.3",
        packageTreeSha256: hash,
        packageFileCount: 1,
      },
      install: {
        strategy: "npm-install",
        lifecycleScripts: "disabled",
      },
      limitations: [],
    },
    dispose: async () => undefined,
  };
}

function mountSource(
  invocation: InstallContainerInvocation,
  destination: string,
): string {
  const mount = invocation.dockerArgs.find(
    (argument) => argument.startsWith("type=bind,") && argument.endsWith(`,dst=${destination}`),
  );
  if (mount === undefined) {
    throw new Error(`missing mount for ${destination}`);
  }
  const source = /(?:^|,)src=([^,]+)/.exec(mount)?.[1];
  if (source === undefined) {
    throw new Error(`mount for ${destination} has no source`);
  }
  return source;
}

describe("install lifecycle observation", () => {
  it("keeps the control and treatment npm commands identical except for scripts", () => {
    const disabled = npmCiArguments("scripts-disabled");
    const enabled = npmCiArguments("scripts-enabled");

    expect(disabled).toContain("--offline=true");
    expect(disabled).toContain("--cache=/npm-cache");
    expect(disabled).toContain("--ignore-scripts=true");
    expect(enabled).toContain("--ignore-scripts=false");
    expect(disabled.filter((argument) => !argument.startsWith("--ignore-scripts="))).toEqual(
      enabled.filter((argument) => !argument.startsWith("--ignore-scripts=")),
    );
  });

  it("builds a blocked, instrumented, writable-target install container", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "forge-install-builder-"));
    const realTargetRoot = join(outputRoot, "real-target");
    const linkedTargetRoot = join(outputRoot, "linked-target");
    const realCacheRoot = join(outputRoot, "real-cache");
    const linkedCacheRoot = join(outputRoot, "linked-cache");
    await Promise.all([
      mkdir(realTargetRoot),
      mkdir(realCacheRoot),
    ]);
    await Promise.all([
      symlink(
        realTargetRoot,
        linkedTargetRoot,
        process.platform === "win32" ? "junction" : "dir",
      ),
      symlink(
        realCacheRoot,
        linkedCacheRoot,
        process.platform === "win32" ? "junction" : "dir",
      ),
    ]);
    const store = await EvidenceStore.create(outputRoot, "run-builder");
    const profile = await materializeDeveloperProfile(
      store,
      "install-scripts-enabled",
      {
        sshKeyCanary: "ssh",
        githubCanary: "github",
        installCanary: "install",
        report: "synthetic\n",
      },
    );
    const rawDirectory = store.pathFor("raw/install-scripts-enabled");
    const built = await createInstallContainerInvocation({
      runId: "run-builder",
      experimentId: "install-scripts-enabled",
      mode: "scripts-enabled",
      config,
      image: "generic-observer:test",
      rawDirectory,
      hostInstallRoot: linkedTargetRoot,
      hostNpmCache: linkedCacheRoot,
      profile,
    });

    expect(built.invocation.dockerArgs).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        "--cap-add",
        "SYS_PTRACE",
        "generic-observer:test",
        "npm",
        "ci",
        "--offline=true",
        "--ignore-scripts=false",
      ]),
    );
    expect(
      built.invocation.dockerArgs.some(
        (argument) =>
          argument ===
          `type=bind,src=${linkedTargetRoot},dst=/opt/target`,
      ),
    ).toBe(true);
    expect(
      built.invocation.dockerArgs.some(
        (argument) =>
          argument ===
          `type=bind,src=${linkedTargetRoot},dst=/opt/target,readonly`,
      ),
    ).toBe(false);
    expect(built.pathMappings).toContainEqual({
      observedPrefix: linkedCacheRoot,
      containerPrefix: "/npm-cache",
    });
    expect(built.pathMappings).toContainEqual({
      observedPrefix: await realpath(linkedTargetRoot),
      containerPrefix: "/opt/target",
    });
    expect(built.pathMappings).toContainEqual({
      observedPrefix: `/run/host_virtiofs${linkedTargetRoot}`,
      containerPrefix: "/opt/target",
    });
    expect(built.pathMappings).toContainEqual({
      observedPrefix: `/run/host_virtiofs${await realpath(linkedTargetRoot)}`,
      containerPrefix: "/opt/target",
    });
    expect(built.invocation.dockerArgs.join(" ")).not.toContain(
      "arbitrary-package",
    );
    expect(built.invocation.dockerArgs.join(" ")).not.toContain(
      "arbitrary_tool",
    );
  });

  it("creates isolated A/B roots, preserves phases, and attempts both installs", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-install-observe-"));
    const sourceRoot = join(root, "prepared");
    const sourceCache = join(root, "cache");
    const packageRoot = join(
      sourceRoot,
      "node_modules",
      "arbitrary-package",
    );
    await mkdir(packageRoot, { recursive: true });
    await mkdir(sourceCache, { recursive: true });
    await writeFile(
      join(sourceRoot, "package.json"),
      '{"name":"consumer","version":"1.0.0"}\n',
    );
    await writeFile(
      join(sourceRoot, "package-lock.json"),
      '{"name":"consumer","lockfileVersion":3,"packages":{}}\n',
    );
    await writeFile(join(packageRoot, "old-install.txt"), "exclude me\n");
    await writeFile(join(sourceCache, "cache-seed"), "same input\n");
    const store = await EvidenceStore.create(join(root, "runs"), "run-install-test");
    const invocations: InstallContainerInvocation[] = [];
    const timestamps = [
      new Date("2026-08-29T12:00:00.000Z"),
      new Date("2026-08-29T12:00:01.000Z"),
      new Date("2026-08-29T12:00:02.000Z"),
      new Date("2026-08-29T12:00:03.000Z"),
    ];

    const observation = await observeInstallLifecycle({
      runId: "run-install-test",
      store,
      config,
      preparedTarget: preparedTarget({
        hostRoot: sourceRoot,
        packageRoot,
        hostNpmCache: sourceCache,
      }),
      image: "generic-observer:test",
      profileSeed: {
        sshKeyCanary: "same-ssh",
        githubCanary: "same-github",
        installCanary: "same-install",
        report: "same report\n",
      },
      dependencies: {
        now: () => timestamps.shift() ?? new Date("2026-08-29T12:00:04.000Z"),
        runContainer: async (invocation) => {
          invocations.push(invocation);
          const installRoot = mountSource(invocation, "/opt/target");
          const cacheRoot = mountSource(invocation, "/npm-cache");
          await expect(
            access(join(installRoot, "node_modules", "arbitrary-package")),
          ).rejects.toThrow();
          expect(await readFile(join(cacheRoot, "cache-seed"), "utf8")).toBe(
            "same input\n",
          );
          await writeFile(invocation.stdoutPath, "synthetic npm stdout\n");
          await writeFile(invocation.stderrPath, "");
          return invocation.mode === "scripts-disabled"
            ? { status: "completed", exitCode: 0 }
            : { status: "failed", exitCode: 42 };
        },
      },
    });

    expect(invocations.map((invocation) => invocation.mode)).toEqual([
      "scripts-disabled",
      "scripts-enabled",
    ]);
    expect(observation.scriptsDisabled.hostRoot).not.toBe(
      observation.scriptsEnabled.hostRoot,
    );
    expect(observation.scriptsDisabled.hostNpmCache).not.toBe(
      observation.scriptsEnabled.hostNpmCache,
    );
    expect(observation.scriptsDisabled.profile.hostHome).not.toBe(
      observation.scriptsEnabled.profile.hostHome,
    );
    expect(observation.scriptsDisabled.profile.seed.installCanary).toBe(
      observation.scriptsEnabled.profile.seed.installCanary,
    );
    expect(observation.scriptsDisabled.phase.status).toBe("completed");
    expect(observation.scriptsEnabled.phase.status).toBe("failed");
    expect(observation.scriptsEnabled.hostPackageRoot).toBe(
      join(
        observation.scriptsEnabled.hostRoot,
        "node_modules",
        "arbitrary-package",
      ),
    );
    expect(
      observation.pathMappingsByExperiment.get("install-scripts-enabled"),
    ).toEqual(observation.scriptsEnabled.pathMappings);

    const phases = (await readFile(store.pathFor("phases.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status: string });
    expect(phases.map((phase) => phase.status)).toEqual([
      "completed",
      "failed",
    ]);
    expect(
      JSON.parse(
        await readFile(observation.scriptsEnabled.metadataPath, "utf8"),
      ),
    ).toMatchObject({
      schema: "forge.install-process/v1",
      mode: "scripts-enabled",
      outcome: { status: "failed", exitCode: 42 },
    });

    const disposableRoot = observation.scriptsEnabled.hostRoot;
    await observation.dispose();
    await expect(access(disposableRoot)).rejects.toThrow();
  });

  it("rejects prepared targets that have no reusable npm cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-install-no-cache-"));
    await writeFile(join(root, "package-lock.json"), "{}\n");
    const store = await EvidenceStore.create(join(root, "runs"), "run-no-cache");

    await expect(
      observeInstallLifecycle({
        runId: "run-no-cache",
        store,
        config,
        preparedTarget: preparedTarget({ hostRoot: root, packageRoot: root }),
        image: "generic-observer:test",
      }),
    ).rejects.toThrow("requires a prepared npm cache");
  });
});
