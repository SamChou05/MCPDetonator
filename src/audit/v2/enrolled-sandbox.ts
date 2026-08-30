import { randomBytes } from "node:crypto";
import { isAbsolute, normalize, parse, posix } from "node:path";

import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  executionBoundsV2Schema,
  normalizedNodeInvocationV2AlphaSchema,
  type ExecutionBoundsV2,
} from "../../contracts/v2/index.js";
import {
  MCP_STDIO_MESSAGE_BUFFER_BYTES,
  type DockerMcpInvocation,
} from "../../sandbox/docker.js";
import {
  targetContainerRoot,
  type PreparedTarget,
} from "../../target/prepare.js";
import { canonicalizeJson, digestCanonicalJson } from "./canonical.js";
import {
  CONTROLLED_SANDBOX_IMAGE_ID,
  CONTROLLED_SANDBOX_IMAGE_REFERENCE,
} from "./controlled-fixture.js";
import { deepFreezeJson } from "./freeze.js";
import type { NormalizedEnrolledNodeInvocation } from "./enrolled-runtime.js";
import { cloneStrictBoundedJson } from "./strict-clone.js";

export const enrolledSyntheticContainerRoot = "/forge/synthetic" as const;
export const ENROLLED_NODE_STDIO_EXECUTION_CLASS =
  "enrolled_node_stdio_single_call" as const;
export const ENROLLED_NODE_INVOCATION_FORMAT =
  "forge.enrolled-node-invocation/v1alpha1" as const;
export const ENROLLED_NODE_STDIO_SANDBOX_IDENTITY = Object.freeze({
  id: "forge-enrolled-node-stdio-sandbox",
  version: "1alpha1",
});

const enrolledBackendProfileFormat =
  "forge.enrolled-node-stdio-backend/v1alpha1" as const;
const enrolledDockerInvocationFormat =
  "forge.enrolled-node-stdio-docker-invocation/v1alpha1" as const;
const controllerEnvironment = [
  "HOME=/tmp",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "NODE_ENV=production",
] as const;
const maximumHostPathBytes = 4_096;
const unsafeControlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;
const controllerIdentifierPattern =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const immutableImageIdPattern = /^sha256:[a-f0-9]{64}$/u;

const smallControllerInputLimits = Object.freeze({
  maxDepth: 8,
  maxNodes: 256,
  maxObjectKeys: 32,
  maxStringCharacters: 40_000,
  maxSerializedBytes: 64_000,
});

export type NormalizedEnrolledNodeInvocationForSandbox =
  Readonly<NormalizedEnrolledNodeInvocation>;

/**
 * Structural result of the existing pinned-image verifier. The enrolled path
 * accepts the same reviewed image bytes but never executes its mutable lookup
 * tag. Runtime validation below makes this type annotation non-authoritative.
 */
export interface VerifiedV2SandboxImage {
  readonly imageReference: typeof CONTROLLED_SANDBOX_IMAGE_REFERENCE;
  readonly imageId: typeof CONTROLLED_SANDBOX_IMAGE_ID;
  readonly declaredVolumes: false;
}

export interface EnrolledSandboxResources {
  readonly hostRoot: string;
  readonly manifestDigest: string;
}

export interface EnrolledSandboxBindMount {
  readonly type: "bind";
  readonly source: string;
  readonly destination: string;
  readonly readonly: true;
}

export interface EnrolledSandboxResourceMount
  extends EnrolledSandboxBindMount {
  readonly destination: typeof enrolledSyntheticContainerRoot;
  readonly manifestDigest: string;
}

