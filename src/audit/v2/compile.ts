import { Buffer } from "node:buffer";

import {
  approvedPolicyV2Schema,
  auditSpecV2Schema,
  boundedJsonValueV2Schema,
  claimProfileV2Schema,
  identifierV2Schema,
  manualAuditCaseV2Schema,
  timestampV2Schema,
  V2_CONTRACT_LIMITS,
  type ApprovalClassV2,
  type ApprovedPolicyV2,
  type AuditSpecV2,
  type BoundedJsonValueV2,
  type CaseOriginV2,
  type ClaimProfileV2,
  type ExperimentPlanCaseV2,
  type ManualAuditCaseV2,
  type ResourceClassV2,
} from "../../contracts/v2/index.js";
import {
  JsonLimitError,
  type JsonTraversalLimits,
} from "../../mcp/json-bounds.js";
import {
  compileInputSchema,
  type CompiledInputSchema,
} from "../../mcp/input-schema.js";
import {
  materializeSyntheticResources,
  type MaterializedSyntheticResources,
} from "./artifacts.js";
import {
  computeCatalogIdentity,
  type ComputedCatalogV2,
  type NormalizedCatalogToolV2,
} from "./catalog.js";
import { canonicalizeJson, digestCanonicalJson } from "./canonical.js";
import { validateClaimEvidenceBindings } from "./claim-evidence.js";
import {
  createExperimentPlanEnvelope,
  type ExperimentPlanEnvelopeV2,
} from "./envelope.js";
import { V2CompileError } from "./errors.js";
import {
  assertPolicyEvaluationWorkBound,
  createPolicyEvaluationWorkTracker,
  evaluatePreparedExperimentDispatch,
  maximumApprovalClass,
  prepareExperimentDispatchPolicy,
  type PolicyEvaluationWorkTracker,
  type PreparedExperimentDispatchPolicy,
} from "./policy.js";
import {
  analyzeStaticResourceReferences,
  resolveStaticResourceReferences,
  type StaticResourceReferenceAnalysis,
} from "./references.js";
import {
  assertSafeInputSchema,
  runSynchronousInputValidator,
  V2_ARGUMENT_LIMITS,
} from "./schema-safety.js";
import {
  cloneStrictBoundedJson,
  V2_ARTIFACT_CLONE_LIMITS,
} from "./strict-clone.js";
import {
  verifyTargetIdentity,
  type VerifiedTargetInput,
} from "./target.js";

export interface CompileExperimentPlanInput {
  readonly planId: string;
  readonly manifestId: string;
  readonly compiledAt: string;
  readonly target: VerifiedTargetInput;
  readonly catalog: unknown;
  readonly claimProfile: unknown;
  readonly policy: unknown;
  readonly auditSpec: unknown;
  readonly mandatoryCases: readonly unknown[];
}

export const PHASE1_COMPILER_IDENTITY = Object.freeze({
  id: "forge-provider-free-compiler",
  version: "2.0.0-phase1",
});

/**
 * Controller-owned work ceilings are deliberately stricter than caller-owned
 * execution bounds. They keep expansion and validation bounded before the
 * final 4 MB / 100k-node ExperimentPlan envelope can reject the artifact.
 */
export const PHASE1_COMPILER_WORK_LIMITS = Object.freeze({
  maxExpandedSteps: 4_096,
  maxAggregateArgumentBytes: 2_000_000,
  maxAggregateArgumentNodes: 50_000,
  maxAggregateCaseBytes: 3_000_000,
  maxAggregateCaseNodes: 75_000,
});

export interface CompiledExperimentPlanV2 extends ExperimentPlanEnvelopeV2 {
  readonly catalog: ComputedCatalogV2;
  readonly resources: MaterializedSyntheticResources;
}

interface ExpandedCase {
  readonly caseId: string;
  readonly origin: "mandatory" | "manual";
  readonly repetition: number;
  readonly environmentVariant: string;
  readonly template: ManualAuditCaseV2;
  readonly aliases: readonly string[];
  readonly aliasesByStepId: ReadonlyMap<
    string,
    StaticResourceReferenceAnalysis
  >;
}

