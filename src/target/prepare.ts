import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

import type { LoadedTargetConfig, TargetConfigV1 } from "../config.js";
import { resolveLocalSourcePath } from "../config.js";
import {
  targetProvenanceV1Schema,
  type TargetProvenanceV1,
} from "../contracts/v1.js";
import type { EvidenceStore } from "../evidence-store.js";
import { sha256, sha256File } from "../evidence-store.js";

export const targetContainerRoot = "/opt/target" as const;

export interface PreparedTarget {
  readonly hostRoot: string;
  readonly packageRoot: string;
  readonly hostNpmCache?: string;
  readonly containerRoot: typeof targetContainerRoot;
  readonly provenance: TargetProvenanceV1;
  dispose(): Promise<void>;
}

interface TreeDigest {
  readonly sha256: string;
  readonly fileCount: number;
}

const maxAcquisitionLogBytes = 2_000_000;
const defaultSigkillAfterMs = 500;
const defaultForceSettlementAfterMs = 1_000;
const defaultCleanupAttemptTimeoutMs = 2_000;
const execFileAsync = promisify(execFile);

export interface NpmInstallOptions {
  readonly image: string;
  readonly runId: string;
  readonly hostRoot: string;
  readonly hostNpmCache: string;
  readonly command: "ci" | "install";
  readonly store: EvidenceStore;
  readonly timeoutMs: number;
}

export interface NpmAcquisitionChildProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  onError(listener: (error: Error) => void): void;
  onClose(
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  terminate(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface NpmAcquisitionDependencies {
  spawnDocker(args: readonly string[]): NpmAcquisitionChildProcess;
  removeContainer(
    containerName: string,
    expectedRunId: string,
    timeoutMs: number,
  ): Promise<void>;
  readonly timing?: {
    readonly sigkillAfterMs?: number;
    readonly forceSettlementAfterMs?: number;
    readonly cleanupAttemptTimeoutMs?: number;
  };
}

export type NpmInstallRunner = (options: NpmInstallOptions) => Promise<void>;

export interface PrepareTargetDependencies {
  readonly runNpmInstall?: NpmInstallRunner;
}

export class NpmAcquisitionError extends Error {
  public constructor(
    message: string,
    readonly cleanupVerified: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NpmAcquisitionError";
  }
}

export class TargetPreparationCleanupError extends Error {
  public readonly cleanupVerified = false;

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TargetPreparationCleanupError";
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function digestTargetTree(
  root: string,
  options: { readonly includeNodeModules?: boolean } = {},
): Promise<TreeDigest> {
  const records: string[] = [];
  let fileCount = 0;

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        (!options.includeNodeModules && entry.name === "node_modules")
      ) {
        continue;
      }
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        records.push(`${relativePath}\0file\0${await sha256File(absolutePath)}`);
        fileCount += 1;
      } else if (entry.isSymbolicLink()) {
        records.push(`${relativePath}\0symlink\0${sha256(await readlink(absolutePath))}`);
        fileCount += 1;
      }
    }
  }

  await visit(root);
  return { sha256: sha256(records.join("\n")), fileCount };
}

function spawnAcquisitionDocker(args: readonly string[]): NpmAcquisitionChildProcess {
  const child = spawn("docker", [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    onError: (listener) => {
      child.once("error", listener);
    },
    onClose: (listener) => {
      child.once("close", listener);
    },
    terminate: (signal) => {
      child.kill(signal);
    },
  };
}

function commandTimedOut(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("killed" in error && error.killed === true) ||
      ("code" in error && error.code === "ETIMEDOUT"))
  );
}

function textField(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return undefined;
}

export function acquisitionContainerDoesNotExist(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly exitCode?: unknown;
    readonly status?: unknown;
    readonly message?: unknown;
    readonly stderr?: unknown;
    readonly stdout?: unknown;
  };
  if (
    [candidate.code, candidate.exitCode, candidate.status].some(
      (value) => value === 0 || value === "0",
    )
  ) {
    return false;
  }
  const diagnostic = [candidate.message, candidate.stderr, candidate.stdout]
    .map(textField)
    .filter((value): value is string => value !== undefined)
    .join("\n")
    .replace(/\r\n?/gu, "\n");
  return diagnostic.split("\n").some((line) =>
    /^\s*(?:docker:\s*)?error(?:\s+response\s+from\s+daemon)?\s*:\s*no\s+such\s+(?:object|container)(?::|\s|$)/iu.test(
      line,
    ),
  );
}

