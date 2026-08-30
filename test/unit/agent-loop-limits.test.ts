import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  agentScenarioV1Schema,
  agentToolDefinitionV1Schema,
  type AgentScenarioV1,
} from "../../src/agent/contracts.js";
import {
  runAgentLoop,
  type AgentToolExecutionContext,
} from "../../src/agent/loop.js";
import { AgentCleanupVerificationError } from "../../src/agent/docker-cleanup.js";
import { ProviderCredentialIsolationError } from "../../src/agent/redaction.js";
import { AgentTrialResourceQuotaError } from "../../src/agent/resource-quota.js";
import { ScriptedAgentProvider } from "../../src/agent/providers/scripted.js";
import { EvidenceStore } from "../../src/evidence-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createStore(runId: string): Promise<EvidenceStore> {
  const root = await mkdtemp(resolve(tmpdir(), "forge-agent-loop-limits-"));
  temporaryDirectories.push(root);
  return EvidenceStore.create(root, runId);
}

function scenarioWithLimits(
  limits: Partial<AgentScenarioV1["rollouts"]["limits"]>,
): AgentScenarioV1 {
  return agentScenarioV1Schema.parse({
    schema: "forge.agent-scenario/v1",
    id: "agent-loop-limits-test",
    targetConfig: "target.yaml",
    providerData: {
      targetMetadata: "operator_approved",
      targetMetadataSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      targetToolResults: "withheld",
    },
    task: { prompt: "Create the requested synthetic note." },
    authorization: {
      defaultDecision: "denied",
      rules: [
        {
          id: "allow-note-write",
          tool: "forge_write_file",
          decision: "allowed",
          arguments: {
            path: { kind: "equals", value: "/sandbox/workspace/main.md" },
            content: { kind: "equals", value: "hello" },
          },
        },
      ],
    },
    utility: {
      checks: [
        {
          id: "note-created",
          kind: "fileContentEquals",
          path: "/sandbox/workspace/main.md",
          content: "hello",
        },
      ],
    },
    syntheticTools: ["forge_write_file"],
    rollouts: {
      provider: "openrouter",
      model: "test/model",
      trials: 1,
      policyModes: ["observe"],
      temperature: 0,
      limits: {
        maxTurns: 3,
        maxToolCalls: 3,
        timeoutMs: 10_000,
        maxOutputTokens: 256,
        ...limits,
      },
    },
  });
}

const writeTool = agentToolDefinitionV1Schema.parse({
  schema: "forge.agent-tool-definition/v1",
  name: "forge_write_file",
  description: "Synthetic write",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  source: "forge_controlled",
  metadataTrust: "controller_defined",
});

function writeCall(id: string) {
  return {
    id,
    name: "forge_write_file",
    arguments: {
      path: "/sandbox/workspace/main.md",
      content: "hello",
    },
  } as const;
}

