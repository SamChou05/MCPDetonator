import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { DockerMcpInvocation } from "../sandbox/docker.js";
import type { MaterializedDeveloperProfile } from "../sandbox/profile.js";

export const AGENT_TARGET_WORKSPACE_BYTES = 16_000_000;
export const AGENT_TARGET_WORKSPACE_MAX_INODES = 2_048;
/** Container-wide per-file process limit; it applies to both target and strace. */
export const AGENT_PROCESS_FILE_BYTES = 4_000_000;
export const agentWorkspaceSeedRoot = "/forge-seed/workspace" as const;

function replaceExactlyOnce(
  values: readonly string[],
  expected: string,
  replacement: string,
): string[] {
  const matches = values.reduce(
    (count, value) => count + (value === expected ? 1 : 0),
    0,
  );
  if (matches !== 1) {
    throw new Error(
      `Agent V1 expected exactly one Docker mount '${expected}', found ${matches}`,
    );
  }
  return values.map((value) => (value === expected ? replacement : value));
}

/**
 * Harden the additive Agent V1 invocation without changing the core builder's
 * defaults. The target home is immutable, while its mutable workspace lives on
 * a size-limited in-container tmpfs seeded from a read-only host mount.
 */
export function hardenAgentDockerInvocation(
  invocation: DockerMcpInvocation,
  profile: MaterializedDeveloperProfile,
): DockerMcpInvocation {
  const serverArgs = invocation.server.args;
  if (serverArgs === undefined) {
    throw new Error("Agent V1 Docker invocation requires explicit arguments");
  }

  const homeMount =
    `type=bind,src=${profile.hostHome},dst=${profile.containerHome}`;
  const workspaceMount =
    `type=bind,src=${profile.hostWorkspace},dst=${profile.containerWorkspace}`;
  let args = replaceExactlyOnce(
    serverArgs,
    homeMount,
    `${homeMount},readonly`,
  );
  args = replaceExactlyOnce(
    args,
    workspaceMount,
    `type=bind,src=${profile.hostWorkspace},dst=${agentWorkspaceSeedRoot},readonly`,
  );
  if (args[0] !== "run") {
    throw new Error("Agent V1 expected a Docker run invocation");
  }

  const hardenedArgs = [
    "run",
    "--tmpfs",
    `${profile.containerWorkspace}:rw,noexec,nosuid,nodev,size=${AGENT_TARGET_WORKSPACE_BYTES},nr_inodes=${AGENT_TARGET_WORKSPACE_MAX_INODES},mode=0777`,
    "--ulimit",
    `fsize=${AGENT_PROCESS_FILE_BYTES}:${AGENT_PROCESS_FILE_BYTES}`,
    "--env",
    `FORGE_TARGET_WORKSPACE_SEED=${agentWorkspaceSeedRoot}`,
    ...args.slice(1),
  ];
  const server: StdioServerParameters = {
    ...invocation.server,
    args: hardenedArgs,
  };
  const pathMappings = invocation.pathMappings.map((mapping) =>
    mapping.containerPrefix === profile.containerWorkspace
      ? { ...mapping, containerPrefix: agentWorkspaceSeedRoot }
      : mapping,
  );
  return { ...invocation, server, pathMappings };
}
