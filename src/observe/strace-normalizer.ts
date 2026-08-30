import { posix } from "node:path";

import {
  observedEventV1Schema,
  type ObservedEffectV1,
  type ObservedEventV1,
} from "../contracts/v1.js";
import type { EvidenceStore } from "../evidence-store.js";
import {
  readExperimentStrace,
  type ParsedStraceRecord,
  type ParsedStraceSyscallRecord,
} from "./strace-parser.js";

interface CandidateEvent {
  readonly timestampSeconds: number;
  readonly processPid: number;
  readonly effect: ObservedEffectV1;
  readonly rawRef: string;
}

interface ProcessStartCandidate {
  readonly timestampSeconds: number;
  readonly pid: number;
  readonly parentPid?: number;
  readonly rawRef: string;
}

const fileReadSyscalls = new Set([
  "read",
  "pread64",
  "readv",
  "preadv",
  "preadv2",
]);
const fileWriteSyscalls = new Set([
  "write",
  "pwrite64",
  "writev",
  "pwritev",
  "pwritev2",
]);

export interface ObservedPathMapping {
  readonly observedPrefix: string;
  readonly containerPrefix: string;
}

function canonicalPath(
  path: string,
  mappings: readonly ObservedPathMapping[],
): string {
  const mapping = [...mappings]
    .sort(
      (left, right) => right.observedPrefix.length - left.observedPrefix.length,
    )
    .find(
      (candidate) =>
        path === candidate.observedPrefix ||
        path.startsWith(`${candidate.observedPrefix}/`),
    );
  if (mapping === undefined) {
    return posix.normalize(path);
  }
  return posix.normalize(
    `${mapping.containerPrefix}${path.slice(mapping.observedPrefix.length)}`,
  );
}

