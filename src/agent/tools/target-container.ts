import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";

import { sha256 } from "../../evidence-store.js";
import type { AgentActionV1 } from "../contracts.js";
import type {
  ControlledFileObservation,
  ControlledToolResult,
} from "./controlled.js";

const execFileAsync = promisify(execFile);
const maxOutputBytes = 131_072;
const maxTargetActionArgumentNodes = 4_096;

export const targetContainerStatWorkerSource = String.raw`
const { constants } = require("node:fs");
const { open, realpath } = require("node:fs/promises");
const { isAbsolute, relative, resolve } = require("node:path");
(async () => {
  const requested = process.argv[1];
  const roots = [process.argv[2], process.argv[3]];
  const fdRoot = process.argv[4];
  if (typeof requested !== "string" || !isAbsolute(requested)) throw new Error("path must be absolute");
  const normalized = resolve(requested);
  let handle;
  try {
    handle = await open(
      normalized,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
    );
  } catch (error) {
    if (error && error.code === "ENOENT") {
      process.stdout.write(JSON.stringify({ exists: false }));
      return;
    }
    throw error;
  }
  try {
    const resolved = await realpath(fdRoot + "/" + handle.fd);
    let allowed = false;
    for (const root of roots) {
      const realRoot = await realpath(root);
      const relation = relative(realRoot, resolved);
      if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) allowed = true;
    }
    if (!allowed) throw new Error("path escapes synthetic roots");
    const stat = await handle.stat();
    const kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
    process.stdout.write(JSON.stringify({ exists: true, kind, bytes: stat.size }));
  } finally {
    await handle.close();
  }
})().catch((error) => { process.stderr.write(error.message); process.exitCode = 1; });
`;

export const targetContainerReadWorkerSource = String.raw`
const { createHash } = require("node:crypto");
const { constants } = require("node:fs");
const { open, realpath } = require("node:fs/promises");
const { isAbsolute, relative, resolve } = require("node:path");
(async () => {
  const requested = process.argv[1];
  const roots = [process.argv[2], process.argv[3]];
  const fdRoot = process.argv[4];
  if (typeof requested !== "string" || !isAbsolute(requested)) throw new Error("path must be absolute");
  const handle = await open(
    resolve(requested),
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  );
  try {
    const resolved = await realpath(fdRoot + "/" + handle.fd);
    let allowed = false;
    for (const root of roots) {
      const realRoot = await realpath(root);
      const relation = relative(realRoot, resolved);
      if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) allowed = true;
    }
    if (!allowed) throw new Error("path escapes synthetic roots");
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("path is not a regular file");
    if (stat.size > 65536) throw new Error("file exceeds 64 KB limit");
    const contents = await handle.readFile();
    if (contents.byteLength > 65536) throw new Error("file exceeds 64 KB limit");
    process.stdout.write(JSON.stringify({
      path: requested,
      bytes: contents.byteLength,
      contentSha256: createHash("sha256").update(contents).digest("hex"),
      contentsBase64: contents.toString("base64")
    }));
  } finally {
    await handle.close();
  }
})().catch((error) => { process.stderr.write(error.message); process.exitCode = 1; });
`;

function requireSyntheticPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 4_096
  ) {
    throw new Error("target utility path must be a bounded string");
  }
  const normalized = posix.normalize(value);
  if (
    !posix.isAbsolute(value) ||
    value.split("/").includes("..") ||
    (normalized !== "/sandbox/home/forge" &&
      !normalized.startsWith("/sandbox/home/forge/") &&
      normalized !== "/sandbox/workspace" &&
      !normalized.startsWith("/sandbox/workspace/"))
  ) {
    throw new Error("target utility path must remain inside synthetic roots");
  }
  return normalized;
}

/** Trusted, bounded utility observer for the target's size-limited workspace. */
export class TargetContainerFilesystemOracle {
  public constructor(
    private readonly options: {
      readonly containerName: string;
      readonly runId: string;
      readonly timeoutMs: number;
    },
  ) {}

  public async inspectFile(pathValue: unknown): Promise<ControlledFileObservation> {
    const path = requireSyntheticPath(pathValue);
    const parsed = JSON.parse(
      await this.runWorker(targetContainerStatWorkerSource, path),
    ) as ControlledFileObservation;
    if (
      typeof parsed.exists !== "boolean" ||
      (parsed.exists &&
        parsed.kind !== "file" &&
        parsed.kind !== "directory" &&
        parsed.kind !== "other")
    ) {
      throw new Error("target filesystem observer returned an invalid result");
    }
    return parsed;
  }

  public async execute(
    name: string,
    rawArguments: unknown,
    timeoutMs = this.options.timeoutMs,
  ): Promise<ControlledToolResult> {
    if (name !== "forge_read_file") {
      throw new Error(`target filesystem observer cannot execute '${name}'`);
    }
    if (
      typeof rawArguments !== "object" ||
      rawArguments === null ||
      Array.isArray(rawArguments) ||
      Object.keys(rawArguments).length !== 1 ||
      !("path" in rawArguments)
    ) {
      throw new Error("target filesystem observer requires exactly one path");
    }
    const path = requireSyntheticPath(
      (rawArguments as { readonly path?: unknown }).path,
    );
    const parsed = JSON.parse(
      await this.runWorker(targetContainerReadWorkerSource, path, timeoutMs),
    ) as {
      readonly path: string;
      readonly bytes: number;
      readonly contentSha256: string;
      readonly contentsBase64: string;
    };
    if (
      typeof parsed.path !== "string" ||
      typeof parsed.contentsBase64 !== "string" ||
      !Number.isSafeInteger(parsed.bytes) ||
      parsed.bytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(parsed.contentSha256)
    ) {
      throw new Error("target filesystem observer returned invalid content");
    }
    const contentsBuffer = Buffer.from(parsed.contentsBase64, "base64");
    if (
      contentsBuffer.byteLength > 65_536 ||
      contentsBuffer.byteLength !== parsed.bytes ||
      sha256(contentsBuffer) !== parsed.contentSha256 ||
      contentsBuffer.toString("base64") !== parsed.contentsBase64
    ) {
      throw new Error("target filesystem observer returned invalid base64 content");
    }
    const contents = contentsBuffer.toString("utf8");
    return {
      content: contents,
      structured: {
        path: parsed.path,
        bytes: contentsBuffer.byteLength,
        contentSha256: parsed.contentSha256,
      },
    };
  }

