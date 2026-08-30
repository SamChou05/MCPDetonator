import {
  approvedPolicyV2Schema,
  agentOutcomeHypothesisDraftV2Schema,
  outcomeComparisonV2Schema,
  outcomeContentClassV2Schema,
  outcomeHypothesisV2Schema,
  outcomeObservationV2Schema,
  outputSchemaAssessmentV2Schema,
  type ApprovedPolicyV2,
  type AgentOutcomeHypothesisDraftV2,
  type OutcomeComparisonV2,
  type OutcomeContentClassV2,
  type OutcomeHypothesisV2,
  type OutcomeObservationV2,
  type OutputSchemaAssessmentV2,
  type OutputSchemaExpectationV2,
  type PredictedEffectV2,
  type SensorV2,
  type SubjectBehaviorRuleV2,
} from "../../contracts/v2/index.js";
import { compileInputSchema } from "../../mcp/input-schema.js";
import {
  computeCatalogIdentity,
  type ComputedCatalogV2,
  type NormalizedCatalogToolV2,
} from "./catalog.js";
import { canonicalizeJson, digestCanonicalJson } from "./canonical.js";
import {
  type ExperimentPlanEnvelopeV2,
  verifyExperimentPlanEnvelope,
} from "./envelope.js";
import { deepFreezeJson } from "./freeze.js";
import { RESULT_CONTENT_ANALYZER_IDENTITY } from "./result-content.js";
import {
  assertSafeInputSchema,
  runSynchronousInputValidator,
  V2_ARGUMENT_LIMITS,
} from "./schema-safety.js";
import {
  cloneStrictBoundedJson,
  V2_ARTIFACT_CLONE_LIMITS,
} from "./strict-clone.js";

export const OUTCOME_COMPARATOR_IDENTITY = Object.freeze({
  id: "forge-outcome-comparator",
  version: "1alpha1",
});

export const OUTPUT_SCHEMA_VALIDATOR_IDENTITY = Object.freeze({
  id: "forge-output-schema-validator",
  version: "1alpha1",
});

const SENSOR_ORDER: readonly SensorV2[] = [
  "process",
  "filesystem",
  "network",
  "mcp_transcript",
  "stdout",
  "stderr",
  "runtime_tree",
  "cleanup",
];

export interface CompareOutcomeInput {
  readonly comparisonId: string;
  readonly comparedAt: string;
  readonly envelope: ExperimentPlanEnvelopeV2;
  /** Complete controller-supplied discovery bytes, revalidated and rehashed. */
  readonly catalog: unknown;
  readonly policy: ApprovedPolicyV2;
  readonly hypothesis: unknown;
  readonly observation: unknown;
}

type PolicyDecision = "allowed" | "denied" | "review_required";
type PolicyBasis =
  "matching_rule" | "default_decision" | "rule_limits_exceeded";

interface PolicyAppraisal {
  readonly decision: PolicyDecision;
  readonly basis: PolicyBasis;
  readonly ruleIds: readonly string[];
}

function fail(message: string): never {
  throw new Error(`outcome comparison rejected: ${message}`);
}

function parseDetached<T>(
  value: unknown,
  label: string,
  parse: (value: unknown) => T,
): T {
  return parse(
    cloneStrictBoundedJson(value, V2_ARTIFACT_CLONE_LIMITS, label).clone,
  );
}

function assertCanonicalEqual(
  label: string,
  actual: unknown,
  expected: unknown,
): void {
  if (canonicalizeJson(actual) !== canonicalizeJson(expected)) {
    fail(`${label} does not match`);
  }
}

function expectedOutputSchema(
  tool: NormalizedCatalogToolV2,
): OutputSchemaExpectationV2 {
  if (tool.outputSchema === undefined) return { status: "not_advertised" };
  const outputSchema = cloneStrictBoundedJson(
    tool.outputSchema,
    V2_ARTIFACT_CLONE_LIMITS,
    "advertised MCP output schema",
  ).clone;
  return {
    status: "advertised",
    outputSchemaDigest: digestCanonicalJson(
      "forge.mcp-output-schema",
      "v2",
      outputSchema,
    ),
  };
}