interface PreparedCatalogToolV2 {
  readonly descriptor: NormalizedCatalogToolV2;
  readonly input: CompiledInputSchema;
}

interface CompilerWorkTracker {
  argumentBytes: number;
  argumentNodes: number;
  caseBytes: number;
  caseNodes: number;
}

function boundedParse<T>(
  value: unknown,
  label: string,
  parse: (detached: unknown) => T,
): T {
  const detached = cloneStrictBoundedJson(
    value,
    V2_ARTIFACT_CLONE_LIMITS,
    label,
  ).clone;
  return parse(detached);
}

function artifactDigest(domain: string, value: unknown): string {
  return digestCanonicalJson(domain, "v2", value);
}

function requireEqual(label: string, left: unknown, right: unknown): void {
  if (canonicalizeJson(left) !== canonicalizeJson(right)) {
    throw new V2CompileError("digest_mismatch", `${label} does not match`);
  }
}

function validateBindings(
  claimProfile: ClaimProfileV2,
  policy: ApprovedPolicyV2,
  spec: AuditSpecV2,
  input: {
    readonly target: ReturnType<typeof verifyTargetIdentity>;
    readonly catalog: ComputedCatalogV2;
    readonly claimProfileDigest: string;
    readonly policyDigest: string;
    readonly compiledAt: string;
  },
): void {
  if (spec.policyDigest !== input.policyDigest) {
    throw new V2CompileError(
      "digest_mismatch",
      "AuditSpec policy digest does not match ApprovedPolicy",
    );
  }
  if (spec.claimProfileDigest !== input.claimProfileDigest) {
    throw new V2CompileError(
      "digest_mismatch",
      "AuditSpec claim digest does not match ClaimProfile",
    );
  }
  if (
    spec.targetSelector.targetId !== input.target.identity.targetId ||
    spec.targetSelector.sourceArtifactSha256 !==
      input.target.identity.sourceArtifact.sha256
  ) {
    throw new V2CompileError(
      "artifact_mismatch",
      "AuditSpec target selector does not match the verified target",
    );
  }
  if (policy.subject.kind !== "exact_target") {
    throw new V2CompileError(
      "policy_missing",
      "Phase 1A requires an exact-target policy subject",
    );
  }
  if (policy.subject.targetId !== input.target.identity.targetId) {
    throw new V2CompileError(
      "policy_missing",
      "ApprovedPolicy subject does not match the verified target",
    );
  }
  if (policy.subject.targetIdentityDigest !== input.target.targetIdentityDigest) {
    throw new V2CompileError(
      "policy_missing",
      "ApprovedPolicy exact target identity does not match verified bytes",
    );
  }
  if (
    policy.expiresAt !== undefined &&
    Date.parse(policy.expiresAt) <= Date.parse(input.compiledAt)
  ) {
    throw new V2CompileError("policy_missing", "ApprovedPolicy has expired");
  }
  const compiledAt = Date.parse(input.compiledAt);
  if (
    !Number.isFinite(compiledAt) ||
    Date.parse(policy.reviewedAt) > compiledAt ||
    Date.parse(spec.createdAt) > compiledAt ||
    Date.parse(claimProfile.generatedAt) > compiledAt
  ) {
    throw new V2CompileError(
      "policy_missing",
      "plan compilation must not predate its policy, spec, or claim inputs",
    );
  }
  if (
    Date.parse(spec.createdAt) < Date.parse(policy.reviewedAt) ||
    Date.parse(spec.createdAt) < Date.parse(claimProfile.generatedAt)
  ) {
    throw new V2CompileError(
      "digest_mismatch",
      "AuditSpec cannot predate the reviewed policy or ClaimProfile it binds",
    );
  }
  for (const requiredSensor of policy.minimumCoverage.requiredSensors) {
    if (!spec.requiredSensors.includes(requiredSensor)) {
      throw new V2CompileError(
        "policy_missing",
        `AuditSpec omits policy-required sensor '${requiredSensor}'`,
      );
    }
  }
  const catalogTools = new Set(
    input.catalog.catalog.tools.map((tool) => tool.name),
  );
  for (const claim of claimProfile.claims) {
    if (!catalogTools.has(claim.toolName)) {
      throw new V2CompileError(
        "digest_mismatch",
        `ClaimProfile references absent tool '${claim.toolName}'`,
      );
    }
  }
  validateClaimEvidenceBindings(claimProfile, input.catalog);
  requireEqual("ClaimProfile target", claimProfile.target, input.target.identity);
  requireEqual("ClaimProfile catalog", claimProfile.catalog, input.catalog.identity);
}