async function removeAcquisitionContainer(
  containerName: string,
  expectedRunId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const runDocker = async (args: readonly string[]) => {
    const remainingMs = Math.max(1, deadline - Date.now());
    return execFileAsync("docker", [...args], {
      encoding: "utf8",
      timeout: remainingMs,
      killSignal: "SIGKILL",
      maxBuffer: 64_000,
    });
  };

  let actualRunId: string;
  try {
    const { stdout } = await runDocker([
      "inspect",
      "--format",
      '{{ index .Config.Labels "forge.run_id" }}',
      containerName,
    ]);
    actualRunId = stdout.trim();
  } catch (error) {
    if (commandTimedOut(error)) {
      throw new Error(
        `timed out inspecting acquisition container '${containerName}'`,
      );
    }
    if (acquisitionContainerDoesNotExist(error)) return;
    throw new Error(
      `could not verify cleanup of acquisition container '${containerName}'`,
      { cause: error },
    );
  }

  if (actualRunId !== expectedRunId) {
    throw new Error(
      `refusing to remove container '${containerName}' because its Forge run label does not match`,
    );
  }

  try {
    await runDocker(["rm", "--force", "--volumes", containerName]);
  } catch (error) {
    if (commandTimedOut(error)) {
      throw new Error(`timed out removing acquisition container '${containerName}'`);
    }
    throw error;
  }
}

const defaultNpmAcquisitionDependencies: NpmAcquisitionDependencies = {
  spawnDocker: spawnAcquisitionDocker,
  removeContainer: removeAcquisitionContainer,
};

function captureBounded(
  chunks: Buffer[],
  state: { size: number; truncated: boolean },
  chunk: Buffer | string,
): void {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = maxAcquisitionLogBytes - state.size;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  chunks.push(buffer.subarray(0, remaining));
  state.size += Math.min(buffer.length, remaining);
  if (buffer.length > remaining) {
    state.truncated = true;
  }
}

async function writeAcquisitionLog(options: {
  readonly path: string;
  readonly chunks: readonly Buffer[];
  readonly truncated: boolean;
  readonly outcome?: string;
  readonly cleanupError?: string;
}): Promise<void> {
  const suffixes: Buffer[] = [];
  if (options.truncated) {
    suffixes.push(
      Buffer.from(
        `\n[forge: output truncated at ${maxAcquisitionLogBytes} bytes]\n`,
        "utf8",
      ),
    );
  }
  if (options.outcome !== undefined) {
    suffixes.push(Buffer.from(`\n[forge: ${options.outcome}]\n`, "utf8"));
  }
  if (options.cleanupError !== undefined) {
    suffixes.push(
      Buffer.from(`\n[forge: container cleanup failed: ${options.cleanupError}]\n`, "utf8"),
    );
  }
  await writeFile(options.path, Buffer.concat([...options.chunks, ...suffixes]), {
    mode: 0o600,
  });
}

