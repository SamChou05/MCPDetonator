import { describe, expect, it } from "vitest";

import {
  compareAdvertisedStaticObservedAndApproved,
  type AdvertisedClaimReference,
  type AdvertisedClaimsByExperiment,
  type BehaviorComparisonRow,
  type ComparedBehaviorCapability,
} from "../../src/behavior-comparison.js";
import {
  targetConfigV1Schema,
  type ExpectedScopeV1,
  type InitializationExperimentV1,
  type TargetConfigV1,
} from "../../src/config.js";
import {
  attributionV1Schema,
  observedEventV1Schema,
  phaseV1Schema,
  type AttributionV1,
  type ObservedEventV1,
  type PhaseV1,
} from "../../src/contracts/v1.js";
import {
  nodePackageStaticInspectionV1Schema,
  type NodePackageStaticInspectionV1,
  type StaticCapability,
} from "../../src/static/contracts.js";

const emptyScope: ExpectedScopeV1 = {
  fileReads: [],
  fileReadPrefixes: [],
  fileWrites: [],
  fileWritePrefixes: [],
  networkConnections: [],
  childExecutables: [],
  childExecutablePrefixes: [],
};

function config(options: {
  readonly initialization: InitializationExperimentV1;
  readonly tools: readonly {
    readonly id: string;
    readonly tool: string;
    readonly expected?: ExpectedScopeV1;
  }[];
}): TargetConfigV1 {
  return targetConfigV1Schema.parse({
    schema: "forge.target/v1",
    target: {
      id: "comparison-target",
      source: { type: "fixture", path: "fixtures/comparison-target" },
      runtime: {
        transport: "stdio",
        command: "node",
        args: ["index.mjs"],
      },
    },
    sandbox: {
      profile: "developer-v1",
      network: "blocked",
      limits: {
        timeoutMs: 5_000,
        cooldownMs: 100,
        memoryMb: 256,
        cpus: 1,
        pids: 64,
      },
    },
    experiments: {
      initialization: options.initialization,
      tools: options.tools.map((tool) => ({
        id: tool.id,
        tool: tool.tool,
        input: {},
        expected: tool.expected ?? emptyScope,
      })),
      workflows: [],
    },
  });
}

function phase(options: {
  readonly phaseId: string;
  readonly experimentId: string;
  readonly kind: PhaseV1["kind"];
  readonly stage?: PhaseV1["stage"];
  readonly toolName?: string;
  readonly second: number;
}): PhaseV1 {
  return phaseV1Schema.parse({
    schema: "forge.phase/v1",
    phaseId: options.phaseId,
    runId: "run-comparison",
    experimentId: options.experimentId,
    kind: options.kind,
    ...(options.stage === undefined ? {} : { stage: options.stage }),
    name: options.phaseId,
    ...(options.toolName === undefined ? {} : { toolName: options.toolName }),
    startedAt: `2026-08-30T00:00:${String(options.second).padStart(2, "0")}.000Z`,
    endedAt: `2026-08-30T00:00:${String(options.second + 1).padStart(2, "0")}.000Z`,
    status: "completed",
  });
}

function event(options: {
  readonly eventId: string;
  readonly experimentId: string;
  readonly sequence: number;
  readonly processRef?: string;
  readonly effect: ObservedEventV1["effect"];
}): ObservedEventV1 {
  return observedEventV1Schema.parse({
    schema: "forge.event/v1",
    eventId: options.eventId,
    runId: "run-comparison",
    experimentId: options.experimentId,
    sequence: options.sequence,
    timestamp: `2026-08-30T00:01:${String(options.sequence).padStart(2, "0")}.000Z`,
    processRef:
      options.processRef ?? `run-comparison:${options.experimentId}:pid-10`,
    effect: options.effect,
    source: {
      collector: "strace",
      rawRef: `raw/${options.experimentId}/strace.10:${options.sequence + 1}`,
    },
  });
}

function attribution(
  observedEvent: ObservedEventV1,
  activePhaseId: string,
  processOriginPhaseId: string = activePhaseId,
): AttributionV1 {
  return attributionV1Schema.parse({
    schema: "forge.attribution/v1",
    attributionId: `attr-${observedEvent.eventId}`,
    runId: "run-comparison",
    eventId: observedEvent.eventId,
    activePhaseId,
    processOriginPhaseId,
    confidence: "high",
    reasons: ["within_phase_bounds", "process_origin_matches_active_phase"],
  });
}

