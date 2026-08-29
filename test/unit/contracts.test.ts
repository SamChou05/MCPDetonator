import { describe, expect, it } from "vitest";

import {
  attributionV1Schema,
  observedEventV1Schema,
  phaseV1Schema,
} from "../../src/contracts/v1.js";

describe("persisted v1 contracts", () => {
  it("validates a canonical file-read event with raw evidence", () => {
    const event = observedEventV1Schema.parse({
      schema: "forge.event/v1",
      eventId: "evt-42",
      runId: "run-7",
      experimentId: "summarize-file",
      sequence: 42,
      timestamp: "2026-08-29T18:20:00.123Z",
      processRef: "run-7:pid-391",
      effect: {
        kind: "file.read",
        path: "/sandbox/home/forge/.ssh/id_ed25519",
        bytes: 64,
        outcome: { status: "succeeded" },
      },
      source: {
        collector: "strace",
        rawRef: "raw/strace.391:84",
      },
    });

    expect(event.effect.kind).toBe("file.read");
  });

  it("keeps attribution separate from the observed event", () => {
    const attribution = attributionV1Schema.parse({
      schema: "forge.attribution/v1",
      attributionId: "attr-42",
      runId: "run-7",
      eventId: "evt-42",
      activePhaseId: "phase-tool-1",
      processOriginPhaseId: "phase-tool-1",
      confidence: "high",
      reasons: ["isolated_tool_run", "within_phase_bounds"],
    });

    expect(attribution.confidence).toBe("high");
  });

  it("rejects a phase whose end precedes its start", () => {
    expect(() =>
      phaseV1Schema.parse({
        schema: "forge.phase/v1",
        phaseId: "phase-1",
        runId: "run-7",
        experimentId: "initialization",
        kind: "initialization",
        name: "initialize MCP",
        startedAt: "2026-08-29T18:20:05.000Z",
        endedAt: "2026-08-29T18:20:00.000Z",
        status: "completed",
      }),
    ).toThrow("endedAt must not precede startedAt");
  });

  it("does not treat a failed exec probe as successful execution", () => {
    const event = observedEventV1Schema.parse({
      schema: "forge.event/v1",
      eventId: "evt-exec-1",
      runId: "run-7",
      experimentId: "summarize-file",
      sequence: 7,
      timestamp: "2026-08-29T18:20:00.123Z",
      processRef: "run-7:pid-391",
      effect: {
        kind: "process.exec",
        executable: "/usr/local/sbin/node",
        args: ["node", "server.js"],
        outcome: { status: "failed", errno: "ENOENT" },
      },
      source: {
        collector: "strace",
        rawRef: "raw/strace.391:12",
      },
    });

    expect(event.effect).toMatchObject({
      kind: "process.exec",
      outcome: { status: "failed", errno: "ENOENT" },
    });
  });
});

