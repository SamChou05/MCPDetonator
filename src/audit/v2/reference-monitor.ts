import {
  approvedPolicyV2Schema,
  controlledExecutionAuthorizationV2Schema,
  timestampV2Schema,
  type ControlledExecutionAuthorizationV2,
} from "../../contracts/v2/index.js";
import {
  compileExperimentPlan,
  type CompileExperimentPlanInput,
} from "./compile.js";
import { computeCatalogIdentity } from "./catalog.js";
import { canonicalizeJson, digestCanonicalJson } from "./canonical.js";
import type { ConsumedControlledExecution } from "./controlled-authority.js";
import {
  CONTROLLED_EXECUTION_RUNNER_IDENTITY,
  CONTROLLED_EXECUTION_SANDBOX_IDENTITY,
  ControlledExecutionAuthorityError,
  claimConsumedControlledExecutionForDispatch,
} from "./controlled-authority.js";
import {
  type ExperimentPlanEnvelopeV2,
  verifyExperimentPlanEnvelope,
} from "./envelope.js";
import { deepFreezeJson } from "./freeze.js";
import {
  cloneStrictBoundedJson,
  V2_ARTIFACT_CLONE_LIMITS,
} from "./strict-clone.js";

export const CONTROLLED_REFERENCE_MONITOR_IDENTITY = Object.freeze({
  id: "forge-controlled-reference-monitor",
  version: "1alpha1",
});

export interface ControlledBackendCapabilities {
  readonly executionClass: "controlled_fixture_only";
  readonly network: "none";
  readonly maxCalls: 1;
  readonly maxRetries: 0;
  readonly resultExposure: "local_quarantine_only";
  readonly sandboxImageId: string;
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
}

export interface RevalidateControlledDispatchInput {
  readonly compileInput: CompileExperimentPlanInput;
  readonly envelope: ExperimentPlanEnvelopeV2;
  readonly authorization: ControlledExecutionAuthorizationV2;
  readonly consumed: ConsumedControlledExecution;
  /** Fresh complete raw MCP discovery from the opened target session. */
  readonly liveCatalog: unknown;
  readonly currentTargetTreeSha256: string;
  /** Produced by fresh verification of every mounted resource artifact. */
  readonly currentSyntheticResourceManifestDigest: string;
  readonly toolName: string;
  readonly arguments: unknown;
  readonly now: string;
  readonly backend: ControlledBackendCapabilities;
}

export interface PreparedControlledDispatch {
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly argumentSha256: string;
  readonly liveCatalogDigest: string;
  readonly checkedAt: string;
  readonly sequence: 0;
}

function fail(
  code: "binding_mismatch" | "expired" | "sandbox_prerequisites_unmet",
  message: string,
): never {
  throw new ControlledExecutionAuthorityError(code, message);
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (canonicalizeJson(actual) !== canonicalizeJson(expected)) {
    fail("binding_mismatch", `${label} does not match`);
  }
}

/**
 * Dispatch-time reference monitor. This runs after fresh discovery and
 * immediately before the sole tools/call send. Fresh compilation rechecks the
 * live input schema, resolved arguments, policy, bounds, and both catalog
 * digests. It cannot issue or refresh a permit.
 */