function staticInspection(
  signals: readonly {
    readonly signalId: string;
    readonly capability: StaticCapability;
  }[] = [],
): NodePackageStaticInspectionV1 {
  return nodePackageStaticInspectionV1Schema.parse({
    schema: "forge.node-package-static/v1",
    runId: "run-comparison",
    targetId: "comparison-target",
    generatedAt: "2026-08-30T00:00:00.000Z",
    manifest: { status: "missing" },
    lockfiles: [],
    provenanceHints: [],
    source: {
      candidateFiles: 1,
      scannedFiles: [],
      skippedFiles: [],
      signals: signals.map((signal, index) => ({
        signalId: signal.signalId,
        capability: signal.capability,
        patternId: `pattern-${signal.signalId}`,
        summary: `Signal for ${signal.capability}.`,
        confidence: "high",
        evidence: {
          artifactPath: `raw/static/source-${index}.json`,
          targetPath: "index.mjs",
          sha256: String(index + 1).repeat(64).slice(0, 64),
          line: index + 1,
          column: 1,
        },
        excerpt: `signal-${index}`,
      })),
    },
    limitations: [],
  });
}

function row(
  rows: readonly BehaviorComparisonRow[],
  capability: BehaviorComparisonRow["capability"],
): BehaviorComparisonRow {
  const result = rows.find((candidate) => candidate.capability === capability);
  if (result === undefined) {
    throw new Error(`missing comparison row for ${capability}`);
  }
  return result;
}

const profileRoots = {
  home: "/sandbox/home/forge",
  workspace: "/sandbox/workspace",
};