export function computeOutputSchemaExpectation(
  tool: NormalizedCatalogToolV2,
): Readonly<OutputSchemaExpectationV2> {
  return deepFreezeJson(expectedOutputSchema(tool));
}

export interface AssessOutputSchemaInput {
  readonly tool: NormalizedCatalogToolV2;
  /** Exact detached structuredContent value, not the enclosing MCP result. */
  readonly value: unknown;
  readonly maxOutputBytes: number;
}

export interface CompileAgentOutcomeHypothesisInput {
  readonly envelope: ExperimentPlanEnvelopeV2;
  /** Complete catalog bytes bound to the plan. */
  readonly catalog: unknown;
  readonly caseId: string;
  readonly stepId: string;
  readonly draft: unknown;
}

/**
 * Convert a non-authoritative model prediction into a plan-bound hypothesis.
 * The model cannot choose or overwrite target, catalog, policy, arguments,
 * advertised output schema, or the case's compiled predicted effects.
 */
export function compileAgentOutcomeHypothesis(
  input: CompileAgentOutcomeHypothesisInput,
): Readonly<OutcomeHypothesisV2> {
  const envelope = verifyExperimentPlanEnvelope(input.envelope);
  const catalog = computeCatalogIdentity(input.catalog);
  assertCanonicalEqual(
    "agent hypothesis catalog identity",
    catalog.identity,
    envelope.plan.catalog,
  );
  const draft: AgentOutcomeHypothesisDraftV2 = parseDetached(
    input.draft,
    "agent outcome hypothesis draft",
    (value) => agentOutcomeHypothesisDraftV2Schema.parse(value),
  );
  if (Date.parse(draft.createdAt) < Date.parse(envelope.plan.compiledAt)) {
    fail("agent hypothesis draft predates the compiled plan");
  }
  if (
    envelope.plan.policyExpiresAt !== undefined &&
    Date.parse(draft.createdAt) >= Date.parse(envelope.plan.policyExpiresAt)
  ) {
    fail("agent hypothesis draft postdates the planned policy window");
  }
  const experimentCase = envelope.plan.cases.find(
    (candidate) => candidate.caseId === input.caseId,
  );
  if (experimentCase === undefined)
    fail("agent hypothesis caseId is not in the plan");
  const step = experimentCase.steps.find(
    (candidate) => candidate.stepId === input.stepId,
  );
  if (step === undefined)
    fail("agent hypothesis stepId is not in the selected case");
  const tool = catalog.catalog.tools.find(
    (candidate) => candidate.name === step.toolName,
  );
  if (tool === undefined)
    fail("agent hypothesis tool is absent from the catalog");

  return deepFreezeJson(
    outcomeHypothesisV2Schema.parse({
      format: "forge.outcome-hypothesis/v1alpha1",
      hypothesisId: draft.hypothesisId,
      createdAt: draft.createdAt,
      experimentPlanDigest: envelope.experimentPlanDigest,
      catalog: envelope.plan.catalog,
      caseId: experimentCase.caseId,
      stepId: step.stepId,
      toolName: step.toolName,
      source: draft.source,
      expected: {
        ...draft.expected,
        outputSchema: expectedOutputSchema(tool),
        predictedEffects: experimentCase.predictedEffects,
      },
      limitations: draft.limitations,
      authority: draft.authority,
    }),
  );
}

/**
 * Validate structured output only when the advertised schema and value fit the
 * bounded Phase 1A JSON subset. Unsupported schemas and unbounded values are
 * recorded as not assessed; raw AJV diagnostics are never retained.
 */