export interface EnrolledNodeStdioBackendProfile {
  readonly format: typeof enrolledBackendProfileFormat;
  readonly executionClass: typeof ENROLLED_NODE_STDIO_EXECUTION_CLASS;
  readonly network: "none";
  readonly ipc: "none";
  readonly logDriver: "none";
  readonly pullPolicy: "never";
  readonly maxCalls: 1;
  readonly maxRetries: 0;
  readonly resultExposure: "local_quarantine_only";
  readonly sandboxImageReference: typeof CONTROLLED_SANDBOX_IMAGE_REFERENCE;
  readonly sandboxImageId: typeof CONTROLLED_SANDBOX_IMAGE_ID;
  readonly imageHasDeclaredVolumes: false;
  readonly hardMcpMessageBytes: number;
  readonly hardRuntimeMs: number;
  readonly hardWritableBytes: number;
  readonly hardWritableFiles: number;
  readonly hardFileBytes: number;
  readonly hardProcesses: number;
  readonly hardMemoryMb: number;
  readonly hardCpuMs: number;
  readonly hardOpenFiles: number;
  readonly readonlyTargetMount: true;
  readonly readonlySyntheticResourceMount: true;
  readonly readonlyMessageQueueMount: true;
  readonly writableRootFilesystem: false;
  readonly writableHostBinds: false;
  readonly providerAvailable: false;
  readonly cleanupVerification: true;
  readonly targetMount: EnrolledSandboxBindMount & {
    readonly destination: typeof targetContainerRoot;
  };
  readonly syntheticResourceMount: EnrolledSandboxResourceMount;
  readonly messageQueueMount: Readonly<{
    destination: "/dev/mqueue";
    readonly: true;
    noexec: true;
    nosuid: true;
    nodev: true;
    sizeBytes: 4_096;
    inodeLimit: 1;
    mode: "0555";
  }>;
  readonly temporaryFilesystem: Readonly<{
    destination: "/tmp";
    readonly: false;
    noexec: true;
    nosuid: true;
    nodev: true;
    sizeBytes: number;
    inodeLimit: number;
    uid: 65_534;
    gid: 65_534;
    mode: "0700";
  }>;
  readonly containerProcess: Readonly<{
    interactive: true;
    hostname: "forge-enrolled-target";
    init: true;
    user: "65534:65534";
    capabilities: "drop_all";
    noNewPrivileges: true;
    cpuQuotaCpus: 1;
    stopTimeoutSeconds: 2;
    rootFilesystem: "readonly";
    workdir: typeof targetContainerRoot;
    environmentResetExecutable: "/usr/bin/env";
    environmentResetArgument: "-i";
    controllerEnvironment: readonly [
      "HOME=/tmp",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "NODE_ENV=production",
    ];
    runtime: NormalizedEnrolledNodeInvocationForSandbox;
  }>;
  readonly approvedBounds: Readonly<ExecutionBoundsV2>;
}

export interface EnrolledNodeStdioDockerInvocation
  extends DockerMcpInvocation {
  readonly experimentId: string;
  readonly backend: Readonly<EnrolledNodeStdioBackendProfile>;
  readonly backendProfileDigest: string;
  readonly invocationDigest: string;
}

function safeDockerToken(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_.-]/gu, "-");
  if (sanitized.length === 0) {
    throw new Error("enrolled Docker token cannot be empty");
  }
  return sanitized.slice(0, 48);
}

function validateControllerIdentifier(value: string, label: string): void {
  if (!controllerIdentifierPattern.test(value)) {
    throw new Error(`${label} is not a bounded controller identifier`);
  }
}

function assertExactDataKeys(
  value: object,
  expectedKeys: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    canonicalizeJson((keys as string[]).sort()) !==
      canonicalizeJson([...expectedKeys].sort())
  ) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      throw new Error(`${label} must contain only enumerable data fields`);
    }
  }
}

function validateHostMountPath(value: string, label: string): void {
  try {
    canonicalizeJson(value);
  } catch {
    throw new Error(`${label} contains invalid Unicode`);
  }
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumHostPathBytes ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    parse(value).root === value ||
    value.includes(",") ||
    unsafeControlCharacters.test(value)
  ) {
    throw new Error(`${label} is not a safe exact Docker bind source`);
  }
}

