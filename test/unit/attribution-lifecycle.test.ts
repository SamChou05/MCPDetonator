import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { attributeEvents } from "../../src/attribute.js";
import {
  observedEventV1Schema,
  phaseV1Schema,
  type ObservedEventV1,
  type PhaseV1,
} from "../../src/contracts/v1.js";
import { EvidenceStore } from "../../src/evidence-store.js";
import { runMcpExperiment } from "../../src/mcp/stdio.js";

function phase(
  value: Omit<PhaseV1, "schema" | "runId" | "experimentId" | "status">,
): PhaseV1 {
  return phaseV1Schema.parse({
    schema: "forge.phase/v1",
    runId: "run-lifecycle",
    experimentId: "echo-tool",
    status: "completed",
    ...value,
  });
}

function processEvent(options: {
  readonly eventId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly processRef: string;
  readonly effect: ObservedEventV1["effect"];
}): ObservedEventV1 {
  return observedEventV1Schema.parse({
    schema: "forge.event/v1",
    eventId: options.eventId,
    runId: "run-lifecycle",
    experimentId: "echo-tool",
    sequence: options.sequence,
    timestamp: options.timestamp,
    processRef: options.processRef,
    effect: options.effect,
    source: {
      collector: "strace",
      rawRef: `raw/echo-tool/strace.10:${options.sequence + 1}`,
    },
  });
}

