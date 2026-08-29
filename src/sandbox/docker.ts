import { execFile, spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { TargetConfigV1 } from "../config.js";
import type { EvidenceStore } from "../evidence-store.js";
import type { PreparedTarget } from "../target/prepare.js";
import type { ObservedPathMapping } from "../observe/strace-normalizer.js";
import type { MaterializedDeveloperProfile } from "./profile.js";

const execFileAsync = promisify(execFile);

export const defaultSandboxImage = "forge-sandbox:dev";

export interface DockerMcpInvocation {
  readonly containerName: string;
  readonly runId: string;
  readonly server: StdioServerParameters;
  readonly pathMappings: readonly ObservedPathMapping[];
}

function mountPathMappings(
  hostPath: string,
  containerPath: string,
): ObservedPathMapping[] {
  return [
    { observedPrefix: hostPath, containerPrefix: containerPath },
    {
      observedPrefix: `/run/host_virtiofs${hostPath}`,
      containerPrefix: containerPath,
    },
  ];
}

function safeDockerToken(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  if (sanitized.length === 0) {
    throw new Error("cannot create an empty Docker resource name");
  }
  return sanitized.slice(0, 48);
}

function assertMountSafe(path: string): void {
  if (path.includes(",")) {
    throw new Error(`Docker bind path contains an unsupported comma: ${path}`);
  }
}

async function commandSucceeds(command: string, args: readonly string[]): Promise<boolean> {
  try {
    await execFileAsync(command, [...args], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

async function runVisible(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], {
      stdio: "inherit",
      shell: false,
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(
          new Error(
            `${command} exited with ${code ?? `signal ${signal ?? "unknown"}`}`,
          ),
        );
      }
    });
  });
}

export async function ensureDockerAvailable(): Promise<void> {
  if (!(await commandSucceeds("docker", ["info"]))) {
    throw new Error(
      "Docker is unavailable. Start Docker Desktop or configure a disposable Linux Docker worker.",
    );
  }
}

export async function ensureSandboxImage(
  projectRoot: string,
  image = defaultSandboxImage,
  rebuild = false,
): Promise<void> {
  await ensureDockerAvailable();

  if (!rebuild && (await commandSucceeds("docker", ["image", "inspect", image]))) {
    return;
  }

  await runVisible("docker", [
    "build",
    "--tag",
    image,
    "--file",
    resolve(projectRoot, "container", "Dockerfile"),
    projectRoot,
  ]);
}

export async function dockerVersion(): Promise<string> {
  const { stdout } = await execFileAsync(
    "docker",
    ["version", "--format", "{{.Server.Version}}"],
    { encoding: "utf8" },
  );
  return stdout.trim();
}

export async function imageStraceVersion(image = defaultSandboxImage): Promise<string> {
  const { stdout } = await execFileAsync(
    "docker",
    ["run", "--rm", "--entrypoint", "strace", image, "--version"],
    { encoding: "utf8" },
  );
  return stdout.split("\n")[0]?.trim() ?? "unknown";
}

export async function createDockerMcpInvocation(options: {
  readonly runId: string;
  readonly experimentId: string;
  readonly config: TargetConfigV1;
  readonly store: EvidenceStore;
  readonly profile: MaterializedDeveloperProfile;
  readonly preparedTarget: PreparedTarget;
  readonly image?: string;
}): Promise<DockerMcpInvocation> {
  const { runId, experimentId, config, store, profile, preparedTarget } = options;
  const image = options.image ?? defaultSandboxImage;
  const containerName = `forge-${safeDockerToken(runId)}-${safeDockerToken(experimentId)}`;
  const rawDirectory = store.pathFor(`raw/${experimentId}`);

  for (const path of [
    rawDirectory,
    profile.hostHome,
    profile.hostWorkspace,
    preparedTarget.hostRoot,
  ]) {
    assertMountSafe(path);
  }

  await mkdir(rawDirectory, { recursive: true, mode: 0o777 });
  await chmod(rawDirectory, 0o777);

  const limits = config.sandbox.limits;
  const runtime = config.target.runtime;
  const targetEnvironment = Object.entries(runtime.env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`);
  const args = [
    "run",
    "--interactive",
    "--name",
    containerName,
    "--label",
    "forge.managed=true",
    "--label",
    `forge.run_id=${runId}`,
    "--label",
    `forge.experiment_id=${experimentId}`,
    "--hostname",
    "forge-target",
    "--network",
    "none",
    "--pull",
    "never",
    "--read-only",
    "--init",
    "--cap-add",
    "SYS_PTRACE",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(limits.pids),
    "--memory",
    `${limits.memoryMb}m`,
    "--cpus",
    String(limits.cpus),
    "--stop-timeout",
    "2",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=16m",
    "--mount",
    `type=bind,src=${rawDirectory},dst=/evidence/raw`,
    "--mount",
    `type=bind,src=${profile.hostHome},dst=${profile.containerHome}`,
    "--mount",
    `type=bind,src=${profile.hostWorkspace},dst=${profile.containerWorkspace}`,
    "--mount",
    `type=bind,src=${preparedTarget.hostRoot},dst=${preparedTarget.containerRoot},readonly`,
    "--env",
    "FORGE_EVIDENCE_DIR=/evidence/raw",
    "--env",
    `FORGE_TARGET_HOME=${profile.containerHome}`,
    "--env",
    `FORGE_TARGET_WORKSPACE=${profile.containerWorkspace}`,
    "--env",
    `FORGE_TARGET_ROOT=${preparedTarget.containerRoot}`,
    "--env",
    `FORGE_TARGET_CWD=${runtime.cwd}`,
    image,
    ...targetEnvironment,
    runtime.command,
    ...runtime.args,
  ];

  return {
    containerName,
    runId,
    server: {
      command: "docker",
      args,
      stderr: "pipe",
      maxBufferSize: 1_000_000,
    },
    pathMappings: [
      ...mountPathMappings(profile.hostHome, profile.containerHome),
      ...mountPathMappings(profile.hostWorkspace, profile.containerWorkspace),
      ...mountPathMappings(
        preparedTarget.hostRoot,
        preparedTarget.containerRoot,
      ),
    ],
  };
}

export async function removeManagedContainer(
  containerName: string,
  expectedRunId: string,
): Promise<void> {
  let actualRunId: string;
  try {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "inspect",
        "--format",
        '{{ index .Config.Labels "forge.run_id" }}',
        containerName,
      ],
      { encoding: "utf8" },
    );
    actualRunId = stdout.trim();
  } catch {
    return;
  }

  if (actualRunId !== expectedRunId) {
    throw new Error(
      `refusing to remove container '${containerName}' because its Forge run label does not match`,
    );
  }

  await execFileAsync("docker", ["rm", "--force", "--volumes", containerName], {
    encoding: "utf8",
  });
}