function parseMandatoryCases(values: readonly unknown[]): ManualAuditCaseV2[] {
  const detached = cloneStrictBoundedJson(
    values,
    V2_ARTIFACT_CLONE_LIMITS,
    "mandatory V2 case suite",
  ).clone;
  if (!Array.isArray(detached)) {
    throw new V2CompileError(
      "digest_mismatch",
      "mandatory case suite must be an array",
    );
  }
  if (detached.length > V2_CONTRACT_LIMITS.arrayItems) {
    throw new V2CompileError(
      "bounds_exceeded",
      "mandatory template count exceeds the V2 plan limit",
    );
  }
  const parsed = detached.map((value) =>
    manualAuditCaseV2Schema.parse(value),
  );
  const seen = new Set<string>();
  for (const item of parsed) {
    if (seen.has(item.caseId)) {
      throw new V2CompileError(
        "duplicate_id",
        `duplicate mandatory caseId '${item.caseId}'`,
      );
    }
    seen.add(item.caseId);
  }
  return parsed;
}

function analyzeCaseAliases(
  template: ManualAuditCaseV2,
  limits: JsonTraversalLimits,
): {
  readonly aliases: readonly string[];
  readonly aliasesByStepId: ReadonlyMap<
    string,
    StaticResourceReferenceAnalysis
  >;
} {
  const aliases = new Set<string>();
  const aliasesByStepId = new Map<string, StaticResourceReferenceAnalysis>();
  for (const step of template.steps) {
    const analysis = analyzeStaticResourceReferences(step.arguments, limits);
    aliasesByStepId.set(step.stepId, analysis);
    for (const alias of analysis.aliases) {
      aliases.add(alias);
    }
  }
  return { aliases: [...aliases].sort(), aliasesByStepId };
}

function expandedCaseId(
  baseId: string,
  environmentVariant: string,
  repetition: number,
): string {
  const readable = `${baseId}--${environmentVariant}--r${repetition}`;
  if (readable.length <= 128) return readable;
  return `case-${digestCanonicalJson("forge.expanded-case", "v2", {
    baseId,
    environmentVariant,
    repetition,
  }).slice(0, 32)}`;
}

