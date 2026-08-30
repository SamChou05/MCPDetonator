import { describe, expect, it } from "vitest";

import {
  attributionV1Schema,
  observedEventV1Schema,
  phaseV1Schema,
} from "../../src/contracts/v1.js";
import { compareStaticAndRuntime } from "../../src/report.js";
import { nodePackageStaticInspectionV1Schema } from "../../src/static/contracts.js";

describe("static/runtime comparison", () => {
  it("compares bounded user effects without treating bootstrap Unix sockets as network behavior", () => {
    const staticEvidence = {
      artifactPath: "raw/static/source.json",
      targetPath: "index.js",
      sha256: "a".repeat(64),
      line: 1,
      column: 1,
    };
    const staticInspection = nodePackageStaticInspectionV1Schema.parse({
      schema: "forge.node-package-static/v1",
      runId: "run-comparison",
      targetId: "generic-target",
      generatedAt: "2026-08-29T20:00:00.000Z",
      manifest: { status: "missing" },
      lockfiles: [],
      provenanceHints: [],
      source: {
        candidateFiles: 1,
        scannedFiles: [],
        skippedFiles: [],
        signals: [
          {
            signalId: "signal-filesystem",
            capability: "filesystem_access",
            patternId: "node-filesystem-module",
            summary: "Imports the Node filesystem API.",
            confidence: "high",
            evidence: staticEvidence,
            excerpt: 'import "node:fs";',
          },
          {
            signalId: "signal-network",
            capability: "network_access",
            patternId: "node-network-module",
            summary: "Imports the Node network API.",
            confidence: "high",
            evidence: { ...staticEvidence, line: 2 },
            excerpt: 'import "node:net";',
          },
        ],
      },
      limitations: [],
    });
    const toolPhase = phaseV1Schema.parse({
      schema: "forge.phase/v1",
      phaseId: "read-document-tool-1",
      runId: "run-comparison",
      experimentId: "read-document",
      kind: "tool",
      name: "call read_document",
      toolName: "read_document",
      startedAt: "2026-08-29T20:00:01.000Z",
      endedAt: "2026-08-29T20:00:02.000Z",
      status: "completed",
    });
    const eventInputs = [
      {
        id: "evt-child-start",
        sequence: 0,
        processRef: "run-comparison:read-document:pid-20",
        effect: {
          kind: "process.start" as const,
          pid: 20,
          parentProcessRef: "run-comparison:read-document:pid-10",
        },
      },
      {
        id: "evt-child-exec",
        sequence: 1,
        processRef: "run-comparison:read-document:pid-20",
        effect: {
          kind: "process.exec" as const,
          executable: "/usr/bin/helper",
          args: ["helper"],
          outcome: { status: "succeeded" as const },
        },
      },
      {
        id: "evt-workspace-read",
        sequence: 2,
        processRef: "run-comparison:read-document:pid-10",
        effect: {
          kind: "file.read" as const,
          path: "/sandbox/workspace/report.txt",
          bytes: 10,
          outcome: { status: "succeeded" as const },
        },
      },
      {
        id: "evt-bootstrap-unix",
        sequence: 3,
        processRef: "run-comparison:read-document:pid-10",
        effect: {
          kind: "network.connect_attempt" as const,
          protocol: "unix" as const,
          address: "/var/run/nscd/socket",
          outcome: { status: "failed" as const, errno: "ENOENT" },
        },
      },
    ];
    const events = eventInputs.map((input) =>
      observedEventV1Schema.parse({
        schema: "forge.event/v1",
        eventId: input.id,
        runId: "run-comparison",
        experimentId: "read-document",
        sequence: input.sequence,
        timestamp: `2026-08-29T20:00:01.${input.sequence}00Z`,
        processRef: input.processRef,
        effect: input.effect,
        source: {
          collector: "strace",
          rawRef: `raw/read-document/strace.10:${input.sequence + 1}`,
        },
      }),
    );
    const attributions = events.map((event) =>
      attributionV1Schema.parse({
        schema: "forge.attribution/v1",
        attributionId: `attr-${event.eventId}`,
        runId: "run-comparison",
        eventId: event.eventId,
        activePhaseId: toolPhase.phaseId,
        processOriginPhaseId: toolPhase.phaseId,
        confidence: "high",
        reasons: ["within_phase_bounds", "isolated_tool_run"],
      }),
    );

    const comparison = compareStaticAndRuntime({
      staticInspection,
      events,
      phases: [toolPhase],
      attributions,
      profileRootsByExperiment: new Map([
        [
          "read-document",
          { home: "/sandbox/home/forge", workspace: "/sandbox/workspace" },
        ],
      ]),
    });
    const rows = new Map(comparison.rows.map((row) => [row.capability, row]));

    expect(rows.get("filesystem_access")).toMatchObject({
      staticSignal: "found",
      runtimeObservation: "observed",
      staticSignalIds: ["signal-filesystem"],
      runtimeEventIds: ["evt-workspace-read"],
    });
    expect(rows.get("process_execution")).toMatchObject({
      staticSignal: "not_found",
      runtimeObservation: "observed",
      runtimeEventIds: ["evt-child-exec"],
    });
    expect(rows.get("network_access")).toMatchObject({
      staticSignal: "found",
      runtimeObservation: "not_observed",
      runtimeEventIds: [],
    });
    expect(rows.get("environment_access")?.runtimeObservation).toBe(
      "not_comparable",
    );
  });
});
