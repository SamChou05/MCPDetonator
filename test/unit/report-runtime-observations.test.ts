import { describe, expect, it } from "vitest";

import { targetConfigV1Schema } from "../../src/config.js";
import {
  attributionV1Schema,
  observedEventV1Schema,
  phaseV1Schema,
} from "../../src/contracts/v1.js";
import { filesystemStateDeltaV1Schema } from "../../src/observe/filesystem-state.js";
import { summarizeRuntimeObservations } from "../../src/report.js";

describe("runtime observation report summary", () => {
  it("counts and links events only from the active tool phase", () => {
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
      outcome?:
        | { readonly status: "succeeded" }
        | { readonly status: "failed"; readonly errno: string };
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
          outcome: options.outcome ?? { status: "succeeded" },
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
    const failedExpected = makeEvent({
      id: "evt-failed-expected-read",
      sequence: 4,
      path: "/sandbox/workspace/report.txt",
      rawRef: "raw/read-document/strace.10:8",
      outcome: { status: "failed", errno: "EACCES" },
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
    const filesystemStateDelta = filesystemStateDeltaV1Schema.parse({
      schema: "forge.filesystem-delta/v1",
      runId: "run-summary",
      experimentId: "read-document",
      artifactRefs: {
        before: "runtime/filesystem-state/read-document/before.json",
        after: "runtime/filesystem-state/read-document/after.json",
        delta: "runtime/filesystem-state/read-document/delta.json",
      },
      snapshotsComplete: { before: true, after: true },
      changes: {
        created: [
          {
            root: "workspace",
            path: "/sandbox/workspace/output.txt",
            kind: "file",
            mode: 0o644,
            size: 6,
            content: { status: "hashed", sha256: "a".repeat(64) },
          },
        ],
        modified: [],
        deleted: [],
        typeChanged: [],
      },
      limitations: [
        "Experiment-level state change; exact process and phase are unknown.",
      ],
    });

    const result = summarizeRuntimeObservations({
      config,
      events: [expected, unrelated, outsideToolPhase, failedExpected],
      phases: [phase],
      attributions: [
        activeAttribution(expected.eventId),
        activeAttribution(unrelated.eventId),
        activeAttribution(failedExpected.eventId),
        attributionV1Schema.parse({
          schema: "forge.attribution/v1",
          attributionId: "attr-late-expected-read",
          runId: "run-summary",
          eventId: outsideToolPhase.eventId,
          confidence: "unattributed",
          reasons: ["outside_phase"],
        }),
      ],
      filesystemStateDeltas: [filesystemStateDelta],
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
        filesystemStateDelta: {
          scope: "isolated_experiment_window",
          attribution: "experiment_only",
          snapshotsComplete: { before: true, after: true },
          changeCounts: {
            created: 1,
            modified: 0,
            deleted: 0,
            typeChanged: 0,
          },
          examples: [
            {
              change: "created",
              path: "/sandbox/workspace/output.txt",
              afterKind: "file",
            },
          ],
          examplesTruncated: false,
          artifactRefs: filesystemStateDelta.artifactRefs,
          limitations: filesystemStateDelta.limitations,
        },
      },
    ]);
  });

  it("counts initialization events across handshake and discovery phases", () => {
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
          cooldownMs: 500,
          memoryMb: 256,
          cpus: 1,
          pids: 64,
        },
      },
      experiments: {
        initialization: true,
        tools: [
          {
            id: "placeholder-tool",
            tool: "placeholder_tool",
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
    const handshakePhase = phaseV1Schema.parse({
      schema: "forge.phase/v1",
      phaseId: "baseline-initialization-initialization-1",
      runId: "run-initialization-summary",
      experimentId: "baseline-initialization",
      kind: "initialization",
      stage: "handshake",
      name: "initialize MCP session",
      startedAt: "2026-08-29T20:00:00.000Z",
      endedAt: "2026-08-29T20:00:00.600Z",
      status: "completed",
    });
    const discoveryPhase = phaseV1Schema.parse({
      schema: "forge.phase/v1",
      phaseId: "baseline-initialization-initialization-2",
      runId: "run-initialization-summary",
      experimentId: "baseline-initialization",
      kind: "initialization",
      stage: "tool_discovery",
      name: "list advertised tools",
      startedAt: "2026-08-29T20:00:00.600Z",
      endedAt: "2026-08-29T20:00:01.000Z",
      status: "completed",
    });
    const cooldownPhase = phaseV1Schema.parse({
      schema: "forge.phase/v1",
      phaseId: "baseline-initialization-cooldown-3",
      runId: "run-initialization-summary",
      experimentId: "baseline-initialization",
      kind: "cooldown",
      stage: "observation_window",
      name: "observe background activity",
      startedAt: "2026-08-29T20:00:01.100Z",
      endedAt: "2026-08-29T20:00:01.600Z",
      status: "completed",
    });
    const handshakeRead = observedEventV1Schema.parse({
      schema: "forge.event/v1",
      eventId: "evt-handshake-read",
      runId: "run-initialization-summary",
      experimentId: "baseline-initialization",
      sequence: 0,
      timestamp: "2026-08-29T20:00:00.500Z",
      processRef: "run-initialization-summary:baseline-initialization:pid-10",
      effect: {
        kind: "file.read",
        path: "/sandbox/home/forge/.config/gh/hosts.yml",
        bytes: 32,
        outcome: { status: "succeeded" },
      },
      source: {
        collector: "strace",
        rawRef: "raw/baseline-initialization/strace.10:5",
      },
    });
    const discoveryOpen = observedEventV1Schema.parse({
      schema: "forge.event/v1",
      eventId: "evt-discovery-open",
      runId: "run-initialization-summary",
      experimentId: "baseline-initialization",
      sequence: 1,
      timestamp: "2026-08-29T20:00:00.800Z",
      processRef: "run-initialization-summary:baseline-initialization:pid-10",
      effect: {
        kind: "file.open",
        path: "/opt/target/tool-registry.json",
        outcome: { status: "succeeded" },
      },
      source: {
        collector: "strace",
        rawRef: "raw/baseline-initialization/strace.10:6",
      },
    });
    const cooldownWrite = observedEventV1Schema.parse({
      schema: "forge.event/v1",
      eventId: "evt-cooldown-write",
      runId: "run-initialization-summary",
      experimentId: "baseline-initialization",
      sequence: 2,
      timestamp: "2026-08-29T20:00:01.300Z",
      processRef: "run-initialization-summary:baseline-initialization:pid-10",
      effect: {
        kind: "file.write",
        path: "/sandbox/workspace/background.txt",
        bytes: 4,
        outcome: { status: "succeeded" },
      },
      source: {
        collector: "strace",
        rawRef: "raw/baseline-initialization/strace.10:7",
      },
    });
    const attribution = (
      eventId: string,
      activePhaseId: string,
    ) =>
      attributionV1Schema.parse({
        schema: "forge.attribution/v1",
        attributionId: `attr-${eventId}`,
        runId: "run-initialization-summary",
        eventId,
        activePhaseId,
        processOriginPhaseId: handshakePhase.phaseId,
        confidence:
          activePhaseId === handshakePhase.phaseId ? "high" : "medium",
        reasons: ["within_phase_bounds"],
      });

    const result = summarizeRuntimeObservations({
      config,
      events: [handshakeRead, discoveryOpen, cooldownWrite],
      phases: [handshakePhase, discoveryPhase, cooldownPhase],
      attributions: [
        attribution(handshakeRead.eventId, handshakePhase.phaseId),
        attribution(discoveryOpen.eventId, discoveryPhase.phaseId),
        attribution(cooldownWrite.eventId, cooldownPhase.phaseId),
      ],
    });

    expect(
      result.find(
        (observation) => observation.experimentId === "baseline-initialization",
      ),
    ).toEqual({
      experimentId: "baseline-initialization",
      kind: "initialization",
      effectCounts: [
        { effectKind: "file.open", count: 1 },
        { effectKind: "file.read", count: 1 },
        { effectKind: "file.write", count: 1 },
      ],
      phaseBreakdown: [
        {
          phaseId: handshakePhase.phaseId,
          name: "initialize MCP session",
          stage: "handshake",
          effectCounts: [{ effectKind: "file.read", count: 1 }],
        },
        {
          phaseId: discoveryPhase.phaseId,
          name: "list advertised tools",
          stage: "tool_discovery",
          effectCounts: [{ effectKind: "file.open", count: 1 }],
        },
        {
          phaseId: cooldownPhase.phaseId,
          name: "observe background activity",
          stage: "observation_window",
          effectCounts: [{ effectKind: "file.write", count: 1 }],
        },
      ],
    });
  });
});
