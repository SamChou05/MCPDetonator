import { execFile, spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { TargetConfigV1 } from "../config.js";
import type { EvidenceStore } from "../evidence-store.js";
import { mountPathMappings } from "../observe/path-mappings.js";
import type { PreparedTarget } from "../target/prepare.js";
import type { ObservedPathMapping } from "../observe/strace-normalizer.js";
import type { MaterializedDeveloperProfile } from "./profile.js";

const execFileAsync = promisify(execFile);

export const defaultSandboxImage = "forge-sandbox:dev";
/** Maximum bytes buffered for one raw JSON-RPC stdio message by the MCP SDK. */
export const MCP_STDIO_MESSAGE_BUFFER_BYTES = 1_000_000;
const managedCleanupChecks = 3;
const managedCleanupSettlementMs = 50;
const managedInspectTimeoutMs = 5_000;
const managedRemoveTimeoutMs = 10_000;

export interface DockerMcpInvocation {
  readonly containerName: string;
  readonly runId: string;
  readonly server: StdioServerParameters;
  readonly pathMappings: readonly ObservedPathMapping[];
}

interface DockerCommandResult {
  readonly stdout: string;
}

type DockerCommandRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<DockerCommandResult>;

interface ManagedContainerCleanupOptions {
  /** Test seam; production callers use the bounded Docker CLI runner. */
  readonly runDocker?: DockerCommandRunner;
  readonly checks?: number;
  readonly inspectTimeoutMs?: number;
  readonly removeTimeoutMs?: number;
  readonly settle?: () => Promise<void>;
}

export class ManagedContainerCleanupError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManagedContainerCleanupError";
  }
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

function textField(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return undefined;
}

function dockerErrorText(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const candidate = error as {
    readonly message?: unknown;
    readonly stderr?: unknown;
    readonly stdout?: unknown;
  };
  return [candidate.message, candidate.stderr, candidate.stdout]
    .map(textField)
    .filter((value): value is string => value !== undefined)
    .join("\n");
}

function containerDoesNotExist(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly exitCode?: unknown;
    readonly status?: unknown;
  };
  if (
    [candidate.code, candidate.exitCode, candidate.status].some(
      (value) => value === 0 || value === "0",
    )
  ) {
    return false;
  }
  const diagnostic = dockerErrorText(error).replace(/\r\n?/gu, "\n");
  return diagnostic.split("\n").some((line) =>
    /^\s*(?:docker:\s*)?error(?:\s+response\s+from\s+daemon)?\s*:\s*no\s+such\s+(?:object|container)(?::|\s|$)/iu.test(
      line,
    ),
  );
}

async function defaultManagedDockerRunner(
  args: readonly string[],
  timeoutMs: number,
): Promise<DockerCommandResult> {
  const { stdout } = await execFileAsync("docker", [...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 64_000,
  });
  return { stdout };
}

async function withinDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  try {
    return await Promise.race([
      operation,
      delay(timeoutMs, undefined, { signal: controller.signal }).then(() => {
        throw new Error(`${label} timed out after ${timeoutMs} ms`);
      }),
    ]);
  } finally {
    controller.abort();
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

export async function sandboxImageId(
  image = defaultSandboxImage,
): Promise<`sha256:${string}`> {
  const { stdout } = await execFileAsync(
    "docker",
    ["image", "inspect", image, "--format", "{{.Id}}"],
    { encoding: "utf8" },
  );
  const imageId = stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
    throw new Error(`Docker returned an invalid image ID for '${image}': ${imageId}`);
  }
  return imageId as `sha256:${string}`;
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

  const pathMappings = (
    await Promise.all([
      mountPathMappings(profile.hostHome, profile.containerHome),
      mountPathMappings(profile.hostWorkspace, profile.containerWorkspace),
      mountPathMappings(
        preparedTarget.hostRoot,
        preparedTarget.containerRoot,
      ),
    ])
  ).flat();

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
      maxBufferSize: MCP_STDIO_MESSAGE_BUFFER_BYTES,
    },
    pathMappings,
  };
}

export async function removeManagedContainer(
  containerName: string,
  expectedRunId: string,
  options: ManagedContainerCleanupOptions = {},
): Promise<void> {
  const runDocker = options.runDocker ?? defaultManagedDockerRunner;
  const checks = options.checks ?? managedCleanupChecks;
  const inspectTimeout = options.inspectTimeoutMs ?? managedInspectTimeoutMs;
  const removeTimeout = options.removeTimeoutMs ?? managedRemoveTimeoutMs;
  const settle = options.settle ?? (() => delay(managedCleanupSettlementMs));
  if (!Number.isSafeInteger(checks) || checks <= 0) {
    throw new ManagedContainerCleanupError(
      "managed-container cleanup checks must be positive",
    );
  }

  const inspect = async (): Promise<
    | { readonly state: "absent" }
    | { readonly state: "present"; readonly runId: string }
  > => {
    try {
      const result = await withinDeadline(
        runDocker(
          [
            "container",
            "inspect",
            "--format",
            '{{ index .Config.Labels "forge.run_id" }}',
            containerName,
          ],
          inspectTimeout,
        ),
        inspectTimeout,
        "Docker container inspect",
      );
      return { state: "present", runId: result.stdout.trim() };
    } catch (error) {
      if (containerDoesNotExist(error)) return { state: "absent" };
      throw new ManagedContainerCleanupError(
        `could not verify cleanup of container '${containerName}'`,
        { cause: error },
      );
    }
  };

  let consecutiveAbsenceChecks = 0;
  let removalAttempts = 0;
  while (consecutiveAbsenceChecks < checks) {
    const observed = await inspect();
    if (observed.state === "absent") {
      consecutiveAbsenceChecks += 1;
    } else {
      consecutiveAbsenceChecks = 0;
      if (observed.runId !== expectedRunId) {
        throw new ManagedContainerCleanupError(
          `refusing to remove container '${containerName}' because its Forge run label does not match`,
        );
      }
      if (removalAttempts >= checks) {
        throw new ManagedContainerCleanupError(
          `container '${containerName}' still exists after cleanup`,
        );
      }
      removalAttempts += 1;
      try {
        await withinDeadline(
          runDocker(
            ["container", "rm", "--force", "--volumes", containerName],
            removeTimeout,
          ),
          removeTimeout,
          "Docker container removal",
        );
      } catch (error) {
        if (!containerDoesNotExist(error)) {
          throw new ManagedContainerCleanupError(
            `could not remove container '${containerName}'`,
            { cause: error },
          );
        }
      }
    }
    if (consecutiveAbsenceChecks < checks) await settle();
  }
}