export function revalidateControlledDispatch(
  input: RevalidateControlledDispatchInput,
): Readonly<PreparedControlledDispatch> {
  claimConsumedControlledExecutionForDispatch(input.consumed);
  const now = timestampV2Schema.parse(input.now);
  const authorization = controlledExecutionAuthorizationV2Schema.parse(
    cloneStrictBoundedJson(
      input.authorization,
      V2_ARTIFACT_CLONE_LIMITS,
      "controlled dispatch authorization",
    ).clone,
  );
  if (
    input.consumed.authorizationDigest !==
    digestCanonicalJson(
      "forge.controlled-execution-authorization",
      "v1alpha1",
      authorization,
    )
  ) {
    fail("binding_mismatch", "consumed permit does not bind the authorization");
  }
  assertEqual(
    "consumed authorization",
    input.consumed.authorization,
    authorization,
  );
  if (
    Date.parse(now) < Date.parse(input.consumed.consumedAt) ||
    Date.parse(now) >= Date.parse(authorization.expiresAt)
  ) {
    fail("expired", "dispatch check is outside the consumed permit window");
  }
  if (
    input.backend.executionClass !== "controlled_fixture_only" ||
    input.backend.network !== "none" ||
    input.backend.maxCalls !== 1 ||
    input.backend.maxRetries !== 0 ||
    input.backend.resultExposure !== "local_quarantine_only" ||
    input.backend.sandboxImageId !== authorization.boundary.imageId ||
    input.backend.imageHasDeclaredVolumes !== false ||
    input.backend.cleanupVerification !== true ||
    input.backend.readonlyTargetMount !== true ||
    input.backend.readonlySyntheticResourceMount !== true ||
    input.backend.readonlyMessageQueueMount !== true ||
    input.backend.writableRootFilesystem !== false ||
    input.backend.writableHostBinds !== false ||
    input.backend.providerAvailable !== false ||
    !Number.isSafeInteger(input.backend.hardMcpMessageBytes) ||
    input.backend.hardMcpMessageBytes <
      authorization.bounds.maxOutputBytesPerStep ||
    input.backend.hardRuntimeMs > authorization.bounds.maxCaseRuntimeMs ||
    input.backend.hardRuntimeMs > authorization.bounds.maxTotalRuntimeMs ||
    input.backend.hardWritableBytes > authorization.bounds.maxWritableBytes ||
    input.backend.hardWritableFiles > authorization.bounds.maxWritableFiles ||
    input.backend.hardFileBytes > authorization.bounds.maxFileBytes ||
    input.backend.hardProcesses > authorization.bounds.maxProcesses ||
    input.backend.hardMemoryMb > authorization.bounds.maxMemoryMb ||
    input.backend.hardCpuMs > authorization.bounds.maxCpuMs ||
    input.backend.hardOpenFiles > authorization.bounds.maxOpenFiles ||
    [
      input.backend.hardRuntimeMs,
      input.backend.hardWritableBytes,
      input.backend.hardWritableFiles,
      input.backend.hardFileBytes,
      input.backend.hardProcesses,
      input.backend.hardMemoryMb,
      input.backend.hardCpuMs,
      input.backend.hardOpenFiles,
    ].some((value) => !Number.isSafeInteger(value) || value < 1)
  ) {
    fail(
      "sandbox_prerequisites_unmet",
      "runtime backend does not dominate the controlled authorization boundary",
    );
  }
  assertEqual(
    "runner identity",
    authorization.boundary.runner,
    CONTROLLED_EXECUTION_RUNNER_IDENTITY,
  );
  assertEqual(
    "sandbox identity",
    authorization.boundary.sandbox,
    CONTROLLED_EXECUTION_SANDBOX_IDENTITY,
  );
  if (
    input.currentTargetTreeSha256 !==
      authorization.experiment.preparedTargetTreeSha256 ||
    !/^[a-f0-9]{64}$/u.test(input.currentTargetTreeSha256)
  ) {
    fail("binding_mismatch", "mounted target tree changed before dispatch");
  }
  if (
    input.currentSyntheticResourceManifestDigest !==
    authorization.experiment.syntheticResourceManifestDigest
  ) {
    fail(
      "binding_mismatch",
      "mounted synthetic resource bytes changed before dispatch",
    );
  }

  const submitted = verifyExperimentPlanEnvelope(input.envelope);
  const liveCompiled = compileExperimentPlan({
    ...input.compileInput,
    catalog: input.liveCatalog,
  });
  if (
    submitted.experimentPlanDigest !== liveCompiled.experimentPlanDigest ||
    authorization.experiment.experimentPlanDigest !==
      liveCompiled.experimentPlanDigest
  ) {
    fail("binding_mismatch", "fresh compilation changed the approved plan");
  }
  assertEqual("freshly compiled plan", submitted.plan, liveCompiled.plan);
  assertEqual(
    "authorization catalog",
    authorization.experiment.catalog,
    liveCompiled.plan.catalog,
  );
  assertEqual(
    "authorization bounds",
    authorization.bounds,
    liveCompiled.plan.bounds,
  );
  const liveCatalog = computeCatalogIdentity(input.liveCatalog);
  assertEqual(
    "live catalog identity",
    liveCatalog.identity,
    liveCompiled.plan.catalog,
  );

  const policy = approvedPolicyV2Schema.parse(
    cloneStrictBoundedJson(
      input.compileInput.policy,
      V2_ARTIFACT_CLONE_LIMITS,
      "controlled dispatch policy",
    ).clone,
  );
  const policyDigest = digestCanonicalJson("forge.audit-policy", "v2", policy);
  if (
    policyDigest !== authorization.experiment.policyDigest ||
    policyDigest !== liveCompiled.plan.policyDigest
  ) {
    fail("binding_mismatch", "dispatch policy changed");
  }
  if (
    policy.expiresAt !== undefined &&
    Date.parse(now) >= Date.parse(policy.expiresAt)
  ) {
    fail("expired", "dispatch policy expired before the tool call");
  }

  const experimentCase = liveCompiled.plan.cases.find(
    (candidate) => candidate.caseId === authorization.experiment.caseId,
  );
  const step = experimentCase?.steps.find(
    (candidate) => candidate.stepId === authorization.experiment.stepId,
  );
  if (
    experimentCase === undefined ||
    experimentCase.steps.length !== 1 ||
    step === undefined ||
    step.toolName !== input.toolName ||
    step.toolName !== authorization.experiment.toolName ||
    step.argumentSha256 !== authorization.experiment.argumentSha256
  ) {
    fail(
      "binding_mismatch",
      "selected case, step, tool, or argument digest changed",
    );
  }
  assertEqual("dispatch arguments", input.arguments, step.arguments);
  const argumentSha256 = digestCanonicalJson(
    "forge.tool-arguments",
    "v2",
    input.arguments,
  );
  if (argumentSha256 !== step.argumentSha256) {
    fail("binding_mismatch", "dispatch argument bytes changed");
  }
  if (
    typeof step.arguments !== "object" ||
    step.arguments === null ||
    Array.isArray(step.arguments)
  ) {
    fail("binding_mismatch", "MCP tool arguments must be an object");
  }

  return deepFreezeJson({
    toolName: step.toolName,
    arguments: step.arguments as Record<string, unknown>,
    argumentSha256,
    liveCatalogDigest: liveCatalog.identity.planCatalogDigest,
    checkedAt: now,
    sequence: 0,
  });
}
