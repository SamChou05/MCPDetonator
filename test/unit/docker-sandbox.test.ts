import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { TargetConfigV1 } from "../../src/config.js";
import { EvidenceStore } from "../../src/evidence-store.js";
import {
  createDockerMcpInvocation,
  ManagedContainerCleanupError,
  removeManagedContainer,
} from "../../src/sandbox/docker.js";
import { materializeDeveloperProfile } from "../../src/sandbox/profile.js";
import type { PreparedTarget } from "../../src/target/prepare.js";

const hash = "a".repeat(64);

const config: TargetConfigV1 = {
  schema: "forge.target/v1",
  target: {
    id: "arbitrary-target",
    source: { type: "local", path: ".", install: "none" },
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
    tools: [],
    workflows: [],
  },
};

describe("runtime Docker invocation", () => {
  it("preserves a lexical bind source and maps its resolved trace aliases", async () => {
    const temporaryRoot = await realpath(
      await mkdtemp(join(tmpdir(), "forge-docker-mapping-")),
    );
    const realTargetRoot = join(temporaryRoot, "real-target");
    const linkedTargetRoot = join(temporaryRoot, "linked-target");

    try {
      await mkdir(realTargetRoot);
      await symlink(
        realTargetRoot,
        linkedTargetRoot,
        process.platform === "win32" ? "junction" : "dir",
      );
      const store = await EvidenceStore.create(
        join(temporaryRoot, "runs"),
        "run-runtime-builder",
      );
      const profile = await materializeDeveloperProfile(
        store,
        "baseline-initialization",
        {
          sshKeyCanary: "ssh",
          githubCanary: "github",
          installCanary: "install",
          report: "synthetic\n",
        },
      );
      const preparedTarget: PreparedTarget = {
        hostRoot: linkedTargetRoot,
        packageRoot: linkedTargetRoot,
        containerRoot: "/opt/target",
        provenance: {
          schema: "forge.target-provenance/v1",
          runId: "run-runtime-builder",
          targetId: "arbitrary-target",
          preparedAt: "2026-08-29T12:00:00.000Z",
          containerRoot: "/opt/target",
          containerPackageRoot: "/opt/target",
          source: {
            type: "local",
            configuredPath: linkedTargetRoot,
            sourceTreeSha256: hash,
            sourceFileCount: 0,
          },
          install: {
            strategy: "none",
            lifecycleScripts: "disabled",
          },
          limitations: [],
        },
        dispose: async () => undefined,
      };

      const invocation = await createDockerMcpInvocation({
        runId: "run-runtime-builder",
        experimentId: "baseline-initialization",
        config,
        store,
        profile,
        preparedTarget,
        image: "generic-observer:test",
      });

      expect(invocation.server.args).toContain(
        `type=bind,src=${linkedTargetRoot},dst=/opt/target,readonly`,
      );
      expect(invocation.pathMappings).toEqual(
        expect.arrayContaining([
          {
            observedPrefix: linkedTargetRoot,
            containerPrefix: "/opt/target",
          },
          {
            observedPrefix: realTargetRoot,
            containerPrefix: "/opt/target",
          },
          {
            observedPrefix: `/run/host_virtiofs${linkedTargetRoot}`,
            containerPrefix: "/opt/target",
          },
          {
            observedPrefix: `/run/host_virtiofs${realTargetRoot}`,
            containerPrefix: "/opt/target",
          },
        ]),
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("removes only the matching run-labeled container and verifies absence", async () => {
    const calls: string[][] = [];
    const missing = Object.assign(new Error("inspect failed"), {
      code: 1,
      stderr: "Error response from daemon: No such container: forge-runtime",
    });
    const runDocker = vi.fn(async (args: readonly string[]) => {
      calls.push([...args]);
      if (calls.length === 1) return { stdout: "run-runtime\n" };
      if (calls.length === 2) return { stdout: "forge-runtime\n" };
      throw missing;
    });

    await expect(
      removeManagedContainer("forge-runtime", "run-runtime", {
        runDocker,
        checks: 2,
        settle: async () => undefined,
      }),
    ).resolves.toBeUndefined();

    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["container", "inspect"],
      ["container", "rm"],
      ["container", "inspect"],
      ["container", "inspect"],
    ]);
  });

  it("fails closed when Docker cannot establish container absence", async () => {
    const runDocker = vi.fn(async () => {
      throw new Error("Cannot connect to the Docker daemon");
    });

    await expect(
      removeManagedContainer("forge-runtime", "run-runtime", {
        runDocker,
        checks: 1,
      }),
    ).rejects.toBeInstanceOf(ManagedContainerCleanupError);
  });

  it("refuses cleanup when the exact container has a different run label", async () => {
    const runDocker = vi.fn(async () => ({ stdout: "different-run\n" }));

    await expect(
      removeManagedContainer("forge-runtime", "run-runtime", {
        runDocker,
        checks: 1,
      }),
    ).rejects.toThrow("run label does not match");
    expect(runDocker).toHaveBeenCalledTimes(1);
  });
});