describe("advertised/static/observed/operator-scope comparison", () => {
  it("keeps failed lifecycle attempts while excluding root exec, Unix sockets, and unrelated cooldown origins", () => {
    const targetConfig = config({
      initialization: true,
      tools: [{ id: "empty-approval", tool: "inspect" }],
    });
    const phases = [
      phase({
        phaseId: "baseline-init",
        experimentId: "baseline-initialization",
        kind: "initialization",
        stage: "handshake",
        second: 0,
      }),
      phase({
        phaseId: "baseline-cooldown",
        experimentId: "baseline-initialization",
        kind: "cooldown",
        stage: "observation_window",
        second: 2,
      }),
      phase({
        phaseId: "tool-initialization",
        experimentId: "empty-approval",
        kind: "initialization",
        stage: "handshake",
        second: 4,
      }),
      phase({
        phaseId: "tool-call",
        experimentId: "empty-approval",
        kind: "tool",
        stage: "tool_invocation",
        toolName: "inspect",
        second: 6,
      }),
      phase({
        phaseId: "tool-cooldown",
        experimentId: "empty-approval",
        kind: "cooldown",
        stage: "observation_window",
        second: 8,
      }),
    ];
    const events = [
      event({
        eventId: "evt-init-open-failed",
        experimentId: "baseline-initialization",
        sequence: 0,
        effect: {
          kind: "file.open",
          path: "/sandbox/workspace/missing.txt",
          outcome: { status: "failed", errno: "ENOENT" },
        },
      }),
      event({
        eventId: "evt-init-sibling-prefix",
        experimentId: "baseline-initialization",
        sequence: 1,
        effect: {
          kind: "file.read",
          path: "/sandbox/workspace-sibling/private.txt",
          outcome: { status: "failed", errno: "EACCES" },
        },
      }),
      event({
        eventId: "evt-init-child-start",
        experimentId: "baseline-initialization",
        sequence: 2,
        processRef: "run-comparison:baseline-initialization:pid-20",
        effect: {
          kind: "process.start",
          pid: 20,
          parentProcessRef: "run-comparison:baseline-initialization:pid-10",
        },
      }),
      event({
        eventId: "evt-init-child-exec-failed",
        experimentId: "baseline-initialization",
        sequence: 3,
        processRef: "run-comparison:baseline-initialization:pid-20",
        effect: {
          kind: "process.exec",
          executable: "/missing/helper",
          args: ["helper"],
          outcome: { status: "failed", errno: "ENOENT" },
        },
      }),
      event({
        eventId: "evt-init-root-exec-failed",
        experimentId: "baseline-initialization",
        sequence: 4,
        effect: {
          kind: "process.exec",
          executable: "/usr/bin/node",
          args: ["node", "index.mjs"],
          outcome: { status: "failed", errno: "EACCES" },
        },
      }),
      event({
        eventId: "evt-init-unix",
        experimentId: "baseline-initialization",
        sequence: 5,
        effect: {
          kind: "network.connect_attempt",
          protocol: "unix",
          address: "/var/run/nscd/socket",
          outcome: { status: "failed", errno: "ENOENT" },
        },
      }),
      event({
        eventId: "evt-init-cooldown-tcp-failed",
        experimentId: "baseline-initialization",
        sequence: 6,
        effect: {
          kind: "network.connect_attempt",
          protocol: "tcp",
          address: "203.0.113.10",
          port: 443,
          outcome: { status: "failed", errno: "ENETUNREACH" },
        },
      }),
      event({
        eventId: "evt-tool-child-start",
        experimentId: "empty-approval",
        sequence: 7,
        processRef: "run-comparison:empty-approval:pid-20",
        effect: {
          kind: "process.start",
          pid: 20,
          parentProcessRef: "run-comparison:empty-approval:pid-10",
        },
      }),
      event({
        eventId: "evt-tool-read-failed",
        experimentId: "empty-approval",
        sequence: 8,
        effect: {
          kind: "file.read",
          path: "/sandbox/home/forge/.ssh/id_ed25519",
          outcome: { status: "failed", errno: "EACCES" },
        },
      }),
      event({
        eventId: "evt-tool-network-failed",
        experimentId: "empty-approval",
        sequence: 9,
        effect: {
          kind: "network.connect_attempt",
          protocol: "tcp",
          address: "198.51.100.20",
          port: 8443,
          outcome: { status: "failed", errno: "ENETUNREACH" },
        },
      }),
      event({
        eventId: "evt-tool-exec-failed",
        experimentId: "empty-approval",
        sequence: 10,
        processRef: "run-comparison:empty-approval:pid-20",
        effect: {
          kind: "process.exec",
          executable: "/usr/bin/curl",
          args: ["curl"],
          outcome: { status: "failed", errno: "ENOENT" },
        },
      }),
      event({
        eventId: "evt-tool-cooldown-write",
        experimentId: "empty-approval",
        sequence: 11,
        effect: {
          kind: "file.write",
          path: "/sandbox/workspace/late.txt",
          bytes: 4,
          outcome: { status: "succeeded" },
        },
      }),
      event({
        eventId: "evt-tool-cooldown-init-origin-network",
        experimentId: "empty-approval",
        sequence: 12,
        effect: {
          kind: "network.connect_attempt",
          protocol: "tcp",
          address: "192.0.2.30",
          port: 443,
          outcome: { status: "failed", errno: "ENETUNREACH" },
        },
      }),
    ];
    const activePhaseByEvent = new Map<string, [string, string?]>([
      ["evt-init-open-failed", ["baseline-init"]],
      ["evt-init-sibling-prefix", ["baseline-init"]],
      ["evt-init-child-start", ["baseline-init"]],
      ["evt-init-child-exec-failed", ["baseline-init"]],
      ["evt-init-root-exec-failed", ["baseline-init"]],
      ["evt-init-unix", ["baseline-init"]],
      ["evt-init-cooldown-tcp-failed", ["baseline-cooldown", "baseline-init"]],
      ["evt-tool-child-start", ["tool-call"]],
      ["evt-tool-read-failed", ["tool-call"]],
      ["evt-tool-network-failed", ["tool-call"]],
      ["evt-tool-exec-failed", ["tool-call"]],
      ["evt-tool-cooldown-write", ["tool-cooldown", "tool-call"]],
      [
        "evt-tool-cooldown-init-origin-network",
        ["tool-cooldown", "tool-initialization"],
      ],
    ]);
    const attributions = events.map((observedEvent) => {
      const selection = activePhaseByEvent.get(observedEvent.eventId);
      if (selection === undefined) {
        throw new Error(`missing test phase for ${observedEvent.eventId}`);
      }
      return attribution(observedEvent, selection[0], selection[1]);
    });
    const claims: AdvertisedClaimsByExperiment = new Map([
      [
        "empty-approval",
        new Map<
          ComparedBehaviorCapability,
          readonly AdvertisedClaimReference[]
        >([
          [
            "filesystem_access",
            [
              { evidenceId: "claim-z", fieldReference: "description" },
              { evidenceId: "claim-a", fieldReference: "inputSchema.path" },
            ],
          ],
        ]),
      ],
    ]);
    const comparison = compareAdvertisedStaticObservedAndApproved({
      config: targetConfig,
      advertisedClaimsByExperiment: claims,
      staticInspection: staticInspection([
        { signalId: "signal-process", capability: "process_execution" },
      ]),
      events,
      phases,
      attributions,
      profileRootsByExperiment: new Map([
        ["baseline-initialization", profileRoots],
        ["empty-approval", profileRoots],
      ]),
    });

    expect(comparison.scopes.map((scope) => scope.experimentId)).toEqual([
      "baseline-initialization",
      "empty-approval",
    ]);
    const initializationRows = comparison.scopes[0]?.rows ?? [];
    expect(row(initializationRows, "filesystem_access")).toMatchObject({
      advertisedState: "not_applicable",
      runtimeEventIds: ["evt-init-open-failed"],
      operatorScopeState: "not_configured",
      withinOperatorScopeEventIds: [],
      outsideOperatorScopeEventIds: [],
      unclassifiedRuntimeEventIds: ["evt-init-open-failed"],
    });
    expect(row(initializationRows, "process_execution")).toMatchObject({
      staticState: "found",
      runtimeEventIds: ["evt-init-child-exec-failed"],
      unclassifiedRuntimeEventIds: ["evt-init-child-exec-failed"],
    });
    expect(row(initializationRows, "network_access")).toMatchObject({
      runtimeEventIds: ["evt-init-cooldown-tcp-failed"],
    });

    const toolRows = comparison.scopes[1]?.rows ?? [];
    expect(row(toolRows, "filesystem_access")).toMatchObject({
      advertisedState: "claimed",
      advertisedClaimReferences: [
        { evidenceId: "claim-a", fieldReference: "inputSchema.path" },
        { evidenceId: "claim-z", fieldReference: "description" },
      ],
      runtimeEventIds: ["evt-tool-cooldown-write", "evt-tool-read-failed"],
      operatorScopeState: "configured",
      withinOperatorScopeEventIds: [],
      outsideOperatorScopeEventIds: [
        "evt-tool-cooldown-write",
        "evt-tool-read-failed",
      ],
      unclassifiedRuntimeEventIds: [],
    });
    expect(row(toolRows, "network_access")).toMatchObject({
      advertisedState: "not_claimed",
      runtimeEventIds: ["evt-tool-network-failed"],
      outsideOperatorScopeEventIds: ["evt-tool-network-failed"],
    });
    expect(row(toolRows, "process_execution")).toMatchObject({
      runtimeEventIds: ["evt-tool-exec-failed"],
      outsideOperatorScopeEventIds: ["evt-tool-exec-failed"],
    });
    expect(row(toolRows, "network_access").interpretation).toContain(
      "does not grant or deny authorization",
    );
  });

  it("distinguishes an unavailable claim assessment from an observed assessment with no claim", () => {
    const targetConfig = config({
      initialization: false,
      tools: [
        { id: "observed-interface", tool: "observed" },
        { id: "unobserved-interface", tool: "unobserved" },
      ],
    });
    const comparison = compareAdvertisedStaticObservedAndApproved({
      config: targetConfig,
      advertisedClaimsByExperiment: new Map([
        [
          "observed-interface",
          new Map<
            ComparedBehaviorCapability,
            readonly AdvertisedClaimReference[]
          >(),
        ],
      ]),
      staticInspection: staticInspection(),
      events: [],
      phases: [],
      attributions: [],
      profileRootsByExperiment: new Map([
        ["observed-interface", profileRoots],
        ["unobserved-interface", profileRoots],
      ]),
    });

    const observedRows =
      comparison.scopes.find(
        (scope) => scope.experimentId === "observed-interface",
      )?.rows ?? [];
    const unobservedRows =
      comparison.scopes.find(
        (scope) => scope.experimentId === "unobserved-interface",
      )?.rows ?? [];
    expect(observedRows.map((candidate) => candidate.advertisedState)).toEqual([
      "not_claimed",
      "not_claimed",
      "not_claimed",
    ]);
    expect(unobservedRows.map((candidate) => candidate.advertisedState)).toEqual([
      "not_observed",
      "not_observed",
      "not_observed",
    ]);
    expect(unobservedRows[0]?.interpretation).toContain(
      "No bounded MCP claim assessment was available",
    );
  });

  it("does not borrow child-process identity from another experiment", () => {
    const targetConfig = config({
      initialization: false,
      tools: [
        { id: "child-source", tool: "source" },
        { id: "root-exec", tool: "destination" },
      ],
    });
    const sourcePhase = phase({
      phaseId: "source-call",
      experimentId: "child-source",
      kind: "tool",
      toolName: "source",
      second: 0,
    });
    const destinationPhase = phase({
      phaseId: "destination-call",
      experimentId: "root-exec",
      kind: "tool",
      toolName: "destination",
      second: 2,
    });
    const sourceChild = event({
      eventId: "evt-source-child",
      experimentId: "child-source",
      sequence: 0,
      processRef: "shared-process-ref",
      effect: {
        kind: "process.start",
        pid: 20,
        parentProcessRef: "source-root-ref",
      },
    });
    const destinationRootExec = event({
      eventId: "evt-destination-root-exec",
      experimentId: "root-exec",
      sequence: 0,
      processRef: "shared-process-ref",
      effect: {
        kind: "process.exec",
        executable: "/usr/bin/node",
        args: ["node", "index.mjs"],
        outcome: { status: "succeeded" },
      },
    });
    const comparison = compareAdvertisedStaticObservedAndApproved({
      config: targetConfig,
      advertisedClaimsByExperiment: new Map([
        ["child-source", new Map()],
        ["root-exec", new Map()],
      ]),
      staticInspection: staticInspection(),
      events: [sourceChild, destinationRootExec],
      phases: [sourcePhase, destinationPhase],
      attributions: [
        attribution(sourceChild, sourcePhase.phaseId),
        attribution(destinationRootExec, destinationPhase.phaseId),
      ],
      profileRootsByExperiment: new Map([
        ["child-source", profileRoots],
        ["root-exec", profileRoots],
      ]),
    });

    const destinationRows =
      comparison.scopes.find((scope) => scope.experimentId === "root-exec")
        ?.rows ?? [];
    expect(row(destinationRows, "process_execution")).toMatchObject({
      runtimeState: "not_observed",
      runtimeEventIds: [],
      outsideOperatorScopeEventIds: [],
    });
  });

  it("partitions configured scope with boundary-safe path, destination, executable, open, and delete semantics", () => {
    const targetConfig = config({
      initialization: { expected: emptyScope },
      tools: [
        {
          id: "bounded-tool",
          tool: "bounded",
          expected: {
            fileReads: [],
            fileReadPrefixes: ["/sandbox/workspace/allowed"],
            fileWrites: ["/sandbox/workspace/remove.txt"],
            fileWritePrefixes: [],
            networkConnections: [{ address: "203.0.113.40", port: 443 }],
            childExecutables: [],
            childExecutablePrefixes: ["/opt/helpers"],
          },
        },
      ],
    });
    const phases = [
      phase({
        phaseId: "baseline-init",
        experimentId: "baseline-initialization",
        kind: "initialization",
        second: 0,
      }),
      phase({
        phaseId: "bounded-call",
        experimentId: "bounded-tool",
        kind: "tool",
        toolName: "bounded",
        second: 2,
      }),
    ];
    const effects: readonly [string, ObservedEventV1["effect"], string?][] = [
      [
        "evt-open-within",
        {
          kind: "file.open",
          path: "/sandbox/workspace/allowed/document.txt",
          outcome: { status: "failed", errno: "ENOENT" },
        },
      ],
      [
        "evt-read-prefix-escape",
        {
          kind: "file.read",
          path: "/sandbox/workspace/allowed-sibling/document.txt",
          outcome: { status: "failed", errno: "EACCES" },
        },
      ],
      [
        "evt-read-parent-escape",
        {
          kind: "file.read",
          path: "/sandbox/workspace/allowed/../outside.txt",
          outcome: { status: "failed", errno: "EACCES" },
        },
      ],
      [
        "evt-read-canonical-within",
        {
          kind: "file.read",
          path: "/sandbox//workspace/allowed/./document.txt",
          outcome: { status: "failed", errno: "ENOENT" },
        },
      ],
      [
        "evt-directory-enumeration",
        {
          kind: "file.read",
          path: "/sandbox/workspace/allowed",
          operation: "directory_entries",
          outcome: { status: "succeeded" },
        },
      ],
      [
        "evt-delete-write-scope",
        {
          kind: "file.delete",
          path: "/sandbox/workspace/remove.txt",
          outcome: { status: "failed", errno: "EPERM" },
        },
      ],
      [
        "evt-network-within",
        {
          kind: "network.connect_attempt",
          protocol: "tcp",
          address: "203.0.113.40",
          port: 443,
          outcome: { status: "failed", errno: "ENETUNREACH" },
        },
      ],
      [
        "evt-network-port-outside",
        {
          kind: "network.connect_attempt",
          protocol: "tcp",
          address: "203.0.113.40",
          port: 80,
          outcome: { status: "failed", errno: "ENETUNREACH" },
        },
      ],
      [
        "evt-listen-outside",
        {
          kind: "network.listen",
          protocol: "tcp",
          address: "203.0.113.40",
          port: 443,
          outcome: { status: "succeeded" },
        },
      ],
      [
        "evt-exec-within",
        {
          kind: "process.exec",
          executable: "/opt/helpers/convert",
          args: ["convert"],
          outcome: { status: "failed", errno: "ENOENT" },
        },
        "run-comparison:bounded-tool:pid-20",
      ],
      [
        "evt-exec-prefix-escape",
        {
          kind: "process.exec",
          executable: "/opt/helpers-malicious/convert",
          args: ["convert"],
          outcome: { status: "failed", errno: "ENOENT" },
        },
        "run-comparison:bounded-tool:pid-21",
      ],
      [
        "evt-exec-parent-escape",
        {
          kind: "process.exec",
          executable: "/opt/helpers/../evil",
          args: ["evil"],
          outcome: { status: "failed", errno: "ENOENT" },
        },
        "run-comparison:bounded-tool:pid-22",
      ],
      [
        "evt-exec-canonical-within",
        {
          kind: "process.exec",
          executable: "/opt//helpers/./convert",
          args: ["convert"],
          outcome: { status: "failed", errno: "ENOENT" },
        },
        "run-comparison:bounded-tool:pid-23",
      ],
    ];
    const baselineEvent = event({
      eventId: "evt-baseline-empty-scope",
      experimentId: "baseline-initialization",
      sequence: 0,
      effect: {
        kind: "file.read",
        path: "/sandbox/workspace/baseline.txt",
        outcome: { status: "failed", errno: "ENOENT" },
      },
    });
    const childStarts = [20, 21, 22, 23].map((pid, index) =>
      event({
        eventId: `evt-child-${pid}`,
        experimentId: "bounded-tool",
        sequence: index + 1,
        processRef: `run-comparison:bounded-tool:pid-${pid}`,
        effect: {
          kind: "process.start",
          pid,
          parentProcessRef: "run-comparison:bounded-tool:pid-10",
        },
      }),
    );
    const toolEvents = effects.map(([eventId, effect, processRef], index) =>
      event({
        eventId,
        experimentId: "bounded-tool",
        sequence: index + 5,
        ...(processRef === undefined ? {} : { processRef }),
        effect,
      }),
    );
    const events = [baselineEvent, ...childStarts, ...toolEvents];
    const attributions = [
      attribution(baselineEvent, "baseline-init"),
      ...childStarts.map((child) => attribution(child, "bounded-call")),
      ...toolEvents.map((toolEvent) => attribution(toolEvent, "bounded-call")),
    ];
    const comparison = compareAdvertisedStaticObservedAndApproved({
      config: targetConfig,
      advertisedClaimsByExperiment: new Map(),
      staticInspection: staticInspection(),
      events,
      phases,
      attributions,
      profileRootsByExperiment: new Map([
        ["baseline-initialization", profileRoots],
        ["bounded-tool", profileRoots],
      ]),
    });

    const initializationFilesystem = row(
      comparison.scopes[0]?.rows ?? [],
      "filesystem_access",
    );
    expect(initializationFilesystem).toMatchObject({
      operatorScopeState: "configured",
      withinOperatorScopeEventIds: [],
      outsideOperatorScopeEventIds: ["evt-baseline-empty-scope"],
      unclassifiedRuntimeEventIds: [],
    });

    const rows = comparison.scopes[1]?.rows ?? [];
    expect(row(rows, "filesystem_access")).toMatchObject({
      withinOperatorScopeEventIds: [
        "evt-delete-write-scope",
        "evt-open-within",
        "evt-read-canonical-within",
      ],
      outsideOperatorScopeEventIds: [
        "evt-read-parent-escape",
        "evt-read-prefix-escape",
      ],
    });
    expect(row(rows, "filesystem_access").runtimeEventIds).not.toContain(
      "evt-directory-enumeration",
    );
    expect(row(rows, "network_access")).toMatchObject({
      withinOperatorScopeEventIds: ["evt-network-within"],
      outsideOperatorScopeEventIds: [
        "evt-listen-outside",
        "evt-network-port-outside",
      ],
    });
    expect(row(rows, "process_execution")).toMatchObject({
      withinOperatorScopeEventIds: [
        "evt-exec-canonical-within",
        "evt-exec-within",
      ],
      outsideOperatorScopeEventIds: [
        "evt-exec-parent-escape",
        "evt-exec-prefix-escape",
      ],
    });
    expect(comparison.limitations).toContain(
      "A file.delete event is evaluated against configured write scope because the current operator scope has no separate delete permission.",
    );
    expect(comparison.limitations).toContain(
      "Directory enumeration is retained in canonical events and observation health, but it is not treated as file-content evidence in this comparison.",
    );
  });

  it("orders scopes, capabilities, claim references, static signals, and runtime IDs independently of input order", () => {
    const configForward = config({
      initialization: false,
      tools: [
        { id: "z-tool", tool: "zeta" },
        { id: "a-tool", tool: "alpha" },
      ],
    });
    const configReverse = config({
      initialization: false,
      tools: [
        { id: "a-tool", tool: "alpha" },
        { id: "z-tool", tool: "zeta" },
      ],
    });
    const phases = [
      phase({
        phaseId: "z-call",
        experimentId: "z-tool",
        kind: "tool",
        toolName: "zeta",
        second: 0,
      }),
      phase({
        phaseId: "a-call",
        experimentId: "a-tool",
        kind: "tool",
        toolName: "alpha",
        second: 2,
      }),
    ];
    const events = [
      event({
        eventId: "evt-z",
        experimentId: "z-tool",
        sequence: 0,
        effect: {
          kind: "file.read",
          path: "/sandbox/workspace/z.txt",
          outcome: { status: "succeeded" },
        },
      }),
      event({
        eventId: "evt-b",
        experimentId: "a-tool",
        sequence: 1,
        effect: {
          kind: "file.read",
          path: "/sandbox/workspace/b.txt",
          outcome: { status: "succeeded" },
        },
      }),
      event({
        eventId: "evt-a",
        experimentId: "a-tool",
        sequence: 2,
        effect: {
          kind: "file.read",
          path: "/sandbox/workspace/a.txt",
          outcome: { status: "succeeded" },
        },
      }),
      event({
        eventId: "evt-ä",
        experimentId: "a-tool",
        sequence: 3,
        effect: {
          kind: "file.read",
          path: "/sandbox/workspace/ä.txt",
          outcome: { status: "succeeded" },
        },
      }),
    ];
    const activePhase = new Map([
      ["evt-z", "z-call"],
      ["evt-b", "a-call"],
      ["evt-a", "a-call"],
      ["evt-ä", "a-call"],
    ]);
    const attributions = events.map((observedEvent) =>
      attribution(observedEvent, activePhase.get(observedEvent.eventId)!),
    );
    const forwardClaims: AdvertisedClaimsByExperiment = new Map([
      [
        "a-tool",
        new Map<
          ComparedBehaviorCapability,
          readonly AdvertisedClaimReference[]
        >([
          [
            "filesystem_access",
            [
              { evidenceId: "claim-z", fieldReference: "description" },
              { evidenceId: "claim-a", fieldReference: "inputSchema.path" },
              { evidenceId: "claim-a", fieldReference: "inputSchema.path" },
              { evidenceId: "claim-ä", fieldReference: "title" },
            ],
          ],
        ]),
      ],
      [
        "z-tool",
        new Map<
          ComparedBehaviorCapability,
          readonly AdvertisedClaimReference[]
        >([
          [
            "network_access",
            [{ evidenceId: "claim-network", fieldReference: "name" }],
          ],
        ]),
      ],
    ]);
    const reverseClaims: AdvertisedClaimsByExperiment = new Map([
      [...forwardClaims.entries()][1]!,
      [
        "a-tool",
        new Map<
          ComparedBehaviorCapability,
          readonly AdvertisedClaimReference[]
        >([
          [
            "filesystem_access",
            [
              { evidenceId: "claim-a", fieldReference: "inputSchema.path" },
              { evidenceId: "claim-z", fieldReference: "description" },
              { evidenceId: "claim-ä", fieldReference: "title" },
            ],
          ],
        ]),
      ],
    ]);
    const signals = [
      { signalId: "signal-z", capability: "network_access" as const },
      { signalId: "signal-a", capability: "network_access" as const },
      { signalId: "signal-ä", capability: "network_access" as const },
    ];
    const rootsByExperiment = new Map([
      ["z-tool", profileRoots],
      ["a-tool", profileRoots],
    ]);

    const forward = compareAdvertisedStaticObservedAndApproved({
      config: configForward,
      advertisedClaimsByExperiment: forwardClaims,
      staticInspection: staticInspection(signals),
      events,
      phases,
      attributions,
      profileRootsByExperiment: rootsByExperiment,
    });
    const reverse = compareAdvertisedStaticObservedAndApproved({
      config: configReverse,
      advertisedClaimsByExperiment: reverseClaims,
      staticInspection: staticInspection([...signals].reverse()),
      events: [...events].reverse(),
      phases: [...phases].reverse(),
      attributions: [...attributions].reverse(),
      profileRootsByExperiment: new Map([...rootsByExperiment].reverse()),
    });

    expect(reverse).toEqual(forward);
    expect(forward.scopes.map((scope) => scope.experimentId)).toEqual([
      "a-tool",
      "z-tool",
    ]);
    expect(forward.scopes[0]?.rows.map((candidate) => candidate.capability)).toEqual([
      "filesystem_access",
      "network_access",
      "process_execution",
    ]);
    expect(row(forward.scopes[0]?.rows ?? [], "filesystem_access")).toMatchObject({
      advertisedClaimReferences: [
        { evidenceId: "claim-a", fieldReference: "inputSchema.path" },
        { evidenceId: "claim-z", fieldReference: "description" },
        { evidenceId: "claim-ä", fieldReference: "title" },
      ],
      runtimeEventIds: ["evt-a", "evt-b", "evt-ä"],
    });
    expect(row(forward.scopes[0]?.rows ?? [], "network_access")).toMatchObject({
      staticSignalIds: ["signal-a", "signal-z", "signal-ä"],
    });
    expect(
      row(forward.scopes[0]?.rows ?? [], "network_access").interpretation,
    ).toContain("selected non-observation is not proof of absence");
  });

  it("retains initialization-origin tool-phase events while qualifying temporal overlap", () => {
    const targetConfig = config({
      initialization: false,
      tools: [{ id: "overlap-tool", tool: "inspect" }],
    });
    const initializationPhase = phase({
      phaseId: "overlap-initialization",
      experimentId: "overlap-tool",
      kind: "initialization",
      stage: "handshake",
      second: 0,
    });
    const toolPhase = phase({
      phaseId: "overlap-call",
      experimentId: "overlap-tool",
      kind: "tool",
      stage: "tool_invocation",
      toolName: "inspect",
      second: 2,
    });
    const overlapEvent = event({
      eventId: "evt-initialization-origin-overlap",
      experimentId: "overlap-tool",
      sequence: 0,
      processRef: "run-comparison:overlap-tool:pid-10",
      effect: {
        kind: "file.read",
        path: "/sandbox/workspace/background.txt",
        outcome: { status: "succeeded" },
      },
    });
    const inferredOverlapEvent = event({
      eventId: "evt-origin-mismatch-fallback",
      experimentId: "overlap-tool",
      sequence: 1,
      processRef: "run-comparison:overlap-tool:pid-11",
      effect: {
        kind: "file.read",
        path: "/sandbox/workspace/legacy-background.txt",
        outcome: { status: "succeeded" },
      },
    });
    const toolOriginEvent = event({
      eventId: "evt-tool-origin",
      experimentId: "overlap-tool",
      sequence: 2,
      processRef: "run-comparison:overlap-tool:pid-20",
      effect: {
        kind: "file.read",
        path: "/sandbox/workspace/tool.txt",
        outcome: { status: "succeeded" },
      },
    });
    const overlapAttribution = attributionV1Schema.parse({
      schema: "forge.attribution/v1",
      attributionId: "attr-overlap",
      runId: "run-comparison",
      eventId: overlapEvent.eventId,
      activePhaseId: toolPhase.phaseId,
      processOriginPhaseId: initializationPhase.phaseId,
      confidence: "medium",
      reasons: [
        "within_phase_bounds",
        "isolated_tool_run",
        "process_origin_precedes_active_phase",
        "initialization_process_active_during_tool_phase",
        "tool_phase_temporal_overlap_only",
      ],
    });
    const inferredOverlapAttribution = attributionV1Schema.parse({
      schema: "forge.attribution/v1",
      attributionId: "attr-inferred-overlap",
      runId: "run-comparison",
      eventId: inferredOverlapEvent.eventId,
      activePhaseId: toolPhase.phaseId,
      processOriginPhaseId: initializationPhase.phaseId,
      confidence: "medium",
      reasons: ["within_phase_bounds", "process_origin_precedes_active_phase"],
    });
    const comparison = compareAdvertisedStaticObservedAndApproved({
      config: targetConfig,
      advertisedClaimsByExperiment: new Map(),
      staticInspection: staticInspection(),
      events: [overlapEvent, inferredOverlapEvent, toolOriginEvent],
      phases: [initializationPhase, toolPhase],
      attributions: [
        overlapAttribution,
        inferredOverlapAttribution,
        attribution(toolOriginEvent, toolPhase.phaseId),
      ],
      profileRootsByExperiment: new Map([["overlap-tool", profileRoots]]),
    });

    const filesystem = row(
      comparison.scopes[0]?.rows ?? [],
      "filesystem_access",
    );
    expect(filesystem).toMatchObject({
      runtimeState: "observed",
      runtimeEventIds: [
        "evt-initialization-origin-overlap",
        "evt-origin-mismatch-fallback",
        "evt-tool-origin",
      ],
      correlationBasis: "phase_timing_and_process_origin_inference",
      temporalOverlapEventIds: [
        "evt-initialization-origin-overlap",
        "evt-origin-mismatch-fallback",
      ],
      outsideOperatorScopeEventIds: [
        "evt-initialization-origin-overlap",
        "evt-origin-mismatch-fallback",
        "evt-tool-origin",
      ],
    });
    expect(filesystem.interpretation).toContain(
      "2 tool-phase events are marked as temporal overlap only",
    );
    expect(comparison.limitations).toContain(
      "Runtime correlation uses phase timing and inferred process origin; temporalOverlapEventIds retain active tool-phase observations that are not unique causal attribution to the tool handler.",
    );
    for (const candidate of comparison.scopes[0]?.rows ?? []) {
      expect(candidate.correlationBasis).toBe(
        "phase_timing_and_process_origin_inference",
      );
    }
  });
});
