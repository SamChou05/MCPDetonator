import { describe, expect, it } from "vitest";

import type { DockerMcpInvocation } from "../../src/sandbox/docker.js";
import type { MaterializedDeveloperProfile } from "../../src/sandbox/profile.js";
import {
  AGENT_TARGET_WORKSPACE_BYTES,
  AGENT_TARGET_WORKSPACE_MAX_INODES,
  AGENT_PROCESS_FILE_BYTES,
  agentWorkspaceSeedRoot,
  hardenAgentDockerInvocation,
} from "../../src/agent/sandbox.js";

describe("Agent V1 Docker invocation hardening", () => {
  it("replaces target-writable host binds with read-only home and bounded tmpfs workspace", () => {
    const profile = {
      hostHome: "/host/profile/home",
      hostWorkspace: "/host/profile/workspace",
      containerHome: "/sandbox/home/forge",
      containerWorkspace: "/sandbox/workspace",
    } as MaterializedDeveloperProfile;
    const invocation = {
      containerName: "forge-agent-test",
      runId: "run-agent-test",
      server: {
        command: "docker",
        args: [
          "run",
          "--mount",
          "type=bind,src=/host/profile/home,dst=/sandbox/home/forge",
          "--mount",
          "type=bind,src=/host/profile/workspace,dst=/sandbox/workspace",
          "image:test",
          "node",
          "server.js",
        ],
      },
      pathMappings: [
        {
          observedPrefix: "/host/profile/workspace",
          containerPrefix: "/sandbox/workspace",
        },
      ],
    } satisfies DockerMcpInvocation;

    const hardened = hardenAgentDockerInvocation(invocation, profile);
    const args = hardened.server.args ?? [];

    expect(args).toContain(
      "type=bind,src=/host/profile/home,dst=/sandbox/home/forge,readonly",
    );
    expect(args).toContain(
      `type=bind,src=/host/profile/workspace,dst=${agentWorkspaceSeedRoot},readonly`,
    );
    expect(args).toContain(
      `/sandbox/workspace:rw,noexec,nosuid,nodev,size=${AGENT_TARGET_WORKSPACE_BYTES},nr_inodes=${AGENT_TARGET_WORKSPACE_MAX_INODES},mode=0777`,
    );
    expect(args).toContain(
      `fsize=${AGENT_PROCESS_FILE_BYTES}:${AGENT_PROCESS_FILE_BYTES}`,
    );
    expect(args).toContain(
      `FORGE_TARGET_WORKSPACE_SEED=${agentWorkspaceSeedRoot}`,
    );
    expect(args).not.toContain(
      "type=bind,src=/host/profile/workspace,dst=/sandbox/workspace",
    );
    expect(invocation.server.args).toContain(
      "type=bind,src=/host/profile/workspace,dst=/sandbox/workspace",
    );
    expect(hardened.pathMappings).toEqual([
      {
        observedPrefix: "/host/profile/workspace",
        containerPrefix: agentWorkspaceSeedRoot,
      },
    ]);
    expect(invocation.pathMappings).toEqual([
      {
        observedPrefix: "/host/profile/workspace",
        containerPrefix: "/sandbox/workspace",
      },
    ]);
  });
});
