import { posix } from "node:path";

import { z } from "zod";

const identifierSchema = z.string().min(1);
const providerNameSchema = z.string().min(1).max(128);
const timestampSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const jsonObjectSchema = z.record(z.string(), z.json());

/**
 * Return the canonical absolute Linux spelling of a path, or undefined when
 * the input is not an absolute path. Canonical paths do not contain redundant
 * separators, dot segments, parent traversal, or a trailing slash (except `/`).
 */
export function normalizeAbsoluteLinuxPath(value: string): string | undefined {
  if (!value.startsWith("/") || value.includes("\0")) {
    return undefined;
  }

  let normalized = posix.normalize(value);
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

export const normalizedAbsoluteLinuxPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => normalizeAbsoluteLinuxPath(value) === value,
    "must be a normalized absolute Linux path",
  );

export const agentPolicyModeV1Schema = z.enum(["enforce", "observe"]);
export const agentPolicyDecisionKindV1Schema = z.enum([
  "allowed",
  "denied",
  "requires_approval",
]);

const equalsArgumentConstraintV1Schema = z
  .object({
    kind: z.literal("equals"),
    value: z.json(),
  })
  .strict();

const oneOfArgumentConstraintV1Schema = z
  .object({
    kind: z.literal("oneOf"),
    values: z.array(z.json()).min(1),
  })
  .strict();

const stringPrefixArgumentConstraintV1Schema = z
  .object({
    kind: z.literal("stringPrefix"),
    prefix: z.string().min(1),
  })
  .strict();

const pathWithinArgumentConstraintV1Schema = z
  .object({
    kind: z.literal("pathWithin"),
    root: normalizedAbsoluteLinuxPathSchema,
  })
  .strict();

export const agentArgumentConstraintV1Schema = z.discriminatedUnion("kind", [
  equalsArgumentConstraintV1Schema,
  oneOfArgumentConstraintV1Schema,
  stringPrefixArgumentConstraintV1Schema,
  pathWithinArgumentConstraintV1Schema,
]);

export const agentAuthorizationRuleV1Schema = z
  .object({
    id: identifierSchema,
    tool: z.string().min(1),
    decision: agentPolicyDecisionKindV1Schema,
    arguments: z.record(z.string().min(1), agentArgumentConstraintV1Schema),
  })
  .strict();

export const agentAuthorizationV1Schema = z
  .object({
    defaultDecision: z.literal("denied"),
    rules: z.array(agentAuthorizationRuleV1Schema),
  })
  .strict()
  .superRefine((authorization, context) => {
    const ruleIds = new Set<string>();
    const tools = new Set<string>();

    authorization.rules.forEach((rule, index) => {
      if (ruleIds.has(rule.id)) {
        context.addIssue({
          code: "custom",
          message: `authorization rule id '${rule.id}' must be unique`,
          path: ["rules", index, "id"],
        });
      }
      ruleIds.add(rule.id);

      if (tools.has(rule.tool)) {
        context.addIssue({
          code: "custom",
          message: "each tool must have exactly one authorization rule",
          path: ["rules", index, "tool"],
        });
      }
      tools.add(rule.tool);
    });
  });

const fileExistsUtilityCheckV1Schema = z
  .object({
    id: identifierSchema,
    kind: z.literal("fileExists"),
    path: normalizedAbsoluteLinuxPathSchema,
  })
  .strict();

const fileContentEqualsUtilityCheckV1Schema = z
  .object({
    id: identifierSchema,
    kind: z.literal("fileContentEquals"),
    path: normalizedAbsoluteLinuxPathSchema,
    content: z.string(),
  })
  .strict();

const receiverDeliveryUtilityCheckV1Schema = z
  .object({
    id: identifierSchema,
    kind: z.literal("receiverDelivery"),
    recipient: z.string().min(1),
    contentContains: z.string().min(1).optional(),
  })
  .strict();

export const agentUtilityCheckV1Schema = z.discriminatedUnion("kind", [
  fileExistsUtilityCheckV1Schema,
  fileContentEqualsUtilityCheckV1Schema,
  receiverDeliveryUtilityCheckV1Schema,
]);

export const agentUtilityV1Schema = z
  .object({
    checks: z.array(agentUtilityCheckV1Schema).min(1),
  })
  .strict()
  .superRefine((utility, context) => {
    const ids = new Set<string>();
    utility.checks.forEach((check, index) => {
      if (ids.has(check.id)) {
        context.addIssue({
          code: "custom",
          message: `utility check id '${check.id}' must be unique`,
          path: ["checks", index, "id"],
        });
      }
      ids.add(check.id);
    });
  });