function expandCases(input: {
  readonly mandatory: readonly ManualAuditCaseV2[];
  readonly spec: AuditSpecV2;
}): ExpandedCase[] {
  const unsupportedCase = [...input.mandatory, ...input.spec.manualCases].find(
    (template) =>
      template.kind !== "tool_call" && template.kind !== "security_probe",
  );
  if (unsupportedCase !== undefined) {
    throw new V2CompileError(
      "binding_unsupported",
      `case kind '${unsupportedCase.kind}' is non-executable in Phase 1A`,
    );
  }
  const expansionFactor =
    input.spec.repetitions * input.spec.environmentVariants.length;
  const expandedMandatoryCount = input.mandatory.length * expansionFactor;
  const expandedManualCount = input.spec.manualCases.length * expansionFactor;
  if (
    expandedMandatoryCount + expandedManualCount >
      V2_CONTRACT_LIMITS.arrayItems ||
    expandedMandatoryCount + expandedManualCount >
      input.spec.executionBounds.maxCases
  ) {
    throw new V2CompileError(
      "bounds_exceeded",
      "expanded case cardinality exceeds the plan budget",
    );
  }
  const manualIds = new Set(input.spec.manualCases.map((item) => item.caseId));
  for (const item of input.mandatory) {
    if (manualIds.has(item.caseId)) {
      throw new V2CompileError(
        "mandatory_collision",
        `manual case collides with mandatory caseId '${item.caseId}'`,
      );
    }
    if (
      item.predictedEffects.some(
        (prediction) => prediction.origin !== "deterministic_generator",
      )
    ) {
      throw new V2CompileError(
        "mandatory_collision",
        "mandatory case predictions must be compiler-owned deterministic predictions",
      );
    }
  }
  for (const item of input.spec.manualCases) {
    if (
      item.predictedEffects.some((prediction) => prediction.origin !== "operator")
    ) {
      throw new V2CompileError(
        "binding_unsupported",
        "manual case predictions must have operator origin in Phase 1A",
      );
    }
  }

  const expandGroup = (
    templates: readonly ManualAuditCaseV2[],
    origin: "mandatory" | "manual",
  ): ExpandedCase[] => {
    const result: ExpandedCase[] = [];
    const limits = argumentLimits(input.spec);
    const analysisByTemplate = new Map(
      templates.map((template) => [
        template,
        analyzeCaseAliases(template, limits),
      ] as const),
    );
    for (const environmentVariant of input.spec.environmentVariants) {
      for (
        let repetition = 1;
        repetition <= input.spec.repetitions;
        repetition += 1
      ) {
        for (const template of templates) {
          const aliasAnalysis = analysisByTemplate.get(template)!;
          result.push({
            caseId: expandedCaseId(
              template.caseId,
              environmentVariant,
              repetition,
            ),
            origin,
            repetition,
            environmentVariant,
            template,
            aliases: aliasAnalysis.aliases,
            aliasesByStepId: aliasAnalysis.aliasesByStepId,
          });
        }
      }
    }
    return result;
  };

  const mandatory = expandGroup(input.mandatory, "mandatory");
  const manual = expandGroup(input.spec.manualCases, "manual");
  if (mandatory.length !== input.spec.mandatoryCaseReservation) {
    throw new V2CompileError(
      "bounds_exceeded",
      "mandatory case reservation does not equal the expanded mandatory suite",
    );
  }
  const total = mandatory.length + manual.length;
  if (total > input.spec.executionBounds.maxCases) {
    throw new V2CompileError("bounds_exceeded", "expanded cases exceed maxCases");
  }
  const identifiers = new Set<string>();
  for (const item of [...mandatory, ...manual]) {
    if (identifiers.has(item.caseId)) {
      throw new V2CompileError("duplicate_id", "expanded caseId collision");
    }
    identifiers.add(item.caseId);
  }
  return [...mandatory, ...manual];
}

function validateMandatoryPolicy(
  policy: ApprovedPolicyV2,
  mandatory: readonly ManualAuditCaseV2[],
): void {
  const available = new Set(mandatory.map((item) => item.caseId));
  for (const required of policy.requiredMandatoryCaseIds) {
    if (!available.has(required)) {
      throw new V2CompileError(
        "mandatory_collision",
        `required mandatory case '${required}' is missing`,
      );
    }
  }
}

function argumentLimits(spec: AuditSpecV2): JsonTraversalLimits {
  return {
    ...V2_ARGUMENT_LIMITS,
    maxSerializedBytes: Math.min(
      V2_ARGUMENT_LIMITS.maxSerializedBytes,
      spec.executionBounds.maxArgumentBytes,
    ),
  };
}

function compileArguments(input: {
  readonly tool: PreparedCatalogToolV2;
  readonly unresolved: unknown;
  readonly resources: ReadonlyMap<
    string,
    { readonly alias: string; readonly containerPath: string }
  >;
  readonly limits: JsonTraversalLimits;
}): {
  readonly arguments: BoundedJsonValueV2;
  readonly argumentBytes: number;
  readonly argumentNodes: number;
} {
  const resolved = resolveStaticResourceReferences(
    input.unresolved,
    input.resources,
    input.limits,
  );
  const bounded = cloneStrictBoundedJson(
    resolved,
    input.limits,
    "resolved V2 tool arguments",
  );
  const detached = boundedJsonValueV2Schema.parse(bounded.clone);
  try {
    const valid = runSynchronousInputValidator(
      input.tool.input.validate,
      detached,
    );
    if (!valid) {
      throw new V2CompileError(
        "schema_validation_failed",
        "executable tool arguments do not satisfy the frozen input schema",
      );
    }
  } catch (error) {
    if (error instanceof V2CompileError) throw error;
    throw new V2CompileError(
      "schema_unsupported",
      "tool input schema is unsupported by the Phase 1A compiler",
      { cause: error },
    );
  }
  return {
    arguments: detached,
    argumentBytes: Buffer.byteLength(canonicalizeJson(detached), "utf8"),
    argumentNodes: bounded.metrics.nodes,
  };
}

