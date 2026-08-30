import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { ExecutionBoundsV2 } from "../../contracts/v2/index.js";
import {
  MCP_STDIO_MESSAGE_BUFFER_BYTES,
  sandboxImageId,
  type DockerMcpInvocation,
} from "../../sandbox/docker.js";
import type { PreparedTarget } from "../../target/prepare.js";
import { verifyArtifactReference } from "./artifacts.js";
import { digestCanonicalJson } from "./canonical.js";
import type { CompiledExperimentPlanV2 } from "./compile.js";
import {
  CONTROLLED_SANDBOX_IMAGE_ID,
  CONTROLLED_SANDBOX_IMAGE_REFERENCE,
} from "./controlled-fixture.js";
import type { ControlledBackendCapabilities } from "./reference-monitor.js";
import type { RuntimeDescriptorV2 } from "./target.js";

const execFileAsync = promisify(execFile);

export const controlledSyntheticContainerRoot = "/forge/synthetic" as const;

export interface MaterializedControlledResources {
  readonly hostRoot: string;
  readonly manifestDigest: string;
  verify(): Promise<string>;
  dispose(): Promise<void>;
}

export interface VerifiedControlledSandboxImage {
  readonly imageReference: typeof CONTROLLED_SANDBOX_IMAGE_REFERENCE;
  readonly imageId: typeof CONTROLLED_SANDBOX_IMAGE_ID;
  readonly declaredVolumes: false;
}

/**
 * Verify the exact reviewed image before any V2 target process is admitted.
 * The dedicated mutable tag is only a lookup convenience: execution uses the
 * returned immutable ID, and an unexpected rebuild fails closed.
 */
export async function verifyPinnedControlledSandboxImage(): Promise<VerifiedControlledSandboxImage> {
  const imageId = await sandboxImageId(CONTROLLED_SANDBOX_IMAGE_REFERENCE);
  if (imageId !== CONTROLLED_SANDBOX_IMAGE_ID) {
    throw new Error(
      "controlled sandbox image differs from the reviewed image trust anchor",
    );
  }
  const { stdout } = await execFileAsync(
    "docker",
    ["image", "inspect", imageId],
    {
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 256_000,
    },
  );
  const inspected = JSON.parse(stdout) as unknown;
  if (!Array.isArray(inspected) || inspected.length !== 1) {
    throw new Error("controlled sandbox image inspection was ambiguous");
  }
  const image = inspected[0] as
    | {
        readonly Id?: unknown;
        readonly Os?: unknown;
        readonly Config?: { readonly Volumes?: unknown } | null;
      }
    | undefined;
  const volumes = image?.Config?.Volumes;
  if (
    image?.Id !== imageId ||
    image.Os !== "linux" ||
    (volumes !== undefined &&
      volumes !== null &&
      (typeof volumes !== "object" ||
        Array.isArray(volumes) ||
        Object.keys(volumes).length !== 0))
  ) {
    throw new Error(
      "controlled sandbox image has an unapproved platform, identity, or declared writable volume",
    );
  }
  return Object.freeze({
    imageReference: CONTROLLED_SANDBOX_IMAGE_REFERENCE,
    imageId: CONTROLLED_SANDBOX_IMAGE_ID,
    declaredVolumes: false as const,
  });
}

function safeDockerToken(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_.-]/gu, "-");
  if (sanitized.length === 0) throw new Error("Docker token cannot be empty");
  return sanitized.slice(0, 48);
}

function assertMountPath(path: string): void {
  if (path.includes(",")) {
    throw new Error(`controlled Docker bind path contains a comma: ${path}`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

/** Materialize exact compiler-owned synthetic bytes into a private read-only tree. */
export async function materializeControlledSyntheticResources(
  compiled: CompiledExperimentPlanV2,
): Promise<MaterializedControlledResources> {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "forge-controlled-resources-"),
  );
  const hostRoot = join(temporaryRoot, "resources");
  await chmod(temporaryRoot, 0o755);
  await mkdir(hostRoot, { mode: 0o755 });

  try {
    for (const instance of compiled.resources.manifest.instances) {
      const expected = compiled.resources.bytesByResourceId.get(
        instance.resourceId,
      );
      if (expected === undefined) {
        throw new Error(
          `compiler omitted bytes for synthetic resource '${instance.resourceId}'`,
        );
      }
      const destination = join(hostRoot, instance.resourceId);
      await writeFile(destination, expected, { flag: "wx", mode: 0o444 });
      await chmod(destination, 0o444);
    }
    await chmod(hostRoot, 0o555);
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }

  const manifestDigest = digestCanonicalJson(
    "forge.synthetic-resource-manifest",
    "v2",
    compiled.resources.manifest,
  );
  if (manifestDigest !== compiled.plan.syntheticResourceManifestDigest) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw new Error("compiled synthetic resource manifest digest changed");
  }

  const verify = async (): Promise<string> => {
    const expectedNames = compiled.resources.manifest.instances
      .map((instance) => instance.resourceId)
      .sort();
    const entries = await readdir(hostRoot, { withFileTypes: true });
    const actualNames = entries.map((entry) => entry.name).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      throw new Error("mounted synthetic resource set changed");
    }
    for (const instance of compiled.resources.manifest.instances) {
      const path = join(hostRoot, instance.resourceId);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(
          `synthetic resource '${instance.resourceId}' is not a regular file`,
        );
      }
      const actual = await readFile(path);
      verifyArtifactReference(instance.artifact, actual);
      const compilerBytes = compiled.resources.bytesByResourceId.get(
        instance.resourceId,
      );
      if (compilerBytes === undefined || !equalBytes(actual, compilerBytes)) {
        throw new Error(
          `synthetic resource '${instance.resourceId}' differs from compiler bytes`,
        );
      }
    }
    return manifestDigest;
  };
  const dispose = async (): Promise<void> => {
    // The mounted directory is intentionally non-writable during execution;
    // restore owner write permission only after verified container cleanup.
    await chmod(hostRoot, 0o755).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  };
  await verify();
  return Object.freeze({
    hostRoot,
    manifestDigest,
    verify,
    dispose,
  });
}