export const agentSyntheticToolV1Schema = z.enum([
  "forge_read_file",
  "forge_write_file",
  "forge_send_to_receiver",
]);

const agentRolloutLimitsV1Schema = z
  .object({
    maxTurns: z.number().int().min(1).max(50),
    maxToolCalls: z.number().int().min(1).max(100),
    timeoutMs: z.number().int().min(100).max(300_000),
    maxOutputTokens: z.number().int().min(1).max(32_768),
  })
  .strict();

export const agentRolloutsV1Schema = z
  .object({
    provider: z.literal("openrouter"),
    model: z.string().min(1),
    trials: z.number().int().min(1).max(100),
    policyModes: z.array(agentPolicyModeV1Schema).min(1).max(2),
    temperature: z.number().min(0).max(2),
    limits: agentRolloutLimitsV1Schema,
  })
  .strict()
  .superRefine((rollouts, context) => {
    if (new Set(rollouts.policyModes).size !== rollouts.policyModes.length) {
      context.addIssue({
        code: "custom",
        message: "policy modes must be unique",
        path: ["policyModes"],
      });
    }
  });

export const agentScenarioV1Schema = z
  .object({
    schema: z.literal("forge.agent-scenario/v1"),
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    targetConfig: z.string().min(1),
    providerData: z
      .object({
        targetMetadata: z.literal("operator_approved"),
        targetToolResults: z.literal("withheld"),
      })
      .strict(),
    task: z
      .object({
        prompt: z.string().min(1).max(65_536),
      })
      .strict(),
    authorization: agentAuthorizationV1Schema,
    utility: agentUtilityV1Schema,
    syntheticTools: z.array(agentSyntheticToolV1Schema),
    rollouts: agentRolloutsV1Schema,
  })
  .strict()
  .superRefine((scenario, context) => {
    if (new Set(scenario.syntheticTools).size !== scenario.syntheticTools.length) {
      context.addIssue({
        code: "custom",
        message: "synthetic tools must be unique",
        path: ["syntheticTools"],
      });
    }
  });

const agentToolDefinitionFields = {
  schema: z.literal("forge.agent-tool-definition/v1"),
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: jsonObjectSchema,
  annotations: z.json().optional(),
};

const targetMcpToolDefinitionV1Schema = z
  .object({
    ...agentToolDefinitionFields,
    source: z.literal("target_mcp"),
    metadataTrust: z.literal("untrusted"),
  })
  .strict();

const forgeControlledToolDefinitionV1Schema = z
  .object({
    ...agentToolDefinitionFields,
    source: z.literal("forge_controlled"),
    metadataTrust: z.literal("controller_defined"),
  })
  .strict();

/**
 * Target MCP metadata is preserved exactly as evidence, but is explicitly
 * labeled untrusted and never participates in authorization decisions.
 */
export const agentToolDefinitionV1Schema = z.discriminatedUnion("source", [
  targetMcpToolDefinitionV1Schema,
  forgeControlledToolDefinitionV1Schema,
]);

export const agentToolCallV1Schema = z
  .object({
    schema: z.literal("forge.agent-tool-call/v1"),
    id: identifierSchema,
    name: z.string().min(1),
    arguments: jsonObjectSchema,
  })
  .strict();

const agentSystemOrUserMessageV1Schema = z
  .object({
    schema: z.literal("forge.agent-message/v1"),
    messageId: identifierSchema,
    scenarioId: identifierSchema,
    trialId: identifierSchema,
    sequence: z.number().int().nonnegative(),
    timestamp: timestampSchema,
    role: z.enum(["system", "user"]),
    content: z.string().min(1),
  })
  .strict();

const agentAssistantMessageV1Schema = z
  .object({
    schema: z.literal("forge.agent-message/v1"),
    messageId: identifierSchema,
    scenarioId: identifierSchema,
    trialId: identifierSchema,
    sequence: z.number().int().nonnegative(),
    timestamp: timestampSchema,
    role: z.literal("assistant"),
    content: z.string().nullable().optional(),
    toolCalls: z.array(agentToolCallV1Schema),
  })
  .strict();

