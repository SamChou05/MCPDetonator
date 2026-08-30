import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import type { ErrorObject, ValidateFunction } from "ajv";

import type { TargetConfigV1 } from "../config.js";
import {
  mcpInterfaceV1Schema,
  mcpMessageV1Schema,
  phaseV1Schema,
  type McpInterfaceV1,
  type McpMessageV1,
  type PhaseV1,
} from "../contracts/v1.js";
import type { EvidenceStore } from "../evidence-store.js";
import { compileInputSchema } from "./input-schema.js";

type ToolExperimentV1 = TargetConfigV1["experiments"]["tools"][number];

export interface McpExperimentResult {
  readonly mcpInterface: McpInterfaceV1;
  readonly phases: readonly PhaseV1[];
  readonly toolResult?: unknown;
}

class RecordingTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;

  private recordQueue: Promise<void> = Promise.resolve();
  private sequence = 0;

  public constructor(
    private readonly inner: StdioClientTransport,
    private readonly recordMessage: (
      direction: McpMessageV1["direction"],
      sequence: number,
      message: JSONRPCMessage,
    ) => Promise<void>,
  ) {}

  private enqueue(
    direction: McpMessageV1["direction"],
    message: JSONRPCMessage,
  ): Promise<void> {
    const sequence = this.sequence;
    this.sequence += 1;
    this.recordQueue = this.recordQueue.then(() =>
      this.recordMessage(direction, sequence, message),
    );
    return this.recordQueue;
  }

  public async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = <T extends JSONRPCMessage>(
      message: T,
      extra?: MessageExtraInfo,
    ) => {
      void this.enqueue("server_to_client", message);
      this.onmessage?.(message, extra);
    };
    await this.inner.start();
  }

  public async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    await this.enqueue("client_to_server", message);
    void options;
    await this.inner.send(message);
  }

  public async close(): Promise<void> {
    await this.inner.close();
    await this.recordQueue;
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return "unknown schema validation error";
  }
  return errors
    .map((error) => `${error.instancePath || "input"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

export async function runMcpExperiment(options: {
  readonly runId: string;
  readonly experimentId: string;
  readonly store: EvidenceStore;
  readonly server: StdioServerParameters;
  readonly timeoutMs: number;
  readonly cooldownMs: number;
  readonly toolExperiment?: ToolExperimentV1;
}): Promise<McpExperimentResult> {
  const {
    runId,
    experimentId,
    store,
    server,
    timeoutMs,
    cooldownMs,
    toolExperiment,
  } = options;
  const stdio = new StdioClientTransport(server);
  const stderrOutput = createWriteStream(
    store.pathFor(`raw/${experimentId}/server-stderr.log`),
    { flags: "a", mode: 0o600 },
  );
  stdio.stderr?.pipe(stderrOutput);

  const recording = new RecordingTransport(
    stdio,
    async (direction, sequence, message) => {
      const entry: McpMessageV1 = {
        schema: "forge.mcp-message/v1",
        runId,
        experimentId,
        sequence,
        timestamp: timestamp(),
        direction,
        message: JSON.parse(JSON.stringify(message)) as McpMessageV1["message"],
      };
      await store.appendJsonl(
        `raw/${experimentId}/mcp-transcript.jsonl`,
        mcpMessageV1Schema,
        entry,
      );
    },
  );
  const client = new Client({ name: "forge-mcp-detonator", version: "0.1.0" });
  const phases: PhaseV1[] = [];

  async function inPhase<T>(
    kind: PhaseV1["kind"],
    name: string,
    task: () => Promise<T>,
    toolName?: string,
  ): Promise<T> {
    const startedAt = timestamp();
    try {
      const result = await task();
      const phase: PhaseV1 = {
        schema: "forge.phase/v1",
        phaseId: `${experimentId}-${kind}-${phases.length + 1}`,
        runId,
        experimentId,
        kind,
        name,
        ...(toolName === undefined ? {} : { toolName }),
        startedAt,
        endedAt: timestamp(),
        status: "completed",
      };
      phases.push(phase);
      await store.appendJsonl("phases.jsonl", phaseV1Schema, phase);
      return result;
    } catch (error) {
      const phase: PhaseV1 = {
        schema: "forge.phase/v1",
        phaseId: `${experimentId}-${kind}-${phases.length + 1}`,
        runId,
        experimentId,
        kind,
        name,
        ...(toolName === undefined ? {} : { toolName }),
        startedAt,
        endedAt: timestamp(),
        status: "failed",
      };
      phases.push(phase);
      await store.appendJsonl("phases.jsonl", phaseV1Schema, phase);
      throw error;
    }
  }

  let connected = false;
  let mcpInterface: McpInterfaceV1 | undefined;
  let toolResult: unknown;

  try {
    const listedTools = await inPhase("initialization", "initialize and list tools", async () => {
      await client.connect(recording, { timeout: timeoutMs });
      connected = true;
      return client.listTools(undefined, { timeout: timeoutMs });
    });

    const serverVersion = client.getServerVersion();
    mcpInterface = {
      schema: "forge.mcp-interface/v1",
      runId,
      experimentId,
      server: {
        name: serverVersion?.name ?? "unknown-server",
        version: serverVersion?.version ?? "unknown-version",
      },
      tools: listedTools.tools.map((tool) => ({
        name: tool.name,
        ...(tool.title === undefined ? {} : { title: tool.title }),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: JSON.parse(
          JSON.stringify(tool.inputSchema),
        ) as McpInterfaceV1["tools"][number]["inputSchema"],
        ...(tool.annotations === undefined
          ? {}
          : {
              annotations: JSON.parse(
                JSON.stringify(tool.annotations),
              ) as NonNullable<McpInterfaceV1["tools"][number]["annotations"]>,
            }),
      })),
    };
    await store.writeJson(
      `mcp/${experimentId}/interface.json`,
      mcpInterfaceV1Schema,
      mcpInterface,
    );

    if (toolExperiment !== undefined) {
      const advertisedTool = listedTools.tools.find(
        (tool) => tool.name === toolExperiment.tool,
      );
      if (advertisedTool === undefined) {
        throw new Error(`MCP did not advertise configured tool '${toolExperiment.tool}'`);
      }

      const schemaJson = JSON.stringify(advertisedTool.inputSchema);
      if (Buffer.byteLength(schemaJson, "utf8") > 256_000) {
        throw new Error("tool input schema exceeds the 256 KB evaluator limit");
      }

      let validateInput: ValidateFunction<unknown>;
      try {
        validateInput = compileInputSchema(advertisedTool.inputSchema).validate;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `could not validate configured input for '${toolExperiment.tool}': ${message}`,
          { cause: error },
        );
      }
      if (!validateInput(toolExperiment.input)) {
        throw new Error(
          `configured input does not match '${toolExperiment.tool}' schema: ${formatAjvErrors(validateInput.errors)}`,
        );
      }

      toolResult = await inPhase(
        "tool",
        `call ${toolExperiment.tool}`,
        () =>
          client.callTool(
            { name: toolExperiment.tool, arguments: toolExperiment.input },
            undefined,
            { timeout: timeoutMs },
          ),
        toolExperiment.tool,
      );
    }

    await inPhase("cooldown", "observe background activity", async () => {
      if (cooldownMs > 0) {
        await delay(cooldownMs);
      }
    });
  } finally {
    if (connected) {
      await client.close().catch(() => undefined);
    } else {
      await recording.close().catch(() => undefined);
    }

    if (!stderrOutput.writableEnded) {
      stderrOutput.end();
    }
    await finished(stderrOutput).catch(() => undefined);
  }

  if (mcpInterface === undefined) {
    throw new Error("MCP initialization did not produce an interface");
  }

  return {
    mcpInterface,
    phases,
    ...(toolResult === undefined ? {} : { toolResult }),
  };
}