function integerResult(result: string): number | undefined {
  const match = /^(-?\d+)/.exec(result);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function failureErrno(result: string): string | undefined {
  return /^-1\s+([A-Z0-9_]+)/.exec(result)?.[1];
}

function decodeQuoted(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

function quotedStrings(value: string): string[] {
  const result: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    result.push(decodeQuoted(match[1] ?? ""));
  }
  return result;
}

function annotatedDescriptorPath(value: string): string | undefined {
  const trimmed = value.trim();
  const descriptorNumber = /^(?:\d+|AT_FDCWD)/.exec(trimmed)?.[0];
  if (
    descriptorNumber === undefined ||
    trimmed[descriptorNumber.length] !== "<"
  ) {
    return undefined;
  }

  const annotationStart = descriptorNumber.length;
  let depth = 0;
  for (let index = annotationStart; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (character === "<") {
      depth += 1;
      continue;
    }
    if (character !== ">") {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      const descriptor = trimmed
        .slice(annotationStart + 1, index)
        .replace(/<(?:char|block) \d+:\d+>$/, "");
      return descriptor.startsWith("/") ? descriptor : undefined;
    }
  }

  return undefined;
}

function resolveArgumentPath(argumentsText: string): string | undefined {
  const values = quotedStrings(argumentsText);
  const requested = values[0];
  if (requested === undefined) {
    return undefined;
  }
  if (requested.startsWith("/")) {
    return posix.normalize(requested);
  }
  const directory = annotatedDescriptorPath(argumentsText);
  return directory?.startsWith("/")
    ? posix.resolve(directory, requested)
    : undefined;
}

function processRef(runId: string, experimentId: string, pid: number): string {
  return `${runId}:${experimentId}:pid-${pid}`;
}

function mapProcesses(records: readonly ParsedStraceRecord[]): {
  readonly ownerByPid: Map<number, number>;
  readonly starts: ProcessStartCandidate[];
} {
  const ownerByPid = new Map<number, number>();
  const starts: ProcessStartCandidate[] = [];

  function owner(pid: number): number {
    return ownerByPid.get(pid) ?? pid;
  }

  for (const record of records) {
    if (
      record.kind !== "syscall" ||
      !["clone", "clone3", "fork", "vfork"].includes(record.syscall)
    ) {
      continue;
    }
    const childPid = integerResult(record.resultText);
    if (childPid === undefined || childPid <= 0) {
      continue;
    }
    const parentOwner = owner(record.pid);
    if (record.argumentsText.includes("CLONE_THREAD")) {
      ownerByPid.set(childPid, parentOwner);
      continue;
    }
    ownerByPid.set(childPid, childPid);
    starts.push({
      timestampSeconds: record.timestampSeconds,
      pid: childPid,
      parentPid: parentOwner,
      rawRef: record.rawRef,
    });
  }

  return { ownerByPid, starts };
}

function normalizeExec(record: ParsedStraceRecord): ObservedEffectV1 | undefined {
  if (record.kind !== "syscall" || record.syscall !== "execve") {
    return undefined;
  }
  const strings = quotedStrings(record.argumentsText);
  const executable = strings[0];
  if (executable === undefined) {
    return undefined;
  }
  const errno = failureErrno(record.resultText);
  return {
    kind: "process.exec",
    executable,
    args: strings.slice(1),
    outcome:
      errno === undefined
        ? { status: "succeeded" }
        : { status: "failed", errno },
  };
}

function normalizeFile(
  record: ParsedStraceSyscallRecord,
  pathMappings: readonly ObservedPathMapping[],
): ObservedEffectV1 | undefined {
  if (["open", "openat", "openat2"].includes(record.syscall)) {
    const errno = failureErrno(record.resultText);
    const path =
      errno === undefined
        ? annotatedDescriptorPath(record.resultText)
        : resolveArgumentPath(record.argumentsText);
    if (path === undefined) {
      return undefined;
    }
    return {
      kind: "file.open",
      path: canonicalPath(path, pathMappings),
      outcome:
        errno === undefined
          ? { status: "succeeded" }
          : { status: "failed", errno },
    };
  }

  if (
    fileReadSyscalls.has(record.syscall) ||
    fileWriteSyscalls.has(record.syscall)
  ) {
    const path = annotatedDescriptorPath(record.argumentsText);
    if (path === undefined) {
      return undefined;
    }
    const errno = failureErrno(record.resultText);
    if (errno !== undefined) {
      return {
        kind: fileReadSyscalls.has(record.syscall) ? "file.read" : "file.write",
        path: canonicalPath(path, pathMappings),
        outcome: { status: "failed", errno },
      };
    }
    const bytes = integerResult(record.resultText);
    if (bytes === undefined || bytes <= 0) {
      return undefined;
    }
    return {
      kind: fileReadSyscalls.has(record.syscall) ? "file.read" : "file.write",
      path: canonicalPath(path, pathMappings),
      bytes,
      outcome: { status: "succeeded" },
    };
  }

  if (["unlink", "unlinkat"].includes(record.syscall)) {
    const path = resolveArgumentPath(record.argumentsText);
    if (path === undefined) {
      return undefined;
    }
    const errno = failureErrno(record.resultText);
    return {
      kind: "file.delete",
      path: canonicalPath(path, pathMappings),
      outcome:
        errno === undefined
          ? { status: "succeeded" }
          : { status: "failed", errno },
    };
  }

  return undefined;
}

function normalizeNetwork(
  record: ParsedStraceSyscallRecord,
): ObservedEffectV1 | undefined {
  if (record.syscall !== "connect" && record.syscall !== "listen") {
    return undefined;
  }
  const annotation = /^\d+<([^>]+)>/.exec(record.argumentsText)?.[1] ?? "";
  const protocol = annotation.startsWith("TCP")
    ? "tcp"
    : annotation.startsWith("UDP")
      ? "udp"
      : annotation.startsWith("UNIX")
        ? "unix"
        : "unknown";
  const ipv4 = /inet_addr\("([^"]+)"\)/.exec(record.argumentsText)?.[1];
  const ipv6 = /inet_pton\(AF_INET6,\s*"([^"]+)"/.exec(record.argumentsText)?.[1];
  const unixPath = /sun_path="([^"]+)"/.exec(record.argumentsText)?.[1];
  const address = (ipv4 ?? ipv6 ?? unixPath ?? annotation) || "unknown";
  const portText = /sin6?_port=htons\((\d+)\)/.exec(record.argumentsText)?.[1];
  const port = portText === undefined ? undefined : Number(portText);
  const errno = failureErrno(record.resultText);

  return {
    kind: record.syscall === "connect" ? "network.connect_attempt" : "network.listen",
    protocol,
    address,
    ...(port === undefined ? {} : { port }),
    outcome: errno === undefined ? { status: "succeeded" } : { status: "failed", errno },
  };
}