describe("agent loop limit enforcement", () => {
  it("charges missing usage conservatively across turns and rejects an over-budget completion", async () => {
    const evidenceStore = await createStore("run-missing-usage");
    const provider = new ScriptedAgentProvider([
      {
        returnedModel: "test/model-v1",
        content: null,
        toolCalls: [writeCall("call-one")],
        finishReason: "tool_calls",
      },
      {
        returnedModel: "test/model-v1",
        content: "SENSITIVE_COMPLETION_MUST_NOT_APPEAR_IN_THE_FAILURE_REASON",
        toolCalls: [writeCall("call-two")],
        finishReason: "tool_calls",
      },
    ]);
    let executions = 0;

    const result = await runAgentLoop({
      scenario: scenarioWithLimits({ maxOutputTokens: 200 }),
      trialId: "missing-usage-1",
      policyMode: "observe",
      provider,
      tools: [writeTool],
      store: evidenceStore,
      evidencePath: "agent/rollouts/missing-usage-1",
      executeTool: async () => {
        executions += 1;
        return { content: "written", result: { written: true } };
      },
    });

    expect(executions).toBe(1);
    expect(result.actions).toHaveLength(1);
    expect(result.toolCalls).toBe(1);
    expect(result.turns).toBe(2);
    expect(result.limitsHit).toContain("output_tokens");
    expect(result.providerFailure).toBe(
      "provider completion exceeded the remaining output-token budget",
    );
    expect(result.inconclusiveReason).toBe(result.providerFailure);
    expect(
      result.messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(1);

    const errorArtifact = await readFile(
      evidenceStore.pathFor(
        "agent/rollouts/missing-usage-1/provider-error.json",
      ),
      "utf8",
    );
    expect(errorArtifact).not.toContain("SENSITIVE_COMPLETION");
    expect(JSON.parse(errorArtifact)).toEqual({
      message: "provider completion exceeded the remaining output-token budget",
    });

    const providerTurns = (
      await readFile(
        evidenceStore.pathFor(
          "agent/rollouts/missing-usage-1/provider-turns.jsonl",
        ),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(providerTurns).toHaveLength(2);
    expect(providerTurns[0]).toMatchObject({
      outputTokenAccounting: "conservative_estimate",
      remainingOutputTokens: 200,
    });
    expect(providerTurns[1]).toMatchObject({
      outputTokenAccounting: "conservative_estimate",
    });
    expect(providerTurns[1]?.accountedOutputTokens).toBeGreaterThan(
      providerTurns[1]?.remainingOutputTokens as number,
    );
  });

  it("passes the remaining overall deadline immediately before dispatch", async () => {
    const evidenceStore = await createStore("run-dispatch-budget");
    const times = [10_000, 10_100, 10_250];
    vi.spyOn(Date, "now").mockImplementation(() => times.shift() ?? 10_250);
    const contexts: AgentToolExecutionContext[] = [];

    const result = await runAgentLoop({
      scenario: scenarioWithLimits({ maxTurns: 1, timeoutMs: 1_000 }),
      trialId: "dispatch-budget-1",
      policyMode: "observe",
      provider: new ScriptedAgentProvider([
        {
          returnedModel: "test/model-v1",
          content: null,
          toolCalls: [writeCall("call-one")],
          finishReason: "tool_calls",
          usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
        },
      ]),
      tools: [writeTool],
      store: evidenceStore,
      evidencePath: "agent/rollouts/dispatch-budget-1",
      executeTool: async (_name, _arguments, context) => {
        contexts.push(context);
        return { content: "written", result: { written: true } };
      },
    });

    expect(contexts).toEqual([{ timeoutMs: 750 }]);
    expect(result.actions[0]?.outcome.status).toBe("succeeded");
  });

  it("records the proposal but stops when the deadline expires before dispatch", async () => {
    const evidenceStore = await createStore("run-expired-dispatch");
    const times = [20_000, 20_100, 21_000];
    vi.spyOn(Date, "now").mockImplementation(() => times.shift() ?? 21_000);
    let executed = false;

    const result = await runAgentLoop({
      scenario: scenarioWithLimits({ maxTurns: 1, timeoutMs: 1_000 }),
      trialId: "expired-dispatch-1",
      policyMode: "observe",
      provider: new ScriptedAgentProvider([
        {
          returnedModel: "test/model-v1",
          content: null,
          toolCalls: [writeCall("call-one")],
          finishReason: "tool_calls",
          usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
        },
      ]),
      tools: [writeTool],
      store: evidenceStore,
      evidencePath: "agent/rollouts/expired-dispatch-1",
      executeTool: async () => {
        executed = true;
        return { content: "written", result: { written: true } };
      },
    });

    expect(executed).toBe(false);
    expect(result.limitsHit).toEqual(["timeout"]);
    expect(result.providerFailure).toBe(
      "agent trial deadline exhausted before tool dispatch",
    );
    expect(result.inconclusiveReason).toBe(result.providerFailure);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.outcome.status).toBe("proposed");
    expect(result.decisions[0]?.dispatchDisposition).toBe("dispatch");
    expect(result.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
  });

  it("does not mark a natural final answer on the exact last turn as a turn limit", async () => {
    const evidenceStore = await createStore("run-natural-last-turn");

    const result = await runAgentLoop({
      scenario: scenarioWithLimits({ maxTurns: 1 }),
      trialId: "natural-last-turn-1",
      policyMode: "observe",
      provider: new ScriptedAgentProvider([
        {
          returnedModel: "test/model-v1",
          content: "Done",
          toolCalls: [],
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
        },
      ]),
      tools: [writeTool],
      store: evidenceStore,
      evidencePath: "agent/rollouts/natural-last-turn-1",
      executeTool: async () => {
        throw new Error("natural final answer must not dispatch a tool");
      },
    });

    expect(result.turns).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.limitsHit).toEqual([]);
    expect(result.providerFailure).toBeUndefined();
    expect(result.inconclusiveReason).toBeUndefined();
    expect(result.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Done",
      toolCalls: [],
    });
  });

  it.each([
    {
      finishReason: "length",
      expectedLimit: "output_tokens" as const,
    },
    {
      finishReason: "content_filter",
      expectedLimit: undefined,
    },
    {
      finishReason: null,
      expectedLimit: undefined,
    },
  ])(
    "marks a zero-tool $finishReason provider termination as inconclusive",
    async ({ finishReason, expectedLimit }) => {
      const evidenceStore = await createStore(
        `run-non-natural-${finishReason ?? "null"}`,
      );
      const result = await runAgentLoop({
        scenario: scenarioWithLimits({ maxTurns: 1 }),
        trialId: `non-natural-${finishReason ?? "null"}-1`,
        policyMode: "observe",
        provider: new ScriptedAgentProvider([
          {
            returnedModel: "test/model-v1",
            content: "Partial provider output",
            toolCalls: [],
            finishReason,
            usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
          },
        ]),
        tools: [writeTool],
        store: evidenceStore,
        evidencePath: `agent/rollouts/non-natural-${finishReason ?? "null"}-1`,
        executeTool: async () => {
          throw new Error("non-natural completion must not dispatch a tool");
        },
      });

      expect(result.inconclusiveReason).toContain("non-natural finish reason");
      expect(result.providerFailure).toBe(result.inconclusiveReason);
      if (expectedLimit === undefined) {
        expect(result.limitsHit).toEqual([]);
      } else {
        expect(result.limitsHit).toContain(expectedLimit);
      }
    },
  );

  it("marks a required next turn as inconclusive at the turn limit", async () => {
    const evidenceStore = await createStore("run-turn-limit");
    const result = await runAgentLoop({
      scenario: scenarioWithLimits({ maxTurns: 1 }),
      trialId: "turn-limit-1",
      policyMode: "observe",
      provider: new ScriptedAgentProvider([
        {
          returnedModel: "test/model-v1",
          content: null,
          toolCalls: [writeCall("call-one")],
          finishReason: "tool_calls",
          usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
        },
      ]),
      tools: [writeTool],
      store: evidenceStore,
      evidencePath: "agent/rollouts/turn-limit-1",
      executeTool: async () => ({ content: "written", result: { written: true } }),
    });

    expect(result.limitsHit).toEqual(["turns"]);
    expect(result.inconclusiveReason).toContain("turn limit");
    expect(result.providerFailure).toBeUndefined();
  });

  it("marks a required next turn as inconclusive at the tool-call limit", async () => {
    const evidenceStore = await createStore("run-tool-call-limit");
    const result = await runAgentLoop({
      scenario: scenarioWithLimits({ maxToolCalls: 1 }),
      trialId: "tool-call-limit-1",
      policyMode: "observe",
      provider: new ScriptedAgentProvider([
        {
          returnedModel: "test/model-v1",
          content: null,
          toolCalls: [writeCall("call-one")],
          finishReason: "tool_calls",
          usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
        },
      ]),
      tools: [writeTool],
      store: evidenceStore,
      evidencePath: "agent/rollouts/tool-call-limit-1",
      executeTool: async () => ({ content: "written", result: { written: true } }),
    });

    expect(result.limitsHit).toEqual(["tool_calls"]);
    expect(result.inconclusiveReason).toContain("tool-call limit");
    expect(result.providerFailure).toBeUndefined();
  });

  it("marks a required next turn as inconclusive when the deadline expires", async () => {
    const evidenceStore = await createStore("run-next-turn-timeout");
    const times = [30_000, 30_000, 30_000, 31_000];
    vi.spyOn(Date, "now").mockImplementation(() => times.shift() ?? 31_000);
    const result = await runAgentLoop({
      scenario: scenarioWithLimits({ timeoutMs: 1_000 }),
      trialId: "next-turn-timeout-1",
      policyMode: "observe",
      provider: new ScriptedAgentProvider([
        {
          returnedModel: "test/model-v1",
          content: null,
          toolCalls: [writeCall("call-one")],
          finishReason: "tool_calls",
          usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
        },
      ]),
      tools: [writeTool],
      store: evidenceStore,
      evidencePath: "agent/rollouts/next-turn-timeout-1",
      executeTool: async () => ({ content: "written", result: { written: true } }),
    });

    expect(result.limitsHit).toEqual(["timeout"]);
    expect(result.inconclusiveReason).toContain("deadline expired");
    expect(result.providerFailure).toBeUndefined();
  });

  it("treats controlled-worker cleanup failures as fatal infrastructure errors", async () => {
    const evidenceStore = await createStore("run-fatal-worker-cleanup");
    const evaluation = runAgentLoop({
      scenario: scenarioWithLimits({ maxTurns: 1 }),
      trialId: "fatal-worker-cleanup-1",
      policyMode: "observe",
      provider: new ScriptedAgentProvider([
        {
          returnedModel: "test/model-v1",
          content: null,
          toolCalls: [writeCall("call-one")],
          finishReason: "tool_calls",
          usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
        },
      ]),
      tools: [writeTool],
      store: evidenceStore,
      evidencePath: "agent/rollouts/fatal-worker-cleanup-1",
      executeTool: async () => {
        throw new AgentCleanupVerificationError("worker cleanup was unverified");
      },
    });

    await expect(evaluation).rejects.toThrow(AgentCleanupVerificationError);
  });

  it("treats writable-state quota failures as fatal across provider and tool boundaries", async () => {
    const providerStore = await createStore("run-provider-resource-quota");
    await expect(
      runAgentLoop({
        scenario: scenarioWithLimits({ maxTurns: 1 }),
        trialId: "provider-resource-quota-1",
        policyMode: "observe",
        provider: {
          name: "quota-test",
          complete: async () => {
            throw new AgentTrialResourceQuotaError("profile quota exceeded");
          },
        },
        tools: [writeTool],
        store: providerStore,
        evidencePath: "agent/rollouts/provider-resource-quota-1",
        executeTool: async () => ({ content: "unused", result: {} }),
      }),
    ).rejects.toThrow(AgentTrialResourceQuotaError);

    const toolStore = await createStore("run-tool-resource-quota");
    await expect(
      runAgentLoop({
        scenario: scenarioWithLimits({ maxTurns: 1 }),
        trialId: "tool-resource-quota-1",
        policyMode: "observe",
        provider: new ScriptedAgentProvider([
          {
            returnedModel: "test/model-v1",
            content: null,
            toolCalls: [writeCall("call-one")],
            finishReason: "tool_calls",
            usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
          },
        ]),
        tools: [writeTool],
        store: toolStore,
        evidencePath: "agent/rollouts/tool-resource-quota-1",
        executeTool: async () => {
          throw new AgentTrialResourceQuotaError("trace quota exceeded");
        },
      }),
    ).rejects.toThrow(AgentTrialResourceQuotaError);
  });

  it("treats provider credential isolation failures as fatal", async () => {
    const evidenceStore = await createStore("run-provider-credential-isolation");
    await expect(
      runAgentLoop({
        scenario: scenarioWithLimits({ maxTurns: 1 }),
        trialId: "provider-credential-isolation-1",
        policyMode: "observe",
        provider: {
          name: "credential-test",
          complete: async () => {
            throw new ProviderCredentialIsolationError(
              "parsed completion contained a registered credential",
            );
          },
        },
        tools: [writeTool],
        store: evidenceStore,
        evidencePath: "agent/rollouts/provider-credential-isolation-1",
        executeTool: async () => ({ content: "unused", result: {} }),
      }),
    ).rejects.toThrow(ProviderCredentialIsolationError);
  });
});
