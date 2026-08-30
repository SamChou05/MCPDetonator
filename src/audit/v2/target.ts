import { z } from "zod";
import { isProxy } from "node:util/types";

import {
  targetIdentityV2Schema,
  V2_CONTRACT_LIMITS,
  type TargetIdentityV2,
} from "../../contracts/v2/index.js";
import { digestCanonicalJson } from "./canonical.js";
import {
  exactByteArrayLength,
  snapshotExactByteArray,
} from "./bytes.js";
import { V2CompileError } from "./errors.js";
import { verifyArtifactReference } from "./artifacts.js";
import { deepFreezeJson } from "./freeze.js";
import {
  cloneStrictBoundedJson,
  V2_ARTIFACT_CLONE_LIMITS,
} from "./strict-clone.js";

const boundedRuntimeString = z.string().min(1).max(512);

export const PHASE1_TARGET_VERIFICATION_LIMITS = Object.freeze({
  maxArtifactBytes: 32 * 1_024 * 1_024,
  maxAggregateArtifactBytes: 48 * 1_024 * 1_024,
});

export const runtimeDescriptorV2Schema = z
  .object({
    transport: z.literal("stdio"),
    protocol: z.literal("mcp"),
    command: boundedRuntimeString,
    args: z.array(boundedRuntimeString).max(64),
    cwd: z.literal("/opt/target"),
    environment: z.object({}).strict(),
  })
  .strict();

export type RuntimeDescriptorV2 = z.infer<typeof runtimeDescriptorV2Schema>;

export interface VerifiedTargetInput {
  readonly identity: unknown;
  readonly sourceArtifactBytes: Uint8Array;
  readonly runtimeSnapshotBytes: Uint8Array;
  readonly runtimeDescriptor: unknown;
}

export interface VerifiedTarget {
  readonly identity: TargetIdentityV2;
  readonly targetIdentityDigest: string;
  readonly runtimeDescriptor: RuntimeDescriptorV2;
}

function targetInputDataProperty(
  input: VerifiedTargetInput,
  key: keyof VerifiedTargetInput,
): unknown {
  if (typeof input !== "object" || input === null || isProxy(input)) {
    throw new V2CompileError("artifact_mismatch", "target input must be plain data");
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new V2CompileError(
      "artifact_mismatch",
      `target input '${key}' must be a data property`,
    );
  }
  return descriptor.value;
}

export function verifyTargetIdentity(
  input: VerifiedTargetInput,
  maximumArtifactBytes: number = V2_CONTRACT_LIMITS.artifactBytes,
  maximumAggregateArtifactBytes: number =
    PHASE1_TARGET_VERIFICATION_LIMITS.maxAggregateArtifactBytes,
): VerifiedTarget {
  const identityValue = targetInputDataProperty(input, "identity");
  const sourceArtifactBytes = targetInputDataProperty(
    input,
    "sourceArtifactBytes",
  );
  const runtimeSnapshotBytes = targetInputDataProperty(
    input,
    "runtimeSnapshotBytes",
  );
  const runtimeDescriptorValue = targetInputDataProperty(
    input,
    "runtimeDescriptor",
  );
  const sourceArtifactByteLength = exactByteArrayLength(sourceArtifactBytes);
  const runtimeSnapshotByteLength = exactByteArrayLength(runtimeSnapshotBytes);
  if (
    sourceArtifactByteLength === undefined ||
    runtimeSnapshotByteLength === undefined
  ) {
    throw new V2CompileError(
      "artifact_mismatch",
      "target artifacts must be detached byte arrays",
    );
  }
  if (
    !Number.isSafeInteger(maximumArtifactBytes) ||
    maximumArtifactBytes < 1 ||
    !Number.isSafeInteger(maximumAggregateArtifactBytes) ||
    maximumAggregateArtifactBytes < 1
  ) {
    throw new V2CompileError(
      "bounds_exceeded",
      "target artifact ceilings must be positive safe integers",
    );
  }
  const effectiveArtifactLimit = Math.min(
    maximumArtifactBytes,
    V2_CONTRACT_LIMITS.artifactBytes,
    PHASE1_TARGET_VERIFICATION_LIMITS.maxArtifactBytes,
  );
  const effectiveAggregateArtifactLimit = Math.min(
    maximumAggregateArtifactBytes,
    PHASE1_TARGET_VERIFICATION_LIMITS.maxAggregateArtifactBytes,
  );
  if (
    sourceArtifactByteLength > effectiveArtifactLimit ||
    runtimeSnapshotByteLength > effectiveArtifactLimit ||
    sourceArtifactByteLength >
      effectiveAggregateArtifactLimit - runtimeSnapshotByteLength
  ) {
    throw new V2CompileError(
      "bounds_exceeded",
      "target bytes exceed the effective Phase 1A per-artifact or aggregate ceiling",
    );
  }
  const sourceArtifactSnapshot = snapshotExactByteArray(
    sourceArtifactBytes,
    "target source artifact",
  );
  const runtimeSnapshot = snapshotExactByteArray(
    runtimeSnapshotBytes,
    "target runtime snapshot",
  );
  const identity = targetIdentityV2Schema.parse(
    cloneStrictBoundedJson(
      identityValue,
      V2_ARTIFACT_CLONE_LIMITS,
      "V2 target identity",
    ).clone,
  );
  verifyArtifactReference(identity.sourceArtifact, sourceArtifactSnapshot);
  verifyArtifactReference(identity.runtimeSnapshot, runtimeSnapshot);

  const runtimeDescriptor = runtimeDescriptorV2Schema.parse(
    cloneStrictBoundedJson(
      runtimeDescriptorValue,
      V2_ARTIFACT_CLONE_LIMITS,
      "V2 runtime descriptor",
    ).clone,
  );
  const runtimeDescriptorDigest = digestCanonicalJson(
    "forge.runtime-descriptor",
    "v2",
    runtimeDescriptor,
  );
  if (runtimeDescriptorDigest !== identity.runtimeDescriptorDigest) {
    throw new V2CompileError(
      "artifact_mismatch",
      "runtime descriptor does not match target identity",
    );
  }

  return Object.freeze({
    identity: deepFreezeJson(identity),
    runtimeDescriptor: deepFreezeJson(runtimeDescriptor),
    targetIdentityDigest: digestCanonicalJson(
      "forge.target-identity",
      "v2",
      identity,
    ),
  });
}