describe("MCP lifecycle phases", () => {
  it("records handshake, discovery, invocation, and observation separately", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "forge-mcp-lifecycle-"));
    const store = await EvidenceStore.create(temporaryRoot, "run-lifecycle");
    await mkdir(store.pathFor("raw/echo-tool"), { recursive: true });

    const serverPath = join(temporaryRoot, "server.mjs");
    const serverModule = import.meta.resolve(
      "@modelcontextprotocol/sdk/server/index.js",
    );
    const stdioModule = import.meta.resolve(
      "@modelcontextprotocol/sdk/server/stdio.js",
    );
    const typesModule = import.meta.resolve("@modelcontextprotocol/sdk/types.js");
    await writeFile(
      serverPath,
      [
        `import { Server } from ${JSON.stringify(serverModule)};`,
        `import { StdioServerTransport } from ${JSON.stringify(stdioModule)};`,
        `import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(typesModule)};`,
        "const server = new Server(",
        "  { name: 'lifecycle-test-server', version: '1.0.0' },",
        "  { capabilities: { tools: {} } },",
        ");",
        "server.setRequestHandler(ListToolsRequestSchema, async () => ({",
        "  tools: [{",
        "    name: 'echo',",
        "    description: 'Returns the supplied text.',",
        "    inputSchema: {",
        "      type: 'object',",
        "      properties: { text: { type: 'string' } },",
        "      required: ['text'],",
        "      additionalProperties: false,",
        "    },",
        "  }],",
        "}));",
        "server.setRequestHandler(CallToolRequestSchema, async (request) => ({",
        "  content: [{ type: 'text', text: request.params.arguments.text }],",
        "}));",
        "await server.connect(new StdioServerTransport());",
      ].join("\n"),
      "utf8",
    );

    const result = await runMcpExperiment({
      runId: "run-lifecycle",
      experimentId: "echo-tool",
      store,
      server: {
        command: process.execPath,
        args: [serverPath],
        stderr: "pipe",
      },
      timeoutMs: 5_000,
      cooldownMs: 0,
      toolExperiment: {
        id: "echo-tool",
        tool: "echo",
        input: { text: "hello" },
        expected: {
          fileReads: [],
          fileReadPrefixes: [],
          fileWrites: [],
          fileWritePrefixes: [],
          networkConnections: [],
          childExecutables: [],
          childExecutablePrefixes: [],
        },
      },
    });

    expect(
      result.phases.map(({ kind, stage, name, status }) => ({
        kind,
        stage,
        name,
        status,
      })),
    ).toEqual([
      {
        kind: "initialization",
        stage: "handshake",
        name: "initialize MCP session",
        status: "completed",
      },
      {
        kind: "initialization",
        stage: "tool_discovery",
        name: "list advertised tools",
        status: "completed",
      },
      {
        kind: "tool",
        stage: "tool_invocation",
        name: "call echo",
        status: "completed",
      },
      {
        kind: "cooldown",
        stage: "observation_window",
        name: "observe background activity",
        status: "completed",
      },
    ]);

    const persistedPhases = (
      await readFile(store.pathFor("phases.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => phaseV1Schema.parse(JSON.parse(line)));
    expect(persistedPhases.map((entry) => entry.stage)).toEqual([
      "handshake",
      "tool_discovery",
      "tool_invocation",
      "observation_window",
    ]);

    const transcript = (
      await readFile(
        store.pathFor("raw/echo-tool/mcp-transcript.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message: { method?: string } });
    const clientMethods = transcript
      .map((entry) => entry.message.method)
      .filter((method): method is string => method !== undefined);
    expect(clientMethods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
  });
});

describe("lifecycle attribution", () => {
  it("identifies initialization processes observed during a tool as temporal overlap", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "forge-attribution-lifecycle-"),
    );
    const store = await EvidenceStore.create(temporaryRoot, "run-lifecycle");
    const phases = [
      phase({
        phaseId: "echo-tool-initialization-1",
        kind: "initialization",
        stage: "handshake",
        name: "initialize MCP session",
        startedAt: "2026-08-29T20:00:00.000Z",
        endedAt: "2026-08-29T20:00:01.000Z",
      }),
      phase({
        phaseId: "echo-tool-initialization-2",
        kind: "initialization",
        stage: "tool_discovery",
        name: "list advertised tools",
        startedAt: "2026-08-29T20:00:01.000Z",
        endedAt: "2026-08-29T20:00:02.000Z",
      }),
      phase({
        phaseId: "echo-tool-tool-3",
        kind: "tool",
        stage: "tool_invocation",
        name: "call echo",
        toolName: "echo",
        startedAt: "2026-08-29T20:00:03.000Z",
        endedAt: "2026-08-29T20:00:04.000Z",
      }),
    ];
    const initializationStart = processEvent({
      eventId: "evt-initialization-start",
      sequence: 0,
      timestamp: "2026-08-29T20:00:00.500Z",
      processRef: "run-lifecycle:echo-tool:pid-10",
      effect: { kind: "process.start", pid: 10 },
    });
    const toolRead = processEvent({
      eventId: "evt-tool-read",
      sequence: 2,
      timestamp: "2026-08-29T20:00:03.500Z",
      processRef: "run-lifecycle:echo-tool:pid-10",
      effect: {
        kind: "file.read",
        path: "/sandbox/workspace/input.txt",
        bytes: 5,
        outcome: { status: "succeeded" },
      },
    });

    const attributions = await attributeEvents({
      store,
      // Attribution must use evidence time, not caller-provided array order.
      events: [toolRead, initializationStart],
      phases,
      isolatedToolExperimentIds: new Set(["echo-tool"]),
    });
    const toolAttribution = attributions.find(
      (attribution) => attribution.eventId === toolRead.eventId,
    );

    expect(toolAttribution).toMatchObject({
      activePhaseId: "echo-tool-tool-3",
      processOriginPhaseId: "echo-tool-initialization-1",
      confidence: "medium",
      reasons: expect.arrayContaining([
        "within_phase_bounds",
        "isolated_tool_run",
        "process_origin_precedes_active_phase",
        "initialization_process_active_during_tool_phase",
        "tool_phase_temporal_overlap_only",
      ]),
    });
    expect(toolAttribution?.reasons).not.toContain(
      "process_origin_matches_active_phase",
    );
  });

  it("uses the later lifecycle stage at a shared millisecond boundary", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "forge-attribution-boundary-"),
    );
    const store = await EvidenceStore.create(temporaryRoot, "run-lifecycle");
    const phases = [
      phase({
        phaseId: "echo-tool-initialization-1",
        kind: "initialization",
        stage: "handshake",
        name: "initialize MCP session",
        startedAt: "2026-08-29T20:00:00.000Z",
        endedAt: "2026-08-29T20:00:01.000Z",
      }),
      phase({
        phaseId: "echo-tool-initialization-2",
        kind: "initialization",
        stage: "tool_discovery",
        name: "list advertised tools",
        startedAt: "2026-08-29T20:00:01.000Z",
        endedAt: "2026-08-29T20:00:02.000Z",
      }),
    ];
    const boundaryEvent = processEvent({
      eventId: "evt-boundary-start",
      sequence: 0,
      timestamp: "2026-08-29T20:00:01.000Z",
      processRef: "run-lifecycle:echo-tool:pid-11",
      effect: { kind: "process.start", pid: 11 },
    });

    const [attribution] = await attributeEvents({
      store,
      events: [boundaryEvent],
      phases,
      isolatedToolExperimentIds: new Set(),
    });

    expect(attribution).toMatchObject({
      activePhaseId: "echo-tool-initialization-2",
      processOriginPhaseId: "echo-tool-initialization-2",
      confidence: "high",
      reasons: expect.arrayContaining(["process_origin_matches_active_phase"]),
    });
  });

  it("does not call an unphased process origin a preceding phase", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "forge-attribution-unphased-"),
    );
    const store = await EvidenceStore.create(temporaryRoot, "run-lifecycle");
    const toolPhase = phase({
      phaseId: "echo-tool-tool-1",
      kind: "tool",
      stage: "tool_invocation",
      name: "call echo",
      toolName: "echo",
      startedAt: "2026-08-29T20:00:03.000Z",
      endedAt: "2026-08-29T20:00:04.000Z",
    });
    const processStart = processEvent({
      eventId: "evt-unphased-start",
      sequence: 0,
      timestamp: "2026-08-29T19:59:59.000Z",
      processRef: "run-lifecycle:echo-tool:pid-12",
      effect: { kind: "process.start", pid: 12 },
    });
    const toolRead = processEvent({
      eventId: "evt-unphased-tool-read",
      sequence: 1,
      timestamp: "2026-08-29T20:00:03.500Z",
      processRef: "run-lifecycle:echo-tool:pid-12",
      effect: {
        kind: "file.read",
        path: "/sandbox/workspace/input.txt",
        bytes: 5,
        outcome: { status: "succeeded" },
      },
    });

    const attributions = await attributeEvents({
      store,
      events: [processStart, toolRead],
      phases: [toolPhase],
      isolatedToolExperimentIds: new Set(["echo-tool"]),
    });
    const toolAttribution = attributions.find(
      (attribution) => attribution.eventId === toolRead.eventId,
    );

    expect(toolAttribution).toMatchObject({
      activePhaseId: "echo-tool-tool-1",
      confidence: "medium",
      reasons: expect.arrayContaining([
        "process_origin_outside_recorded_phases",
        "tool_phase_temporal_overlap_only",
      ]),
    });
    expect(toolAttribution).not.toHaveProperty("processOriginPhaseId");
    expect(toolAttribution?.reasons).not.toContain(
      "process_origin_precedes_active_phase",
    );
  });
});