export async function runNpmInstall(
  options: NpmInstallOptions,
  dependencies: NpmAcquisitionDependencies = defaultNpmAcquisitionDependencies,
): Promise<void> {
  assertMountSafe(options.hostRoot);
  assertMountSafe(options.hostNpmCache);
  const containerName = `forge-${safeDockerToken(options.runId)}-acquisition`;
  const logPath = options.store.pathFor("raw/acquisition/npm-install.log");
  await mkdir(resolve(logPath, ".."), { recursive: true });
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
    "forge.phase=acquisition",
    "--network",
    "bridge",
    "--pull",
    "never",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=256m",
    "--mount",
    `type=bind,src=${options.hostRoot},dst=/target`,
    "--mount",
    `type=bind,src=${options.hostNpmCache},dst=/npm-cache`,
    "--workdir",
    "/target",
    "--user",
    "65534:65534",
    "--env",
    "HOME=/tmp",
    "--env",
    "npm_config_cache=/npm-cache",
    "--entrypoint",
    "npm",
    options.image,
    options.command,
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--package-lock=true",
  ];
  const chunks: Buffer[] = [];
  const captureState = { size: 0, truncated: false };
  const sigkillAfterMs = Math.max(
    0,
    dependencies.timing?.sigkillAfterMs ?? defaultSigkillAfterMs,
  );
  const forceSettlementAfterMs = Math.max(
    sigkillAfterMs,
    dependencies.timing?.forceSettlementAfterMs ??
      defaultForceSettlementAfterMs,
  );
  const cleanupAttemptTimeoutMs = Math.max(
    1,
    dependencies.timing?.cleanupAttemptTimeoutMs ??
      defaultCleanupAttemptTimeoutMs,
  );
  let cleanupError: string | undefined;

  const cleanupContainer = async (): Promise<void> => {
    let cleanupTimeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      cleanupTimeout = setTimeout(
        () =>
          reject(
            new Error(
              `container cleanup timed out after ${cleanupAttemptTimeoutMs} ms`,
            ),
          ),
        cleanupAttemptTimeoutMs,
      );
    });
    try {
      await Promise.race([
        Promise.resolve().then(() =>
          dependencies.removeContainer(
            containerName,
            options.runId,
            cleanupAttemptTimeoutMs,
          ),
        ),
        timeoutPromise,
      ]);
      cleanupError = undefined;
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(cleanupTimeout);
    }
  };

  let child: NpmAcquisitionChildProcess;
  try {
    child = dependencies.spawnDocker(dockerArgs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cleanupContainer();
    await writeAcquisitionLog({
      path: logPath,
      chunks,
      truncated: false,
      outcome: `failed to start Docker: ${message}`,
      ...(cleanupError === undefined ? {} : { cleanupError }),
    });
    throw new NpmAcquisitionError(
      `sandboxed npm ${options.command} could not start: ${message}${cleanupError === undefined ? "" : `; container cleanup failed: ${cleanupError}`}`,
      cleanupError === undefined,
      { cause: error },
    );
  }

  child.stdout.on("data", (chunk: Buffer | string) =>
    captureBounded(chunks, captureState, chunk),
  );
  child.stderr.on("data", (chunk: Buffer | string) =>
    captureBounded(chunks, captureState, chunk),
  );

  let timedOut = false;
  let processError: Error | undefined;
  let timeoutCleanup: Promise<void> | undefined;
  let sigkillTimer: NodeJS.Timeout | undefined;
  let forceSettlementTimer: NodeJS.Timeout | undefined;
  let processSettled = false;

  type ProcessResult = {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  };
  let settleProcess: (result: ProcessResult, closeOutput?: boolean) => void = () =>
    undefined;
  const processCompletion = new Promise<ProcessResult>((resolveRun) => {
    settleProcess = (result, closeOutput = false) => {
      if (processSettled) {
        return;
      }
      processSettled = true;
      if (closeOutput) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      resolveRun(result);
    };
    child.onError((error) => {
      processError = error;
      settleProcess({ code: null, signal: null }, true);
    });
    // A normal ChildProcess `close` follows process exit and output-stream
    // closure, so no explicit stream destruction is needed in this path.
    child.onClose((code, signal) => {
      settleProcess({ code, signal });
    });
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    timeoutCleanup = cleanupContainer();
    sigkillTimer = setTimeout(() => {
      try {
        child.terminate("SIGKILL");
      } catch (error) {
        processError ??= error instanceof Error ? error : new Error(String(error));
      }
    }, sigkillAfterMs);
    forceSettlementTimer = setTimeout(() => {
      settleProcess({ code: null, signal: "SIGKILL" }, true);
    }, forceSettlementAfterMs);
    try {
      child.terminate("SIGTERM");
    } catch (error) {
      processError ??= error instanceof Error ? error : new Error(String(error));
    }
  }, options.timeoutMs);

  let processResult: ProcessResult;
  try {
    processResult = await processCompletion;
  } finally {
    clearTimeout(timeout);
    clearTimeout(sigkillTimer);
    clearTimeout(forceSettlementTimer);
    await timeoutCleanup;
    // A timeout cleanup can race container creation. Repeat the label-checked
    // removal after process close or forced settlement so a late-created
    // container is not left running. This is harmless for `docker run --rm`.
    await cleanupContainer();
  }

  const capturedText = Buffer.concat(chunks).toString("utf8");
  const outcome = timedOut
    ? `timed out after ${options.timeoutMs} ms`
    : processError !== undefined
      ? `Docker process failed: ${processError.message}`
      : processResult.code === 0
        ? undefined
        : `exited with ${processResult.code ?? `signal ${processResult.signal ?? "unknown"}`}`;
  await writeAcquisitionLog({
    path: logPath,
    chunks,
    truncated: captureState.truncated,
    ...(outcome === undefined ? {} : { outcome }),
    ...(cleanupError === undefined ? {} : { cleanupError }),
  });

  if (timedOut) {
    throw new NpmAcquisitionError(
      `sandboxed npm ${options.command} timed out after ${options.timeoutMs} ms${cleanupError === undefined ? "" : `; container cleanup failed: ${cleanupError}`}`,
      cleanupError === undefined,
    );
  }
  if (processError !== undefined) {
    throw new NpmAcquisitionError(
      `sandboxed npm ${options.command} failed to run: ${processError.message}${cleanupError === undefined ? "" : `; container cleanup failed: ${cleanupError}`}`,
      cleanupError === undefined,
      { cause: processError },
    );
  }
  if (processResult.code !== 0) {
    throw new NpmAcquisitionError(
      `sandboxed npm ${options.command} exited with ${processResult.code ?? `signal ${processResult.signal ?? "unknown"}`}: ${capturedText.slice(-2_000)}${cleanupError === undefined ? "" : `; container cleanup failed: ${cleanupError}`}`,
      cleanupError === undefined,
    );
  }
  if (cleanupError !== undefined) {
    throw new NpmAcquisitionError(
      `sandboxed npm ${options.command} completed but container cleanup failed: ${cleanupError}`,
      false,
    );
  }
}