function normalizeExit(record: ParsedStraceRecord): ObservedEffectV1 | undefined {
  if (record.kind === "signal-termination") {
    return { kind: "process.exit", signal: record.signal };
  }
  if (record.syscall !== "exit_group") {
    return undefined;
  }
  const exitCode = Number(record.argumentsText.split(",")[0]);
  if (!Number.isSafeInteger(exitCode)) {
    return undefined;
  }
  return { kind: "process.exit", exitCode };
}

export async function normalizeExperiment(options: {
  readonly store: EvidenceStore;
  readonly runId: string;
  readonly experimentId: string;
  readonly pathMappings?: readonly ObservedPathMapping[];
}): Promise<ObservedEventV1[]> {
  const { store, runId, experimentId } = options;
  const pathMappings = options.pathMappings ?? [];
  const records = await readExperimentStrace(
    store.pathFor(`raw/${experimentId}`),
    experimentId,
  );
  const { ownerByPid, starts } = mapProcesses(records);
  const candidates: CandidateEvent[] = [];
  const processOwners = new Set<number>();

  for (const record of records) {
    processOwners.add(ownerByPid.get(record.pid) ?? record.pid);
  }

  const childPids = new Set(starts.map((start) => start.pid));
  for (const rootPid of [...processOwners].filter((pid) => !childPids.has(pid))) {
    const firstRecord = records.find(
      (record) => (ownerByPid.get(record.pid) ?? record.pid) === rootPid,
    );
    if (firstRecord !== undefined) {
      candidates.push({
        timestampSeconds: firstRecord.timestampSeconds,
        processPid: rootPid,
        effect: { kind: "process.start", pid: rootPid },
        rawRef: firstRecord.rawRef,
      });
    }
  }

  for (const start of starts) {
    candidates.push({
      timestampSeconds: start.timestampSeconds,
      processPid: start.pid,
      effect: {
        kind: "process.start",
        pid: start.pid,
        ...(start.parentPid === undefined
          ? {}
          : { parentProcessRef: processRef(runId, experimentId, start.parentPid) }),
      },
      rawRef: start.rawRef,
    });
  }

  for (const record of records) {
    const ownerPid = ownerByPid.get(record.pid) ?? record.pid;
    const effect =
      normalizeExec(record) ??
      (record.kind === "syscall"
        ? normalizeFile(record, pathMappings) ?? normalizeNetwork(record)
        : undefined) ??
      (record.pid === ownerPid ? normalizeExit(record) : undefined);
    if (effect !== undefined) {
      candidates.push({
        timestampSeconds: record.timestampSeconds,
        processPid: ownerPid,
        effect,
        rawRef: record.rawRef,
      });
    }
  }

  candidates.sort(
    (left, right) =>
      left.timestampSeconds - right.timestampSeconds ||
      left.rawRef.localeCompare(right.rawRef),
  );

  return candidates.map((candidate, sequence) =>
    observedEventV1Schema.parse({
      schema: "forge.event/v1",
      eventId: `evt-${experimentId}-${sequence + 1}`,
      runId,
      experimentId,
      sequence,
      timestamp: new Date(candidate.timestampSeconds * 1_000).toISOString(),
      processRef: processRef(runId, experimentId, candidate.processPid),
      effect: candidate.effect,
      source: { collector: "strace", rawRef: candidate.rawRef },
    }),
  );
}

export async function normalizeRun(options: {
  readonly store: EvidenceStore;
  readonly runId: string;
  readonly experimentIds: readonly string[];
  readonly pathMappingsByExperiment?: ReadonlyMap<
    string,
    readonly ObservedPathMapping[]
  >;
}): Promise<ObservedEventV1[]> {
  const allEvents: ObservedEventV1[] = [];
  for (const experimentId of options.experimentIds) {
    allEvents.push(
      ...(await normalizeExperiment({
        store: options.store,
        runId: options.runId,
        experimentId,
        pathMappings: options.pathMappingsByExperiment?.get(experimentId) ?? [],
      })),
    );
  }
  await options.store.writeJsonl("events.jsonl", observedEventV1Schema, allEvents);
  return allEvents;
}
