import { spawn } from "node:child_process";
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

async function runNpmInstall(options: {
  readonly image: string;
  readonly runId: string;
  readonly hostRoot: string;
  readonly hostNpmCache: string;
  readonly command: "ci" | "install";
  readonly store: EvidenceStore;
}): Promise<void> {
  assertMountSafe(options.hostRoot);
  const containerName = `forge-${safeDockerToken(options.runId)}-acquisition`;
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

  const output = await new Promise<string>((resolveRun, rejectRun) => {
    const child = spawn("docker", dockerArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const capture = (chunk: Buffer) => {
      if (size < 2_000_000) {
        chunks.push(chunk.subarray(0, 2_000_000 - size));
        size += chunk.length;
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (code === 0) {
        resolveRun(text);
      } else {
        rejectRun(
          new Error(
            `sandboxed npm ${options.command} exited with ${code ?? `signal ${signal ?? "unknown"}`}: ${text.slice(-2_000)}`,
          ),
        );
      }
    });
  });

  const logPath = options.store.pathFor("raw/acquisition/npm-install.log");
  await mkdir(resolve(logPath, ".."), { recursive: true });
  await writeFile(logPath, output, { encoding: "utf8", mode: 0o600 });
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
      await runNpmInstall({
        image: options.image,
        runId: options.runId,
        hostRoot,
        hostNpmCache,
        command: "install",
        store: options.store,
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
        await runNpmInstall({
          image: options.image,
          runId: options.runId,
          hostRoot,
          hostNpmCache,
          command: hasLock ? "ci" : "install",
          store: options.store,
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
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