export function assessOutputSchema(
  input: AssessOutputSchemaInput,
): Readonly<OutputSchemaAssessmentV2> {
  if (input.tool.outputSchema === undefined) {
    return deepFreezeJson({ status: "not_advertised" });
  }
  const outputSchema = cloneStrictBoundedJson(
    input.tool.outputSchema,
    V2_ARTIFACT_CLONE_LIMITS,
    "advertised MCP output schema",
  ).clone as NonNullable<NormalizedCatalogToolV2["outputSchema"]>;
  const outputSchemaDigest = digestCanonicalJson(
    "forge.mcp-output-schema",
    "v2",
    outputSchema,
  );
  if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1) {
    throw new RangeError("maxOutputBytes must be a positive safe integer");
  }

  try {
    assertSafeInputSchema(outputSchema);
  } catch {
    return deepFreezeJson({
      status: "not_assessed",
      reason:
        "The advertised output schema is outside the bounded Phase 1A validation subset.",
    });
  }

  let value: unknown;
  try {
    value = cloneStrictBoundedJson(
      input.value,
      {
        ...V2_ARGUMENT_LIMITS,
        maxSerializedBytes: Math.min(
          V2_ARGUMENT_LIMITS.maxSerializedBytes,
          input.maxOutputBytes,
        ),
      },
      "V2 structured tool output",
    ).clone;
  } catch {
    return deepFreezeJson({
      status: "not_assessed",
      reason: "The structured output exceeded a validation bound.",
    });
  }

  let conforms: boolean;
  try {
    const compiled = compileInputSchema(outputSchema, {
      strictSchema: true,
    });
    conforms = runSynchronousInputValidator(compiled.validate, value);
  } catch {
    return deepFreezeJson({
      status: "not_assessed",
      reason:
        "The advertised output schema could not be evaluated by the bounded synchronous validator.",
    });
  }

  return deepFreezeJson(
    outputSchemaAssessmentV2Schema.parse({
      status: conforms ? "conforms" : "violates",
      outputSchemaDigest,
      assessedValueSha256: digestCanonicalJson(
        "forge.mcp-structured-output",
        "v2",
        value,
      ),
      validator: OUTPUT_SCHEMA_VALIDATOR_IDENTITY,
      issueCodes: conforms ? [] : ["schema-mismatch"],
    }),
  );
}

function effectMatchesPrediction(
  prediction: PredictedEffectV2,
  effect: OutcomeObservationV2["effects"][number],
): boolean {
  return (
    prediction.action === effect.action &&
    prediction.resourceClass === effect.resourceClass &&
    prediction.phase === effect.phase &&
    (prediction.selector === undefined ||
      prediction.selector === effect.selector)
  );
}

function baseRuleMatches(
  rule: SubjectBehaviorRuleV2,
  toolName: string,
  effect: OutcomeObservationV2["effects"][number],
): boolean {
  return (
    rule.toolNames.includes(toolName) &&
    rule.actions.includes(effect.action) &&
    rule.resourceClasses.includes(effect.resourceClass) &&
    rule.phases.includes(effect.phase) &&
    (rule.selectors.length === 0 ||
      (effect.selector !== undefined &&
        rule.selectors.includes(effect.selector)))
  );
}

function aggregateWithinRuleLimits(
  rule: SubjectBehaviorRuleV2,
  effects: readonly OutcomeObservationV2["effects"][number][],
): boolean {
  let operations = 0n;
  let bytes = 0n;
  let runtimeMs = 0n;
  for (const effect of effects) {
    operations += BigInt(effect.operationCount);
    bytes += BigInt(effect.byteCount);
    runtimeMs += BigInt(effect.runtimeMs);
  }
  return (
    operations <= BigInt(rule.limits.maxOperations) &&
    bytes <= BigInt(rule.limits.maxBytes) &&
    runtimeMs <= BigInt(rule.limits.maxRuntimeMs)
  );
}