  private async runWorker(
    source: string,
    path: string,
    timeoutMs = this.options.timeoutMs,
  ): Promise<string> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("target filesystem observer timeout must be positive");
    }
    const { stdout: label } = await execFileAsync(
      "docker",
      [
        "container",
        "inspect",
        "--format",
        '{{ index .Config.Labels "forge.run_id" }}',
        this.options.containerName,
      ],
      {
        encoding: "utf8",
        timeout: Math.min(timeoutMs, this.options.timeoutMs),
        maxBuffer: 64_000,
      },
    );
    if (label.trim() !== this.options.runId) {
      throw new Error("target filesystem observer refused a container label mismatch");
    }
    const { stdout } = await execFileAsync(
      "docker",
      [
        "container",
        "exec",
        "--user",
        "0:0",
        this.options.containerName,
        "/usr/local/bin/node",
        "--eval",
        source,
        path,
        "/sandbox/home/forge",
        "/sandbox/workspace",
        "/proc/self/fd",
      ],
      {
        encoding: "utf8",
        timeout: Math.min(timeoutMs, this.options.timeoutMs),
        maxBuffer: maxOutputBytes,
      },
    );
    return stdout;
  }
}

export interface TargetActionPathObservation {
  readonly actionId: string;
  readonly toolName: string;
  readonly path: string;
  readonly exists?: boolean;
  readonly kind?: "file" | "directory" | "other";
  readonly bytes?: number;
  readonly contentSha256?: string;
  readonly readStatus: "hashed" | "not_file" | "missing" | "observer_error";
}

/** Extract only bounded synthetic paths from dispatched target-MCP arguments. */
export function targetActionPathCandidates(
  actions: readonly AgentActionV1[],
): readonly { readonly actionId: string; readonly toolName: string; readonly path: string }[] {
  const candidates: Array<{
    readonly actionId: string;
    readonly toolName: string;
    readonly path: string;
  }> = [];
  for (const action of actions) {
    if (
      action.toolSource !== "target_mcp" ||
      (action.outcome.status !== "succeeded" && action.outcome.status !== "failed")
    ) {
      continue;
    }
    const pending: unknown[] = [action.toolCall.arguments];
    let visitedNodes = 0;
    while (
      pending.length > 0 &&
      candidates.length < 256 &&
      visitedNodes < maxTargetActionArgumentNodes
    ) {
      const value = pending.pop();
      visitedNodes += 1;
      if (typeof value === "string") {
        try {
          candidates.push({
            actionId: action.actionId,
            toolName: action.toolCall.name,
            path: requireSyntheticPath(value),
          });
        } catch {
          // Non-path strings and out-of-root paths are not trusted observation targets.
        }
      } else if (Array.isArray(value)) {
        for (const entry of value) {
          if (pending.length + visitedNodes >= maxTargetActionArgumentNodes) {
            break;
          }
          pending.push(entry);
        }
      } else if (value !== null && typeof value === "object") {
        for (const entry of Object.values(value)) {
          if (pending.length + visitedNodes >= maxTargetActionArgumentNodes) {
            break;
          }
          pending.push(entry);
        }
      }
    }
  }
  return candidates.filter(
    (candidate, index) =>
      candidates.findIndex(
        (other) =>
          other.actionId === candidate.actionId && other.path === candidate.path,
      ) === index,
  );
}

/** Persistable trusted observations of target-MCP path arguments before tmpfs cleanup. */
export async function observeTargetActionPaths(
  actions: readonly AgentActionV1[],
  oracle: Pick<TargetContainerFilesystemOracle, "inspectFile" | "execute">,
): Promise<readonly TargetActionPathObservation[]> {
  const observations: TargetActionPathObservation[] = [];
  for (const candidate of targetActionPathCandidates(actions)) {
    try {
      const inspected = await oracle.inspectFile(candidate.path);
      if (!inspected.exists) {
        observations.push({ ...candidate, exists: false, readStatus: "missing" });
        continue;
      }
      if (inspected.kind !== "file") {
        observations.push({
          ...candidate,
          exists: true,
          ...(inspected.kind === undefined ? {} : { kind: inspected.kind }),
          ...(inspected.bytes === undefined ? {} : { bytes: inspected.bytes }),
          readStatus: "not_file",
        });
        continue;
      }
      const result = await oracle.execute("forge_read_file", {
        path: candidate.path,
      });
      const exactBytes = result.structured.bytes;
      const exactSha256 = result.structured.contentSha256;
      if (
        !Number.isSafeInteger(exactBytes) ||
        typeof exactBytes !== "number" ||
        exactBytes < 0 ||
        typeof exactSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(exactSha256)
      ) {
        throw new Error("target filesystem observer omitted exact file metadata");
      }
      observations.push({
        ...candidate,
        exists: true,
        kind: "file",
        bytes: exactBytes,
        contentSha256: exactSha256,
        readStatus: "hashed",
      });
    } catch {
      observations.push({
        ...candidate,
        readStatus: "observer_error",
      });
    }
  }
  return observations;
}
