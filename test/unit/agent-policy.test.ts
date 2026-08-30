import { describe, expect, it } from "vitest";

import {
  agentAuthorizationV1Schema,
  agentToolCallV1Schema,
} from "../../src/agent/contracts.js";
import {
  createAgentPolicyDecision,
  evaluateAgentToolCallPolicy,
} from "../../src/agent/policy.js";
import type {
  AgentAuthorizationV1,
  AgentToolCallV1,
} from "../../src/agent/contracts.js";

const authorization: AgentAuthorizationV1 = agentAuthorizationV1Schema.parse({
  defaultDecision: "denied",
  rules: [
    {
      id: "controlled-write",
      tool: "forge_write_file",
      decision: "allowed",
      arguments: {
        path: { kind: "pathWithin", root: "/sandbox/workspace" },
        mode: { kind: "oneOf", values: ["create", "replace"] },
        content: { kind: "stringPrefix", prefix: "public:" },
        metadata: {
          kind: "equals",
          value: { classification: "synthetic", retained: false },
        },
      },
    },
    {
      id: "receiver-needs-approval",
      tool: "forge_send_to_receiver",
      decision: "requires_approval",
      arguments: {
        recipient: { kind: "equals", value: "reviewer@example.test" },
        content: { kind: "stringPrefix", prefix: "review:" },
      },
    },
    {
      id: "explicitly-denied-read",
      tool: "forge_read_file",
      decision: "denied",
      arguments: {
        path: { kind: "equals", value: "/sandbox/secrets/token" },
      },
    },
  ],
});

function toolCall(name: string, args: Record<string, unknown>): AgentToolCallV1 {
  return agentToolCallV1Schema.parse({
    schema: "forge.agent-tool-call/v1",
    id: "call-1",
    name,
    arguments: args,
  });
}

function validWriteCall(
  overrides: Readonly<Record<string, unknown>> = {},
): AgentToolCallV1 {
  return toolCall("forge_write_file", {
    path: "/sandbox/workspace/main.md",
    mode: "create",
    content: "public: hello",
    metadata: { retained: false, classification: "synthetic" },
    ...overrides,
  });
}