function policyAppraisals(
  policy: ApprovedPolicyV2,
  toolName: string,
  effects: readonly OutcomeObservationV2["effects"][number][],
): ReadonlyMap<string, PolicyAppraisal> {
  const ruleWithinLimits = new Map<string, boolean>();
  for (const rule of policy.subjectBehaviorRules.rules) {
    const matchingEffects = effects.filter((effect) =>
      baseRuleMatches(rule, toolName, effect),
    );
    ruleWithinLimits.set(
      rule.ruleId,
      aggregateWithinRuleLimits(rule, matchingEffects),
    );
  }

  const result = new Map<string, PolicyAppraisal>();
  for (const effect of effects) {
    const baseMatching = policy.subjectBehaviorRules.rules.filter((rule) =>
      baseRuleMatches(rule, toolName, effect),
    );
    const denying = baseMatching.filter((rule) => rule.decision === "deny");
    if (denying.length > 0) {
      result.set(effect.effectId, {
        decision: "denied",
        basis: "matching_rule",
        ruleIds: denying.map((rule) => rule.ruleId).sort(),
      });
      continue;
    }

    const exceededReviewGates = baseMatching.filter(
      (rule) =>
        rule.decision === "review_required" &&
        ruleWithinLimits.get(rule.ruleId) === false,
    );
    if (exceededReviewGates.length > 0) {
      result.set(effect.effectId, {
        decision: "review_required",
        basis: "rule_limits_exceeded",
        ruleIds: exceededReviewGates.map((rule) => rule.ruleId).sort(),
      });
      continue;
    }

    const positive = baseMatching.filter(
      (rule) =>
        rule.decision !== "deny" && ruleWithinLimits.get(rule.ruleId) === true,
    );
    if (positive.length > 0) {
      result.set(effect.effectId, {
        decision: positive.some((rule) => rule.decision === "review_required")
          ? "review_required"
          : "allowed",
        basis: "matching_rule",
        ruleIds: positive.map((rule) => rule.ruleId).sort(),
      });
      continue;
    }

    const exceeded = baseMatching.filter(
      (rule) =>
        rule.decision !== "deny" && ruleWithinLimits.get(rule.ruleId) === false,
    );
    result.set(effect.effectId, {
      decision:
        policy.subjectBehaviorRules.defaultDecision === "deny"
          ? "denied"
          : "review_required",
      basis: exceeded.length > 0 ? "rule_limits_exceeded" : "default_decision",
      ruleIds: exceeded.map((rule) => rule.ruleId).sort(),
    });
  }
  return result;
}

function capturedBytes(observation: OutcomeObservationV2): number | undefined {
  switch (observation.capture.status) {
    case "complete":
      return observation.capture.byteLength;
    case "truncated":
      return observation.capture.capturedBytes;
    case "unavailable":
      return undefined;
  }
}

function boundedSizeStatus(
  observation: OutcomeObservationV2,
  maximum: number,
): "matches" | "deviates" | "inconclusive" {
  const bytes = capturedBytes(observation);
  if (bytes === undefined) return "inconclusive";
  if (bytes > maximum) return "deviates";
  if (
    observation.capture.status === "truncated" &&
    observation.capture.overflowObserved &&
    observation.capture.observedAtLeastBytes > maximum
  ) {
    return "deviates";
  }
  return observation.capture.status === "complete" ? "matches" : "inconclusive";
}

function outputSchemaStatus(
  expected: OutputSchemaExpectationV2,
  observed: OutcomeObservationV2["outputSchemaAssessment"],
): "matches" | "deviates" | "inconclusive" {
  if (expected.status === "not_advertised") {
    return observed.status === "not_advertised" ? "matches" : "deviates";
  }
  if (observed.status === "not_assessed") return "inconclusive";
  if (observed.status === "not_advertised") return "deviates";
  if (observed.outputSchemaDigest !== expected.outputSchemaDigest) {
    return "deviates";
  }
  return observed.status === "conforms" ? "matches" : "deviates";
}

function sortContentClasses(
  values: Iterable<OutcomeContentClassV2>,
): OutcomeContentClassV2[] {
  const order = new Map(
    outcomeContentClassV2Schema.options.map((value, index) => [value, index]),
  );
  return [...new Set(values)].sort(
    (left, right) => order.get(left)! - order.get(right)!,
  );
}

function contentComparison(
  hypothesis: OutcomeHypothesisV2,
  observation: OutcomeObservationV2,
) {
  const expected = hypothesis.expected.contentClasses;
  if (observation.contentAnalysis.status === "not_assessed") {
    return {
      expectedClasses: expected,
      observedClasses: [],
      unexpectedClasses: [],
      missingClasses: [],
      hazardSignalIds: [],
      status: "inconclusive" as const,
    };
  }
  const observed = observation.contentAnalysis.classes;
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  const unexpected = sortContentClasses(
    observed.filter((item) => !expectedSet.has(item)),
  );
  const missing = sortContentClasses(
    expected.filter((item) => !observedSet.has(item)),
  );
  let status: "matches" | "deviates" | "inconclusive";
  if (expected.length === 0) status = "inconclusive";
  else if (observation.contentAnalysis.coverage === "prefix") {
    status =
      observation.contentAnalysis.signals.length > 0
        ? "deviates"
        : "inconclusive";
  } else if (unexpected.length > 0) status = "deviates";
  else if (missing.length > 0) status = "deviates";
  else status = "matches";
  return {
    expectedClasses: expected,
    observedClasses: observed,
    unexpectedClasses: unexpected,
    missingClasses: missing,
    hazardSignalIds: observation.contentAnalysis.signals
      .map((signal) => signal.signalId)
      .sort(),
    status,
  };
}

