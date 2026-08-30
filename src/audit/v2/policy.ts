import { Buffer } from "node:buffer";

import {
  approvedPolicyV2Schema,
  type ApprovedPolicyV2,
  type ApprovalClassV2,
  type CaseOriginV2,
  type ExecutionBoundsV2,
  type ResourceClassV2,
} from "../../contracts/v2/index.js";
import { canonicalizeJson } from "./canonical.js";
import { V2CompileError } from "./errors.js";
import { deepFreezeJson } from "./freeze.js";
import {
  cloneStrictBoundedJson,
  V2_ARTIFACT_CLONE_LIMITS,
} from "./strict-clone.js";

const approvalRank: Readonly<Record<ApprovalClassV2, number>> = {
  automatic: 0,
  operator_review: 1,
  security_review: 2,
};

export function maximumApprovalClass(
  ...values: readonly ApprovalClassV2[]
): ApprovalClassV2 {
  let result: ApprovalClassV2 = "automatic";
  for (const value of values) {
    if (approvalRank[value] > approvalRank[result]) result = value;
  }
  return result;
}

function decodePointerSegment(segment: string): string {
  if (/~(?:[^01]|$)/u.test(segment)) {
    throw new V2CompileError("policy_missing", "invalid policy JSON pointer");
  }
  const decoded = segment.replaceAll("~1", "/").replaceAll("~0", "~");
  if (["__proto__", "prototype", "constructor"].includes(decoded)) {
    throw new V2CompileError(
      "policy_missing",
      "unsafe policy JSON pointer segment",
    );
  }
  return decoded;
}

function pointerValue(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/") || pointer.length > 512) {
    throw new V2CompileError("policy_missing", "invalid policy JSON pointer");
  }
  const segments = pointer.slice(1).split("/");
  if (segments.length > 32) {
    throw new V2CompileError("policy_missing", "policy JSON pointer is too deep");
  }

  let current = document;
  for (const encoded of segments) {
    const segment = decodePointerSegment(encoded);
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(segment)) return undefined;
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object" || current === null) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

type DispatchRule = ApprovedPolicyV2["experimentDispatchRules"]["rules"][number];
type DispatchArgumentRule = DispatchRule["argumentRules"][number];

export const PHASE1_POLICY_EVALUATION_LIMITS = Object.freeze({
  maxPredicateChecks: 100_000,
  maxCanonicalActualBytes: 4_000_000,
});

interface PreparedArgumentRule {
  readonly rule: DispatchArgumentRule;
  readonly canonicalExpected?: string;
  readonly canonicalCandidates?: readonly string[];
}

interface PreparedDispatchRule {
  readonly rule: DispatchRule;
  readonly argumentRules: readonly PreparedArgumentRule[];
}

export interface PreparedExperimentDispatchPolicy {
  readonly rules: readonly PreparedDispatchRule[];
}

export interface PolicyEvaluationWorkTracker {
  predicateChecks: number;
  canonicalActualBytes: number;
}

function reservePredicateCheck(work: PolicyEvaluationWorkTracker): void {
  work.predicateChecks += 1;
  if (
    work.predicateChecks >
    PHASE1_POLICY_EVALUATION_LIMITS.maxPredicateChecks
  ) {
    throw new V2CompileError(
      "bounds_exceeded",
      "experiment dispatch policy exceeds the Phase 1A predicate work budget",
    );
  }
}

function cachedPointerValue(
  document: unknown,
  pointer: string,
  values: Map<string, unknown>,
): unknown {
  if (values.has(pointer)) return values.get(pointer);
  const value = pointerValue(document, pointer);
  values.set(pointer, value);
  return value;
}

function cachedCanonicalActual(
  pointer: string,
  actual: unknown,
  canonicalValues: Map<string, string>,
  work: PolicyEvaluationWorkTracker,
): string {
  const cached = canonicalValues.get(pointer);
  if (cached !== undefined) return cached;
  const canonical = canonicalizeJson(actual);
  work.canonicalActualBytes += Buffer.byteLength(canonical, "utf8");
  if (
    work.canonicalActualBytes >
    PHASE1_POLICY_EVALUATION_LIMITS.maxCanonicalActualBytes
  ) {
    throw new V2CompileError(
      "bounds_exceeded",
      "experiment dispatch policy exceeds the Phase 1A canonical-value work budget",
    );
  }
  canonicalValues.set(pointer, canonical);
  return canonical;
}