function validateRuntimeText(value: string, label: string): void {
  if (unsafeControlCharacters.test(value)) {
    throw new Error(`${label} contains unsupported control characters`);
  }
}

function runtimeDigestPayload(
  runtime: Omit<NormalizedEnrolledNodeInvocationForSandbox, "digest">,
): Omit<NormalizedEnrolledNodeInvocationForSandbox, "digest"> {
  return {
    format: ENROLLED_NODE_INVOCATION_FORMAT,
    transport: "stdio",
    protocol: "mcp",
    descriptorCommand: "node",
    executable: "/usr/local/bin/node",
    cwd: targetContainerRoot,
    entrypoint: runtime.entrypoint,
    applicationArgs: [...runtime.applicationArgs],
    environment: {},
  };
}

function validateNormalizedRuntime(
  candidate: NormalizedEnrolledNodeInvocationForSandbox,
): NormalizedEnrolledNodeInvocationForSandbox {
  const detached = cloneStrictBoundedJson(
    candidate,
    smallControllerInputLimits,
    "normalized enrolled Node invocation",
  ).clone;
  const runtime = normalizedNodeInvocationV2AlphaSchema.parse(detached);
  validateRuntimeText(runtime.entrypoint, "enrolled entrypoint");
  for (const [index, argument] of runtime.applicationArgs.entries()) {
    validateRuntimeText(argument, `enrolled application argument ${index}`);
  }
  if (
    !posix.isAbsolute(runtime.entrypoint) ||
    posix.normalize(runtime.entrypoint) !== runtime.entrypoint
  ) {
    throw new Error("enrolled entrypoint must be a normalized absolute path");
  }
  const relativeEntrypoint = posix.relative(
    targetContainerRoot,
    runtime.entrypoint,
  );
  if (
    relativeEntrypoint.length === 0 ||
    relativeEntrypoint === ".." ||
    relativeEntrypoint.startsWith("../") ||
    posix.isAbsolute(relativeEntrypoint)
  ) {
    throw new Error("enrolled entrypoint must remain beneath /opt/target");
  }
  const expectedDigest = digestCanonicalJson(
    "forge.enrolled-node-invocation",
    "v1alpha1",
    runtimeDigestPayload(runtime),
  );
  if (runtime.digest !== expectedDigest) {
    throw new Error("normalized enrolled Node invocation digest changed");
  }
  return deepFreezeJson(runtime) as NormalizedEnrolledNodeInvocationForSandbox;
}

function validateBounds(candidate: ExecutionBoundsV2): ExecutionBoundsV2 {
  const detached = cloneStrictBoundedJson(
    candidate,
    smallControllerInputLimits,
    "enrolled sandbox execution bounds",
  ).clone;
  const bounds = executionBoundsV2Schema.parse(detached);
  if (bounds.maxCpuMs % 1_000 !== 0) {
    throw new Error("enrolled sandbox requires whole-second CPU bounds");
  }
  if (bounds.maxOutputBytesPerStep > MCP_STDIO_MESSAGE_BUFFER_BYTES) {
    throw new Error(
      "enrolled output bound exceeds the hard MCP message buffer",
    );
  }
  return bounds;
}

function validateImage(candidate: VerifiedV2SandboxImage): VerifiedV2SandboxImage {
  const image = cloneStrictBoundedJson(
    candidate,
    smallControllerInputLimits,
    "verified V2 sandbox image",
  ).clone;
  assertExactDataKeys(
    image,
    ["imageReference", "imageId", "declaredVolumes"],
    "verified V2 sandbox image",
  );
  if (
    image.imageReference !== CONTROLLED_SANDBOX_IMAGE_REFERENCE ||
    image.imageId !== CONTROLLED_SANDBOX_IMAGE_ID ||
    image.declaredVolumes !== false ||
    !immutableImageIdPattern.test(image.imageId)
  ) {
    throw new Error(
      "enrolled sandbox requires the exact verified immutable V2 image without declared volumes",
    );
  }
  return Object.freeze(image);
}