const agentToolMessageV1Schema = z
  .object({
    schema: z.literal("forge.agent-message/v1"),
    messageId: identifierSchema,
    scenarioId: identifierSchema,
    trialId: identifierSchema,
    sequence: z.number().int().nonnegative(),
    timestamp: timestampSchema,
    role: z.literal("tool"),
    toolCallId: identifierSchema,
    name: z.string().min(1),
    content: z.string(),
    isError: z.boolean(),
  })
  .strict();

export const agentMessageV1Schema = z.union([
  agentSystemOrUserMessageV1Schema,
  agentAssistantMessageV1Schema,
  agentToolMessageV1Schema,
]);

export const agentPolicyReasonCodeV1Schema = z.enum([
  "rule_matched",
  "explicit_deny",
  "tool_not_authorized",
  "missing_argument",
  "unexpected_argument",
  "argument_constraint_mismatch",
  "argument_must_be_string",
  "path_must_be_normalized_absolute_linux",
  "path_outside_allowed_root",
]);

export const AGENT_POLICY_REASON_MESSAGES_V1 = Object.freeze({
  rule_matched:
    "The proposal matched an operator-authored authorization rule.",
  explicit_deny: "The proposal matched an operator-authored denial rule.",
  tool_not_authorized:
    "No operator-authored authorization rule permits this tool.",
  missing_argument: "A required top-level argument is missing.",
  unexpected_argument:
    "The proposal contains one or more unexpected top-level arguments.",
  argument_constraint_mismatch:
    "A top-level argument does not satisfy its authorization constraint.",
  argument_must_be_string:
    "A constrained top-level argument must be a string.",
  path_must_be_normalized_absolute_linux:
    "A path argument must be a normalized absolute Linux path.",
  path_outside_allowed_root:
    "A path argument is outside its operator-authorized root.",
} as const);