function packageDirectory(root: string, packageName: string): string {
  return join(root, "node_modules", ...packageName.split("/"));
}

function containerPackageDirectory(packageName: string): string {
  return `${targetContainerRoot}/node_modules/${packageName}`;
}

async function readInstalledPackageLock(
  hostRoot: string,
  packageName: string,
): Promise<{
  readonly version: string;
  readonly resolved?: string;
  readonly integrity?: string;
}> {
  const source = await readFile(join(hostRoot, "package-lock.json"), "utf8");
  const parsed = JSON.parse(source) as {
    packages?: Record<
      string,
      { version?: unknown; resolved?: unknown; integrity?: unknown }
    >;
  };
  const entry = parsed.packages?.[`node_modules/${packageName}`];
  if (typeof entry?.version !== "string") {
    throw new Error(`package-lock.json does not contain installed package '${packageName}'`);
  }
  return {
    version: entry.version,
    ...(typeof entry.resolved === "string" ? { resolved: entry.resolved } : {}),
    ...(typeof entry.integrity === "string" ? { integrity: entry.integrity } : {}),
  };
}

async function preservePackageEvidence(options: {
  readonly store: EvidenceStore;
  readonly hostRoot: string;
  readonly packageRoot: string;
}): Promise<{ packageManifestSha256?: string; packageLockSha256?: string }> {
  const evidenceDirectory = options.store.pathFor("target");
  await mkdir(evidenceDirectory, { recursive: true });
  const packageManifest = join(options.packageRoot, "package.json");
  const packageLock = join(options.hostRoot, "package-lock.json");
  const result: { packageManifestSha256?: string; packageLockSha256?: string } = {};

  if (await pathExists(packageManifest)) {
    await copyFile(packageManifest, join(evidenceDirectory, "package.json"));
    result.packageManifestSha256 = await sha256File(packageManifest);
  }
  if (await pathExists(packageLock)) {
    await copyFile(packageLock, join(evidenceDirectory, "package-lock.json"));
    result.packageLockSha256 = await sha256File(packageLock);
  }
  return result;
}