function reserveArgumentWork(
  tracker: CompilerWorkTracker,
  compiled: { readonly argumentBytes: number; readonly argumentNodes: number },
): void {
  const nextBytes = tracker.argumentBytes + compiled.argumentBytes;
  const nextNodes = tracker.argumentNodes + compiled.argumentNodes;
  if (
    nextBytes > PHASE1_COMPILER_WORK_LIMITS.maxAggregateArgumentBytes ||
    nextNodes > PHASE1_COMPILER_WORK_LIMITS.maxAggregateArgumentNodes
  ) {
    throw new V2CompileError(
      "bounds_exceeded",
      "expanded arguments exceed the Phase 1A aggregate compiler work budget",
    );
  }
  tracker.argumentBytes = nextBytes;
  tracker.argumentNodes = nextNodes;
}

function retainCompiledCase(
  tracker: CompilerWorkTracker,
  value: ExperimentPlanCaseV2,
): ExperimentPlanCaseV2 {
  let bounded: ReturnType<typeof cloneStrictBoundedJson<ExperimentPlanCaseV2>>;
  try {
    bounded = cloneStrictBoundedJson(
      value,
      {
        ...V2_ARTIFACT_CLONE_LIMITS,
        maxNodes: PHASE1_COMPILER_WORK_LIMITS.maxAggregateCaseNodes,
        maxSerializedBytes:
          PHASE1_COMPILER_WORK_LIMITS.maxAggregateCaseBytes,
      },
      "compiled Phase 1A case",
    );
  } catch (error) {
    if (error instanceof JsonLimitError) {
      throw new V2CompileError(
        "bounds_exceeded",
        "compiled case exceeds the Phase 1A compiler work budget",
        { cause: error },
      );
    }
    throw error;
  }
  const nextBytes = tracker.caseBytes + bounded.metrics.serializedBytes;
  const nextNodes = tracker.caseNodes + bounded.metrics.nodes;
  if (
    nextBytes > PHASE1_COMPILER_WORK_LIMITS.maxAggregateCaseBytes ||
    nextNodes > PHASE1_COMPILER_WORK_LIMITS.maxAggregateCaseNodes
  ) {
    throw new V2CompileError(
      "bounds_exceeded",
      "expanded cases exceed the Phase 1A aggregate compiler work budget",
    );
  }
  tracker.caseBytes = nextBytes;
  tracker.caseNodes = nextNodes;
  return bounded.clone;
}

function prepareSelectedTools(
  catalog: ComputedCatalogV2,
  cases: readonly ExpandedCase[],
): ReadonlyMap<string, PreparedCatalogToolV2> {
  const selected = new Set(
    cases.flatMap((item) => item.template.steps.map((step) => step.toolName)),
  );
  const prepared = new Map<string, PreparedCatalogToolV2>();
  for (const tool of catalog.catalog.tools) {
    if (!selected.has(tool.name)) continue;
    try {
      assertSafeInputSchema(tool.inputSchema);
      prepared.set(tool.name, {
        descriptor: tool,
        input: compileInputSchema(tool.inputSchema, { strictSchema: true }),
      });
    } catch (error) {
      throw new V2CompileError(
        "schema_unsupported",
        `tool '${tool.name}' input schema is unsupported by the Phase 1A compiler`,
        { cause: error },
      );
    }
  }
  return prepared;
}

function resourceClassesForAliases(
  spec: AuditSpecV2,
  analysis: StaticResourceReferenceAnalysis,
  conservativeClasses: readonly ResourceClassV2[] = [],
): ResourceClassV2[] {
  const result = new Set<ResourceClassV2>();
  for (const resource of spec.syntheticResources) {
    if (analysis.aliases.has(resource.alias)) result.add(resource.resourceClass);
  }
  if (result.size === 0 || analysis.hasUnclassifiedValues) {
    result.add("unknown");
  }
  for (const resourceClass of conservativeClasses) {
    result.add(resourceClass);
  }
  return [...result].sort();
}

