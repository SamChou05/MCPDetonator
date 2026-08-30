import {
  AGENT_POLICY_REASON_MESSAGES_V1,
  agentPolicyDecisionV1Schema,
  normalizeAbsoluteLinuxPath,
} from "./contracts.js";
import type {
  AgentArgumentConstraintV1,
  AgentAuthorizationV1,
  AgentPolicyDecisionV1,
  AgentPolicyEvaluationV1,
  AgentPolicyModeV1,
  AgentPolicyReasonCodeV1,
  AgentPolicyReasonV1,
  AgentToolCallV1,
} from "./contracts.js";

interface ReasonContext {
  readonly ruleId?: string;
  readonly argument?: string;
}

function reason(
  code: AgentPolicyReasonCodeV1,
  context: ReasonContext = {},
): AgentPolicyReasonV1 {
  return {
    code,
    message: AGENT_POLICY_REASON_MESSAGES_V1[code],
    ...(context.ruleId === undefined ? {} : { ruleId: context.ruleId }),
    ...(context.argument === undefined ? {} : { argument: context.argument }),
  };
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => jsonValuesEqual(value, right[index]));
  }

  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }

  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();

  if (
    leftKeys.length !== rightKeys.length ||
    !leftKeys.every((key, index) => key === rightKeys[index])
  ) {
    return false;
  }

  return leftKeys.every((key) =>
    jsonValuesEqual(leftRecord[key], rightRecord[key]),
  );
}

function pathIsWithin(path: string, root: string): boolean {
  return root === "/" || path === root || path.startsWith(`${root}/`);
}

function evaluateConstraint(
  value: unknown,
  constraint: AgentArgumentConstraintV1,
  ruleId: string,
  argument: string,
): AgentPolicyReasonV1 | undefined {
  const context = { ruleId, argument };

  switch (constraint.kind) {
    case "equals":
      return jsonValuesEqual(value, constraint.value)
        ? undefined
        : reason("argument_constraint_mismatch", context);
    case "oneOf":
      return constraint.values.some((candidate) => jsonValuesEqual(value, candidate))
        ? undefined
        : reason("argument_constraint_mismatch", context);
    case "stringPrefix":
      if (typeof value !== "string") {
        return reason("argument_must_be_string", context);
      }
      return value.startsWith(constraint.prefix)
        ? undefined
        : reason("argument_constraint_mismatch", context);
    case "pathWithin": {
      if (typeof value !== "string") {
        return reason("argument_must_be_string", context);
      }
      const normalized = normalizeAbsoluteLinuxPath(value);
      if (normalized === undefined || normalized !== value) {
        return reason("path_must_be_normalized_absolute_linux", context);
      }
      return pathIsWithin(normalized, constraint.root)
        ? undefined
        : reason("path_outside_allowed_root", context);
    }
  }
}

function dispatchDisposition(
  decision: AgentPolicyEvaluationV1["decision"],
  policyMode: AgentPolicyModeV1,
): AgentPolicyEvaluationV1["dispatchDisposition"] {
  if (decision === "allowed" || policyMode === "observe") {
    return "dispatch";
  }
  return "block";
}

/**
 * Evaluate a model-proposed tool call against only the operator-authored
 * authorization rules. MCP descriptions, schemas, annotations, and tool
 * results are deliberately absent from this API and cannot expand authority.
 *
 * `observe` permits policy failures to be dispatched only because the V1
 * runner confines every effect to synthetic resources. The returned decision
 * remains `denied` or `requires_approval`; dispatch never changes the policy
 * result into an authorization success.
 */
export function evaluateAgentToolCallPolicy(
  authorization: AgentAuthorizationV1,
  toolCall: AgentToolCallV1,
  policyMode: AgentPolicyModeV1,
): AgentPolicyEvaluationV1 {
  const rule = authorization.rules.find((candidate) => candidate.tool === toolCall.name);

  if (rule === undefined) {
    const decision = authorization.defaultDecision;
    return {
      decision,
      reasons: [reason("tool_not_authorized")],
      dispatchDisposition: dispatchDisposition(decision, policyMode),
    };
  }

  const expectedArguments = Object.keys(rule.arguments).sort();
  const proposedArguments = Object.keys(toolCall.arguments).sort();
  const proposedArgumentSet = new Set(proposedArguments);
  const expectedArgumentSet = new Set(expectedArguments);
  const argumentShapeReasons: AgentPolicyReasonV1[] = [];

  for (const argument of expectedArguments) {
    if (!proposedArgumentSet.has(argument)) {
      argumentShapeReasons.push(
        reason("missing_argument", { ruleId: rule.id, argument }),
      );
    }
  }

  if (proposedArguments.some((argument) => !expectedArgumentSet.has(argument))) {
    // Do not copy an untrusted argument name into an evidence-safe reason.
    argumentShapeReasons.push(reason("unexpected_argument", { ruleId: rule.id }));
  }

  if (argumentShapeReasons.length > 0) {
    return {
      decision: "denied",
      matchedRuleId: rule.id,
      reasons: argumentShapeReasons,
      dispatchDisposition: dispatchDisposition("denied", policyMode),
    };
  }

  const constraintReasons: AgentPolicyReasonV1[] = [];
  for (const argument of expectedArguments) {
    const constraint = rule.arguments[argument];
    if (constraint === undefined) {
      continue;
    }
    const mismatch = evaluateConstraint(
      toolCall.arguments[argument],
      constraint,
      rule.id,
      argument,
    );
    if (mismatch !== undefined) {
      constraintReasons.push(mismatch);
    }
  }

  if (constraintReasons.length > 0) {
    return {
      decision: "denied",
      matchedRuleId: rule.id,
      reasons: constraintReasons,
      dispatchDisposition: dispatchDisposition("denied", policyMode),
    };
  }

  const matchedReason =
    rule.decision === "denied" ? "explicit_deny" : "rule_matched";
  return {
    decision: rule.decision,
    matchedRuleId: rule.id,
    reasons: [reason(matchedReason, { ruleId: rule.id })],
    dispatchDisposition: dispatchDisposition(rule.decision, policyMode),
  };
}

export interface CreateAgentPolicyDecisionInput {
  readonly decisionId: string;
  readonly scenarioId: string;
  readonly trialId: string;
  readonly actionId: string;
  readonly evaluatedAt: string;
  readonly policyMode: AgentPolicyModeV1;
  readonly authorization: AgentAuthorizationV1;
  readonly toolCall: AgentToolCallV1;
}

/** Create and validate the persisted decision artifact for one proposal. */
export function createAgentPolicyDecision(
  input: CreateAgentPolicyDecisionInput,
): AgentPolicyDecisionV1 {
  const evaluation = evaluateAgentToolCallPolicy(
    input.authorization,
    input.toolCall,
    input.policyMode,
  );

  return agentPolicyDecisionV1Schema.parse({
    schema: "forge.agent-policy-decision/v1",
    decisionId: input.decisionId,
    scenarioId: input.scenarioId,
    trialId: input.trialId,
    actionId: input.actionId,
    evaluatedAt: input.evaluatedAt,
    policyMode: input.policyMode,
    ...evaluation,
  });
}