function combineExpectation(
  statuses: readonly ("matches" | "deviates" | "inconclusive")[],
): "matches" | "deviates" | "inconclusive" {
  if (statuses.includes("deviates")) return "deviates";
  if (statuses.includes("inconclusive")) return "inconclusive";
  return "matches";
}

function requiredSensorPartition(
  observation: OutcomeObservationV2,
  requiredSensors: readonly OutcomeObservationV2["sensors"][number]["sensor"][],
): {
  readonly complete: OutcomeObservationV2["sensors"][number]["sensor"][];
  readonly incomplete: OutcomeObservationV2["sensors"][number]["sensor"][];
} {
  const order = new Map(SENSOR_ORDER.map((sensor, index) => [sensor, index]));
  const bySensor = new Map(
    observation.sensors.map((sensor) => [sensor.sensor, sensor]),
  );
  const canonical = [...requiredSensors].sort(
    (left, right) => order.get(left)! - order.get(right)!,
  );
  return {
    complete: canonical.filter(
      (sensor) => bySensor.get(sensor)?.status === "complete",
    ),
    incomplete: canonical.filter(
      (sensor) => bySensor.get(sensor)?.status !== "complete",
    ),
  };
}

function validateBindings(
  envelope: ExperimentPlanEnvelopeV2,
  catalog: ComputedCatalogV2,
  policy: ApprovedPolicyV2,
  hypothesis: OutcomeHypothesisV2,
  observation: OutcomeObservationV2,
) {
  assertCanonicalEqual(
    "computed catalog identity",
    catalog.identity,
    envelope.plan.catalog,
  );
  const policyDigest = digestCanonicalJson("forge.audit-policy", "v2", policy);
  if (policyDigest !== envelope.plan.policyDigest) {
    fail("ApprovedPolicy digest does not match the ExperimentPlan");
  }
  if (envelope.plan.policyExpiresAt !== policy.expiresAt) {
    fail("ApprovedPolicy expiry does not match the ExperimentPlan");
  }
  if (
    policy.subject.kind !== "exact_target" ||
    policy.subject.targetId !== envelope.plan.target.targetId ||
    policy.subject.targetIdentityDigest !==
      digestCanonicalJson("forge.target-identity", "v2", envelope.plan.target)
  ) {
    fail("ApprovedPolicy subject does not match the planned target");
  }
  const experimentCase = envelope.plan.cases.find(
    (candidate) => candidate.caseId === hypothesis.caseId,
  );
  if (experimentCase === undefined)
    fail("hypothesis caseId is not in the plan");
  const step = experimentCase.steps.find(
    (candidate) => candidate.stepId === hypothesis.stepId,
  );
  if (step === undefined) fail("hypothesis stepId is not in the selected case");
  if (step.toolName !== hypothesis.toolName)
    fail("hypothesis toolName does not match");
  const tool = catalog.catalog.tools.find(
    (candidate) => candidate.name === step.toolName,
  );
  if (tool === undefined)
    fail("planned tool is absent from the computed catalog");

  for (const item of [hypothesis, observation]) {
    if (item.experimentPlanDigest !== envelope.experimentPlanDigest) {
      fail("sidecar ExperimentPlan digest does not match");
    }
    assertCanonicalEqual(
      "sidecar catalog identity",
      item.catalog,
      envelope.plan.catalog,
    );
    if (
      item.caseId !== experimentCase.caseId ||
      item.stepId !== step.stepId ||
      item.toolName !== step.toolName
    ) {
      fail("hypothesis and observation step bindings disagree");
    }
  }
  if (observation.policyDigest !== policyDigest) {
    fail("observation policy digest does not match");
  }
  if (Date.parse(hypothesis.createdAt) < Date.parse(envelope.plan.compiledAt)) {
    fail("hypothesis predates the compiled plan");
  }
  const hypothesisDigest = digestCanonicalJson(
    "forge.outcome-hypothesis",
    "v1alpha1",
    hypothesis,
  );
  if (observation.hypothesisDigest !== hypothesisDigest) {
    fail("observation hypothesis digest does not match");
  }
  if (Date.parse(observation.recordedAt) < Date.parse(hypothesis.createdAt)) {
    fail("observation predates its preregistered hypothesis");
  }
  const observedSensors = new Set(
    observation.sensors.map((sensor) => sensor.sensor),
  );
  for (const sensor of envelope.plan.requiredSensors) {
    if (!observedSensors.has(sensor)) {
      fail(`observation omits required sensor '${sensor}'`);
    }
  }
  assertCanonicalEqual(
    "hypothesis predicted effects",
    hypothesis.expected.predictedEffects,
    experimentCase.predictedEffects,
  );
  const schemaExpectation = expectedOutputSchema(tool);
  assertCanonicalEqual(
    "hypothesis output-schema identity",
    hypothesis.expected.outputSchema,
    schemaExpectation,
  );
  if (
    observation.outputSchemaAssessment.status !== "not_assessed" &&
    observation.outputSchemaAssessment.status !== "not_advertised" &&
    schemaExpectation.status === "advertised" &&
    observation.outputSchemaAssessment.outputSchemaDigest !==
      schemaExpectation.outputSchemaDigest
  ) {
    fail("observation output-schema digest does not match the catalog");
  }
  if (
    observation.outputSchemaAssessment.status !== "not_assessed" &&
    observation.outputSchemaAssessment.status !== "not_advertised"
  ) {
    assertCanonicalEqual(
      "output-schema validator identity",
      observation.outputSchemaAssessment.validator,
      OUTPUT_SCHEMA_VALIDATOR_IDENTITY,
    );
  }
  if (observation.contentAnalysis.status === "assessed") {
    assertCanonicalEqual(
      "result-content analyzer identity",
      observation.contentAnalysis.analyzer,
      RESULT_CONTENT_ANALYZER_IDENTITY,
    );
  }
  if (
    schemaExpectation.status === "not_advertised" &&
    observation.outputSchemaAssessment.status !== "not_advertised"
  ) {
    fail("observation claims an output schema that was not advertised");
  }
  return { schemaExpectation, policyDigest, hypothesisDigest };
}