function argumentRuleMatches(
  prepared: PreparedArgumentRule,
  argumentsValue: unknown,
  pointerValues: Map<string, unknown>,
  canonicalValues: Map<string, string>,
  work: PolicyEvaluationWorkTracker,
): boolean {
  reservePredicateCheck(work);
  const rule = prepared.rule;
  const actual = cachedPointerValue(
    argumentsValue,
    rule.jsonPointer,
    pointerValues,
  );
  if (actual === undefined) return false;
  switch (rule.operator) {
    case "equals":
      return (
        cachedCanonicalActual(
          rule.jsonPointer,
          actual,
          canonicalValues,
          work,
        ) === prepared.canonicalExpected
      );
    case "one_of":
      return binarySearch(
        prepared.canonicalCandidates!,
        cachedCanonicalActual(
          rule.jsonPointer,
          actual,
          canonicalValues,
          work,
        ),
      );
    case "string_prefix":
      return typeof actual === "string" && actual.startsWith(rule.prefix);
  }
}

function binarySearch(values: readonly string[], candidate: string): boolean {
  let lower = 0;
  let upper = values.length - 1;
  while (lower <= upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const value = values[middle]!;
    if (value === candidate) return true;
    if (value < candidate) lower = middle + 1;
    else upper = middle - 1;
  }
  return false;
}

function ruleBaseSelectorMatches(
  prepared: PreparedDispatchRule,
  input: ExperimentDispatchInput,
  pointerValues: Map<string, unknown>,
  canonicalValues: Map<string, string>,
  work: PolicyEvaluationWorkTracker,
): boolean {
  reservePredicateCheck(work);
  const rule = prepared.rule;
  if (!rule.toolNames.includes(input.toolName)) return false;
  if (!rule.allowedOrigins.includes(input.origin)) return false;
  return prepared.argumentRules.every((argumentRule) =>
    argumentRuleMatches(
      argumentRule,
      input.arguments,
      pointerValues,
      canonicalValues,
      work,
    ),
  );
}

function withinRuleLimits(
  rule: DispatchRule,
  input: ExperimentDispatchInput,
): boolean {
  if (input.planCaseCount > rule.limits.maxCases) return false;
  if (input.planStepCount > rule.limits.maxSteps) return false;
  if (input.argumentBytes > rule.limits.maxArgumentBytes) return false;
  if (input.requestedRuntimeMs > rule.limits.maxRuntimeMs) return false;
  const bounds = input.executionBounds;
  if (bounds.maxCases > rule.limits.maxCases) return false;
  if (bounds.maxStepsPerCase > rule.limits.maxStepsPerCase) return false;
  if (bounds.maxTotalSteps > rule.limits.maxSteps) return false;
  if (bounds.maxArgumentBytes > rule.limits.maxArgumentBytes) return false;
  if (bounds.maxCaseRuntimeMs > rule.limits.maxRuntimeMs) return false;
  if (bounds.maxTotalRuntimeMs > rule.limits.maxTotalRuntimeMs) return false;
  if (
    bounds.maxOutputBytesPerStep > rule.limits.maxOutputBytesPerStep ||
    bounds.maxTotalOutputBytes > rule.limits.maxTotalOutputBytes ||
    bounds.maxWritableBytes > rule.limits.maxWritableBytes ||
    bounds.maxWritableFiles > rule.limits.maxWritableFiles ||
    bounds.maxFileBytes > rule.limits.maxFileBytes ||
    bounds.maxProcesses > rule.limits.maxProcesses ||
    bounds.maxMemoryMb > rule.limits.maxMemoryMb ||
    bounds.maxCpuMs > rule.limits.maxCpuMs ||
    bounds.maxOpenFiles > rule.limits.maxOpenFiles
  ) {
    return false;
  }
  return true;
}

export interface ExperimentDispatchInput {
  readonly toolName: string;
  readonly origin: CaseOriginV2;
  readonly arguments: unknown;
  readonly resourceClasses: readonly ResourceClassV2[];
  readonly planCaseCount: number;
  readonly planStepCount: number;
  readonly argumentBytes: number;
  readonly requestedRuntimeMs: number;
  readonly executionBounds: ExecutionBoundsV2;
}

export function prepareExperimentDispatchPolicy(
  policy: ApprovedPolicyV2,
): PreparedExperimentDispatchPolicy {
  const detachedPolicy = deepFreezeJson(
    approvedPolicyV2Schema.parse(
      cloneStrictBoundedJson(
        policy,
        V2_ARTIFACT_CLONE_LIMITS,
        "V2 experiment dispatch policy",
      ).clone,
    ),
  );
  return Object.freeze({
    rules: Object.freeze(
      detachedPolicy.experimentDispatchRules.rules.map((rule) =>
        Object.freeze({
          rule,
          argumentRules: Object.freeze(
            rule.argumentRules.map((argumentRule) => {
              switch (argumentRule.operator) {
                case "equals":
                  return Object.freeze({
                    rule: argumentRule,
                    canonicalExpected: canonicalizeJson(argumentRule.value),
                  });
                case "one_of":
                  return Object.freeze({
                    rule: argumentRule,
                    canonicalCandidates: Object.freeze(
                      argumentRule.values
                        .map((candidate) => canonicalizeJson(candidate))
                        .sort(),
                    ),
                  });
                case "string_prefix":
                  return Object.freeze({ rule: argumentRule });
              }
            }),
          ),
        }),
      ),
    ),
  });
}