export interface ControlledDockerInvocation extends DockerMcpInvocation {
  readonly backend: Readonly<ControlledBackendCapabilities>;
}

/**
 * Build the only V2 execution backend currently admitted: an exact controlled
 * fixture with no writable host bind, no network, read-only inputs/rootfs,
 * kernel resource ceilings, one controller call, and no provider interface.
 */
export function createControlledDockerInvocation(options: {
  readonly runId: string;
  readonly experimentId: string;
  readonly preparedTarget: PreparedTarget;
  readonly resources: MaterializedControlledResources;
  readonly runtime: RuntimeDescriptorV2;
  readonly bounds: ExecutionBoundsV2;
  readonly imageId: string;
}): ControlledDockerInvocation {
  const { bounds, preparedTarget, resources, runtime } = options;
  if (
    runtime.command !== "node" ||
    runtime.args.length !== 1 ||
    runtime.args[0] !== "/opt/target/server.js" ||
    runtime.cwd !== "/opt/target" ||
    Object.keys(runtime.environment).length !== 0
  ) {
    throw new Error(
      "controlled sandbox rejected an unknown runtime descriptor",
    );
  }
  if (bounds.maxCpuMs % 1_000 !== 0) {
    throw new Error("controlled sandbox requires whole-second CPU bounds");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(options.imageId)) {
    throw new Error("controlled sandbox requires an immutable image ID");
  }
  assertMountPath(preparedTarget.hostRoot);
  assertMountPath(resources.hostRoot);

  // The nonce prevents two same-runId callers from sharing a Docker name and
  // accidentally treating one another's container as cleanup-owned state.
  const instanceToken = randomBytes(12).toString("hex");
  const containerName = `forge-${safeDockerToken(options.runId)}-${safeDockerToken(options.experimentId)}-${instanceToken}`;
  const backend: ControlledBackendCapabilities = Object.freeze({
    executionClass: "controlled_fixture_only",
    network: "none",
    maxCalls: 1,
    maxRetries: 0,
    resultExposure: "local_quarantine_only",
    sandboxImageId: options.imageId,
    imageHasDeclaredVolumes: false,
    hardMcpMessageBytes: MCP_STDIO_MESSAGE_BUFFER_BYTES,
    hardRuntimeMs: bounds.maxCaseRuntimeMs,
    hardWritableBytes: bounds.maxWritableBytes,
    hardWritableFiles: bounds.maxWritableFiles,
    hardFileBytes: bounds.maxFileBytes,
    hardProcesses: bounds.maxProcesses,
    hardMemoryMb: bounds.maxMemoryMb,
    hardCpuMs: bounds.maxCpuMs,
    hardOpenFiles: bounds.maxOpenFiles,
    readonlyTargetMount: true,
    readonlySyntheticResourceMount: true,
    readonlyMessageQueueMount: true,
    writableRootFilesystem: false,
    writableHostBinds: false,
    providerAvailable: false,
    cleanupVerification: true,
  });

  const args = [
    "run",
    "--interactive",
    "--name",
    containerName,
    "--label",
    "forge.managed=true",
    "--label",
    `forge.run_id=${options.runId}`,
    "--label",
    `forge.experiment_id=${options.experimentId}`,
    "--hostname",
    "forge-controlled-target",
    "--network",
    "none",
    "--ipc",
    "none",
    "--log-driver",
    "none",
    "--pull",
    "never",
    "--read-only",
    "--init",
    "--user",
    "65534:65534",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(bounds.maxProcesses),
    "--memory",
    `${bounds.maxMemoryMb}m`,
    "--memory-swap",
    `${bounds.maxMemoryMb}m`,
    "--cpus",
    "1",
    "--ulimit",
    `cpu=${bounds.maxCpuMs / 1_000}:${bounds.maxCpuMs / 1_000}`,
    "--ulimit",
    `fsize=${bounds.maxFileBytes}:${bounds.maxFileBytes}`,
    "--ulimit",
    `nofile=${bounds.maxOpenFiles}:${bounds.maxOpenFiles}`,
    "--ulimit",
    "core=0:0",
    "--stop-timeout",
    "2",
    "--tmpfs",
    "/dev/mqueue:ro,noexec,nosuid,nodev,size=4096,nr_inodes=1,mode=0555",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${bounds.maxWritableBytes},nr_inodes=${bounds.maxWritableFiles},uid=65534,gid=65534,mode=0700`,
    "--mount",
    `type=bind,src=${preparedTarget.hostRoot},dst=${preparedTarget.containerRoot},readonly`,
    "--mount",
    `type=bind,src=${resources.hostRoot},dst=${controlledSyntheticContainerRoot},readonly`,
    "--workdir",
    runtime.cwd,
    "--entrypoint",
    "/usr/bin/env",
    options.imageId,
    "-i",
    "HOME=/tmp",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "NODE_ENV=production",
    "/usr/local/bin/node",
    ...runtime.args,
  ];
  const server: StdioServerParameters = {
    command: "docker",
    args,
    stderr: "pipe",
    maxBufferSize: MCP_STDIO_MESSAGE_BUFFER_BYTES,
  };
  return Object.freeze({
    containerName,
    runId: options.runId,
    server,
    pathMappings: [],
    backend,
  });
}