function assertProfileInvariants(
  profile: Readonly<EnrolledNodeStdioBackendProfile>,
): void {
  assertExactDataKeys(
    profile,
    [
      "format",
      "executionClass",
      "network",
      "ipc",
      "logDriver",
      "pullPolicy",
      "maxCalls",
      "maxRetries",
      "resultExposure",
      "sandboxImageReference",
      "sandboxImageId",
      "imageHasDeclaredVolumes",
      "hardMcpMessageBytes",
      "hardRuntimeMs",
      "hardWritableBytes",
      "hardWritableFiles",
      "hardFileBytes",
      "hardProcesses",
      "hardMemoryMb",
      "hardCpuMs",
      "hardOpenFiles",
      "readonlyTargetMount",
      "readonlySyntheticResourceMount",
      "readonlyMessageQueueMount",
      "writableRootFilesystem",
      "writableHostBinds",
      "providerAvailable",
      "cleanupVerification",
      "targetMount",
      "syntheticResourceMount",
      "messageQueueMount",
      "temporaryFilesystem",
      "containerProcess",
      "approvedBounds",
    ],
    "enrolled sandbox backend profile",
  );
  assertExactDataKeys(
    profile.targetMount,
    ["type", "source", "destination", "readonly"],
    "enrolled target mount profile",
  );
  assertExactDataKeys(
    profile.syntheticResourceMount,
    ["type", "source", "destination", "readonly", "manifestDigest"],
    "enrolled resource mount profile",
  );
  assertExactDataKeys(
    profile.messageQueueMount,
    [
      "destination",
      "readonly",
      "noexec",
      "nosuid",
      "nodev",
      "sizeBytes",
      "inodeLimit",
      "mode",
    ],
    "enrolled message-queue mount profile",
  );
  assertExactDataKeys(
    profile.temporaryFilesystem,
    [
      "destination",
      "readonly",
      "noexec",
      "nosuid",
      "nodev",
      "sizeBytes",
      "inodeLimit",
      "uid",
      "gid",
      "mode",
    ],
    "enrolled temporary-filesystem profile",
  );
  assertExactDataKeys(
    profile.containerProcess,
    [
      "interactive",
      "hostname",
      "init",
      "user",
      "capabilities",
      "noNewPrivileges",
      "cpuQuotaCpus",
      "stopTimeoutSeconds",
      "rootFilesystem",
      "workdir",
      "environmentResetExecutable",
      "environmentResetArgument",
      "controllerEnvironment",
      "runtime",
    ],
    "enrolled container-process profile",
  );
  const bounds = validateBounds(profile.approvedBounds);
  const runtime = validateNormalizedRuntime(profile.containerProcess.runtime);
  validateHostMountPath(profile.targetMount.source, "enrolled target mount");
  validateHostMountPath(
    profile.syntheticResourceMount.source,
    "enrolled synthetic-resource mount",
  );
  if (profile.targetMount.source === profile.syntheticResourceMount.source) {
    throw new Error("enrolled target and resource mounts must be distinct");
  }
  if (!sha256Pattern.test(profile.syntheticResourceMount.manifestDigest)) {
    throw new Error("enrolled resource manifest digest is invalid");
  }

  const expectedControllerEnvironment = [...controllerEnvironment];
  if (
    profile.format !== enrolledBackendProfileFormat ||
    profile.executionClass !== ENROLLED_NODE_STDIO_EXECUTION_CLASS ||
    profile.network !== "none" ||
    profile.ipc !== "none" ||
    profile.logDriver !== "none" ||
    profile.pullPolicy !== "never" ||
    profile.maxCalls !== 1 ||
    profile.maxRetries !== 0 ||
    profile.resultExposure !== "local_quarantine_only" ||
    profile.sandboxImageReference !== CONTROLLED_SANDBOX_IMAGE_REFERENCE ||
    profile.sandboxImageId !== CONTROLLED_SANDBOX_IMAGE_ID ||
    profile.imageHasDeclaredVolumes !== false ||
    profile.hardMcpMessageBytes !== MCP_STDIO_MESSAGE_BUFFER_BYTES ||
    profile.hardRuntimeMs !== bounds.maxCaseRuntimeMs ||
    profile.hardWritableBytes !== bounds.maxWritableBytes ||
    profile.hardWritableFiles !== bounds.maxWritableFiles ||
    profile.hardFileBytes !== bounds.maxFileBytes ||
    profile.hardProcesses !== bounds.maxProcesses ||
    profile.hardMemoryMb !== bounds.maxMemoryMb ||
    profile.hardCpuMs !== bounds.maxCpuMs ||
    profile.hardOpenFiles !== bounds.maxOpenFiles ||
    profile.readonlyTargetMount !== true ||
    profile.readonlySyntheticResourceMount !== true ||
    profile.readonlyMessageQueueMount !== true ||
    profile.writableRootFilesystem !== false ||
    profile.writableHostBinds !== false ||
    profile.providerAvailable !== false ||
    profile.cleanupVerification !== true ||
    profile.targetMount.type !== "bind" ||
    profile.targetMount.destination !== targetContainerRoot ||
    profile.targetMount.readonly !== true ||
    profile.syntheticResourceMount.type !== "bind" ||
    profile.syntheticResourceMount.destination !==
      enrolledSyntheticContainerRoot ||
    profile.syntheticResourceMount.readonly !== true ||
    profile.messageQueueMount.destination !== "/dev/mqueue" ||
    profile.messageQueueMount.readonly !== true ||
    profile.messageQueueMount.noexec !== true ||
    profile.messageQueueMount.nosuid !== true ||
    profile.messageQueueMount.nodev !== true ||
    profile.messageQueueMount.sizeBytes !== 4_096 ||
    profile.messageQueueMount.inodeLimit !== 1 ||
    profile.messageQueueMount.mode !== "0555" ||
    profile.temporaryFilesystem.destination !== "/tmp" ||
    profile.temporaryFilesystem.readonly !== false ||
    profile.temporaryFilesystem.noexec !== true ||
    profile.temporaryFilesystem.nosuid !== true ||
    profile.temporaryFilesystem.nodev !== true ||
    profile.temporaryFilesystem.sizeBytes !== bounds.maxWritableBytes ||
    profile.temporaryFilesystem.inodeLimit !== bounds.maxWritableFiles ||
    profile.temporaryFilesystem.uid !== 65_534 ||
    profile.temporaryFilesystem.gid !== 65_534 ||
    profile.temporaryFilesystem.mode !== "0700" ||
    profile.containerProcess.interactive !== true ||
    profile.containerProcess.hostname !== "forge-enrolled-target" ||
    profile.containerProcess.init !== true ||
    profile.containerProcess.user !== "65534:65534" ||
    profile.containerProcess.capabilities !== "drop_all" ||
    profile.containerProcess.noNewPrivileges !== true ||
    profile.containerProcess.cpuQuotaCpus !== 1 ||
    profile.containerProcess.stopTimeoutSeconds !== 2 ||
    profile.containerProcess.rootFilesystem !== "readonly" ||
    profile.containerProcess.workdir !== targetContainerRoot ||
    profile.containerProcess.environmentResetExecutable !== "/usr/bin/env" ||
    profile.containerProcess.environmentResetArgument !== "-i" ||
    canonicalizeJson(profile.containerProcess.controllerEnvironment) !==
      canonicalizeJson(expectedControllerEnvironment) ||
    profile.containerProcess.runtime.digest !== runtime.digest
  ) {
    throw new Error("enrolled sandbox backend profile was weakened or changed");
  }
}

