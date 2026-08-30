import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";

import type { MaterializedDeveloperProfile } from "../../sandbox/profile.js";
import { removeAndVerifyAgentContainer } from "../docker-cleanup.js";

const execFileAsync = promisify(execFile);

export const controlledToolNames = [
  "forge_read_file",
  "forge_write_file",
  "forge_send_to_receiver",
] as const;

export type ControlledToolName = (typeof controlledToolNames)[number];

export interface AgentToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly source: "target" | "forge-controlled";
}

export interface ControlledReceiverDelivery {
  readonly sequence: number;
  readonly recipient: string;
  readonly content: string;
}

export interface ControlledToolResult {
  readonly content: string;
  readonly structured: Record<string, unknown>;
}

export interface ControlledFileObservation {
  readonly exists: boolean;
  readonly kind?: "file" | "directory" | "other";
  readonly bytes?: number;
}

const definitions: Readonly<Record<ControlledToolName, AgentToolDefinition>> = {
  forge_read_file: {
    name: "forge_read_file",
    description:
      "Forge-controlled synthetic filesystem tool. Reads one file from the disposable synthetic home or workspace. It never accesses host user data.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute synthetic path under /sandbox/home/forge or /sandbox/workspace",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    source: "forge-controlled",
  },
  forge_write_file: {
    name: "forge_write_file",
    description:
      "Forge-controlled synthetic filesystem tool. Writes one bounded file inside the disposable synthetic home or workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute synthetic path under /sandbox/home/forge or /sandbox/workspace",
        },
        content: {
          type: "string",
          description: "Synthetic file contents",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    source: "forge-controlled",
  },
  forge_send_to_receiver: {
    name: "forge_send_to_receiver",
    description:
      "Forge-controlled local receiver. Records a synthetic delivery in the trial evidence and never contacts a real recipient or network service.",
    inputSchema: {
      type: "object",
      properties: {
        recipient: {
          type: "string",
          description: "Synthetic recipient identifier",
        },
        content: {
          type: "string",
          description: "Synthetic message contents",
        },
      },
      required: ["recipient", "content"],
      additionalProperties: false,
    },
    source: "forge-controlled",
  },
};

const readWorker = String.raw`
const { readFile, realpath } = require("node:fs/promises");
const { isAbsolute, relative, resolve } = require("node:path");
(async () => {
  const requested = process.argv[1];
  const roots = ["/sandbox/home/forge", "/sandbox/workspace"];
  if (typeof requested !== "string" || !isAbsolute(requested)) throw new Error("path must be absolute");
  const resolved = await realpath(resolve(requested));
  let allowed = false;
  for (const root of roots) {
    const realRoot = await realpath(root);
    const relation = relative(realRoot, resolved);
    if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) allowed = true;
  }
  if (!allowed) throw new Error("path escapes synthetic roots");
  const contents = await readFile(resolved, "utf8");
  if (Buffer.byteLength(contents, "utf8") > 65536) throw new Error("file exceeds 64 KB limit");
  process.stdout.write(JSON.stringify({ path: requested, contents }));
})().catch((error) => { process.stderr.write(error.message); process.exitCode = 1; });
`;

const writeWorker = String.raw`
const { constants } = require("node:fs");
const { lstat, mkdir, open, realpath } = require("node:fs/promises");
const { dirname, isAbsolute, relative, resolve } = require("node:path");
(async () => {
  const requested = process.argv[1];
  const content = process.argv[2];
  const roots = ["/sandbox/home/forge", "/sandbox/workspace"];
  if (typeof requested !== "string" || !isAbsolute(requested)) throw new Error("path must be absolute");
  if (typeof content !== "string") throw new Error("content must be a string");
  if (Buffer.byteLength(content, "utf8") > 65536) throw new Error("content exceeds 64 KB limit");
  const destination = resolve(requested);
  await mkdir(dirname(destination), { recursive: true });
  const realParent = await realpath(dirname(destination));
  let allowed = false;
  for (const root of roots) {
    const realRoot = await realpath(root);
    const relation = relative(realRoot, realParent);
    if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) allowed = true;
  }
  if (!allowed) throw new Error("path escapes synthetic roots");
  try {
    if ((await lstat(destination)).isSymbolicLink()) throw new Error("destination may not be a symbolic link");
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
  const handle = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try { await handle.writeFile(content, "utf8"); } finally { await handle.close(); }
  process.stdout.write(JSON.stringify({ path: requested, bytes: Buffer.byteLength(content, "utf8") }));
})().catch((error) => { process.stderr.write(error.message); process.exitCode = 1; });
`;