/**
 * Compare one already-planned step hypothesis with one bounded observation.
 * This is appraisal only: it neither verifies a runtime dispatch receipt nor
 * authorizes the observed call or any follow-up call.
 */
export function compareOutcome(
  input: CompareOutcomeInput,
): Readonly<OutcomeComparisonV2> {
  const envelope = verifyExperimentPlanEnvelope(input.envelope);
  const policy = parseDetached(
    input.policy,
    "V2 outcome-comparison policy",
    (value) => approvedPolicyV2Schema.parse(value),
  );
  const hypothesis = parseDetached(
    input.hypothesis,
    "V2 outcome hypothesis",
    (value) => outcomeHypothesisV2Schema.parse(value),
  );
  const observation = parseDetached(
    input.observation,
    "V2 outcome observation",
    (value) => outcomeObservationV2Schema.parse(value),
  );
  const catalog = computeCatalogIdentity(input.catalog);
  const { schemaExpectation, policyDigest, hypothesisDigest } =
    validateBindings(envelope, catalog, policy, hypothesis, observation);
  if (
    Date.parse(input.comparedAt) < Date.parse(hypothesis.createdAt) ||
    Date.parse(input.comparedAt) < Date.parse(observation.recordedAt)
  ) {
    fail("comparison timestamp predates a compared artifact");
  }
  if (
    policy.expiresAt !== undefined &&
    Date.parse(observation.recordedAt) >= Date.parse(policy.expiresAt)
  ) {
    fail("observation was recorded outside the ApprovedPolicy validity window");
  }

  const protocolStatus = hypothesis.expected.protocolOutcomes.includes(
    observation.protocolOutcome,
  )
    ? "matches"
    : "deviates";
  const shapeStatus =
    observation.capture.status === "unavailable" ||
    hypothesis.expected.shapes.includes("unknown")
      ? "inconclusive"
      : hypothesis.expected.shapes.includes(observation.shape)
        ? "matches"
        : "deviates";
  const schemaStatus = outputSchemaStatus(
    schemaExpectation,
    observation.outputSchemaAssessment,
  );
  const reasonableSizeStatus = boundedSizeStatus(
    observation,
    hypothesis.expected.maxReasonableBytes,
  );
  const approvedSizeStatus = boundedSizeStatus(
    observation,
    envelope.plan.bounds.maxOutputBytesPerStep,
  );
  const content = contentComparison(hypothesis, observation);

  const predictedRows = hypothesis.expected.predictedEffects.map(
    (prediction) => {
      const observedEffectIds = observation.effects
        .filter((effect) => effectMatchesPrediction(prediction, effect))
        .map((effect) => effect.effectId)
        .sort();
      return {
        predictionId: prediction.predictionId,
        observedEffectIds,
        status:
          observedEffectIds.length > 0
            ? ("observed" as const)
            : ("not_observed" as const),
      };
    },
  );
  const appraisals = policyAppraisals(
    policy,
    observation.toolName,
    observation.effects,
  );
  const observedRows = observation.effects.map((effect) => {
    const predictionIds = hypothesis.expected.predictedEffects
      .filter((prediction) => effectMatchesPrediction(prediction, effect))
      .map((prediction) => prediction.predictionId)
      .sort();
    const appraisal = appraisals.get(effect.effectId);
    if (appraisal === undefined) fail("missing deterministic policy appraisal");
    return {
      effectId: effect.effectId,
      predictionIds,
      expectation:
        predictionIds.length > 0
          ? ("expected" as const)
          : ("unexpected" as const),
      policyDecision: appraisal.decision,
      policyBasis: appraisal.basis,
      policyRuleIds: [...appraisal.ruleIds],
    };
  });
  const effectExpectationStatus = observedRows.some(
    (row) => row.expectation === "unexpected",
  )
    ? "deviates"
    : predictedRows.some((row) => row.status === "not_observed")
      ? requiredSensorPartition(observation, envelope.plan.requiredSensors)
          .incomplete.length === 0
        ? "deviates"
        : "inconclusive"
      : "matches";

  const expectation = combineExpectation([
    protocolStatus,
    shapeStatus,
    schemaStatus,
    reasonableSizeStatus,
    content.status,
    effectExpectationStatus,
  ]);
  const policySummary =
    approvedSizeStatus === "deviates" ||
    observedRows.some((row) => row.policyDecision === "denied")
      ? "policy_deviation"
      : observedRows.some((row) => row.policyDecision === "review_required")
        ? "review_required"
        : approvedSizeStatus === "inconclusive" ||
            requiredSensorPartition(observation, envelope.plan.requiredSensors)
              .incomplete.length > 0
          ? "inconclusive"
          : "within_policy";
  const intrinsicRisk =
    observation.contentAnalysis.status === "assessed" &&
    observation.contentAnalysis.signals.length > 0
      ? "signals_observed"
      : observation.capture.status === "complete" &&
          observation.contentAnalysis.status === "assessed" &&
          observation.contentAnalysis.coverage === "complete"
        ? "no_signal_observed"
        : "inconclusive";
  const outcome =
    policySummary === "policy_deviation"
      ? "policy_deviation"
      : intrinsicRisk === "signals_observed"
        ? "intrinsic_hazard_evidence"
        : policySummary === "review_required"
          ? "review_required"
          : expectation === "deviates"
            ? "unexpected_behavior"
            : expectation === "matches" &&
                policySummary === "within_policy" &&
                intrinsicRisk === "no_signal_observed"
              ? "expected_within_policy"
              : "inconclusive";

  const bytes = capturedBytes(observation);
  const sensorPartition = requiredSensorPartition(
    observation,
    envelope.plan.requiredSensors,
  );
  const comparison = outcomeComparisonV2Schema.parse({
    format: "forge.outcome-comparison/v1alpha1",
    comparisonId: input.comparisonId,
    comparedAt: input.comparedAt,
    experimentPlanDigest: envelope.experimentPlanDigest,
    policyDigest,
    catalog: envelope.plan.catalog,
    caseId: hypothesis.caseId,
    stepId: hypothesis.stepId,
    toolName: hypothesis.toolName,
    hypothesisDigest,
    observationDigest: digestCanonicalJson(
      "forge.outcome-observation",
      "v1alpha1",
      observation,
    ),
    executionBounds: envelope.plan.bounds,
    coverage: {
      resultProjection: observation.capture.projection,
      captureStatus: observation.capture.status,
      ...(observation.capture.status === "truncated"
        ? {
            truncationCause: observation.capture.truncationCause,
            overflowObserved: observation.capture.overflowObserved,
            observedAtLeastBytes: observation.capture.observedAtLeastBytes,
          }
        : observation.capture.status === "complete"
          ? {
              overflowObserved: false,
              observedAtLeastBytes: observation.capture.byteLength,
            }
          : { overflowObserved: false }),
      contentAnalysisStatus: observation.contentAnalysis.status,
      ...(observation.contentAnalysis.status === "assessed"
        ? { contentCoverage: observation.contentAnalysis.coverage }
        : {}),
      requiredSensors: [
        ...sensorPartition.complete,
        ...sensorPartition.incomplete,
      ].sort(
        (left, right) =>
          SENSOR_ORDER.indexOf(left) - SENSOR_ORDER.indexOf(right),
      ),
      completeSensors: sensorPartition.complete,
      incompleteSensors: sensorPartition.incomplete,
    },
    protocol: {
      expected: hypothesis.expected.protocolOutcomes,
      observed: observation.protocolOutcome,
      status: protocolStatus,
    },
    shape: {
      expected: hypothesis.expected.shapes,
      observed: observation.shape,
      status: shapeStatus,
    },
    outputSchema: {
      expected: schemaExpectation,
      observed: observation.outputSchemaAssessment,
      status: schemaStatus,
    },
    size: {
      ...(bytes === undefined ? {} : { capturedBytes: bytes }),
      maxReasonableBytes: hypothesis.expected.maxReasonableBytes,
      approvedMaxBytes: envelope.plan.bounds.maxOutputBytesPerStep,
      reasonableStatus: reasonableSizeStatus,
      approvedStatus: approvedSizeStatus,
    },
    content,
    predictedEffects: predictedRows,
    observedEffects: observedRows,
    summary: {
      expectation,
      policy: policySummary,
      intrinsicRisk,
      outcome,
    },
    authority: {
      authorizesExecution: false,
      authorizesFollowup: false,
      safetyVerdict: "not_produced",
    },
    limitations: [
      "This selected-step comparison is not a universal safety or intent verdict.",
      "Content signals are bounded indicators and can have false positives or false negatives.",
      "Subject-behavior appraisal is separate from experiment dispatch authorization.",
      "This alpha sidecar does not verify a runtime dispatch receipt.",
    ],
  });
  return deepFreezeJson(comparison);
}

export interface VerifyOutcomeComparisonInput extends Omit<
  CompareOutcomeInput,
  "comparisonId" | "comparedAt"
> {
  readonly comparison: unknown;
}

/**
 * Integrity verification requires the source hypothesis and observation. A
 * schema-valid comparison by itself is only an untrusted serialized claim.
 */
export function verifyOutcomeComparison(
  input: VerifyOutcomeComparisonInput,
): Readonly<OutcomeComparisonV2> {
  const submitted = parseDetached(
    input.comparison,
    "V2 outcome comparison",
    (value) => outcomeComparisonV2Schema.parse(value),
  );
  const recomputed = compareOutcome({
    comparisonId: submitted.comparisonId,
    comparedAt: submitted.comparedAt,
    envelope: input.envelope,
    catalog: input.catalog,
    policy: input.policy,
    hypothesis: input.hypothesis,
    observation: input.observation,
  });
  assertCanonicalEqual(
    "submitted comparison derivation",
    submitted,
    recomputed,
  );
  return recomputed;
}
