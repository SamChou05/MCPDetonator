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
const directoryReadSyscalls = new Set(["getdents", "getdents64"]);

const unsupportedFilesystemMutationSyscalls = new Set([
  "chmod",
  "chown",
  "creat",
  "fallocate",
  "fchmod",
  "fchmodat",
  "fchmodat2",
  "fchown",
  "fchownat",
  "fremovexattr",
  "fsetxattr",
  "ftruncate",
  "futimesat",
  "lchown",
  "link",
  "linkat",
  "lremovexattr",
  "lsetxattr",
  "mkdir",
  "mkdirat",
  "mknod",
  "mknodat",
  "removexattr",
  "rename",
  "renameat",
  "renameat2",
  "rmdir",
  "setxattr",
  "symlink",
  "symlinkat",
  "truncate",
  "utime",
  "utimensat",
  "utimes",
]);
const unsupportedDataTransferAttemptSyscalls = new Set([
  "copy_file_range",
  "sendfile",
  "sendfile64",
  "sendmmsg",
  "sendmsg",
  "sendto",
  "shutdown",
  "splice",
  "tee",
  "vmsplice",
]);
const unsupportedSuccessfulReceiveSyscalls = new Set([
  "accept",
  "accept4",
  "recvmmsg",
  "recvfrom",
  "recvmsg",
]);
const unsupportedEscapeOrInterferenceAttemptSyscalls = new Set([
  "bpf",
  "chroot",
  "fsconfig",
  "fsmount",
  "fsopen",
  "fspick",
  "kill",
  "mount",
  "mount_setattr",
  "move_mount",
  "open_by_handle_at",
  "open_tree",
  "perf_event_open",
  "pidfd_send_signal",
  "pivot_root",
  "process_vm_readv",
  "process_vm_writev",
  "ptrace",
  "setns",
  "tgkill",
  "tkill",
  "umount",
  "umount2",
  "unshare",
  "userfaultfd",
]);
const unsupportedOpaqueIoSyscalls = new Set([
  "io_cancel",
  "io_destroy",
  "io_getevents",
  "io_pgetevents",
  "io_pgetevents_time64",
  "io_setup",
  "io_submit",
  "io_uring_enter",
  "io_uring_register",
  "io_uring_setup",
]);
const metadataPathProbeSyscalls = new Set([
  "access",
  "getxattr",
  "lgetxattr",
  "listxattr",
  "llistxattr",
  "lstat",
  "lstat64",
  "readlink",
  "stat",
  "stat64",
]);
const metadataAtPathProbeSyscalls = new Set([
  "faccessat",
  "faccessat2",
  "fstatat64",
  "newfstatat",
  "readlinkat",
  "statx",
]);
const metadataDescriptorProbeSyscalls = new Set([
  "fgetxattr",
  "flistxattr",
  "fstat",
  "fstat64",
]);
const defaultPolicyRelevantPathPrefixes = [
  "/sandbox/home/forge",
  "/sandbox/workspace",
] as const;

export const maxPolicyRelevantTraceGapExamples = 25;

export type PolicyRelevantTraceGapCategory =
  | "filesystem_mutation"
  | "data_transfer"
  | "escape_or_interference"
  | "opaque_io"
  | "failed_capability_probe"
  | "network_endpoint"
  | "alternate_file_access"
  | "indeterminate_outcome"
  | "truncated_arguments"
  | "unresolved_path";

export type PolicyRelevantTraceGapOutcome =
  | "succeeded"
  | "failed"
  | "unknown";

export interface PolicyRelevantTraceGapExample {
  readonly category: PolicyRelevantTraceGapCategory;
  readonly syscall: string;
  readonly rawRef: string;
  readonly outcome: PolicyRelevantTraceGapOutcome;
}

export interface PolicyRelevantTraceGapClassification {
  readonly recordCount: number;
  readonly categoryCounts: readonly {
    readonly category: PolicyRelevantTraceGapCategory;
    readonly recordCount: number;
  }[];
  readonly syscallCounts: readonly {
    readonly syscall: string;
    readonly recordCount: number;
  }[];
  readonly outcomeCounts: readonly {
    readonly outcome: PolicyRelevantTraceGapOutcome;
    readonly recordCount: number;
  }[];
  readonly examples: readonly PolicyRelevantTraceGapExample[];
  readonly truncatedExampleCount: number;
}

export interface ClassifyPolicyRelevantTraceGapOptions {
  readonly pathMappings?: readonly ObservedPathMapping[];
  readonly relevantPathPrefixes?: readonly string[] | undefined;
  readonly maxExamples?: number;
}

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

function syscallOutcome(result: string): PolicyRelevantTraceGapOutcome {
  if (failureErrno(result) !== undefined) {
    return "failed";
  }
  const integer = integerResult(result);
  if (integer !== undefined && integer >= 0) {
    return "succeeded";
  }
  if (/^0x[0-9a-f]+(?:\s|$)/i.test(result)) {
    return "succeeded";
  }
  return "unknown";
}

function syscallSucceeded(result: string): boolean {
  return syscallOutcome(result) === "succeeded";
}

type CanonicalSyscallOutcome =
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly errno: string };

function canonicalSyscallOutcome(
  result: string,
): CanonicalSyscallOutcome | undefined {
  const classified = syscallOutcome(result);
  if (classified === "succeeded") {
    return { status: "succeeded" };
  }
  if (classified === "failed") {
    const errno = failureErrno(result);
    return errno === undefined ? undefined : { status: "failed", errno };
  }
  return undefined;
}

