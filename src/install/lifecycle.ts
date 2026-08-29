import { spawn } from "node:child_process";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import type { TargetConfigV1 } from "../config.js";
import {
  phaseV1Schema,
  type PhaseV1,
} from "../contracts/v1.js";
import type { EvidenceStore } from "../evidence-store.js";
import type { ObservedPathMapping } from "../observe/strace-normalizer.js";
import { removeManagedContainer } from "../sandbox/docker.js";
import {
  createDeveloperProfileSeed,
  materializeDeveloperProfile,
  type DeveloperProfileSeed,
  type MaterializedDeveloperProfile,
} from "../sandbox/profile.js";
import type { PreparedTarget } from "../target/prepare.js";

const installContainerRoot = "/opt/target" as const;
const installCacheRoot = "/npm-cache" as const;
const maximumLogBytes = 2_000_000;

export type InstallLifecycleMode = "scripts-disabled" | "scripts-enabled";

export interface InstallProcessOutcome {
  readonly status: "completed" | "failed" | "timed_out";
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  readonly error?: string;
}

export interface InstallContainerInvocation {
  readonly runId: string;
  readonly experimentId: string;
  readonly mode: InstallLifecycleMode;
  readonly containerName: string;
  readonly dockerArgs: readonly string[];
  readonly timeoutMs: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export type InstallContainerRunner = (
  invocation: InstallContainerInvocation,
) => Promise<InstallProcessOutcome>;

export interface InstallLifecycleExperiment {
  readonly mode: InstallLifecycleMode;
  readonly experimentId: string;
  readonly hostRoot: string;
  readonly hostPackageRoot: string;
  readonly hostNpmCache: string;
  readonly containerRoot: typeof installContainerRoot;
  readonly containerPackageRoot: string;
  readonly profile: MaterializedDeveloperProfile;
  readonly pathMappings: readonly ObservedPathMapping[];
  readonly phase: PhaseV1;
  readonly outcome: InstallProcessOutcome;
  readonly rawDirectory: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly metadataPath: string;
}

export interface InstallLifecycleObservation {
  readonly experiments: readonly [
    InstallLifecycleExperiment,
    InstallLifecycleExperiment,
  ];
  readonly scriptsDisabled: InstallLifecycleExperiment;
  readonly scriptsEnabled: InstallLifecycleExperiment;
  readonly phases: readonly PhaseV1[];
  readonly pathMappingsByExperiment: ReadonlyMap<
    string,
    readonly ObservedPathMapping[]
  >;
  dispose(): Promise<void>;
}

export interface InstallLifecycleDependencies {
  readonly runContainer?: InstallContainerRunner;
  readonly now?: () => Date;
}

const installProcessRecordSchema = z
  .object({
    schema: z.literal("forge.install-process/v1"),
    runId: z.string().min(1),
    experimentId: z.string().min(1),
    mode: z.enum(["scripts-disabled", "scripts-enabled"]),
    command: z.array(z.string().min(1)),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
    outcome: z
      .object({
        status: z.enum(["completed", "failed", "timed_out"]),
        exitCode: z.number().int().optional(),
        signal: z.string().min(1).optional(),
        error: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

function safeDockerToken(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  if (sanitized.length === 0) {
    throw new Error("cannot create an empty Docker resource name");
  }
  return sanitized.slice(0, 48);
}

function assertMountSafe(path: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`Docker bind path must be absolute: ${path}`);
  }
  if (path.includes(",")) {
    throw new Error(`Docker bind path contains an unsupported comma: ${path}`);
  }
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

/**
 * The two commands intentionally differ only in lifecycle-script policy.
 * All artifact resolution is offline and uses the isolated cache mount.
 */
export function npmCiArguments(mode: InstallLifecycleMode): readonly string[] {
  return [
    "ci",
    "--offline=true",
    `--ignore-scripts=${mode === "scripts-disabled" ? "true" : "false"}`,
    `--cache=${installCacheRoot}`,
    "--omit=dev",
    "--audit=false",
    "--fund=false",
    "--package-lock=true",
  ];
}

export function createInstallContainerInvocation(options: {
  readonly runId: string;
  readonly experimentId: string;
  readonly mode: InstallLifecycleMode;
  readonly config: TargetConfigV1;
  readonly image: string;
  readonly rawDirectory: string;
  readonly hostInstallRoot: string;
  readonly hostNpmCache: string;
  readonly profile: MaterializedDeveloperProfile;
}): {
  readonly invocation: InstallContainerInvocation;
  readonly pathMappings: readonly ObservedPathMapping[];
} {
  for (const path of [
    options.rawDirectory,
    options.hostInstallRoot,
    options.hostNpmCache,
    options.profile.hostHome,
    options.profile.hostWorkspace,
  ]) {
    assertMountSafe(path);
  }

  const containerName = `forge-${safeDockerToken(options.runId)}-${safeDockerToken(options.experimentId)}`;
  const limits = options.config.sandbox.limits;
  const command = ["npm", ...npmCiArguments(options.mode)];
  const dockerArgs = [
    "run",
    "--rm",
    "--name",
    containerName,
    "--label",
    "forge.managed=true",
    "--label",
    `forge.run_id=${options.runId}`,
    "--label",
    `forge.experiment_id=${options.experimentId}`,
    "--label",
    "forge.phase=install",
    "--label",
    `forge.lifecycle_scripts=${options.mode}`,
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
    `type=bind,src=${options.rawDirectory},dst=/evidence/raw`,
    "--mount",
    `type=bind,src=${options.profile.hostHome},dst=${options.profile.containerHome}`,
    "--mount",
    `type=bind,src=${options.profile.hostWorkspace},dst=${options.profile.containerWorkspace}`,
    "--mount",
    `type=bind,src=${options.hostInstallRoot},dst=${installContainerRoot}`,
    "--mount",
    `type=bind,src=${options.hostNpmCache},dst=${installCacheRoot}`,
    "--env",
    "FORGE_EVIDENCE_DIR=/evidence/raw",
    "--env",
    `FORGE_TARGET_HOME=${options.profile.containerHome}`,
    "--env",
    `FORGE_TARGET_WORKSPACE=${options.profile.containerWorkspace}`,
    "--env",
    `FORGE_TARGET_ROOT=${installContainerRoot}`,
    "--env",
    `FORGE_TARGET_CWD=${installContainerRoot}`,
    options.image,
    ...command,
  ];

  return {
    invocation: {
      runId: options.runId,
      experimentId: options.experimentId,
      mode: options.mode,
      containerName,
      dockerArgs,
      timeoutMs: limits.installTimeoutMs,
      stdoutPath: resolve(options.rawDirectory, "npm-stdout.log"),
      stderrPath: resolve(options.rawDirectory, "npm-stderr.log"),
    },
    pathMappings: [
      ...mountPathMappings(
        options.profile.hostHome,
        options.profile.containerHome,
      ),
      ...mountPathMappings(
        options.profile.hostWorkspace,
        options.profile.containerWorkspace,
      ),
      ...mountPathMappings(options.hostInstallRoot, installContainerRoot),
      ...mountPathMappings(options.hostNpmCache, installCacheRoot),
    ],
  };
}

function captureBounded(
  chunks: Buffer[],
  state: { size: number; truncated: boolean },
  chunk: Buffer,
): void {
  const remaining = maximumLogBytes - state.size;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  const captured = chunk.subarray(0, remaining);
  chunks.push(captured);
  state.size += captured.length;
  if (captured.length < chunk.length) {
    state.truncated = true;
  }
}

async function writeCapturedLog(
  path: string,
  chunks: readonly Buffer[],
  truncated: boolean,
): Promise<void> {
  const suffix = truncated
    ? Buffer.from("\n[forge: output truncated at 2000000 bytes]\n", "utf8")
    : Buffer.alloc(0);
  await writeFile(path, Buffer.concat([...chunks, suffix]), { mode: 0o600 });
}

export const runInstallContainer: InstallContainerRunner = async (
  invocation,
) => {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutState = { size: 0, truncated: false };
  const stderrState = { size: 0, truncated: false };
  let timedOut = false;
  let cleanupError: string | undefined;
  let timeoutCleanup: Promise<void> | undefined;

  const child = spawn("docker", [...invocation.dockerArgs], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  child.stdout.on("data", (chunk: Buffer) =>
    captureBounded(stdoutChunks, stdoutState, chunk),
  );
  child.stderr.on("data", (chunk: Buffer) =>
    captureBounded(stderrChunks, stderrState, chunk),
  );

  const timeout = setTimeout(() => {
    timedOut = true;
    timeoutCleanup = removeManagedContainer(
      invocation.containerName,
      invocation.runId,
    ).catch((error: unknown) => {
      cleanupError = error instanceof Error ? error.message : String(error);
    });
    child.kill("SIGTERM");
  }, invocation.timeoutMs);

  let processResult:
    | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
    | { readonly error: Error };
  try {
    processResult = await new Promise((resolveRun) => {
      let settled = false;
      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          resolveRun({ error });
        }
      });
      // `close` fires after the stdio streams close, so the evidence logs do
      // not lose output buffered after process exit.
      child.once("close", (code, signal) => {
        if (!settled) {
          settled = true;
          resolveRun({ code, signal });
        }
      });
    });
  } finally {
    clearTimeout(timeout);
    await timeoutCleanup;
    await removeManagedContainer(invocation.containerName, invocation.runId).catch(
      (error: unknown) => {
        cleanupError ??=
          error instanceof Error ? error.message : String(error);
      },
    );
    await Promise.all([
      writeCapturedLog(
        invocation.stdoutPath,
        stdoutChunks,
        stdoutState.truncated,
      ),
      writeCapturedLog(
        invocation.stderrPath,
        stderrChunks,
        stderrState.truncated,
      ),
    ]);
  }

  if (timedOut) {
    return {
      status: "timed_out",
      ...(cleanupError === undefined ? {} : { error: cleanupError }),
    };
  }
  if ("error" in processResult) {
    return { status: "failed", error: processResult.error.message };
  }
  if (processResult.code === 0) {
    return { status: "completed", exitCode: 0 };
  }
  return {
    status: "failed",
    ...(processResult.code === null ? {} : { exitCode: processResult.code }),
    ...(processResult.signal === null ? {} : { signal: processResult.signal }),
    ...(cleanupError === undefined ? {} : { error: cleanupError }),
  };
};

async function makeTreeWritable(root: string): Promise<void> {
  async function visit(path: string): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      return;
    }
    if (stat.isDirectory()) {
      await chmod(path, 0o777);
      const entries = await readdir(path);
      for (const entry of entries) {
        await visit(join(path, entry));
      }
      return;
    }
    if (stat.isFile()) {
      await chmod(path, stat.mode | 0o222);
    }
  }