function executableCaseKind(
  kind: ManualAuditCaseV2["kind"],
): ExperimentPlanCaseV2["kind"] {
  if (kind !== "tool_call" && kind !== "security_probe") {
    throw new V2CompileError(
      "binding_unsupported",
      `case kind '${kind}' cannot enter a Phase 1A ExperimentPlan`,
    );
  }
  return kind;
}

function validatePrePlanBounds(
  spec: AuditSpecV2,
  target: ReturnType<typeof verifyTargetIdentity>,
  catalog: ComputedCatalogV2,
): void {
  if (
    target.identity.sourceArtifact.byteLength >
      spec.prePlanBounds.maxArtifactBytes ||
    target.identity.runtimeSnapshot.byteLength >
      spec.prePlanBounds.maxArtifactBytes
  ) {
    throw new V2CompileError(
      "bounds_exceeded",
      "verified target artifacts exceed pre-plan artifact bounds",
    );
  }
  if (
    catalog.identity.toolCount > spec.prePlanBounds.maxCatalogTools ||
    catalog.acquisition.pageCount > spec.prePlanBounds.maxCatalogPages ||
    catalog.metrics.serializedBytes > spec.prePlanBounds.maxCatalogBytes
  ) {
    throw new V2CompileError(
      "bounds_exceeded",
      "complete catalog exceeds AuditSpec pre-plan bounds",
    );
  }
}

function validateRequestedToolCoverage(
  policy: ApprovedPolicyV2,
  catalog: ComputedCatalogV2,
  cases: readonly ExpandedCase[],
): void {
  const selected = new Set(
    cases.flatMap((item) => item.template.steps.map((step) => step.toolName)),
  );
  const percent =
    catalog.identity.toolCount === 0
      ? 0
      : Math.floor((selected.size * 100) / catalog.identity.toolCount);
  if (percent < policy.minimumCoverage.minimumToolCoveragePercent) {
    throw new V2CompileError(
      "policy_missing",
      "compiled cases do not meet policy minimum tool coverage",
    );
  }
}

function validateMandatoryResourceClassBindings(
  spec: AuditSpecV2,
  cases: readonly ExpandedCase[],
): void {
  const classByAlias = new Map(
    spec.syntheticResources.map((resource) => [
      resource.alias,
      resource.resourceClass,
    ] as const),
  );
  for (const draft of cases) {
    if (draft.origin !== "mandatory") continue;
    const expectedClasses = new Set(
      draft.template.predictedEffects.map((effect) => effect.resourceClass),
    );
    for (const alias of draft.aliases) {
      const resourceClass = classByAlias.get(alias);
      if (resourceClass === undefined) {
        throw new V2CompileError(
          "resource_unknown",
          `mandatory case references unknown synthetic resource alias '${alias}'`,
        );
      }
      if (!expectedClasses.has(resourceClass)) {
        throw new V2CompileError(
          "mandatory_collision",
          `synthetic resource class for mandatory alias '${alias}' conflicts with the controller-owned case suite`,
        );
      }
    }
  }
}

