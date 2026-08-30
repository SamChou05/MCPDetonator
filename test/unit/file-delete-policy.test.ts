import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { targetConfigV1Schema } from "../../src/config.js";
import {
  attributionV1Schema,
  observedEventV1Schema,
  phaseV1Schema,
} from "../../src/contracts/v1.js";
import { EvidenceStore } from "../../src/evidence-store.js";
import { summarizeRuntimeObservations } from "../../src/report.js";
import { evaluateRuntimeRules } from "../../src/rules.js";

describe("file deletion policy", () => {
  it("treats deletes as mutations governed by the configured write scope", async () => {
    const runId = "run-delete-policy";
    const experimentId = "delete-document";
    const root = await mkdtemp(join(tmpdir(), "forge-delete-policy-"));
    const store = await EvidenceStore.create(root, runId);
    const config = targetConfigV1Schema.parse({
      schema: "forge.target/v1",
      target: {
        id: "delete-policy-fixture",
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
        initialization: false,
        tools: [
          {
            id: experimentId,
            tool: "delete_document",
            input: {},
            expected: {
              fileReads: [],
              fileWrites: ["/sandbox/workspace/allowed.txt"],
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
      stage: "tool_invocation",
      name: "call delete_document",
      toolName: "delete_document",
      startedAt: "2026-08-30T04:00:00.000Z",
      endedAt: "2026-08-30T04:00:01.000Z",
      status: "completed",
    });
    const allowedDelete = observedEventV1Schema.parse({
      schema: "forge.event/v1",
      eventId: "evt-allowed-delete",
      runId,
      experimentId,
      sequence: 0,
      timestamp: "2026-08-30T04:00:00.200Z",
      processRef: `${runId}:${experimentId}:pid-10`,
      effect: {
        kind: "file.delete",
        path: "/sandbox/workspace/allowed.txt",
        outcome: { status: "succeeded" },
      },
      source: { collector: "strace", rawRef: "raw/delete-document/strace.10:1" },
    });
    const unexpectedDelete = observedEventV1Schema.parse({
      schema: "forge.event/v1",
      eventId: "evt-unexpected-delete",
      runId,
      experimentId,
      sequence: 1,
      timestamp: "2026-08-30T04:00:00.300Z",
      processRef: `${runId}:${experimentId}:pid-10`,
      effect: {
        kind: "file.delete",
        path: "/sandbox/workspace/blocked.txt",
        outcome: { status: "failed", errno: "EPERM" },
      },
      source: { collector: "strace", rawRef: "raw/delete-document/strace.10:2" },
    });
    const repeatedAllowedDelete = observedEventV1Schema.parse({
      ...allowedDelete,
      eventId: "evt-allowed-delete-repeated",
      sequence: 2,
      timestamp: "2026-08-30T04:00:00.400Z",
      source: { collector: "strace", rawRef: "raw/delete-document/strace.10:3" },
    });
    const events = [allowedDelete, unexpectedDelete, repeatedAllowedDelete];
    const attributions = events.map((event) =>
      attributionV1Schema.parse({
        schema: "forge.attribution/v1",
        attributionId: `attr-${event.eventId}`,
        runId,
        eventId: event.eventId,
        activePhaseId: phase.phaseId,
        processOriginPhaseId: phase.phaseId,
        confidence: "high",
        reasons: ["within_phase_bounds", "isolated_tool_run"],
      }),
    );

    const findings = await evaluateRuntimeRules({
      store,
      runId,
      config,
      events,
      phases: [phase],
      attributions,
      sensitivePathsByExperiment: new Map([[experimentId, new Set()]]),
      profileRootsByExperiment: new Map([
        [
          experimentId,
          { home: "/sandbox/home/forge", workspace: "/sandbox/workspace" },
        ],
      ]),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "runtime.file_scope_exceeded",
      eventIds: [unexpectedDelete.eventId],
      confidence: "high",
    });
    expect(findings[0]?.summary).toContain("attempted file.delete");
    expect(findings[0]?.summary).toContain("recorded syscall failed");

    const [observation] = summarizeRuntimeObservations({
      config,
      events,
      phases: [phase],
      attributions,
    });
    expect(observation?.expectedScopeMatches).toMatchObject({
      eventCount: 2,
      examples: [{ eventId: allowedDelete.eventId }],
      examplesTruncated: false,
    });
  });
});