export function assertPolicyEvaluationWorkBound(
  prepared: PreparedExperimentDispatchPolicy,
  totalSteps: number,
): void {
  if (!Number.isSafeInteger(totalSteps) || totalSteps < 0) {
    throw new V2CompileError(
      "bounds_exceeded",
      "policy evaluation step count must be a non-negative safe integer",
    );
  }
  const checksPerStep = prepared.rules.reduce(
    (total, preparedRule) => total + 1 + preparedRule.argumentRules.length,
    0,
  );
  if (
    checksPerStep > PHASE1_POLICY_EVALUATION_LIMITS.maxPredicateChecks ||
    (checksPerStep > 0 &&
      totalSteps >
        Math.floor(
          PHASE1_POLICY_EVALUATION_LIMITS.maxPredicateChecks / checksPerStep,
        ))
  ) {
    throw new V2CompileError(
      "bounds_exceeded",
      "expanded plan exceeds the Phase 1A policy-evaluation work budget",
    );
  }
}

export function createPolicyEvaluationWorkTracker(): PolicyEvaluationWorkTracker {
  return { predicateChecks: 0, canonicalActualBytes: 0 };
}

/**
 * This evaluator intentionally reads only experimentDispatchRules. Subject
 * behavior appraisal can describe a forbidden deployment effect without
 * preventing a separately authorized synthetic audit probe.
 */
export function evaluatePreparedExperimentDispatch(
  prepared: PreparedExperimentDispatchPolicy,
  input: ExperimentDispatchInput,
  work: PolicyEvaluationWorkTracker,
): ApprovalClassV2 {
  const pointerValues = new Map<string, unknown>();
  const canonicalValues = new Map<string, string>();
  const baseSelected = prepared.rules
    .filter((preparedRule) =>
      ruleBaseSelectorMatches(
        preparedRule,
        input,
        pointerValues,
        canonicalValues,
        work,
      ),
    )
    .map((preparedRule) => preparedRule.rule);
  const overlapping = baseSelected.filter((rule) =>
    input.resourceClasses.some((resourceClass) =>
      rule.allowedResourceClasses.includes(resourceClass),
    ),
  );
  // A deny selector is a prohibition, not a grant whose applicability can be
  // escaped by asking for more than its stated limits. Limits therefore never
  // weaken a matching deny.
  if (overlapping.some((rule) => rule.decision === "deny")) {
    throw new V2CompileError(
      "policy_denied",
      `experiment dispatch policy denies tool '${input.toolName}'`,
    );
  }

  // Phase 1A has no producer-output workflow binding or runtime taint object.
  // A matching review gate that depends on either unsupported flow proof or
  // exceeded limits must fail closed instead of falling through to an allow.
  const unsatisfiedReviewGate = overlapping.find(
    (rule) =>
      rule.decision === "approval_required" &&
      (rule.allowedDataFlows.length > 0 || !withinRuleLimits(rule, input)),
  );
  if (unsatisfiedReviewGate !== undefined) {
    throw new V2CompileError(
      "policy_denied",
      `approval-required dispatch rule '${unsatisfiedReviewGate.ruleId}' cannot be satisfied in Phase 1A`,
    );
  }

  const positive = overlapping.filter(
    (rule) =>
      rule.decision !== "deny" &&
      rule.allowedDataFlows.length === 0 &&
      withinRuleLimits(rule, input),
  );
  if (positive.length === 0) {
    throw new V2CompileError(
      "policy_denied",
      `no experiment dispatch rule authorizes tool '${input.toolName}'`,
    );
  }
  const authorizedResourceClasses = new Set(
    positive.flatMap((rule) => rule.allowedResourceClasses),
  );
  if (
    !input.resourceClasses.every((resourceClass) =>
      authorizedResourceClasses.has(resourceClass),
    )
  ) {
    throw new V2CompileError(
      "policy_denied",
      `experiment dispatch rules do not authorize every resource class for tool '${input.toolName}'`,
    );
  }
  return maximumApprovalClass(
    ...positive.map((rule) => rule.minimumApprovalClass),
  );
}

export function evaluateExperimentDispatch(
  policy: ApprovedPolicyV2,
  input: ExperimentDispatchInput,
): ApprovalClassV2 {
  const prepared = prepareExperimentDispatchPolicy(policy);
  assertPolicyEvaluationWorkBound(prepared, 1);
  return evaluatePreparedExperimentDispatch(
    prepared,
    input,
    createPolicyEvaluationWorkTracker(),
  );
}