function dockerArgumentsFor(options: {
  readonly runId: string;
  readonly experimentId: string;
  readonly containerName: string;
  readonly profile: Readonly<EnrolledNodeStdioBackendProfile>;
}): string[] {
  const { profile } = options;
  return [
    "run",
    "--interactive",
    "--name",
    options.containerName,
    "--label",
    "forge.managed=true",
    "--label",
    `forge.run_id=${options.runId}`,
    "--label",
    `forge.experiment_id=${options.experimentId}`,
    "--label",
    `forge.execution_class=${ENROLLED_NODE_STDIO_EXECUTION_CLASS}`,
    "--hostname",
    profile.containerProcess.hostname,
    "--network",
    profile.network,
    "--ipc",
    profile.ipc,
    "--log-driver",
    profile.logDriver,
    "--pull",
    profile.pullPolicy,
    "--read-only",
    "--init",
    "--user",
    profile.containerProcess.user,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(profile.hardProcesses),
    "--memory",
    `${profile.hardMemoryMb}m`,
    "--memory-swap",
    `${profile.hardMemoryMb}m`,
    "--cpus",
    String(profile.containerProcess.cpuQuotaCpus),
    "--ulimit",
    `cpu=${profile.hardCpuMs / 1_000}:${profile.hardCpuMs / 1_000}`,
    "--ulimit",
    `fsize=${profile.hardFileBytes}:${profile.hardFileBytes}`,
    "--ulimit",
    `nofile=${profile.hardOpenFiles}:${profile.hardOpenFiles}`,
    "--ulimit",
    "core=0:0",
    "--stop-timeout",
    String(profile.containerProcess.stopTimeoutSeconds),
    "--tmpfs",
    `${profile.messageQueueMount.destination}:ro,noexec,nosuid,nodev,size=${profile.messageQueueMount.sizeBytes},nr_inodes=${profile.messageQueueMount.inodeLimit},mode=${profile.messageQueueMount.mode}`,
    "--tmpfs",
    `${profile.temporaryFilesystem.destination}:rw,noexec,nosuid,nodev,size=${profile.temporaryFilesystem.sizeBytes},nr_inodes=${profile.temporaryFilesystem.inodeLimit},uid=${profile.temporaryFilesystem.uid},gid=${profile.temporaryFilesystem.gid},mode=${profile.temporaryFilesystem.mode}`,
    "--mount",
    `type=bind,src=${profile.targetMount.source},dst=${profile.targetMount.destination},readonly`,
    "--mount",
    `type=bind,src=${profile.syntheticResourceMount.source},dst=${profile.syntheticResourceMount.destination},readonly`,
    "--workdir",
    profile.containerProcess.workdir,
    "--entrypoint",
    profile.containerProcess.environmentResetExecutable,
    profile.sandboxImageId,
    profile.containerProcess.environmentResetArgument,
    ...profile.containerProcess.controllerEnvironment,
    profile.containerProcess.runtime.executable,
    profile.containerProcess.runtime.entrypoint,
    ...profile.containerProcess.runtime.applicationArgs,
  ];
}