export async function prepareTarget(options: {
  readonly loaded: LoadedTargetConfig;
  readonly runId: string;
  readonly store: EvidenceStore;
  readonly image: string;
  readonly dependencies?: PrepareTargetDependencies;
}): Promise<PreparedTarget> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "forge-target-"));
  const hostRoot = join(temporaryRoot, "artifact");
  const hostNpmCache = join(temporaryRoot, "npm-cache");
  await mkdir(hostRoot, { recursive: true, mode: 0o777 });
  await mkdir(hostNpmCache, { recursive: true, mode: 0o777 });
  await chmod(temporaryRoot, 0o755);
  await chmod(hostRoot, 0o777);
  await chmod(hostNpmCache, 0o777);

  let packageRoot = hostRoot;
  let containerPackageRoot: string = targetContainerRoot;
  let source: TargetProvenanceV1["source"];
  let installStrategy: TargetProvenanceV1["install"]["strategy"] = "none";
  const npmInstall = options.dependencies?.runNpmInstall ?? runNpmInstall;

  try {
    const configuredSource: TargetConfigV1["target"]["source"] =
      options.loaded.config.target.source;

    if (configuredSource.type === "npm") {
      await writeFile(
        join(hostRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "forge-prepared-target",
            version: "1.0.0",
            private: true,
            dependencies: { [configuredSource.package]: configuredSource.version },
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o666 },
      );
      await npmInstall({
        image: options.image,
        runId: options.runId,
        hostRoot,
        hostNpmCache,
        command: "install",
        store: options.store,
        timeoutMs: options.loaded.config.sandbox.limits.installTimeoutMs,
      });
      installStrategy = "npm-install";
      const installed = await readInstalledPackageLock(
        hostRoot,
        configuredSource.package,
      );
      if (installed.version !== configuredSource.version) {
        throw new Error(
          `npm resolved ${configuredSource.package} to ${installed.version}, expected ${configuredSource.version}`,
        );
      }
      packageRoot = packageDirectory(hostRoot, configuredSource.package);
      containerPackageRoot = containerPackageDirectory(configuredSource.package);
      const packageDigest = await digestTargetTree(packageRoot);
      source = {
        type: "npm",
        package: configuredSource.package,
        requestedVersion: configuredSource.version,
        resolvedVersion: installed.version,
        packageTreeSha256: packageDigest.sha256,
        packageFileCount: packageDigest.fileCount,
        ...(installed.resolved === undefined ? {} : { resolved: installed.resolved }),
        ...(installed.integrity === undefined ? {} : { integrity: installed.integrity }),
      };
    } else {
      const configuredPath = resolveLocalSourcePath(options.loaded);
      if (configuredPath === undefined) {
        throw new Error("local target source path could not be resolved");
      }
      const sourceRoot = await realpath(configuredPath);
      const sourceStat = await lstat(sourceRoot);
      if (!sourceStat.isDirectory()) {
        throw new Error(`local target source is not a directory: ${sourceRoot}`);
      }
      const digest = await digestTargetTree(sourceRoot);
      const install =
        configuredSource.type === "fixture"
          ? "npm-ignore-scripts"
          : configuredSource.install;
      await cp(sourceRoot, hostRoot, {
        recursive: true,
        force: true,
        filter: (sourcePath) =>
          install === "none" ||
          (basename(sourcePath) !== "node_modules" && basename(sourcePath) !== ".git"),
        verbatimSymlinks: true,
      });
      await chmod(hostRoot, 0o777);
      packageRoot = hostRoot;
      if (install === "npm-ignore-scripts") {
        const hasLock = await pathExists(join(hostRoot, "package-lock.json"));
        await npmInstall({
          image: options.image,
          runId: options.runId,
          hostRoot,
          hostNpmCache,
          command: hasLock ? "ci" : "install",
          store: options.store,
          timeoutMs: options.loaded.config.sandbox.limits.installTimeoutMs,
        });
        installStrategy = hasLock ? "npm-ci" : "npm-install";
      }
      source = {
        type: configuredSource.type,
        configuredPath,
        sourceTreeSha256: digest.sha256,
        sourceFileCount: digest.fileCount,
      };
    }

    const packageEvidence = await preservePackageEvidence({
      store: options.store,
      hostRoot,
      packageRoot,
    });
    const provenance: TargetProvenanceV1 = {
      schema: "forge.target-provenance/v1",
      runId: options.runId,
      targetId: options.loaded.config.target.id,
      preparedAt: new Date().toISOString(),
      containerRoot: targetContainerRoot,
      containerPackageRoot,
      source,
      install: {
        strategy: installStrategy,
        lifecycleScripts: "disabled",
      },
      ...packageEvidence,
      limitations: [
        "Acquisition installs dependencies with lifecycle scripts disabled.",
        "The prepared target is mounted read-only during runtime experiments.",
      ],
    };
    await options.store.writeJson(
      "target/provenance.json",
      targetProvenanceV1Schema,
      provenance,
    );

    return {
      hostRoot,
      packageRoot,
      ...(installStrategy === "none" ? {} : { hostNpmCache }),
      containerRoot: targetContainerRoot,
      provenance,
      dispose: async () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new TargetPreparationCleanupError(
        "target preparation failed and temporary-input cleanup could not be verified",
        { cause: new AggregateError([error, cleanupError]) },
      );
    }
    throw error;
  }
}
