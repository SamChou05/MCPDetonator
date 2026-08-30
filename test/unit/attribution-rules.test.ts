import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { attributeEvents } from "../../src/attribute.js";
import {
  initializationEnabled,
  initializationExpectedScope,
  targetConfigV1Schema,
} from "../../src/config.js";
import {
  observedEventV1Schema,
  phaseV1Schema,
  type ObservedEffectV1,
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

  it("surfaces initialization credential reads and tool-originated cooldown activity", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-lifecycle-rules-"));
    const store = await EvidenceStore.create(root, "run-lifecycle");
    const initializationCredentialPath = "/baseline/home/.config/token";
    const delayedCredentialPath = "/tool/home/.ssh/id_ed25519";
    const config = targetConfigV1Schema.parse({
      schema: "forge.target/v1",
      target: {
        id: "lifecycle-fixture",
        source: { type: "fixture", path: "." },
        runtime: { transport: "stdio", command: "node", args: ["server.js"] },
      },
      sandbox: {
        profile: "developer-v1",
        network: "blocked",
        limits: {
          timeoutMs: 1_000,
          cooldownMs: 500,
          memoryMb: 128,
          cpus: 1,
          pids: 32,
        },
      },
      experiments: {
        initialization: true,
        tools: [
          {
            id: "delayed-tool",
            tool: "delayed_tool",
            input: {},
            expected: {
              fileReads: [],
              fileWrites: [],
              networkConnections: [],
              childExecutables: [],
            },
          },
        ],
        workflows: [],
      },
    });
    const phases = [
      phaseV1Schema.parse({
        schema: "forge.phase/v1",
        phaseId: "baseline-initialization-initialization-1",
        runId: "run-lifecycle",
        experimentId: "baseline-initialization",
        kind: "initialization",
        name: "initialize",
        startedAt: "2026-08-29T20:00:00.000Z",
        endedAt: "2026-08-29T20:00:01.000Z",
        status: "completed",
      }),
      phaseV1Schema.parse({
        schema: "forge.phase/v1",
        phaseId: "delayed-tool-tool-1",
        runId: "run-lifecycle",
        experimentId: "delayed-tool",
        kind: "tool",
        name: "call delayed_tool",
        toolName: "delayed_tool",
        startedAt: "2026-08-29T20:00:02.000Z",
        endedAt: "2026-08-29T20:00:03.000Z",
        status: "completed",
      }),
      phaseV1Schema.parse({
        schema: "forge.phase/v1",
        phaseId: "delayed-tool-cooldown-2",
        runId: "run-lifecycle",
        experimentId: "delayed-tool",
        kind: "cooldown",
        name: "observe background activity",
        startedAt: "2026-08-29T20:00:03.100Z",
        endedAt: "2026-08-29T20:00:03.600Z",
        status: "completed",
      }),
    ];
    const initializationCredential = observedEventV1Schema.parse({
      schema: "forge.event/v1",
      eventId: "evt-initialization-credential",
      runId: "run-lifecycle",
      experimentId: "baseline-initialization",
      sequence: 0,
      timestamp: "2026-08-29T20:00:00.500Z",
      processRef: "run-lifecycle:baseline-initialization:pid-10",
      effect: {
        kind: "file.read",
        path: initializationCredentialPath,
        bytes: 20,
        outcome: { status: "succeeded" },
      },
      source: {
        collector: "strace",
        rawRef: "raw/baseline-initialization/strace.10:1",
      },
    });
    const workerStart = observedEventV1Schema.parse({
      schema: "forge.event/v1",
      eventId: "evt-delayed-worker-start",
      runId: "run-lifecycle",
      experimentId: "delayed-tool",
      sequence: 0,
      timestamp: "2026-08-29T20:00:02.500Z",
      processRef: "run-lifecycle:delayed-tool:pid-20",
      effect: { kind: "process.start", pid: 20 },
      source: { collector: "strace", rawRef: "raw/delayed-tool/strace.10:2" },
    });
    const delayedRead = observedEventV1Schema.parse({
      schema: "forge.event/v1",
      eventId: "evt-delayed-read",
      runId: "run-lifecycle",
      experimentId: "delayed-tool",
      sequence: 1,
      timestamp: "2026-08-29T20:00:03.300Z",
      processRef: "run-lifecycle:delayed-tool:pid-20",
      effect: {
        kind: "file.read",
        path: delayedCredentialPath,
        bytes: 20,
        outcome: { status: "succeeded" },
      },
      source: { collector: "strace", rawRef: "raw/delayed-tool/strace.20:1" },
    });
    const delayedBootstrapRead = observedEventV1Schema.parse({
      schema: "forge.event/v1",
      eventId: "evt-delayed-bootstrap-read",
      runId: "run-lifecycle",
      experimentId: "delayed-tool",
      sequence: 2,
      timestamp: "2026-08-29T20:00:03.350Z",
      processRef: "run-lifecycle:delayed-tool:pid-20",
      effect: {
        kind: "file.read",
        path: "/usr/lib/node_modules/runtime-bootstrap.js",
        bytes: 20,
        outcome: { status: "succeeded" },
      },
      source: { collector: "strace", rawRef: "raw/delayed-tool/strace.20:2" },
    });
    const events = [
      initializationCredential,
      workerStart,
      delayedRead,
      delayedBootstrapRead,
    ];
    const attributions = await attributeEvents({
      store,
      events,
      phases,
      isolatedToolExperimentIds: new Set(["delayed-tool"]),
    });
    const findings = await evaluateRuntimeRules({
      store,
      runId: "run-lifecycle",
      config,
      events,
      phases,
      attributions,
      sensitivePathsByExperiment: new Map([
        ["baseline-initialization", new Set([initializationCredentialPath])],
        ["delayed-tool", new Set([delayedCredentialPath])],
      ]),
      profileRootsByExperiment: new Map([
        [
          "baseline-initialization",
          { home: "/baseline/home", workspace: "/baseline/workspace" },
        ],
        ["delayed-tool", { home: "/tool/home", workspace: "/tool/workspace" }],
      ]),
    });

    expect(findings.map((value) => value.ruleId).sort()).toEqual([
      "runtime.initialization_sensitive_access",
      "runtime.post_return_activity",
    ]);
    expect(
      findings.find(
        (value) => value.ruleId === "runtime.initialization_sensitive_access",
      ),
    ).toMatchObject({ confidence: "high", eventIds: [initializationCredential.eventId] });
    expect(
      findings.find((value) => value.ruleId === "runtime.post_return_activity"),
    ).toMatchObject({ confidence: "medium", eventIds: [delayedRead.eventId] });
  });

  it("applies an operator-authored scope across every initialization phase", async () => {
    const runId = "run-initialization-scope";
    const root = await mkdtemp(join(tmpdir(), "forge-initialization-scope-"));
    const store = await EvidenceStore.create(root, runId);
    const profileHome = "/initialization/home";
    const profileWorkspace = "/initialization/workspace";
    const credentialPath = `${profileHome}/.config/private-token`;
    const allowedReadPath = `${profileWorkspace}/allowed.txt`;
    const unexpectedWritePath = `${profileHome}/created.txt`;
    const config = targetConfigV1Schema.parse({
      schema: "forge.target/v1",
      target: {
        id: "initialization-scope-fixture",
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
        initialization: {
          expected: {
            fileReads: [allowedReadPath],
            fileWrites: [],
            networkConnections: [{ address: "203.0.113.7", port: 443 }],
            childExecutables: ["/usr/bin/git"],
          },
        },
        tools: [
          {
            id: "configured-tool",
            tool: "configured_tool",
            input: {},
            expected: {
              fileReads: [],
              fileWrites: [],
              networkConnections: [],
              childExecutables: [],
            },
          },
        ],
        workflows: [],
      },
    });

    expect(initializationEnabled(false)).toBe(false);
    expect(initializationEnabled(true)).toBe(true);
    expect(initializationEnabled(config.experiments.initialization)).toBe(true);
    expect(initializationExpectedScope(true)).toBeUndefined();
    expect(
      initializationExpectedScope(config.experiments.initialization),
    ).toMatchObject({
      fileReadPrefixes: [],
      fileWritePrefixes: [],
      childExecutablePrefixes: [],
    });

    const phases = [
      phaseV1Schema.parse({
        schema: "forge.phase/v1",
        phaseId: "baseline-initialization-startup-1",
        runId,
        experimentId: "baseline-initialization",
        kind: "initialization",
        name: "start server",
        startedAt: "2026-08-29T21:00:00.000Z",
        endedAt: "2026-08-29T21:00:01.000Z",
        status: "completed",
      }),
      phaseV1Schema.parse({
        schema: "forge.phase/v1",
        phaseId: "baseline-initialization-discovery-2",
        runId,
        experimentId: "baseline-initialization",
        kind: "initialization",
        name: "discover tools",
        startedAt: "2026-08-29T21:00:01.100Z",
        endedAt: "2026-08-29T21:00:02.000Z",
        status: "completed",
      }),
      phaseV1Schema.parse({
        schema: "forge.phase/v1",
        phaseId: "baseline-initialization-cooldown-3",
        runId,
        experimentId: "baseline-initialization",
        kind: "cooldown",
        name: "observe initialization background activity",
        startedAt: "2026-08-29T21:00:02.100Z",
        endedAt: "2026-08-29T21:00:02.900Z",
        status: "completed",
      }),
    ];
    let sequence = 0;
    const event = (
      eventId: string,
      timestamp: string,
      processRef: string,
      effect: ObservedEffectV1,
    ) =>
      observedEventV1Schema.parse({
        schema: "forge.event/v1",
        eventId,
        runId,
        experimentId: "baseline-initialization",
        sequence: sequence++,
        timestamp,
        processRef,
        effect,
        source: {
          collector: "strace",
          rawRef: `raw/baseline-initialization/${eventId}`,
        },
      });
    const rootProcessRef = `${runId}:baseline-initialization:pid-10`;
    const childProcessRef = `${runId}:baseline-initialization:pid-20`;
    const rootStart = event(
      "evt-initialization-root-start",
      "2026-08-29T21:00:00.100Z",
      rootProcessRef,
      { kind: "process.start", pid: 10 },
    );
    const rootShimExec = event(
      "evt-initialization-root-shim-exec",
      "2026-08-29T21:00:00.200Z",
      rootProcessRef,
      {
        kind: "process.exec",
        executable: "/usr/bin/node",
        args: ["node", "server.js"],
        outcome: { status: "succeeded" },
      },
    );
    const allowedRead = event(
      "evt-initialization-allowed-read",
      "2026-08-29T21:00:00.300Z",
      rootProcessRef,
      {
        kind: "file.read",
        path: allowedReadPath,
        bytes: 10,
        outcome: { status: "succeeded" },
      },
    );
    const unexpectedRead = event(
      "evt-initialization-unexpected-read",
      "2026-08-29T21:00:00.400Z",
      rootProcessRef,
      {
        kind: "file.read",
        path: profileWorkspace,
        bytes: 10,
        outcome: { status: "succeeded" },
      },
    );
    const credentialRead = event(
      "evt-initialization-credential-read",
      "2026-08-29T21:00:00.500Z",
      rootProcessRef,
      {
        kind: "file.read",
        path: credentialPath,
        bytes: 20,
        outcome: { status: "succeeded" },
      },
    );
    const childStart = event(
      "evt-initialization-child-start",
      "2026-08-29T21:00:00.600Z",
      childProcessRef,
      {
        kind: "process.start",
        pid: 20,
        parentProcessRef: rootProcessRef,
      },
    );
    const allowedChildExec = event(
      "evt-initialization-allowed-child-exec",
      "2026-08-29T21:00:01.200Z",
      childProcessRef,
      {
        kind: "process.exec",
        executable: "/usr/bin/git",
        args: ["git", "--version"],
        outcome: { status: "succeeded" },
      },
    );
    const unexpectedChildExec = event(
      "evt-initialization-unexpected-child-exec",
      "2026-08-29T21:00:01.300Z",
      childProcessRef,
      {
        kind: "process.exec",
        executable: "/usr/bin/curl",
        args: ["curl", "https://example.invalid"],
        outcome: { status: "succeeded" },
      },
    );
    const failedChildExec = event(
      "evt-initialization-failed-child-exec",
      "2026-08-29T21:00:01.400Z",
      childProcessRef,
      {
        kind: "process.exec",
        executable: "/usr/bin/wget",
        args: ["wget", "https://example.invalid"],
        outcome: { status: "failed", errno: "ENOENT" },
      },
    );
    const unexpectedWrite = event(
      "evt-initialization-unexpected-write",
      "2026-08-29T21:00:01.500Z",
      rootProcessRef,
      {
        kind: "file.write",
        path: unexpectedWritePath,
        bytes: 8,
        outcome: { status: "succeeded" },
      },
    );
    const allowedConnection = event(
      "evt-initialization-allowed-network",
      "2026-08-29T21:00:01.600Z",
      rootProcessRef,
      {
        kind: "network.connect_attempt",
        protocol: "tcp",
        address: "203.0.113.7",
        port: 443,
        outcome: { status: "failed", errno: "ENETUNREACH" },
      },
    );
    const unexpectedConnection = event(
      "evt-initialization-unexpected-network",
      "2026-08-29T21:00:01.700Z",
      rootProcessRef,
      {
        kind: "network.connect_attempt",
        protocol: "tcp",
        address: "198.51.100.9",
        port: 8443,
        outcome: { status: "failed", errno: "ENETUNREACH" },
      },
    );
    const unixConnection = event(
      "evt-initialization-unix-network",
      "2026-08-29T21:00:01.800Z",
      rootProcessRef,
      {
        kind: "network.connect_attempt",
        protocol: "unix",
        address: "/tmp/server.sock",
        outcome: { status: "succeeded" },
      },
    );
    const cooldownCredentialRead = event(
      "evt-initialization-cooldown-credential-read",
      "2026-08-29T21:00:02.200Z",
      rootProcessRef,
      {
        kind: "file.read",
        path: credentialPath,
        bytes: 20,
        outcome: { status: "succeeded" },
      },
    );
    const cooldownUnexpectedWrite = event(
      "evt-initialization-cooldown-unexpected-write",
      "2026-08-29T21:00:02.300Z",
      rootProcessRef,
      {
        kind: "file.write",
        path: `${profileWorkspace}/cooldown.txt`,
        bytes: 8,
        outcome: { status: "succeeded" },
      },
    );
    const events = [
      rootStart,
      rootShimExec,
      allowedRead,
      unexpectedRead,
      credentialRead,
      childStart,
      allowedChildExec,
      unexpectedChildExec,
      failedChildExec,
      unexpectedWrite,
      allowedConnection,
      unexpectedConnection,
      unixConnection,
      cooldownCredentialRead,
      cooldownUnexpectedWrite,
    ];
    const attributions = await attributeEvents({
      store,
      events,
      phases,
      isolatedToolExperimentIds: new Set(),
    });
    const findings = await evaluateRuntimeRules({
      store,
      runId,
      config,
      events,
      phases,
      attributions,
      sensitivePathsByExperiment: new Map([
        ["baseline-initialization", new Set([credentialPath])],
      ]),
      profileRootsByExperiment: new Map([
        [
          "baseline-initialization",
          { home: profileHome, workspace: profileWorkspace },
        ],
      ]),
    });

    expect(findings).toHaveLength(6);
    expect(
      findings.find(
        (value) => value.ruleId === "runtime.initialization_sensitive_access",
      ),
    ).toMatchObject({
      confidence: "medium",
      eventIds: [credentialRead.eventId, cooldownCredentialRead.eventId],
    });
    expect(
      findings
        .filter(
          (value) =>
            value.ruleId === "runtime.initialization_file_scope_exceeded",
        )
        .flatMap((value) => value.eventIds)
        .sort(),
    ).toEqual(
      [
        unexpectedRead.eventId,
        unexpectedWrite.eventId,
        cooldownUnexpectedWrite.eventId,
      ].sort(),
    );
    expect(
      findings.find(
        (value) =>
          value.ruleId === "runtime.initialization_unexpected_process_exec",
      ),
    ).toMatchObject({
      confidence: "medium",
      eventIds: [unexpectedChildExec.eventId],
    });
    expect(
      findings.find(
        (value) =>
          value.ruleId === "runtime.initialization_unexpected_network_attempt",
      ),
    ).toMatchObject({ eventIds: [unexpectedConnection.eventId] });
    expect(
      findings.flatMap((value) => value.eventIds),
    ).not.toEqual(expect.arrayContaining([rootShimExec.eventId]));
  });
});