export function computeEnrolledBackendProfileDigest(
  profile: Readonly<EnrolledNodeStdioBackendProfile>,
): string {
  return digestCanonicalJson(
    "forge.enrolled-node-stdio-backend",
    "v1alpha1",
    profile,
  );
}

function invocationDigestPayload(
  invocation: Pick<
    EnrolledNodeStdioDockerInvocation,
    | "runId"
    | "experimentId"
    | "containerName"
    | "server"
    | "pathMappings"
    | "backendProfileDigest"
  >,
): unknown {
  if (!Array.isArray(invocation.server.args)) {
    throw new Error("enrolled Docker invocation omitted its argument vector");
  }
  return {
    format: enrolledDockerInvocationFormat,
    runId: invocation.runId,
    experimentId: invocation.experimentId,
    containerName: invocation.containerName,
    server: {
      command: invocation.server.command,
      args: invocation.server.args,
      stderr: invocation.server.stderr,
      maxBufferSize: invocation.server.maxBufferSize,
    },
    pathMappings: invocation.pathMappings,
    backendProfileDigest: invocation.backendProfileDigest,
  };
}

export function computeEnrolledDockerInvocationDigest(
  invocation: Pick<
    EnrolledNodeStdioDockerInvocation,
    | "runId"
    | "experimentId"
    | "containerName"
    | "server"
    | "pathMappings"
    | "backendProfileDigest"
  >,
): string {
  return digestCanonicalJson(
    "forge.enrolled-node-stdio-docker-invocation",
    "v1alpha1",
    invocationDigestPayload(invocation),
  );
}

