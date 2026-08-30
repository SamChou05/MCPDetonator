import {
  experimentPlanV2Schema,
  type ExperimentPlanV2,
} from "../../contracts/v2/index.js";
import { isProxy } from "node:util/types";
import { digestCanonicalJson } from "./canonical.js";
import { V2CompileError } from "./errors.js";
import { deepFreezeJson } from "./freeze.js";
import { assertResolvedPlanArguments } from "./references.js";
import { V2_ARGUMENT_LIMITS } from "./schema-safety.js";
import {
  cloneStrictBoundedJson,
  V2_ARTIFACT_CLONE_LIMITS,
} from "./strict-clone.js";

export interface ExperimentPlanEnvelopeV2 {
  readonly plan: Readonly<ExperimentPlanV2>;
  readonly experimentPlanDigest: string;
}

export function createExperimentPlanEnvelope(
  value: unknown,
): ExperimentPlanEnvelopeV2 {
  const detached = cloneStrictBoundedJson(
    value,
    V2_ARTIFACT_CLONE_LIMITS,
    "V2 ExperimentPlan",
  ).clone;
  const plan = experimentPlanV2Schema.parse(detached);
  if (Object.hasOwn(plan, "experimentPlanDigest")) {
    throw new V2CompileError(
      "digest_mismatch",
      "ExperimentPlan must not contain its own digest",
    );
  }
  const manifestDigest = digestCanonicalJson(
    "forge.synthetic-resource-manifest",
    "v2",
    plan.syntheticResourceManifest,
  );
  if (manifestDigest !== plan.syntheticResourceManifestDigest) {
    throw new V2CompileError(
      "digest_mismatch",
      "synthetic resource manifest digest does not match its embedded bytes",
    );
  }
  for (const experimentCase of plan.cases) {
    const allowedSyntheticPaths = new Set(
      plan.syntheticResourceManifest.instances
        .filter((instance) => instance.caseId === experimentCase.caseId)
        .map((instance) => instance.containerPath),
    );
    const argumentLimits = {
      ...V2_ARGUMENT_LIMITS,
      maxSerializedBytes: Math.min(
        V2_ARGUMENT_LIMITS.maxSerializedBytes,
        plan.bounds.maxArgumentBytes,
      ),
    };
    for (const step of experimentCase.steps) {
      assertResolvedPlanArguments(
        step.arguments,
        allowedSyntheticPaths,
        argumentLimits,
      );
      const argumentDigest = digestCanonicalJson(
        "forge.tool-arguments",
        "v2",
        step.arguments,
      );
      if (argumentDigest !== step.argumentSha256) {
        throw new V2CompileError(
          "digest_mismatch",
          `argument digest does not match step '${step.stepId}'`,
        );
      }
    }
  }
  const experimentPlanDigest = digestCanonicalJson(
    "forge.experiment-plan",
    "v2",
    plan,
  );
  return Object.freeze({
    plan: deepFreezeJson(plan),
    experimentPlanDigest,
  });
}

export function verifyExperimentPlanEnvelope(
  envelope: ExperimentPlanEnvelopeV2,
): ExperimentPlanEnvelopeV2 {
  if (typeof envelope !== "object" || envelope === null || isProxy(envelope)) {
    throw new V2CompileError(
      "digest_mismatch",
      "plan envelope must be a non-proxy plain object",
    );
  }
  const prototype = Object.getPrototypeOf(envelope);
  const ownKeys = Reflect.ownKeys(envelope);
  const isBareEnvelope =
    ownKeys.length === 2 &&
    ownKeys.includes("plan") &&
    ownKeys.includes("experimentPlanDigest");
  const isCompiledEnvelope =
    ownKeys.length === 4 &&
    ownKeys.includes("plan") &&
    ownKeys.includes("experimentPlanDigest") &&
    ownKeys.includes("catalog") &&
    ownKeys.includes("resources");
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    (!isBareEnvelope && !isCompiledEnvelope) ||
    ownKeys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(envelope, key);
      return descriptor === undefined || !("value" in descriptor);
    })
  ) {
    throw new V2CompileError(
      "digest_mismatch",
      "plan envelope must contain exactly the recognized data properties",
    );
  }
  const planDescriptor = Object.getOwnPropertyDescriptor(envelope, "plan");
  const digestDescriptor = Object.getOwnPropertyDescriptor(
    envelope,
    "experimentPlanDigest",
  );
  if (
    planDescriptor === undefined ||
    !("value" in planDescriptor) ||
    digestDescriptor === undefined ||
    !("value" in digestDescriptor) ||
    typeof digestDescriptor.value !== "string"
  ) {
    throw new V2CompileError(
      "digest_mismatch",
      "plan envelope requires data properties for plan and digest",
    );
  }
  const recomputed = createExperimentPlanEnvelope(planDescriptor.value);
  if (recomputed.experimentPlanDigest !== digestDescriptor.value) {
    throw new V2CompileError(
      "digest_mismatch",
      "ExperimentPlan digest does not match the canonical plan",
    );
  }
  return recomputed;
}