  await visit(root);
}

async function copyInstallInput(
  sourceRoot: string,
  installRoot: string,
): Promise<void> {
  await cp(sourceRoot, installRoot, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    filter: (sourcePath) => {
      const name = basename(sourcePath);
      return name !== "node_modules" && name !== ".git";
    },
  });
  await makeTreeWritable(installRoot);
}

function phaseFor(options: {
  readonly runId: string;
  readonly experimentId: string;
  readonly mode: InstallLifecycleMode;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: InstallProcessOutcome;
}): PhaseV1 {
  return phaseV1Schema.parse({
    schema: "forge.phase/v1",
    phaseId: `${options.experimentId}-install-1`,
    runId: options.runId,
    experimentId: options.experimentId,
    kind: "install",
    name:
      options.mode === "scripts-enabled"
        ? "npm ci with lifecycle scripts enabled"
        : "npm ci with lifecycle scripts disabled",
    startedAt: options.startedAt,
    endedAt: options.endedAt,
    status: options.outcome.status,
  });
}

function packageRelativePath(preparedTarget: PreparedTarget): string {
  const path = relative(preparedTarget.hostRoot, preparedTarget.packageRoot);
  if (path.startsWith("..") || isAbsolute(path)) {
    throw new Error("prepared package root escapes the prepared target root");
  }
  return path;
}

