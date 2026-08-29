import { describe, expect, it } from "vitest";

import { targetConfigV1Schema } from "../../src/config.js";
import {
  attributionV1Schema,
  observedEventV1Schema,
  phaseV1Schema,
} from "../../src/contracts/v1.js";
import { summarizeRuntimeObservations } from "../../src/report.js";

describe("runtime observation report summary", () => {
  it("links expected-scope examples only from the active tool phase", () => {
    const config = targetConfigV1Schema.parse({
      schema: "forge.target/v1",
      target: {
        id: "generic-target",
        source: { type: "local", path: "/input/target", install: "none" },
        runtime: {
          transport: "stdio",
          command: "node",
          args: ["/opt/target/index.js"],
        },
      },
      sandbox: {
        profile: "developer-v1",
        network: "blocked",
        limits: {
          timeoutMs: 10_000,
          cooldownMs: 0,
          memoryMb: 256,
          cpus: 1,
          pids: 64,
        },
      },
      experiments: {
        initialization: false,
        tools: [
          {
            id: "read-document",
            tool: "read_document",
            input: { path: "/sandbox/workspace/report.txt" },
            expected: {
              fileReads: ["/sandbox/workspace/report.txt"],
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
      phaseId: "phase-read-document-tool",
      runId: "run-summary",
      experimentId: "read-document",
      kind: "tool",
      name: "call read_document",
      toolName: "read_document",
      startedAt: "2026-08-29T20:00:00.000Z",
      endedAt: "2026-08-29T20:00:01.000Z",
      status: "completed",
    });
    const makeEvent = (options: {
      id: string;
      sequence: number;
      path: string;
      rawRef: string;
    }) =>
      observedEventV1Schema.parse({
        schema: "forge.event/v1",
        eventId: options.id,
        runId: "run-summary",
        experimentId: "read-document",
        sequence: options.sequence,
        timestamp: "2026-08-29T20:00:00.500Z",
        processRef: "run-summary:pid-10",
        effect: {
          kind: "file.read",
          path: options.path,
          outcome: { status: "succeeded" },
        },
        source: { collector: "strace", rawRef: options.rawRef },
      });
    const expected = makeEvent({
      id: "evt-expected-read",
      sequence: 1,
      path: "/sandbox/workspace/report.txt",
      rawRef: "raw/read-document/strace.10:5",
    });
    const unrelated = makeEvent({
      id: "evt-unrelated-read",
      sequence: 2,
      path: "/sandbox/home/forge/.ssh/id_ed25519",
      rawRef: "raw/read-document/strace.10:6",
    });
    const outsideToolPhase = makeEvent({
      id: "evt-late-expected-read",
      sequence: 3,
      path: "/sandbox/workspace/report.txt",
      rawRef: "raw/read-document/strace.10:7",
    });
    const activeAttribution = (eventId: string) =>
      attributionV1Schema.parse({
        schema: "forge.attribution/v1",
        attributionId: `attr-${eventId}`,
        runId: "run-summary",
        eventId,
        activePhaseId: phase.phaseId,
        processOriginPhaseId: "phase-read-document-initialization",
        confidence: "medium",
        reasons: ["process_origin_precedes_active_phase"],
      });

    const result = summarizeRuntimeObservations({
      config,
      events: [expected, unrelated, outsideToolPhase],
      phases: [phase],
      attributions: [
        activeAttribution(expected.eventId),
        activeAttribution(unrelated.eventId),
        attributionV1Schema.parse({
          schema: "forge.attribution/v1",
          attributionId: "attr-late-expected-read",
          runId: "run-summary",
          eventId: outsideToolPhase.eventId,
          confidence: "unattributed",
          reasons: ["outside_phase"],
        }),
      ],
    });

    expect(result).toEqual([
      {
        experimentId: "read-document",
        kind: "tool",
        toolName: "read_document",
        effectCounts: [{ effectKind: "file.read", count: 3 }],
        expectedScopeMatches: {
          eventCount: 1,
          examples: [
            {
              eventId: "evt-expected-read",
              effect: expected.effect,
              attributionConfidence: "medium",
              rawRef: "raw/read-document/strace.10:5",
            },
          ],
          examplesTruncated: false,
        },
      },
    ]);
  });
});
