import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { attributeEvents } from "../../src/attribute.js";
import { targetConfigV1Schema } from "../../src/config.js";
import {
  observedEventV1Schema,
  phaseV1Schema,
} from "../../src/contracts/v1.js";
import { EvidenceStore } from "../../src/evidence-store.js";
import { evaluateRuntimeRules } from "../../src/rules.js";

describe("attribution and runtime rules", () => {
  it("does not claim high causality for an initialization worker acting during a tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-attribution-worker-"));
    const store = await EvidenceStore.create(root, "run-worker");
    const phases = [
      phaseV1Schema.parse({
        schema: "forge.phase/v1",
        phaseId: "worker-initialization-1",
        runId: "run-worker",
        experimentId: "worker-tool",
        kind: "initialization",
        name: "initialize",
        startedAt: "2026-08-29T18:20:00.000Z",
        endedAt: "2026-08-29T18:20:01.000Z",
        status: "completed",
      }),
      phaseV1Schema.parse({
        schema: "forge.phase/v1",
        phaseId: "worker-tool-2",
        runId: "run-worker",
        experimentId: "worker-tool",
        kind: "tool",
        name: "call worker_tool",
        toolName: "worker_tool",
        startedAt: "2026-08-29T18:20:02.000Z",
        endedAt: "2026-08-29T18:20:03.000Z",
        status: "completed",
      }),
    ];
    const events = [
      observedEventV1Schema.parse({
        schema: "forge.event/v1",
        eventId: "evt-worker-start",
        runId: "run-worker",
        experimentId: "worker-tool",
        sequence: 0,
        timestamp: "2026-08-29T18:20:00.500Z",
        processRef: "run-worker:worker-tool:pid-10",
        effect: { kind: "process.start", pid: 10 },
        source: { collector: "strace", rawRef: "raw/worker-tool/strace.10:1" },
      }),
      observedEventV1Schema.parse({
        schema: "forge.event/v1",
        eventId: "evt-worker-read",
        runId: "run-worker",
        experimentId: "worker-tool",
        sequence: 1,
        timestamp: "2026-08-29T18:20:02.500Z",
        processRef: "run-worker:worker-tool:pid-10",
        effect: {
          kind: "file.read",
          path: "/synthetic/workspace/input.txt",
          bytes: 4,
          outcome: { status: "succeeded" },
        },
        source: { collector: "strace", rawRef: "raw/worker-tool/strace.10:2" },
      }),
    ];

    const attributions = await attributeEvents({
      store,
      events,
      phases,
      isolatedToolExperimentIds: new Set(["worker-tool"]),
    });
    expect(attributions.find((value) => value.eventId === "evt-worker-read")).toMatchObject({
      activePhaseId: "worker-tool-2",
      processOriginPhaseId: "worker-initialization-1",
      confidence: "medium",
      reasons: expect.arrayContaining(["process_origin_precedes_active_phase"]),
    });
  });

  it("detects a randomized out-of-scope canary without tool-specific logic", async () => {
    const randomSuffix = Math.random().toString(16).slice(2);
    const experimentId = `tool-${randomSuffix}`;
    const toolName = `read_${randomSuffix}`;
    const profileHome = `/profiles/${randomSuffix}/home`;
    const profileWorkspace = `/profiles/${randomSuffix}/workspace`;
    const sensitivePath = `${profileHome}/private-${randomSuffix}`;
    const runId = `run-${randomSuffix}`;
    const root = await mkdtemp(join(tmpdir(), "forge-rules-"));
    const store = await EvidenceStore.create(root, runId);
    const config = targetConfigV1Schema.parse({
      schema: "forge.target/v1",
      target: {
        id: "random-fixture",
        source: { type: "fixture", path: "." },
        runtime: { transport: "stdio", command: "node", args: ["server.js"] },
      },
      sandbox: {
        profile: "developer-v1",
        network: "blocked",
        limits: {
          timeoutMs: 1_000,
          cooldownMs: 0,
          memoryMb: 128,
          cpus: 1,
          pids: 32,
        },
      },
      experiments: {
        initialization: true,
        tools: [
          {
            id: experimentId,
            tool: toolName,
            input: { path: "/sandbox/workspace/input.txt" },
            expected: {
              fileReads: ["/sandbox/workspace/input.txt"],
              fileWrites: [],
              networkConnections: [],
              childExecutables: [],
            },
          },
        ],
        workflows: [],
      },
    });
    const phase = phaseV1Schema.parse({
      schema: "forge.phase/v1",
      phaseId: `${experimentId}-tool-1`,
      runId,
      experimentId,
      kind: "tool",
      name: `call ${toolName}`,
      toolName,
      startedAt: "2026-08-29T18:20:00.000Z",
      endedAt: "2026-08-29T18:20:01.000Z",
      status: "completed",
    });
    const event = observedEventV1Schema.parse({
      schema: "forge.event/v1",
      eventId: `evt-${randomSuffix}`,
      runId,
      experimentId,
      sequence: 0,
      timestamp: "2026-08-29T18:20:00.500Z",
      processRef: `${runId}:${experimentId}:pid-9001`,
      effect: {
        kind: "file.read",
        path: sensitivePath,
        bytes: 20,
        outcome: { status: "succeeded" },
      },
      source: { collector: "strace", rawRef: `raw/${experimentId}/strace.9001:7` },
    });
    const attributions = await attributeEvents({
      store,
      events: [event],
      phases: [phase],
      isolatedToolExperimentIds: new Set([experimentId]),
    });
    const findings = await evaluateRuntimeRules({
      store,
      runId,
      config,
      events: [event],
      phases: [phase],
      attributions,
      sensitivePathsByExperiment: new Map([
        [experimentId, new Set([sensitivePath])],
      ]),
      profileRootsByExperiment: new Map([
        [experimentId, { home: profileHome, workspace: profileWorkspace }],
      ]),
    });

    expect(attributions[0]?.confidence).toBe("high");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "runtime.file_scope_exceeded",
      severity: "high",
      confidence: "high",
      eventIds: [event.eventId],
    });
    expect(findings[0]?.summary).toContain(toolName);
    expect(findings[0]?.summary).toContain(sensitivePath);

    const configuredTool = config.experiments.tools[0];
    if (configuredTool === undefined) {
      throw new Error("test tool was not configured");
    }
    const prefixAllowedConfig = targetConfigV1Schema.parse({
      ...config,
      experiments: {
        ...config.experiments,
        tools: [
          {
            ...configuredTool,
            expected: {
              ...configuredTool.expected,
              fileReadPrefixes: [profileHome],
            },
          },
        ],
      },
    });
    const prefixAllowedFindings = await evaluateRuntimeRules({
      store,
      runId,
      config: prefixAllowedConfig,
      events: [event],
      phases: [phase],
      attributions,
      sensitivePathsByExperiment: new Map([
        [experimentId, new Set([sensitivePath])],
      ]),
      profileRootsByExperiment: new Map([
        [experimentId, { home: profileHome, workspace: profileWorkspace }],
      ]),
    });
    expect(prefixAllowedFindings).toHaveLength(0);
  });
});