describe("deterministic agent authorization", () => {
  it("allows only an exact top-level argument shape satisfying every constraint", () => {
    const result = evaluateAgentToolCallPolicy(
      authorization,
      validWriteCall(),
      "enforce",
    );

    expect(result).toMatchObject({
      decision: "allowed",
      matchedRuleId: "controlled-write",
      dispatchDisposition: "dispatch",
      reasons: [{ code: "rule_matched", ruleId: "controlled-write" }],
    });
  });

  it("defaults to deny without copying an unknown tool or its arguments into reasons", () => {
    const call = toolCall("attacker_named_tool", {
      payload: "SUPER_SECRET_CANARY",
    });
    const result = evaluateAgentToolCallPolicy(authorization, call, "enforce");

    expect(result).toMatchObject({
      decision: "denied",
      dispatchDisposition: "block",
      reasons: [{ code: "tool_not_authorized" }],
    });
    expect(JSON.stringify(result)).not.toContain("attacker_named_tool");
    expect(JSON.stringify(result)).not.toContain("SUPER_SECRET_CANARY");
  });

  it("denies missing and unexpected top-level arguments", () => {
    const missing = toolCall("forge_write_file", {
      path: "/sandbox/workspace/main.md",
      mode: "create",
      content: "public: hello",
    });
    const missingResult = evaluateAgentToolCallPolicy(
      authorization,
      missing,
      "enforce",
    );
    expect(missingResult.decision).toBe("denied");
    expect(missingResult.reasons).toContainEqual(
      expect.objectContaining({
        code: "missing_argument",
        argument: "metadata",
      }),
    );

    const unexpected = validWriteCall({
      exfiltrateTo: "SUPER_SECRET_DESTINATION",
    });
    const unexpectedResult = evaluateAgentToolCallPolicy(
      authorization,
      unexpected,
      "enforce",
    );
    expect(unexpectedResult.decision).toBe("denied");
    expect(unexpectedResult.reasons).toContainEqual(
      expect.objectContaining({ code: "unexpected_argument" }),
    );
    expect(JSON.stringify(unexpectedResult)).not.toContain("exfiltrateTo");
    expect(JSON.stringify(unexpectedResult)).not.toContain(
      "SUPER_SECRET_DESTINATION",
    );
  });

  it("uses canonical component boundaries for pathWithin", () => {
    const sibling = evaluateAgentToolCallPolicy(
      authorization,
      validWriteCall({ path: "/sandbox/workspace-escape/token" }),
      "enforce",
    );
    expect(sibling).toMatchObject({
      decision: "denied",
      reasons: [{ code: "path_outside_allowed_root" }],
    });

    const traversal = evaluateAgentToolCallPolicy(
      authorization,
      validWriteCall({ path: "/sandbox/workspace/../secrets/token" }),
      "enforce",
    );
    expect(traversal).toMatchObject({
      decision: "denied",
      reasons: [{ code: "path_must_be_normalized_absolute_linux" }],
    });

    const relative = evaluateAgentToolCallPolicy(
      authorization,
      validWriteCall({ path: "workspace/main.md" }),
      "enforce",
    );
    expect(relative).toMatchObject({
      decision: "denied",
      reasons: [{ code: "path_must_be_normalized_absolute_linux" }],
    });
  });

  it("denies scalar constraint mismatches and non-string prefix inputs", () => {
    const outsideOneOf = evaluateAgentToolCallPolicy(
      authorization,
      validWriteCall({ mode: "append" }),
      "enforce",
    );
    expect(outsideOneOf.reasons).toContainEqual(
      expect.objectContaining({
        code: "argument_constraint_mismatch",
        argument: "mode",
      }),
    );

    const nonString = evaluateAgentToolCallPolicy(
      authorization,
      validWriteCall({ content: 42 }),
      "enforce",
    );
    expect(nonString.reasons).toContainEqual(
      expect.objectContaining({
        code: "argument_must_be_string",
        argument: "content",
      }),
    );
  });

  it("preserves approval and denial decisions while policy mode controls dispatch", () => {
    const approvalCall = toolCall("forge_send_to_receiver", {
      recipient: "reviewer@example.test",
      content: "review: ready",
    });

    expect(
      evaluateAgentToolCallPolicy(authorization, approvalCall, "enforce"),
    ).toMatchObject({
      decision: "requires_approval",
      dispatchDisposition: "block",
    });
    expect(
      evaluateAgentToolCallPolicy(authorization, approvalCall, "observe"),
    ).toMatchObject({
      decision: "requires_approval",
      dispatchDisposition: "dispatch",
    });

    const deniedCall = toolCall("forge_read_file", {
      path: "/sandbox/secrets/token",
    });
    expect(
      evaluateAgentToolCallPolicy(authorization, deniedCall, "enforce"),
    ).toMatchObject({
      decision: "denied",
      dispatchDisposition: "block",
      reasons: [{ code: "explicit_deny" }],
    });
    expect(
      evaluateAgentToolCallPolicy(authorization, deniedCall, "observe"),
    ).toMatchObject({
      decision: "denied",
      dispatchDisposition: "dispatch",
    });
  });

  it("creates a strict versioned decision without persisting the proposed values", () => {
    const decision = createAgentPolicyDecision({
      decisionId: "decision-1",
      scenarioId: "scenario-1",
      trialId: "trial-1",
      actionId: "action-1",
      evaluatedAt: "2026-08-29T20:00:00.000Z",
      policyMode: "enforce",
      authorization,
      toolCall: toolCall("unknown", { secret: "CANARY_DO_NOT_PERSIST" }),
    });

    expect(decision.schema).toBe("forge.agent-policy-decision/v1");
    expect(decision.decision).toBe("denied");
    expect(JSON.stringify(decision)).not.toContain("CANARY_DO_NOT_PERSIST");
  });
});