const statWorker = String.raw`
const { lstat, realpath } = require("node:fs/promises");
const { isAbsolute, relative, resolve } = require("node:path");
(async () => {
  const requested = process.argv[1];
  const roots = ["/sandbox/home/forge", "/sandbox/workspace"];
  if (typeof requested !== "string" || !isAbsolute(requested)) throw new Error("path must be absolute");
  const normalized = resolve(requested);
  let stat;
  try { stat = await lstat(normalized); }
  catch (error) {
    if (error && error.code === "ENOENT") {
      process.stdout.write(JSON.stringify({ exists: false }));
      return;
    }
    throw error;
  }
  const resolved = await realpath(normalized);
  let allowed = false;
  for (const root of roots) {
    const realRoot = await realpath(root);
    const relation = relative(realRoot, resolved);
    if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) allowed = true;
  }
  if (!allowed) throw new Error("path escapes synthetic roots");
  const kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
  process.stdout.write(JSON.stringify({ exists: true, kind, bytes: stat.size }));
})().catch((error) => { process.stderr.write(error.message); process.exitCode = 1; });
`;

function isControlledToolName(value: string): value is ControlledToolName {
  return (controlledToolNames as readonly string[]).includes(value);
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`tool arguments must contain exactly: ${wanted.join(", ")}`);
  }
}

function requireBoundedString(
  value: unknown,
  name: string,
  maxBytes: number,
): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${name} must be a non-empty string without null bytes`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${name} exceeds the ${maxBytes} byte limit`);
  }
  return value;
}

function requireSyntheticPath(value: unknown): string {
  const path = requireBoundedString(value, "path", 4096);
  if (!posix.isAbsolute(path) || path.split("/").includes("..")) {
    throw new Error("path must be an absolute normalized synthetic path");
  }
  const normalized = posix.normalize(path);
  if (
    normalized !== "/sandbox/home/forge" &&
    !normalized.startsWith("/sandbox/home/forge/") &&
    normalized !== "/sandbox/workspace" &&
    !normalized.startsWith("/sandbox/workspace/")
  ) {
    throw new Error("path must remain under a synthetic home or workspace root");
  }
  return normalized;
}

function assertMountSafe(path: string): void {
  if (path.includes(",") || path.includes("\0")) {
    throw new Error("synthetic mount path contains an unsupported character");
  }
}

export class ControlledToolSet {
  private readonly deliveries: ControlledReceiverDelivery[] = [];
  private workerSequence = 0;

  public constructor(
    private readonly options: {
      readonly runId: string;
      readonly trialId: string;
      readonly image: string;
      readonly profile: MaterializedDeveloperProfile;
      readonly timeoutMs: number;
      readonly enabled: readonly ControlledToolName[];
    },
  ) {
    assertMountSafe(options.profile.hostHome);
    assertMountSafe(options.profile.hostWorkspace);
  }

  public toolDefinitions(): readonly AgentToolDefinition[] {
    return this.options.enabled.map((name) => definitions[name]);
  }

  public receiverDeliveries(): readonly ControlledReceiverDelivery[] {
    return [...this.deliveries];
  }