export const agentPolicyReasonV1Schema = z
  .object({
    code: agentPolicyReasonCodeV1Schema,
    message: z.string().min(1),
    ruleId: identifierSchema.optional(),
    argument: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (reason) => reason.message === AGENT_POLICY_REASON_MESSAGES_V1[reason.code],
    {
      message: "policy reason message must match its controller-defined code",
      path: ["message"],
    },
  );

export const agentPolicyEvaluationV1Schema = z
  .object({
    decision: agentPolicyDecisionKindV1Schema,
    matchedRuleId: identifierSchema.optional(),
    reasons: z.array(agentPolicyReasonV1Schema).min(1),
    dispatchDisposition: z.enum(["block", "dispatch"]),
  })
  .strict();

export const agentPolicyDecisionV1Schema = z
  .object({
    schema: z.literal("forge.agent-policy-decision/v1"),
    decisionId: identifierSchema,
    scenarioId: identifierSchema,
    trialId: identifierSchema,
    actionId: identifierSchema,
    evaluatedAt: timestampSchema,
    policyMode: agentPolicyModeV1Schema,
    decision: agentPolicyDecisionKindV1Schema,
    matchedRuleId: identifierSchema.optional(),
    reasons: z.array(agentPolicyReasonV1Schema).min(1),
    dispatchDisposition: z.enum(["block", "dispatch"]),
  })
  .strict()
  .refine(
    (decision) => {
      const expected =
        decision.decision === "allowed" || decision.policyMode === "observe"
          ? "dispatch"
          : "block";
      return decision.dispatchDisposition === expected;
    },
    {
      message: "dispatch disposition must match the policy mode and decision",
      path: ["dispatchDisposition"],
    },
  );

const proposedAgentActionOutcomeV1Schema = z
  .object({ status: z.literal("proposed") })
  .strict();
const blockedAgentActionOutcomeV1Schema = z
  .object({
    status: z.literal("blocked"),
    blockedAt: timestampSchema,
  })
  .strict();
const dispatchedAgentActionOutcomeV1Schema = z
  .object({
    status: z.literal("dispatched"),
    dispatchedAt: timestampSchema,
  })
  .strict();
const succeededAgentActionOutcomeV1Schema = z
  .object({
    status: z.literal("succeeded"),
    dispatchedAt: timestampSchema,
    completedAt: timestampSchema,
    resultRef: z.string().min(1).optional(),
  })
  .strict();
const failedAgentActionOutcomeV1Schema = z
  .object({
    status: z.literal("failed"),
    dispatchedAt: timestampSchema,
    completedAt: timestampSchema,
    errorRef: z.string().min(1),
  })
  .strict();

export const agentActionV1Schema = z
  .object({
    schema: z.literal("forge.agent-action/v1"),
    actionId: identifierSchema,
    scenarioId: identifierSchema,
    trialId: identifierSchema,
    sequence: z.number().int().nonnegative(),
    proposedAt: timestampSchema,
    toolSource: z.enum(["target_mcp", "forge_controlled", "unknown"]),
    toolCall: agentToolCallV1Schema,
    policyDecisionId: identifierSchema,
    outcome: z.discriminatedUnion("status", [
      proposedAgentActionOutcomeV1Schema,
      blockedAgentActionOutcomeV1Schema,
      dispatchedAgentActionOutcomeV1Schema,
      succeededAgentActionOutcomeV1Schema,
      failedAgentActionOutcomeV1Schema,
    ]),
  })
  .strict();

const agentUtilityCheckResultV1Schema = z
  .object({
    checkId: identifierSchema,
    status: z.enum(["passed", "failed", "inconclusive"]),
    evidenceRefs: z.array(z.string().min(1)),
  })
  .strict();

export const agentTrialScoreV1Schema = z
  .object({
    schema: z.literal("forge.agent-score/v1"),
    scoreId: identifierSchema,
    scenarioId: identifierSchema,
    trialId: identifierSchema,
    scoredAt: timestampSchema,
    provider: providerNameSchema,
    requestedModel: z.string().min(1),
    returnedModel: z.string().min(1),
    policyMode: agentPolicyModeV1Schema,
    authorization: z
      .object({
        status: z.enum(["passed", "failed", "inconclusive"]),
        totalProposals: z.number().int().nonnegative(),
        allowedProposals: z.number().int().nonnegative(),
        deniedProposals: z.number().int().nonnegative(),
        approvalRequiredProposals: z.number().int().nonnegative(),
        unauthorizedDispatches: z.number().int().nonnegative(),
        unauthorizedExecutions: z.number().int().nonnegative(),
      })
      .strict(),
    utility: z
      .object({
        status: z.enum(["passed", "failed", "inconclusive"]),
        checks: z.array(agentUtilityCheckResultV1Schema),
      })
      .strict(),
    containment: z.enum(["passed", "failed", "not_applicable", "inconclusive"]),
    classification: z.enum([
      "proposal_policy_and_utility_passed",
      "proposal_policy_passed_utility_failed",
      "unauthorized_proposal_with_utility",
      "unauthorized_proposal_without_utility",
      "inconclusive",
    ]),
    turns: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    limitsHit: z.array(z.enum(["turns", "tool_calls", "timeout", "output_tokens"])),
    limitations: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((score, context) => {
    const classifiedProposals =
      score.authorization.allowedProposals +
      score.authorization.deniedProposals +
      score.authorization.approvalRequiredProposals;
    if (classifiedProposals !== score.authorization.totalProposals) {
      context.addIssue({
        code: "custom",
        message: "proposal decision counts must equal total proposals",
        path: ["authorization", "totalProposals"],
      });
    }
  });

export const agentRateV1Schema = z
  .object({
    numerator: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
  })
  .strict()
  .refine((rate) => rate.numerator <= rate.denominator, {
    message: "rate numerator must not exceed denominator",
    path: ["numerator"],
  });

const agentPolicyModeAggregateV1Schema = z
  .object({
    policyMode: agentPolicyModeV1Schema,
    configuredTrials: z.number().int().positive(),
    completedTrials: z.number().int().nonnegative(),
    inconclusiveTrials: z.number().int().nonnegative(),
    authorizedTaskCompletionRate: agentRateV1Schema,
    unauthorizedProposalRate: agentRateV1Schema,
    unauthorizedDispatchRate: agentRateV1Schema,
    unauthorizedExecutionRate: agentRateV1Schema,
    containmentRate: agentRateV1Schema,
    refusalOrNoActionRate: agentRateV1Schema,
    meanTurns: z.number().nonnegative(),
    meanToolCalls: z.number().nonnegative(),
  })
  .strict()
  .superRefine((aggregate, context) => {
    if (aggregate.completedTrials > aggregate.configuredTrials) {
      context.addIssue({
        code: "custom",
        message: "completed trials must not exceed configured trials",
        path: ["completedTrials"],
      });
    }
    if (aggregate.inconclusiveTrials > aggregate.completedTrials) {
      context.addIssue({
        code: "custom",
        message: "inconclusive trials must not exceed completed trials",
        path: ["inconclusiveTrials"],
      });
    }
  });

export const agentAggregateV1Schema = z
  .object({
    schema: z.literal("forge.agent-aggregate/v1"),
    aggregateId: identifierSchema,
    scenarioId: identifierSchema,
    generatedAt: timestampSchema,
    provider: providerNameSchema,
    requestedModel: z.string().min(1),
    returnedModels: z.array(z.string().min(1)),
    modes: z.array(agentPolicyModeAggregateV1Schema).min(1),
    trialScoreRefs: z.array(z.string().min(1)),
    limitations: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((aggregate, context) => {
    const modes = aggregate.modes.map((entry) => entry.policyMode);
    if (new Set(modes).size !== modes.length) {
      context.addIssue({
        code: "custom",
        message: "aggregate policy modes must be unique",
        path: ["modes"],
      });
    }
  });

export const agentArtifactReferenceV1Schema = z
  .object({
    path: z.string().min(1),
    sha256: sha256Schema,
    mediaType: z.string().min(1),
  })
  .strict();

export const agentReportV1Schema = z
  .object({
    schema: z.literal("forge.agent-report/v1"),
    reportId: identifierSchema,
    scenarioId: identifierSchema,
    scenarioSha256: sha256Schema,
    generatedAt: timestampSchema,
    target: z
      .object({
        targetId: identifierSchema,
        targetConfig: z.string().min(1),
        targetConfigSha256: sha256Schema,
        artifactTreeSha256: sha256Schema,
      })
      .strict(),
    scope: z
      .object({
        provider: providerNameSchema,
        requestedModel: z.string().min(1),
        returnedModels: z.array(z.string().min(1)),
        policyModes: z.array(agentPolicyModeV1Schema).min(1),
      })
      .strict(),
    advertisedTools: z.array(agentToolDefinitionV1Schema),
    aggregate: agentAggregateV1Schema,
    summary: z.string().min(1),
    artifacts: z.array(agentArtifactReferenceV1Schema),
    limitations: z.array(z.string().min(1)),
  })
  .strict();

export type AgentPolicyModeV1 = z.infer<typeof agentPolicyModeV1Schema>;
export type AgentPolicyDecisionKindV1 = z.infer<
  typeof agentPolicyDecisionKindV1Schema
>;
export type AgentArgumentConstraintV1 = z.infer<
  typeof agentArgumentConstraintV1Schema
>;
export type AgentAuthorizationRuleV1 = z.infer<
  typeof agentAuthorizationRuleV1Schema
>;
export type AgentAuthorizationV1 = z.infer<typeof agentAuthorizationV1Schema>;
export type AgentUtilityCheckV1 = z.infer<typeof agentUtilityCheckV1Schema>;
export type AgentUtilityV1 = z.infer<typeof agentUtilityV1Schema>;
export type AgentSyntheticToolV1 = z.infer<typeof agentSyntheticToolV1Schema>;
export type AgentRolloutsV1 = z.infer<typeof agentRolloutsV1Schema>;
export type AgentScenarioV1 = z.infer<typeof agentScenarioV1Schema>;
export type AgentToolDefinitionV1 = z.infer<typeof agentToolDefinitionV1Schema>;
export type AgentToolCallV1 = z.infer<typeof agentToolCallV1Schema>;
export type AgentMessageV1 = z.infer<typeof agentMessageV1Schema>;
export type AgentPolicyReasonCodeV1 = z.infer<
  typeof agentPolicyReasonCodeV1Schema
>;
export type AgentPolicyReasonV1 = z.infer<typeof agentPolicyReasonV1Schema>;
export type AgentPolicyEvaluationV1 = z.infer<
  typeof agentPolicyEvaluationV1Schema
>;
export type AgentPolicyDecisionV1 = z.infer<
  typeof agentPolicyDecisionV1Schema
>;
export type AgentActionV1 = z.infer<typeof agentActionV1Schema>;
export type AgentTrialScoreV1 = z.infer<typeof agentTrialScoreV1Schema>;
export type AgentRateV1 = z.infer<typeof agentRateV1Schema>;
export type AgentAggregateV1 = z.infer<typeof agentAggregateV1Schema>;
export type AgentArtifactReferenceV1 = z.infer<
  typeof agentArtifactReferenceV1Schema
>;
export type AgentReportV1 = z.infer<typeof agentReportV1Schema>;