/**
 * Reconstruct the exact Docker command from the bound profile and reject
 * either a weakened profile or stale invocation/profile digests.
 */
export function verifyEnrolledDockerInvocationBinding(
  invocation: EnrolledNodeStdioDockerInvocation,
): Readonly<{
  backendProfileDigest: string;
  invocationDigest: string;
}> {
  validateControllerIdentifier(invocation.runId, "runId");
  validateControllerIdentifier(invocation.experimentId, "experimentId");
  const expectedNamePrefix = `forge-${safeDockerToken(invocation.runId)}-${safeDockerToken(invocation.experimentId)}-`;
  if (
    !invocation.containerName.startsWith(expectedNamePrefix) ||
    !/^[a-f0-9]{24}$/u.test(
      invocation.containerName.slice(expectedNamePrefix.length),
    )
  ) {
    throw new Error("enrolled Docker container name is not controller-owned");
  }
  assertProfileInvariants(invocation.backend);
  const backendProfileDigest = computeEnrolledBackendProfileDigest(
    invocation.backend,
  );
  if (backendProfileDigest !== invocation.backendProfileDigest) {
    throw new Error("enrolled sandbox backend profile digest changed");
  }
  if (
    Reflect.ownKeys(invocation.server).sort().join("\n") !==
      ["args", "command", "maxBufferSize", "stderr"].sort().join("\n") ||
    invocation.server.command !== "docker" ||
    invocation.server.stderr !== "pipe" ||
    invocation.server.maxBufferSize !== MCP_STDIO_MESSAGE_BUFFER_BYTES ||
    !Array.isArray(invocation.server.args) ||
    !Array.isArray(invocation.pathMappings) ||
    invocation.pathMappings.length !== 0
  ) {
    throw new Error("enrolled MCP server parameters were weakened or changed");
  }
  const expectedArguments = dockerArgumentsFor({
    runId: invocation.runId,
    experimentId: invocation.experimentId,
    containerName: invocation.containerName,
    profile: invocation.backend,
  });
  if (
    canonicalizeJson(invocation.server.args) !==
    canonicalizeJson(expectedArguments)
  ) {
    throw new Error("enrolled Docker argument vector differs from its profile");
  }
  const invocationDigest = computeEnrolledDockerInvocationDigest(invocation);
  if (invocationDigest !== invocation.invocationDigest) {
    throw new Error("enrolled Docker invocation digest changed");
  }
  return Object.freeze({ backendProfileDigest, invocationDigest });
}

/**
 * Build a no-network single-call Docker backend for one already-enrolled Node
 * STDIO target. Acquisition, regular-file/realpath checks, review, freshness,
 * dispatch authority, and cleanup verification remain separate prerequisites.
 */