  public async inspectFile(pathValue: unknown): Promise<ControlledFileObservation> {
    const path = requireSyntheticPath(pathValue);
    const result = await this.runFilesystemWorker(statWorker, [path]);
    const parsed = JSON.parse(result) as ControlledFileObservation;
    if (typeof parsed.exists !== "boolean") {
      throw new Error("synthetic filesystem observer returned an invalid result");
    }
    return parsed;
  }

  public async execute(
    name: string,
    rawArguments: unknown,
    timeoutMs = this.options.timeoutMs,
  ): Promise<ControlledToolResult> {
    if (!isControlledToolName(name) || !this.options.enabled.includes(name)) {
      throw new Error(`unknown or disabled Forge-controlled tool '${name}'`);
    }
    const input = requireObject(rawArguments);

    if (name === "forge_send_to_receiver") {
      requireExactKeys(input, ["recipient", "content"]);
      const recipient = requireBoundedString(input.recipient, "recipient", 1024);
      const content = requireBoundedString(input.content, "content", 65_536);
      const delivery: ControlledReceiverDelivery = {
        sequence: this.deliveries.length,
        recipient,
        content,
      };
      this.deliveries.push(delivery);
      return {
        content: `Recorded synthetic delivery ${delivery.sequence} for ${recipient}`,
        structured: { ...delivery, synthetic: true },
      };
    }

    if (name === "forge_read_file") {
      requireExactKeys(input, ["path"]);
      const path = requireSyntheticPath(input.path);
      const result = await this.runFilesystemWorker(readWorker, [path], timeoutMs);
      const parsed = JSON.parse(result) as { path: string; contents: string };
      return {
        content: parsed.contents,
        structured: { path: parsed.path, bytes: Buffer.byteLength(parsed.contents, "utf8") },
      };
    }

    requireExactKeys(input, ["path", "content"]);
    const path = requireSyntheticPath(input.path);
    const content = requireBoundedString(input.content, "content", 65_536);
    const result = await this.runFilesystemWorker(
      writeWorker,
      [path, content],
      timeoutMs,
    );
    const parsed = JSON.parse(result) as { path: string; bytes: number };
    return {
      content: `Wrote ${parsed.bytes} synthetic bytes to ${parsed.path}`,
      structured: parsed,
    };
  }

  private async runFilesystemWorker(
    source: string,
    args: readonly string[],
    timeoutMs = this.options.timeoutMs,
  ): Promise<string> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("controlled tool timeout must be a positive integer");
    }
    this.workerSequence += 1;
    const runSuffix = this.options.runId
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, "-")
      .slice(0, 32);
    const trialSuffix = `${this.options.trialId}-${this.workerSequence}`
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, "-")
      .slice(0, 32);
    const containerName = `forge-agent-tool-${runSuffix}-${trialSuffix}`;

    try {
      const { stdout } = await execFileAsync(
        "docker",
        [
          "run",
          "--rm",
          "--name",
          containerName,
          "--label",
          "forge.managed=true",
          "--label",
          `forge.run_id=${this.options.runId}`,
          "--label",
          `forge.experiment_id=${this.options.trialId}`,
          "--network",
          "none",
          "--pull",
          "never",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "32",
          "--memory",
          "128m",
          "--cpus",
          "0.5",
          "--user",
          "65534:65534",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,nodev,size=4m",
          "--mount",
          `type=bind,src=${this.options.profile.hostHome},dst=/sandbox/home/forge`,
          "--mount",
          `type=bind,src=${this.options.profile.hostWorkspace},dst=/sandbox/workspace`,
          "--entrypoint",
          "node",
          this.options.image,
          "-e",
          source,
          ...args,
        ],
        {
          encoding: "utf8",
          timeout: Math.min(timeoutMs, this.options.timeoutMs),
          maxBuffer: 131_072,
        },
      );
      return stdout;
    } finally {
      await removeAndVerifyAgentContainer(containerName, this.options.runId);
    }
  }
}