function decodeQuoted(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

interface QuotedStringMatch {
  readonly value: string;
  readonly truncated: boolean;
}

function quotedStringMatches(value: string): QuotedStringMatch[] {
  const result: QuotedStringMatch[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    result.push({
      value: decodeQuoted(match[1] ?? ""),
      truncated: value.slice(pattern.lastIndex).startsWith("..."),
    });
  }
  return result;
}

function quotedStrings(value: string): string[] {
  return quotedStringMatches(value).map((match) => match.value);
}

function splitTopLevelArguments(value: string): string[] {
  const argumentsList: string[] = [];
  let start = 0;
  let escaped = false;
  let inString = false;
  const closingDelimiters: string[] = [];
  const matchingDelimiter: Readonly<Record<string, string>> = {
    "(": ")",
    "[": "]",
    "{": "}",
    "<": ">",
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    const expectedClosing = matchingDelimiter[character ?? ""];
    if (expectedClosing !== undefined) {
      closingDelimiters.push(expectedClosing);
      continue;
    }
    if (
      closingDelimiters.length > 0 &&
      character === closingDelimiters[closingDelimiters.length - 1]
    ) {
      closingDelimiters.pop();
      continue;
    }
    if (character === "," && closingDelimiters.length === 0) {
      argumentsList.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  argumentsList.push(value.slice(start).trim());
  return argumentsList;
}

function containsUnquotedEllipsis(value: string): boolean {
  let escaped = false;
  let inString = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (value.startsWith("...", index)) {
      return true;
    }
  }
  return false;
}

function execArgumentsAreTruncated(
  record: ParsedStraceSyscallRecord,
): boolean {
  const argumentIndex =
    record.syscall === "execve"
      ? 1
      : record.syscall === "execveat"
        ? 2
        : undefined;
  if (argumentIndex === undefined) {
    return false;
  }
  const argumentVector =
    splitTopLevelArguments(record.argumentsText)[argumentIndex] ?? "";
  return (
    quotedStringMatches(argumentVector).some((match) => match.truncated) ||
    containsUnquotedEllipsis(argumentVector)
  );
}

function annotatedDescriptorValue(value: string): string | undefined {
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
      return trimmed.slice(annotationStart + 1, index);
    }
  }

  return undefined;
}

function annotatedDescriptorPath(value: string): string | undefined {
  const descriptor = annotatedDescriptorValue(value)?.replace(
    /<(?:char|block) \d+:\d+>$/,
    "",
  );
  return descriptor?.startsWith("/") ? descriptor : undefined;
}