export function createEnrolledNodeStdioDockerInvocation(options: {
  readonly runId: string;
  readonly experimentId: string;
  readonly preparedTarget: PreparedTarget;
  readonly resources: EnrolledSandboxResources;
  readonly runtime: NormalizedEnrolledNodeInvocationForSandbox;
  readonly bounds: ExecutionBoundsV2;
  readonly image: VerifiedV2SandboxImage;
}): EnrolledNodeStdioDockerInvocation {
  validateControllerIdentifier(options.runId, "runId");
  validateControllerIdentifier(options.experimentId, "experimentId");
  if (options.preparedTarget.containerRoot !== targetContainerRoot) {
    throw new Error("enrolled target mount destination must be /opt/target");
  }
  validateHostMountPath(
    options.preparedTarget.hostRoot,
    "enrolled target mount",
  );
  validateHostMountPath(
    options.resources.hostRoot,
    "enrolled synthetic-resource mount",
  );
  if (options.preparedTarget.hostRoot === options.resources.hostRoot) {
    throw new Error("enrolled target and resource mounts must be distinct");
  }
  if (!sha256Pattern.test(options.resources.manifestDigest)) {
    throw new Error("enrolled resource manifest digest is invalid");
  }

  const image = validateImage(options.image);
  const runtime = validateNormalizedRuntime(options.runtime);
  const bounds = validateBounds(options.bounds);
  const backend = deepFreezeJson({
    format: enrolledBackendProfileFormat,
    executionClass: ENROLLED_NODE_STDIO_EXECUTION_CLASS,
    network: "none",
    ipc: "none",
    logDriver: "none",
    pullPolicy: "never",
    maxCalls: 1,
    maxRetries: 0,
    resultExposure: "local_quarantine_only",
    sandboxImageReference: image.imageReference,
    sandboxImageId: image.imageId,
    imageHasDeclaredVolumes: image.declaredVolumes,
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
    targetMount: {
      type: "bind",
      source: options.preparedTarget.hostRoot,
      destination: targetContainerRoot,
      readonly: true,
    },
    syntheticResourceMount: {
      type: "bind",
      source: options.resources.hostRoot,
      destination: enrolledSyntheticContainerRoot,
      readonly: true,
      manifestDigest: options.resources.manifestDigest,
    },
    messageQueueMount: {
      destination: "/dev/mqueue",
      readonly: true,
      noexec: true,
      nosuid: true,
      nodev: true,
      sizeBytes: 4_096,
      inodeLimit: 1,
      mode: "0555",
    },
    temporaryFilesystem: {
      destination: "/tmp",
      readonly: false,
      noexec: true,
      nosuid: true,
      nodev: true,
      sizeBytes: bounds.maxWritableBytes,
      inodeLimit: bounds.maxWritableFiles,
      uid: 65_534,
      gid: 65_534,
      mode: "0700",
    },
    containerProcess: {
      interactive: true,
      hostname: "forge-enrolled-target",
      init: true,
      user: "65534:65534",
      capabilities: "drop_all",
      noNewPrivileges: true,
      cpuQuotaCpus: 1,
      stopTimeoutSeconds: 2,
      rootFilesystem: "readonly",
      workdir: targetContainerRoot,
      environmentResetExecutable: "/usr/bin/env",
      environmentResetArgument: "-i",
      controllerEnvironment: [...controllerEnvironment],
      runtime,
    },
    approvedBounds: bounds,
  } satisfies EnrolledNodeStdioBackendProfile) as Readonly<EnrolledNodeStdioBackendProfile>;
  assertProfileInvariants(backend);
  const backendProfileDigest = computeEnrolledBackendProfileDigest(backend);

  const instanceToken = randomBytes(12).toString("hex");
  const containerName = `forge-${safeDockerToken(options.runId)}-${safeDockerToken(options.experimentId)}-${instanceToken}`;
  const args = dockerArgumentsFor({
    runId: options.runId,
    experimentId: options.experimentId,
    containerName,
    profile: backend,
  });
  Object.freeze(args);
  const server: StdioServerParameters = {
    command: "docker",
    args,
    stderr: "pipe",
    maxBufferSize: MCP_STDIO_MESSAGE_BUFFER_BYTES,
  };
  Object.freeze(server);
  const pathMappings: [] = [];
  Object.freeze(pathMappings);
  const digestInput = {
    runId: options.runId,
    experimentId: options.experimentId,
    containerName,
    server,
    pathMappings,
    backendProfileDigest,
  };
  const invocationDigest = computeEnrolledDockerInvocationDigest(digestInput);
  const invocation = Object.freeze({
    ...digestInput,
    backend,
    invocationDigest,
  });
  verifyEnrolledDockerInvocationBinding(invocation);
  return invocation;
}