/**
 * Observe the consumer-visible npm install lifecycle using a controlled A/B
 * comparison. The same prepared source and cache seed both experiments; only
 * npm's lifecycle-script policy changes.
 */
export async function observeInstallLifecycle(options: {
  readonly runId: string;
  readonly store: EvidenceStore;
  readonly config: TargetConfigV1;
  readonly preparedTarget: PreparedTarget;
  readonly image: string;
  readonly profileSeed?: DeveloperProfileSeed;
  readonly dependencies?: InstallLifecycleDependencies;
}): Promise<InstallLifecycleObservation> {
  const sourceCache = options.preparedTarget.hostNpmCache;
  if (sourceCache === undefined) {
    throw new Error(
      "install lifecycle observation requires a prepared npm cache",
    );
  }
  await access(resolve(options.preparedTarget.hostRoot, "package-lock.json"));
  await access(sourceCache);

  // Resolve platform aliases (for example macOS /var -> /private/var) before
  // building Docker Desktop path mappings. strace reports the real mount path.
  const temporaryRoot = await realpath(
    await mkdtemp(join(tmpdir(), "forge-install-lifecycle-")),
  );
  const runContainer =
    options.dependencies?.runContainer ?? runInstallContainer;
  const now = options.dependencies?.now ?? (() => new Date());
  const profileSeed =
    options.profileSeed ?? createDeveloperProfileSeed();
  const packagePath = packageRelativePath(options.preparedTarget);
  const modes: readonly InstallLifecycleMode[] = [
    "scripts-disabled",
    "scripts-enabled",
  ];

  try {
    const prepared = await Promise.all(
      modes.map(async (mode) => {
        const experimentId = `install-${mode}`;
        const experimentRoot = resolve(temporaryRoot, experimentId);
        const hostInstallRoot = resolve(experimentRoot, "target");
        const hostNpmCache = resolve(experimentRoot, "npm-cache");
        const rawDirectory = options.store.pathFor(`raw/${experimentId}`);
        await mkdir(experimentRoot, { recursive: true, mode: 0o755 });
        await mkdir(rawDirectory, { recursive: true, mode: 0o777 });
        await chmod(rawDirectory, 0o777);
        await Promise.all([
          copyInstallInput(
            options.preparedTarget.hostRoot,
            hostInstallRoot,
          ),
          cp(sourceCache, hostNpmCache, {
            recursive: true,
            force: true,
            verbatimSymlinks: true,
          }).then(() => makeTreeWritable(hostNpmCache)),
        ]);
        const profile = await materializeDeveloperProfile(
          options.store,
          experimentId,
          profileSeed,
        );
        const built = createInstallContainerInvocation({
          runId: options.runId,
          experimentId,
          mode,
          config: options.config,
          image: options.image,
          rawDirectory,
          hostInstallRoot,
          hostNpmCache,
          profile,
        });
        await Promise.all([
          writeFile(built.invocation.stdoutPath, "", { mode: 0o600 }),
          writeFile(built.invocation.stderrPath, "", { mode: 0o600 }),
        ]);
        return {
          mode,
          experimentId,
          hostInstallRoot,
          hostNpmCache,
          rawDirectory,
          profile,
          ...built,
        };
      }),
    );

    const experiments: InstallLifecycleExperiment[] = [];
    for (const experiment of prepared) {
      const startedAt = now().toISOString();
      let outcome: InstallProcessOutcome;
      try {
        outcome = await runContainer(experiment.invocation);
      } catch (error) {
        outcome = {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const endedAt = now().toISOString();
      const phase = phaseFor({
        runId: options.runId,
        experimentId: experiment.experimentId,
        mode: experiment.mode,
        startedAt,
        endedAt,
        outcome,
      });
      await options.store.appendJsonl("phases.jsonl", phaseV1Schema, phase);
      const metadataPath = options.store.pathFor(
        `raw/${experiment.experimentId}/install.json`,
      );
      await options.store.writeJson(
        `raw/${experiment.experimentId}/install.json`,
        installProcessRecordSchema,
        {
          schema: "forge.install-process/v1",
          runId: options.runId,
          experimentId: experiment.experimentId,
          mode: experiment.mode,
          command: ["npm", ...npmCiArguments(experiment.mode)],
          startedAt,
          endedAt,
          outcome,
        },
      );
      experiments.push({
        mode: experiment.mode,
        experimentId: experiment.experimentId,
        hostRoot: experiment.hostInstallRoot,
        hostPackageRoot:
          packagePath.length === 0
            ? experiment.hostInstallRoot
            : resolve(experiment.hostInstallRoot, packagePath),
        hostNpmCache: experiment.hostNpmCache,
        containerRoot: installContainerRoot,
        containerPackageRoot:
          options.preparedTarget.provenance.containerPackageRoot,
        profile: experiment.profile,
        pathMappings: experiment.pathMappings,
        phase,
        outcome,
        rawDirectory: experiment.rawDirectory,
        stdoutPath: experiment.invocation.stdoutPath,
        stderrPath: experiment.invocation.stderrPath,
        metadataPath,
      });
    }

    const scriptsDisabled = experiments.find(
      (experiment) => experiment.mode === "scripts-disabled",
    );
    const scriptsEnabled = experiments.find(
      (experiment) => experiment.mode === "scripts-enabled",
    );
    if (scriptsDisabled === undefined || scriptsEnabled === undefined) {
      throw new Error("install lifecycle experiment set is incomplete");
    }

    return {
      experiments: [scriptsDisabled, scriptsEnabled],
      scriptsDisabled,
      scriptsEnabled,
      phases: experiments.map((experiment) => experiment.phase),
      pathMappingsByExperiment: new Map(
        experiments.map((experiment) => [
          experiment.experimentId,
          experiment.pathMappings,
        ]),
      ),
      dispose: async () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
}