function compileCase(input: {
  readonly draft: ExpandedCase;
  readonly spec: AuditSpecV2;
  readonly policy: PreparedExperimentDispatchPolicy;
  readonly policyWork: PolicyEvaluationWorkTracker;
  readonly tools: ReadonlyMap<string, PreparedCatalogToolV2>;
  readonly resources: MaterializedSyntheticResources;
  readonly planCaseCount: number;
  readonly planStepCount: number;
  readonly work: CompilerWorkTracker;
}): ExperimentPlanCaseV2 {
  const caseResources = input.resources.resourcesByCaseId.get(input.draft.caseId);
  if (caseResources === undefined) {
    throw new V2CompileError("resource_unknown", "case resource map is missing");
  }
  let requiredApproval: ApprovalClassV2 =
    input.draft.template.minimumApprovalClass;
  const steps: ExperimentPlanCaseV2["steps"][number][] = [];
  for (const step of input.draft.template.steps) {
    const tool = input.tools.get(step.toolName);
    if (tool === undefined) {
      throw new V2CompileError(
        "tool_missing",
        `case references unknown tool '${step.toolName}'`,
      );
    }
    const limits = argumentLimits(input.spec);
    const referenceAnalysis = input.draft.aliasesByStepId.get(step.stepId) ?? {
      aliases: new Set<string>(),
      hasUnclassifiedValues: true,
    };
    const compiled = compileArguments({
      tool,
      unresolved: step.arguments,
      resources: caseResources,
      limits,
    });
    reserveArgumentWork(input.work, compiled);
    const policyApproval = evaluatePreparedExperimentDispatch(
      input.policy,
      {
        toolName: step.toolName,
        origin: input.draft.origin as CaseOriginV2,
        arguments: compiled.arguments,
        resourceClasses: resourceClassesForAliases(
          input.spec,
          referenceAnalysis,
          input.draft.origin === "mandatory"
            ? input.draft.template.predictedEffects.map(
                (effect) => effect.resourceClass,
              )
            : [],
        ),
        planCaseCount: input.planCaseCount,
        planStepCount: input.planStepCount,
        argumentBytes: compiled.argumentBytes,
        requestedRuntimeMs: input.spec.executionBounds.maxCaseRuntimeMs,
        executionBounds: input.spec.executionBounds,
      },
      input.policyWork,
    );
    requiredApproval = maximumApprovalClass(requiredApproval, policyApproval);
    steps.push({
      stepId: step.stepId,
      toolName: step.toolName,
      arguments: compiled.arguments,
      argumentSha256: artifactDigest("forge.tool-arguments", compiled.arguments),
    });
  }

  return {
    caseId: input.draft.caseId,
    origin: input.draft.origin,
    kind: executableCaseKind(input.draft.template.kind),
    repetition: input.draft.repetition,
    environmentVariant: input.draft.environmentVariant,
    description: input.draft.template.description,
    steps,
    predictedEffects: input.draft.template.predictedEffects,
    assertions: input.draft.template.assertions,
    requiredApprovalClass: requiredApproval,
  };
}

