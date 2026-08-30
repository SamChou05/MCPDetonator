import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TargetConfigV1 } from "../../src/config.js";
import { EvidenceStore } from "../../src/evidence-store.js";
import { createDockerMcpInvocation } from "../../src/sandbox/docker.js";
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
});