function resolveArgumentPath(argumentsText: string): string | undefined {
  const requestedMatch = quotedStringMatches(argumentsText)[0];
  if (requestedMatch === undefined || requestedMatch.truncated) {
    return undefined;
  }
  const requested = requestedMatch.value;
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
      !["clone", "clone3", "fork", "vfork"].includes(record.syscall) ||
      !syscallSucceeded(record.resultText)
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

function resolveExecveatPath(
  record: ParsedStraceSyscallRecord,
  pathMappings: readonly ObservedPathMapping[],
): string | undefined {
  const syscallArguments = splitTopLevelArguments(record.argumentsText);
  const directoryDescriptor = syscallArguments[0] ?? "";
  const pathnameArgument = syscallArguments[1] ?? "";
  const pathnameMatch = quotedStringMatches(pathnameArgument)[0];
  if (pathnameMatch === undefined || pathnameMatch.truncated) {
    return undefined;
  }

  if (pathnameMatch.value.startsWith("/")) {
    return canonicalPath(pathnameMatch.value, pathMappings);
  }

  const descriptorPath = annotatedDescriptorPath(directoryDescriptor);
  if (pathnameMatch.value.length > 0) {
    return descriptorPath === undefined
      ? undefined
      : canonicalPath(
          posix.resolve(descriptorPath, pathnameMatch.value),
          pathMappings,
        );
  }

  const flags = syscallArguments[4] ?? "";
  if (
    !/\bAT_EMPTY_PATH\b/.test(flags) ||
    !/^\d+</.test(directoryDescriptor.trim()) ||
    descriptorPath === undefined
  ) {
    return undefined;
  }
  return canonicalPath(descriptorPath, pathMappings);
}

function normalizeExec(
  record: ParsedStraceRecord,
  pathMappings: readonly ObservedPathMapping[],
): ObservedEffectV1 | undefined {
  if (record.kind !== "syscall") {
    return undefined;
  }
  if (execArgumentsAreTruncated(record)) {
    return undefined;
  }

  const syscallArguments = splitTopLevelArguments(record.argumentsText);
  let executable: string | undefined;
  let args: string[];
  if (record.syscall === "execve") {
    const executableMatch = quotedStringMatches(syscallArguments[0] ?? "")[0];
    if (executableMatch === undefined || executableMatch.truncated) {
      return undefined;
    }
    executable = executableMatch.value;
    if (!executable.startsWith("/")) {
      return undefined;
    }
    executable = canonicalPath(executable, pathMappings);
    args = quotedStrings(syscallArguments[1] ?? "");
  } else if (record.syscall === "execveat") {
    executable = resolveExecveatPath(record, pathMappings);
    if (executable === undefined) {
      return undefined;
    }
    args = quotedStrings(syscallArguments[2] ?? "");
  } else {
    return undefined;
  }

  const outcome = canonicalSyscallOutcome(record.resultText);
  if (outcome === undefined) {
    return undefined;
  }
  return {
    kind: "process.exec",
    executable,
    args,
    outcome,
  };
}

function normalizeFile(
  record: ParsedStraceSyscallRecord,
  pathMappings: readonly ObservedPathMapping[],
): ObservedEffectV1 | undefined {
  if (["open", "openat", "openat2"].includes(record.syscall)) {
    const outcome = canonicalSyscallOutcome(record.resultText);
    if (outcome === undefined) {
      return undefined;
    }
    const path =
      outcome.status === "succeeded"
        ? annotatedDescriptorPath(record.resultText)
        : resolveArgumentPath(record.argumentsText);
    if (path === undefined) {
      return undefined;
    }
    const truncatesExistingPath =
      /\bO_TRUNC\b/.test(record.argumentsText) &&
      !/\bO_TMPFILE\b/.test(record.argumentsText);
    return {
      kind: truncatesExistingPath ? "file.write" : "file.open",
      path: canonicalPath(path, pathMappings),
      ...(truncatesExistingPath ? { operation: "truncate" as const } : {}),
      outcome,
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
    const outcome = canonicalSyscallOutcome(record.resultText);
    if (outcome === undefined) {
      return undefined;
    }
    if (outcome.status === "failed") {
      return {
        kind: fileReadSyscalls.has(record.syscall) ? "file.read" : "file.write",
        path: canonicalPath(path, pathMappings),
        outcome,
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

  if (directoryReadSyscalls.has(record.syscall)) {
    const path = annotatedDescriptorPath(record.argumentsText);
    if (path === undefined) {
      return undefined;
    }
    const outcome = canonicalSyscallOutcome(record.resultText);
    if (outcome === undefined) {
      return undefined;
    }
    if (outcome.status === "failed") {
      return {
        kind: "file.read",
        path: canonicalPath(path, pathMappings),
        operation: "directory_entries",
        outcome,
      };
    }
    const bytes = integerResult(record.resultText);
    if (bytes === undefined || bytes <= 0) {
      return undefined;
    }
    // V1 has no directory-enumeration kind. Preserve the exact syscall in the
    // rawRef and use the closest filesystem-read shape without claiming that
    // getdents' returned dirent-buffer bytes are file-content bytes.
    return {
      kind: "file.read",
      path: canonicalPath(path, pathMappings),
      operation: "directory_entries",
      outcome: { status: "succeeded" },
    };
  }

  if (["unlink", "unlinkat"].includes(record.syscall)) {
    const path = resolveArgumentPath(record.argumentsText);
    if (path === undefined) {
      return undefined;
    }
    const outcome = canonicalSyscallOutcome(record.resultText);
    if (outcome === undefined) {
      return undefined;
    }
    return {
      kind: "file.delete",
      path: canonicalPath(path, pathMappings),
      outcome,
    };
  }

  return undefined;
}

interface NetworkEndpoint {
  readonly protocol?: "tcp" | "udp" | "unix" | "unknown";
  readonly address?: string;
  readonly port?: number;
}

interface BoundNetworkEndpoint {
  readonly endpoint: NetworkEndpoint;
  readonly descriptorAnnotation?: string;
}

function validNetworkPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function annotatedNetworkEndpoint(annotation: string): NetworkEndpoint {
  const protocol = annotation.startsWith("TCP")
    ? ("tcp" as const)
    : annotation.startsWith("UDP")
      ? ("udp" as const)
      : annotation.startsWith("UNIX")
        ? ("unix" as const)
        : undefined;
  const openingBracket = annotation.indexOf("[");
  const closingBracket = annotation.lastIndexOf("]");
  if (openingBracket < 0 || closingBracket <= openingBracket) {
    return protocol === undefined ? {} : { protocol };
  }

  let endpoint = annotation.slice(openingBracket + 1, closingBracket);
  endpoint = endpoint.split("->", 1)[0] ?? endpoint;
  if (protocol === "unix") {
    return {
      protocol,
      ...(endpoint.startsWith("/") || endpoint.startsWith("@")
        ? { address: endpoint }
        : {}),
    };
  }
  if (/^\d+$/.test(endpoint)) {
    return protocol === undefined ? {} : { protocol };
  }

  const separator = endpoint.lastIndexOf(":");
  if (separator < 0) {
    return protocol === undefined ? {} : { protocol };
  }
  const port = Number(endpoint.slice(separator + 1));
  const address = endpoint
    .slice(0, separator)
    .replace(/^\[/, "")
    .replace(/\]$/, "");
  return {
    ...(protocol === undefined ? {} : { protocol }),
    ...(address.length === 0 ? {} : { address }),
    ...(validNetworkPort(port) ? { port } : {}),
  };
}

function socketDescriptor(value: string): number | undefined {
  const descriptor = /^(\d+)(?:<|\s|,|$)/.exec(value.trim())?.[1];
  if (descriptor === undefined) {
    return undefined;
  }
  const parsed = Number(descriptor);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function networkEndpoint(
  record: ParsedStraceSyscallRecord,
  fallback?: NetworkEndpoint,
): Required<Pick<NetworkEndpoint, "protocol" | "address">> &
  Pick<NetworkEndpoint, "port"> {
  const firstArgument = splitTopLevelArguments(record.argumentsText)[0] ?? "";
  const descriptorAnnotation = annotatedDescriptorValue(firstArgument) ?? "";
  const annotatedEndpoint = annotatedNetworkEndpoint(descriptorAnnotation);
  const explicitProtocol = record.argumentsText.includes("AF_UNIX")
    ? ("unix" as const)
    : undefined;
  const protocol =
    annotatedEndpoint.protocol ??
    explicitProtocol ??
    fallback?.protocol ??
    "unknown";
  const ipv4 = /inet_addr\("([^"]+)"\)/.exec(record.argumentsText)?.[1];
  const ipv6 = /inet_pton\(AF_INET6,\s*"([^"]+)"/.exec(
    record.argumentsText,
  )?.[1];
  const unixPathMatch = /sun_path=(@?)"([^"]+)"/.exec(record.argumentsText);
  const unixPath =
    unixPathMatch?.[2] === undefined
      ? undefined
      : `${unixPathMatch[1] ?? ""}${unixPathMatch[2]}`;
  const address =
    ipv4 ??
    ipv6 ??
    unixPath ??
    annotatedEndpoint.address ??
    fallback?.address ??
    "unknown";
  const portText = /sin6?_port=htons\((\d+)\)/.exec(
    record.argumentsText,
  )?.[1];
  const explicitPort = portText === undefined ? undefined : Number(portText);
  const port = validNetworkPort(explicitPort ?? -1)
    ? explicitPort
    : annotatedEndpoint.port ?? fallback?.port;
  return { protocol, address, ...(port === undefined ? {} : { port }) };
}

function compatibleBoundEndpoint(
  bound: BoundNetworkEndpoint | undefined,
  currentAnnotation: string | undefined,
): NetworkEndpoint | undefined {
  if (bound === undefined || currentAnnotation === undefined) {
    return undefined;
  }
  if (bound.descriptorAnnotation === currentAnnotation) {
    return bound.endpoint;
  }

  const current = annotatedNetworkEndpoint(currentAnnotation);
  if (
    current.protocol !== undefined &&
    bound.endpoint.protocol !== undefined &&
    current.protocol !== bound.endpoint.protocol
  ) {
    return undefined;
  }
  if (
    current.address !== undefined &&
    bound.endpoint.address !== undefined &&
    current.address === bound.endpoint.address
  ) {
    return bound.endpoint;
  }
  return undefined;
}

type NetworkDescriptorTable = Map<number, BoundNetworkEndpoint>;

interface NetworkDescriptorState {
  readonly tableByPid: Map<number, NetworkDescriptorTable>;
}

function networkDescriptorTable(
  state: NetworkDescriptorState,
  pid: number,
): NetworkDescriptorTable {
  const existing = state.tableByPid.get(pid);
  if (existing !== undefined) {
    return existing;
  }
  const created: NetworkDescriptorTable = new Map();
  state.tableByPid.set(pid, created);
  return created;
}

function descriptorRangeBoundary(value: string): number | undefined {
  const trimmed = value.trim();
  if (/^(?:~0U|UINT_MAX)(?:\s|$)/.test(trimmed)) {
    return Number.MAX_SAFE_INTEGER;
  }
  const match = /^(\d+)(?:\s|$)/.exec(trimmed)?.[1];
  if (match === undefined) {
    return undefined;
  }
  const parsed = Number(match);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function invalidateDescriptorRange(
  table: NetworkDescriptorTable,
  firstArgument: string,
  lastArgument: string,
): void {
  const first = descriptorRangeBoundary(firstArgument);
  const last = descriptorRangeBoundary(lastArgument);
  if (first === undefined || last === undefined || first > last) {
    table.clear();
    return;
  }
  for (const descriptor of [...table.keys()]) {
    if (descriptor >= first && descriptor <= last) {
      table.delete(descriptor);
    }
  }
}

function closeRangeRequestsUnshare(flagsArgument: string): boolean {
  if (/\bCLOSE_RANGE_UNSHARE\b/.test(flagsArgument)) {
    return true;
  }
  const numericFlags = descriptorRangeBoundary(flagsArgument);
  return numericFlags !== undefined && (numericFlags & 2) !== 0;
}

function closeRangeRequestsCloexec(flagsArgument: string): boolean {
  if (/\bCLOSE_RANGE_CLOEXEC\b/.test(flagsArgument)) {
    return true;
  }
  const numericFlags = descriptorRangeBoundary(flagsArgument);
  return numericFlags !== undefined && (numericFlags & 4) !== 0;
}

function isFcntlDuplication(commandArgument: string): boolean {
  const trimmed = commandArgument.trim();
  return (
    /^F_DUPFD(?:_CLOEXEC)?(?:\s|$)/.test(trimmed) ||
    /^(?:0|1030)(?:\s|$)/.test(trimmed)
  );
}

function maintainNetworkDescriptorState(
  record: ParsedStraceSyscallRecord,
  state: NetworkDescriptorState,
): void {
  if (["clone", "clone3", "fork", "vfork"].includes(record.syscall)) {
    if (!syscallSucceeded(record.resultText)) {
      return;
    }
    const childPid = integerResult(record.resultText);
    if (childPid !== undefined && childPid > 0) {
      const parentTable = networkDescriptorTable(state, record.pid);
      state.tableByPid.set(
        childPid,
        /\bCLONE_FILES\b/.test(record.argumentsText)
          ? parentTable
          : new Map(parentTable),
      );
    }
    return;
  }

  const syscallArguments = splitTopLevelArguments(record.argumentsText);
  const firstDescriptor = socketDescriptor(syscallArguments[0] ?? "");
  const table = networkDescriptorTable(state, record.pid);
  if (record.syscall === "close" && firstDescriptor !== undefined) {
    // A missing/ambiguous close result cannot safely preserve a correlated
    // endpoint. Dropping it trades recall for avoiding a false later listen.
    table.delete(firstDescriptor);
    return;
  }

  if (record.syscall === "close_range") {
    const outcome = syscallOutcome(record.resultText);
    if (outcome === "failed") {
      return;
    }
    const requestsUnshare = closeRangeRequestsUnshare(
      syscallArguments[2] ?? "",
    );
    const affectedTable = requestsUnshare ? new Map(table) : table;
    if (requestsUnshare) {
      state.tableByPid.set(record.pid, affectedTable);
    }
    // CLOSE_RANGE_CLOEXEC marks descriptors for a future exec; it does not
    // close them now. Preserve endpoint identity until an exec actually makes
    // close-on-exec state observable. UNSHARE still detaches the caller's
    // table, because that part of the request takes effect immediately.
    if (closeRangeRequestsCloexec(syscallArguments[2] ?? "")) {
      return;
    }
    invalidateDescriptorRange(
      affectedTable,
      syscallArguments[0] ?? "",
      syscallArguments[1] ?? "",
    );
    return;
  }

  if (["dup", "dup2", "dup3"].includes(record.syscall)) {
    const outcome = syscallOutcome(record.resultText);
    if (outcome === "unknown" && record.syscall !== "dup") {
      const requestedTarget = socketDescriptor(syscallArguments[1] ?? "");
      if (requestedTarget !== undefined) {
        table.delete(requestedTarget);
      }
      return;
    }
    if (outcome !== "succeeded" || firstDescriptor === undefined) {
      return;
    }
    const targetDescriptor = integerResult(record.resultText);
    if (targetDescriptor === undefined || targetDescriptor < 0) {
      return;
    }
    const source = table.get(firstDescriptor);
    if (source === undefined) {
      table.delete(targetDescriptor);
    } else {
      table.set(targetDescriptor, source);
    }
    return;
  }

  if (
    ["fcntl", "fcntl64"].includes(record.syscall) &&
    isFcntlDuplication(syscallArguments[1] ?? "")
  ) {
    const outcome = syscallOutcome(record.resultText);
    if (outcome === "unknown") {
      const minimumTarget = descriptorRangeBoundary(
        syscallArguments[2] ?? "",
      );
      if (minimumTarget === undefined) {
        table.clear();
      } else {
        for (const descriptor of [...table.keys()]) {
          if (descriptor >= minimumTarget && descriptor !== firstDescriptor) {
            table.delete(descriptor);
          }
        }
      }
      return;
    }
    if (outcome !== "succeeded" || firstDescriptor === undefined) {
      return;
    }
    const targetDescriptor = integerResult(record.resultText);
    if (targetDescriptor === undefined || targetDescriptor < 0) {
      return;
    }
    const source = table.get(firstDescriptor);
    if (source === undefined) {
      table.delete(targetDescriptor);
    } else {
      table.set(targetDescriptor, source);
    }
    return;
  }

  if (
    [
      "accept",
      "accept4",
      "creat",
      "open",
      "openat",
      "openat2",
      "socket",
    ].includes(record.syscall) &&
    syscallSucceeded(record.resultText)
  ) {
    const createdDescriptor = integerResult(record.resultText);
    if (createdDescriptor !== undefined && createdDescriptor >= 0) {
      table.delete(createdDescriptor);
    }
  }

  if (record.syscall === "socketpair" && syscallSucceeded(record.resultText)) {
    for (const match of record.argumentsText.matchAll(/(?:^|[\[,\s])(\d+)</g)) {
      const descriptor = Number(match[1]);
      if (Number.isSafeInteger(descriptor)) {
        table.delete(descriptor);
      }
    }
  }
}

function normalizeNetwork(
  record: ParsedStraceSyscallRecord,
  state: NetworkDescriptorState,
): ObservedEffectV1 | undefined {
  maintainNetworkDescriptorState(record, state);
  if (!["bind", "connect", "listen"].includes(record.syscall)) {
    return undefined;
  }
  if (isNetlinkEndpoint(record)) {
    return undefined;
  }

  const firstArgument = splitTopLevelArguments(record.argumentsText)[0] ?? "";
  const descriptor = socketDescriptor(firstArgument);
  const table = networkDescriptorTable(state, record.pid);
  const descriptorAnnotation = annotatedDescriptorValue(firstArgument);
  const fallback =
    record.syscall === "listen" && descriptor !== undefined
      ? compatibleBoundEndpoint(table.get(descriptor), descriptorAnnotation)
      : undefined;
  const endpoint = networkEndpoint(record, fallback);
  const outcome = canonicalSyscallOutcome(record.resultText);

  if (record.syscall === "bind") {
    if (outcome?.status === "succeeded" && descriptor !== undefined) {
      table.set(descriptor, {
        endpoint,
        ...(descriptorAnnotation === undefined ? {} : { descriptorAnnotation }),
      });
    }
    // Stream sockets do not receive peers until listen(2). A datagram bind is
    // itself a receiving endpoint. Failed binds are not mislabeled as listen
    // attempts; V1 has no exact effect kind for them.
    if (outcome?.status !== "succeeded" || endpoint.protocol !== "udp") {
      return undefined;
    }
  }

  if (outcome === undefined) {
    return undefined;
  }

  return {
    kind:
      record.syscall === "connect"
        ? "network.connect_attempt"
        : "network.listen",
    protocol: endpoint.protocol,
    address: endpoint.address,
    ...(endpoint.port === undefined ? {} : { port: endpoint.port }),
    outcome,
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

const policyRelevantTraceGapCategoryOrder: readonly PolicyRelevantTraceGapCategory[] = [
  "filesystem_mutation",
  "data_transfer",
  "escape_or_interference",
  "opaque_io",
  "failed_capability_probe",
  "network_endpoint",
  "alternate_file_access",
  "indeterminate_outcome",
  "truncated_arguments",
  "unresolved_path",
];

function boundedTraceGapExampleLimit(value: number | undefined): number {
  if (value === undefined) {
    return 5;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("maxExamples must be a nonnegative safe integer");
  }
  return Math.min(value, maxPolicyRelevantTraceGapExamples);
}

function relevantPathPrefixes(
  value: readonly string[] | undefined,
): readonly string[] {
  const requested = value ?? defaultPolicyRelevantPathPrefixes;
  if (requested.length > 16) {
    throw new RangeError("relevantPathPrefixes cannot contain more than 16 paths");
  }
  const normalized = requested.map((prefix) => {
    if (!prefix.startsWith("/")) {
      throw new TypeError("relevantPathPrefixes must be absolute paths");
    }
    return posix.normalize(prefix);
  });
  return [...new Set(normalized)].sort();
}

function pathIsWithin(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) =>
      prefix === "/" || path === prefix || path.startsWith(`${prefix}/`),
  );
}

function truncatedPathCouldBeRelevant(
  path: string,
  prefixes: readonly string[],
): boolean {
  const normalized = posix.normalize(path);
  return (
    pathIsWithin(normalized, prefixes) ||
    prefixes.some((prefix) => prefix.startsWith(normalized))
  );
}

function isMutatingOpen(record: ParsedStraceSyscallRecord): boolean {
  return (
    ["open", "openat", "openat2"].includes(record.syscall) &&
    /\bO_(?:CREAT|TMPFILE)\b/.test(record.argumentsText)
  );
}

function isTruncatingOpen(record: ParsedStraceSyscallRecord): boolean {
  return (
    ["open", "openat", "openat2"].includes(record.syscall) &&
    /\bO_TRUNC\b/.test(record.argumentsText) &&
    !/\bO_TMPFILE\b/.test(record.argumentsText)
  );
}

function hasUnresolvedOrdinaryOpenPath(
  record: ParsedStraceSyscallRecord,
  pathMappings: readonly ObservedPathMapping[],
  prefixes: readonly string[],
): boolean {
  if (
    !["open", "openat", "openat2"].includes(record.syscall) ||
    isMutatingOpen(record) ||
    isTruncatingOpen(record) ||
    syscallOutcome(record.resultText) === "succeeded"
  ) {
    return false;
  }

  const syscallArguments = splitTopLevelArguments(record.argumentsText);
  const pathnameIndex = record.syscall === "open" ? 0 : 1;
  const pathname = quotedStringMatches(
    syscallArguments[pathnameIndex] ?? "",
  )[0];
  if (pathname === undefined) {
    return false;
  }

  const descriptorPath =
    record.syscall === "open"
      ? undefined
      : annotatedDescriptorPath(syscallArguments[0] ?? "");
  if (!pathname.truncated) {
    return !pathname.value.startsWith("/") && descriptorPath === undefined;
  }

  const plausiblePath = pathname.value.startsWith("/")
    ? canonicalPath(pathname.value, pathMappings)
    : descriptorPath === undefined
      ? undefined
      : canonicalPath(
          posix.resolve(descriptorPath, pathname.value),
          pathMappings,
        );
  return (
    plausiblePath === undefined ||
    truncatedPathCouldBeRelevant(plausiblePath, prefixes)
  );
}

interface MutationPathAssessment {
  readonly paths: readonly string[];
  readonly unresolved: boolean;
}

function resolvePathArgument(
  syscallArguments: readonly string[],
  pathIndex: number,
  directoryDescriptorIndex?: number,
): string | undefined {
  const pathname = quotedStringMatches(syscallArguments[pathIndex] ?? "")[0];
  if (pathname === undefined || pathname.truncated) {
    return undefined;
  }
  if (pathname.value.startsWith("/")) {
    return posix.normalize(pathname.value);
  }
  const descriptorPath =
    directoryDescriptorIndex === undefined
      ? undefined
      : annotatedDescriptorPath(
          syscallArguments[directoryDescriptorIndex] ?? "",
        );
  if (pathname.value.length === 0) {
    return /\bAT_EMPTY_PATH\b/.test(syscallArguments.join(","))
      ? descriptorPath
      : undefined;
  }
  return descriptorPath === undefined
    ? undefined
    : posix.resolve(descriptorPath, pathname.value);
}

function mutationPathAssessment(
  record: ParsedStraceSyscallRecord,
  pathMappings: readonly ObservedPathMapping[],
): MutationPathAssessment | undefined {
  if (
    !isMutatingOpen(record) &&
    !unsupportedFilesystemMutationSyscalls.has(record.syscall)
  ) {
    return undefined;
  }

  const syscallArguments = splitTopLevelArguments(record.argumentsText);
  const candidates: Array<string | undefined> = [];
  if (isMutatingOpen(record)) {
    const resultPath = annotatedDescriptorPath(record.resultText);
    if (resultPath !== undefined) {
      candidates.push(resultPath);
    } else if (record.syscall === "open") {
      candidates.push(resolvePathArgument(syscallArguments, 0));
    } else {
      candidates.push(resolvePathArgument(syscallArguments, 1, 0));
    }
  } else if (
    [
      "chmod",
      "chown",
      "creat",
      "lchown",
      "lremovexattr",
      "lsetxattr",
      "mkdir",
      "mknod",
      "removexattr",
      "rmdir",
      "setxattr",
      "truncate",
      "utime",
      "utimes",
    ].includes(record.syscall)
  ) {
    candidates.push(resolvePathArgument(syscallArguments, 0));
  } else if (
    [
      "fallocate",
      "fchmod",
      "fchown",
      "fremovexattr",
      "fsetxattr",
      "ftruncate",
    ].includes(record.syscall)
  ) {
    candidates.push(annotatedDescriptorPath(syscallArguments[0] ?? ""));
  } else if (
    [
      "fchmodat",
      "fchmodat2",
      "fchownat",
      "futimesat",
      "mkdirat",
      "mknodat",
      "utimensat",
    ].includes(record.syscall)
  ) {
    candidates.push(resolvePathArgument(syscallArguments, 1, 0));
  } else if (["link", "rename"].includes(record.syscall)) {
    candidates.push(
      resolvePathArgument(syscallArguments, 0),
      resolvePathArgument(syscallArguments, 1),
    );
  } else if (["linkat", "renameat", "renameat2"].includes(record.syscall)) {
    candidates.push(
      resolvePathArgument(syscallArguments, 1, 0),
      resolvePathArgument(syscallArguments, 3, 2),
    );
  } else if (record.syscall === "symlink") {
    candidates.push(resolvePathArgument(syscallArguments, 1));
  } else if (record.syscall === "symlinkat") {
    candidates.push(resolvePathArgument(syscallArguments, 2, 1));
  }

  if (candidates.length === 0) {
    return { paths: [], unresolved: true };
  }
  const unresolved = candidates.some((candidate) => candidate === undefined);
  const paths = candidates.flatMap((candidate) =>
    candidate === undefined
      ? []
      : [canonicalPath(candidate, pathMappings)],
  );
  return { paths: [...new Set(paths)].sort(), unresolved };
}

function hasUnresolvedPolicyRelevantPath(
  record: ParsedStraceSyscallRecord,
  pathMappings: readonly ObservedPathMapping[],
  prefixes: readonly string[],
): boolean {
  if (record.syscall === "execveat") {
    return resolveExecveatPath(record, pathMappings) === undefined;
  }
  if (record.syscall === "execve") {
    const firstArgument = splitTopLevelArguments(record.argumentsText)[0] ?? "";
    const executable = quotedStringMatches(firstArgument)[0];
    return (
      executable === undefined ||
      executable.truncated ||
      !executable.value.startsWith("/")
    );
  }
  if (["unlink", "unlinkat"].includes(record.syscall)) {
    return resolveArgumentPath(record.argumentsText) === undefined;
  }
  if (hasUnresolvedOrdinaryOpenPath(record, pathMappings, prefixes)) {
    return true;
  }
  if (directoryReadSyscalls.has(record.syscall)) {
    const bytes = integerResult(record.resultText);
    const attemptedRead =
      syscallOutcome(record.resultText) !== "succeeded" ||
      (bytes !== undefined && bytes > 0);
    return (
      attemptedRead &&
      annotatedDescriptorPath(record.argumentsText) === undefined
    );
  }
  if (isTruncatingOpen(record)) {
    return syscallOutcome(record.resultText) === "succeeded"
      ? annotatedDescriptorPath(record.resultText) === undefined
      : resolveArgumentPath(record.argumentsText) === undefined;
  }
  return false;
}

function isRelevantFileMapping(
  record: ParsedStraceSyscallRecord,
  pathMappings: readonly ObservedPathMapping[],
  prefixes: readonly string[],
): boolean {
  if (
    !["mmap", "mmap2"].includes(record.syscall)
  ) {
    return false;
  }
  const syscallArguments = splitTopLevelArguments(record.argumentsText);
  if (/\bMAP_ANONYMOUS\b/.test(syscallArguments[3] ?? "")) {
    return false;
  }
  const path = annotatedDescriptorPath(syscallArguments[4] ?? "");
  return (
    path !== undefined &&
    pathIsWithin(canonicalPath(path, pathMappings), prefixes)
  );
}

function isRelevantDirectoryEnumeration(
  record: ParsedStraceSyscallRecord,
  pathMappings: readonly ObservedPathMapping[],
  prefixes: readonly string[],
): boolean {
  if (!directoryReadSyscalls.has(record.syscall)) {
    return false;
  }
  const bytes = integerResult(record.resultText);
  const path = annotatedDescriptorPath(record.argumentsText);
  return (
    syscallSucceeded(record.resultText) &&
    bytes !== undefined &&
    bytes > 0 &&
    path !== undefined &&
    pathIsWithin(canonicalPath(path, pathMappings), prefixes)
  );
}

interface MetadataProbeAssessment {
  readonly path?: string;
  readonly unresolvedRelevant: boolean;
}

function metadataProbeAssessment(
  record: ParsedStraceSyscallRecord,
  pathMappings: readonly ObservedPathMapping[],
  prefixes: readonly string[],
): MetadataProbeAssessment | undefined {
  const syscallArguments = splitTopLevelArguments(record.argumentsText);
  if (metadataDescriptorProbeSyscalls.has(record.syscall)) {
    const descriptorPath = annotatedDescriptorPath(syscallArguments[0] ?? "");
    return descriptorPath === undefined
      ? undefined
      : {
          path: canonicalPath(descriptorPath, pathMappings),
          unresolvedRelevant: false,
        };
  }

  let pathIndex: number;
  let directoryDescriptorIndex: number | undefined;
  if (metadataPathProbeSyscalls.has(record.syscall)) {
    pathIndex = 0;
    directoryDescriptorIndex = undefined;
  } else if (metadataAtPathProbeSyscalls.has(record.syscall)) {
    pathIndex = 1;
    directoryDescriptorIndex = 0;
  } else {
    return undefined;
  }

  const pathname = quotedStringMatches(syscallArguments[pathIndex] ?? "")[0];
  const descriptorArgument =
    directoryDescriptorIndex === undefined
      ? ""
      : (syscallArguments[directoryDescriptorIndex] ?? "");
  const descriptorPath = annotatedDescriptorPath(descriptorArgument);
  const canonicalDescriptorPath =
    descriptorPath === undefined
      ? undefined
      : canonicalPath(descriptorPath, pathMappings);
  if (pathname === undefined) {
    return undefined;
  }
  if (pathname.truncated) {
    const plausiblePath = pathname.value.startsWith("/")
      ? canonicalPath(pathname.value, pathMappings)
      : canonicalDescriptorPath === undefined
        ? undefined
        : posix.resolve(canonicalDescriptorPath, pathname.value);
    return {
      unresolvedRelevant:
        plausiblePath === undefined
          ? true
          : truncatedPathCouldBeRelevant(plausiblePath, prefixes),
    };
  }

  let resolvedPath: string | undefined;
  if (pathname.value.startsWith("/")) {
    resolvedPath = canonicalPath(pathname.value, pathMappings);
  } else if (pathname.value.length > 0 && canonicalDescriptorPath !== undefined) {
    resolvedPath = posix.resolve(canonicalDescriptorPath, pathname.value);
  } else if (
    pathname.value.length === 0 &&
    /^\d+</.test(descriptorArgument.trim()) &&
    canonicalDescriptorPath !== undefined &&
    (record.syscall === "readlinkat" ||
      /\bAT_EMPTY_PATH\b/.test(record.argumentsText))
  ) {
    resolvedPath = canonicalDescriptorPath;
  }

  if (resolvedPath === undefined) {
    return { unresolvedRelevant: true };
  }
  return { path: resolvedPath, unresolvedRelevant: false };
}

function isLocalOnlyNetworkTransfer(
  record: ParsedStraceSyscallRecord,
): boolean {
  const firstArgument = splitTopLevelArguments(record.argumentsText)[0] ?? "";
  const descriptorAnnotation = annotatedDescriptorValue(firstArgument) ?? "";
  return (
    /\bAF_(?:NETLINK|UNIX|LOCAL)\b/.test(record.argumentsText) ||
    descriptorAnnotation.startsWith("NETLINK") ||
    descriptorAnnotation.startsWith("UNIX")
  );
}

function isInternetSocketDescriptorIo(
  record: ParsedStraceSyscallRecord,
): boolean {
  if (
    !fileReadSyscalls.has(record.syscall) &&
    !fileWriteSyscalls.has(record.syscall)
  ) {
    return false;
  }
  const firstArgument = splitTopLevelArguments(record.argumentsText)[0] ?? "";
  const descriptorAnnotation = annotatedDescriptorValue(firstArgument) ?? "";
  return (
    descriptorAnnotation.startsWith("TCP") ||
    descriptorAnnotation.startsWith("UDP")
  );
}

function isNetlinkEndpoint(record: ParsedStraceSyscallRecord): boolean {
  const firstArgument = splitTopLevelArguments(record.argumentsText)[0] ?? "";
  const descriptorAnnotation = annotatedDescriptorValue(firstArgument) ?? "";
  return (
    /\bAF_NETLINK\b/.test(record.argumentsText) ||
    descriptorAnnotation.startsWith("NETLINK")
  );
}

function isSignalZeroProbe(record: ParsedStraceSyscallRecord): boolean {
  const signalIndex =
    record.syscall === "tgkill"
      ? 2
      : ["kill", "pidfd_send_signal", "tkill"].includes(record.syscall)
        ? 1
        : undefined;
  if (signalIndex === undefined) {
    return false;
  }
  const signalArgument =
    splitTopLevelArguments(record.argumentsText)[signalIndex] ?? "";
  const numericSignal = /^([+-]?\d+)(?:\s|$)/.exec(signalArgument)?.[1];
  return numericSignal !== undefined && Number(numericSignal) === 0;
}

function unknownCanonicalOutcomeGapCategory(
  record: ParsedStraceSyscallRecord,
  options: {
    readonly pathMappings: readonly ObservedPathMapping[];
    readonly relevantPathPrefixes: readonly string[];
  },
): PolicyRelevantTraceGapCategory | undefined {
  if (syscallOutcome(record.resultText) !== "unknown") {
    return undefined;
  }

  if (["execve", "execveat"].includes(record.syscall)) {
    return "indeterminate_outcome";
  }
  if (
    ["bind", "connect", "listen"].includes(record.syscall) &&
    !isNetlinkEndpoint(record)
  ) {
    return "network_endpoint";
  }

  let path: string | undefined;
  let category: PolicyRelevantTraceGapCategory | undefined;
  if (["unlink", "unlinkat"].includes(record.syscall)) {
    path = resolveArgumentPath(record.argumentsText);
    category = "filesystem_mutation";
  } else if (["open", "openat", "openat2"].includes(record.syscall)) {
    path = resolveArgumentPath(record.argumentsText);
    category = isTruncatingOpen(record)
      ? "filesystem_mutation"
      : "alternate_file_access";
  } else if (fileWriteSyscalls.has(record.syscall)) {
    path = annotatedDescriptorPath(record.argumentsText);
    category = "filesystem_mutation";
  } else if (
    fileReadSyscalls.has(record.syscall) ||
    directoryReadSyscalls.has(record.syscall)
  ) {
    path = annotatedDescriptorPath(record.argumentsText);
    category = "alternate_file_access";
  } else if (["mmap", "mmap2"].includes(record.syscall)) {
    const syscallArguments = splitTopLevelArguments(record.argumentsText);
    if (/\bMAP_ANONYMOUS\b/.test(syscallArguments[3] ?? "")) {
      return undefined;
    }
    path = annotatedDescriptorPath(syscallArguments[4] ?? "");
    category = "alternate_file_access";
  }

  if (path === undefined || category === undefined) {
    return undefined;
  }
  return pathIsWithin(
    canonicalPath(path, options.pathMappings),
    options.relevantPathPrefixes,
  )
    ? category
    : undefined;
}

function policyRelevantTraceGapCategory(
  record: ParsedStraceSyscallRecord,
  options: {
    readonly pathMappings: readonly ObservedPathMapping[];
    readonly relevantPathPrefixes: readonly string[];
  },
): PolicyRelevantTraceGapCategory | undefined {
  if (execArgumentsAreTruncated(record)) {
    return "truncated_arguments";
  }
  const mutation = mutationPathAssessment(record, options.pathMappings);
  if (mutation !== undefined) {
    if (mutation.unresolved) {
      return "unresolved_path";
    }
    return mutation.paths.some((path) =>
      pathIsWithin(path, options.relevantPathPrefixes),
    )
      ? "filesystem_mutation"
      : undefined;
  }
  if (
    hasUnresolvedPolicyRelevantPath(
      record,
      options.pathMappings,
      options.relevantPathPrefixes,
    )
  ) {
    return "unresolved_path";
  }
  const unknownCanonicalOutcome = unknownCanonicalOutcomeGapCategory(
    record,
    options,
  );
  if (unknownCanonicalOutcome !== undefined) {
    return unknownCanonicalOutcome;
  }
  if (
    isRelevantDirectoryEnumeration(
      record,
      options.pathMappings,
      options.relevantPathPrefixes,
    )
  ) {
    return "alternate_file_access";
  }
  const metadataProbe = metadataProbeAssessment(
    record,
    options.pathMappings,
    options.relevantPathPrefixes,
  );
  if (metadataProbe?.unresolvedRelevant === true) {
    return "unresolved_path";
  }
  if (
    metadataProbe?.path !== undefined &&
    pathIsWithin(metadataProbe.path, options.relevantPathPrefixes)
  ) {
    return "alternate_file_access";
  }
  if (record.syscall === "bind" && !isNetlinkEndpoint(record)) {
    return "network_endpoint";
  }
  if (
    isInternetSocketDescriptorIo(record) &&
    (fileWriteSyscalls.has(record.syscall) ||
      (fileReadSyscalls.has(record.syscall) &&
        syscallSucceeded(record.resultText) &&
        (integerResult(record.resultText) ?? 0) > 0))
  ) {
    return "data_transfer";
  }
  if (
    !isLocalOnlyNetworkTransfer(record) &&
    (unsupportedDataTransferAttemptSyscalls.has(record.syscall) ||
      (unsupportedSuccessfulReceiveSyscalls.has(record.syscall) &&
        syscallSucceeded(record.resultText)))
  ) {
    return "data_transfer";
  }
  if (
    unsupportedEscapeOrInterferenceAttemptSyscalls.has(record.syscall) ||
    (["clone", "clone3"].includes(record.syscall) &&
      /\bCLONE_NEW[A-Z_]+\b/.test(record.argumentsText))
  ) {
    if (isSignalZeroProbe(record)) {
      return undefined;
    }
    return "escape_or_interference";
  }
  if (
    record.syscall === "io_uring_setup" &&
    syscallOutcome(record.resultText) === "failed"
  ) {
    // No ring descriptor exists after a definitive setup failure, so this
    // record cannot represent opaque ring I/O. The category describes the
    // failed capability setup attempt without inferring why it was made.
    return "failed_capability_probe";
  }
  if (unsupportedOpaqueIoSyscalls.has(record.syscall)) {
    return "opaque_io";
  }
  if (
    isRelevantFileMapping(
      record,
      options.pathMappings,
      options.relevantPathPrefixes,
    )
  ) {
    return "alternate_file_access";
  }
  return undefined;
}

/**
 * Classifies parsed syscalls that can affect Forge's runtime policy but do not
 * yet have a lossless canonical V1 event. This is coverage metadata, not a
 * behavior finding: in particular mmap records prove a mapping, not page use.
 */
export function classifyPolicyRelevantTraceGaps(
  records: readonly ParsedStraceRecord[],
  options: ClassifyPolicyRelevantTraceGapOptions = {},
): PolicyRelevantTraceGapClassification {
  const maxExamples = boundedTraceGapExampleLimit(options.maxExamples);
  const pathMappings = options.pathMappings ?? [];
  const prefixes = relevantPathPrefixes(options.relevantPathPrefixes);
  const categoryCounts = new Map<PolicyRelevantTraceGapCategory, number>();
  const syscallCounts = new Map<string, number>();
  const outcomeCounts = new Map<PolicyRelevantTraceGapOutcome, number>();
  const examples: PolicyRelevantTraceGapExample[] = [];
  let recordCount = 0;

  const orderedRecords = [...records].sort(
    (left, right) =>
      left.timestampSeconds - right.timestampSeconds ||
      left.rawRef.localeCompare(right.rawRef),
  );
  for (const record of orderedRecords) {
    if (record.kind !== "syscall") {
      continue;
    }
    const category = policyRelevantTraceGapCategory(record, {
      pathMappings,
      relevantPathPrefixes: prefixes,
    });
    if (category === undefined) {
      continue;
    }
    recordCount += 1;
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    syscallCounts.set(
      record.syscall,
      (syscallCounts.get(record.syscall) ?? 0) + 1,
    );
    const outcome = syscallOutcome(record.resultText);
    outcomeCounts.set(outcome, (outcomeCounts.get(outcome) ?? 0) + 1);
    if (examples.length < maxExamples) {
      examples.push({
        category,
        syscall: record.syscall,
        rawRef: record.rawRef,
        outcome,
      });
    }
  }

  return {
    recordCount,
    categoryCounts: policyRelevantTraceGapCategoryOrder.flatMap((category) => {
      const count = categoryCounts.get(category);
      return count === undefined ? [] : [{ category, recordCount: count }];
    }),
    syscallCounts: [...syscallCounts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([syscall, count]) => ({ syscall, recordCount: count })),
    outcomeCounts: ([
      "succeeded",
      "failed",
      "unknown",
    ] as const).flatMap((outcome) => {
      const count = outcomeCounts.get(outcome);
      return count === undefined ? [] : [{ outcome, recordCount: count }];
    }),
    examples,
    truncatedExampleCount: recordCount - examples.length,
  };
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
  const networkDescriptorState: NetworkDescriptorState = {
    tableByPid: new Map(),
  };

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
      normalizeExec(record, pathMappings) ??
      (record.kind === "syscall"
        ? normalizeNetwork(record, networkDescriptorState) ??
          normalizeFile(record, pathMappings)
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