export function compileExperimentPlan(
  input: CompileExperimentPlanInput,
): CompiledExperimentPlanV2 {
  const planId = identifierV2Schema.parse(input.planId);
  const manifestId = identifierV2Schema.parse(input.manifestId);
  const compiledAt = timestampV2Schema.parse(input.compiledAt);
  const spec = boundedParse(input.auditSpec, "V2 AuditSpec", (value) =>
    auditSpecV2Schema.parse(value),
  );
  if (spec.unsupportedCaseHandling !== "reject") {
    throw new V2CompileError(
      "schema_unsupported",
      "Phase 1A supports only unsupportedCaseHandling='reject'",
    );
  }
  const verifiedTarget = verifyTargetIdentity(
    input.target,
    spec.prePlanBounds.maxArtifactBytes,
  );
  let catalog: ComputedCatalogV2;
  try {
    catalog = computeCatalogIdentity(input.catalog, {
      maxTools: spec.prePlanBounds.maxCatalogTools,
      maxPages: spec.prePlanBounds.maxCatalogPages,
      maxSerializedBytes: spec.prePlanBounds.maxCatalogBytes,
    });
  } catch (error) {
    if (
      error instanceof JsonLimitError ||
      (error instanceof Error &&
        error.message.startsWith("acquisition.pageCount must be"))
    ) {
      throw new V2CompileError(
        "bounds_exceeded",
        "complete catalog exceeds AuditSpec pre-plan bounds before SDK validation",
        { cause: error },
      );
    }
    throw error;
  }
  const claimProfile = boundedParse(
    input.claimProfile,
    "V2 ClaimProfile",
    (value) => claimProfileV2Schema.parse(value),
  );
  const policy = boundedParse(input.policy, "V2 ApprovedPolicy", (value) =>
    approvedPolicyV2Schema.parse(value),
  );
  const claimProfileDigest = artifactDigest(
    "forge.claim-profile",
    claimProfile,
  );
  const policyDigest = artifactDigest("forge.audit-policy", policy);
  validateBindings(claimProfile, policy, spec, {
    target: verifiedTarget,
    catalog,
    claimProfileDigest,
    policyDigest,
    compiledAt,
  });
  validatePrePlanBounds(spec, verifiedTarget, catalog);

  const mandatoryTemplates = parseMandatoryCases(input.mandatoryCases);
  const mandatorySuiteDigest = artifactDigest(
    "forge.mandatory-case-suite",
    mandatoryTemplates,
  );
  if (mandatorySuiteDigest !== spec.mandatorySuiteDigest) {
    throw new V2CompileError(
      "digest_mismatch",
      "mandatory case suite does not match the AuditSpec binding",
    );
  }
  validateMandatoryPolicy(policy, mandatoryTemplates);
  const expandedCases = expandCases({ mandatory: mandatoryTemplates, spec });
  validateMandatoryResourceClassBindings(spec, expandedCases);
  validateRequestedToolCoverage(policy, catalog, expandedCases);
  const totalSteps = expandedCases.reduce(
    (sum, item) => sum + item.template.steps.length,
    0,
  );
  if (
    expandedCases.some(
      (item) =>
        item.template.steps.length > spec.executionBounds.maxStepsPerCase,
    ) ||
    totalSteps > spec.executionBounds.maxTotalSteps ||
    totalSteps > PHASE1_COMPILER_WORK_LIMITS.maxExpandedSteps
  ) {
    throw new V2CompileError(
      "bounds_exceeded",
      "expanded plan exceeds step bounds",
    );
  }
  const preparedPolicy = prepareExperimentDispatchPolicy(policy);
  assertPolicyEvaluationWorkBound(preparedPolicy, totalSteps);

  const resources = materializeSyntheticResources({
    manifestId,
    resources: spec.syntheticResources,
    cases: expandedCases.map((item) => ({
      caseId: item.caseId,
      repetition: item.repetition,
      aliases: item.aliases,
    })),
    maxFileBytes: spec.executionBounds.maxFileBytes,
    maxWritableBytes: spec.executionBounds.maxWritableBytes,
    maxWritableFiles: spec.executionBounds.maxWritableFiles,
  });
  const tools = prepareSelectedTools(catalog, expandedCases);
  const work: CompilerWorkTracker = {
    argumentBytes: 0,
    argumentNodes: 0,
    caseBytes: 0,
    caseNodes: 0,
  };
  const policyWork = createPolicyEvaluationWorkTracker();
  const cases: ExperimentPlanCaseV2[] = [];
  for (const draft of expandedCases) {
    const compiledCase = compileCase({
      draft,
      spec,
      policy: preparedPolicy,
      policyWork,
      tools,
      resources,
      planCaseCount: expandedCases.length,
      planStepCount: totalSteps,
      work,
    });
    cases.push(retainCompiledCase(work, compiledCase));
  }
  const mandatoryCount = cases.filter((item) => item.origin === "mandatory").length;
  const requiredApprovalClass = maximumApprovalClass(
    ...cases.map((item) => item.requiredApprovalClass),
  );
  const auditSpecDigest = artifactDigest("forge.audit-spec", spec);
  const syntheticResourceManifestDigest = artifactDigest(
    "forge.synthetic-resource-manifest",
    resources.manifest,
  );
  const planCandidate = {
    schema: "forge.experiment-plan/v2",
    planId,
    compiledAt,
    compiler: PHASE1_COMPILER_IDENTITY,
    ...(policy.expiresAt === undefined
      ? {}
      : { policyExpiresAt: policy.expiresAt }),
    target: verifiedTarget.identity,
    catalog: catalog.identity,
    claimProfileDigest,
    policyDigest,
    auditSpecDigest,
    syntheticResourceManifest: resources.manifest,
    syntheticResourceManifestDigest,
    caseBudgetReservation: {
      mandatory: mandatoryCount,
      manual: cases.length - mandatoryCount,
      total: cases.length,
    },
    bounds: spec.executionBounds,
    requiredSensors: spec.requiredSensors,
    unsupportedSensors: [],
    coverageRequirements: policy.minimumCoverage,
    cases,
    requiredApprovalClass,
  };
  // The envelope performs the iterative byte/node/depth preflight before its
  // recursive ExperimentPlan schema parse.
  const envelope = createExperimentPlanEnvelope(planCandidate);
  return Object.freeze({ ...envelope, catalog, resources });
}
