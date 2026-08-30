import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import type { ErrorObject, ValidateFunction } from "ajv";

import {
  mcpInterfaceV1Schema,
  mcpMessageV1Schema,
  phaseV1Schema,
  type McpInterfaceV1,
  type McpMessageV1,
  type PhaseV1,
} from "../contracts/v1.js";
import type { EvidenceStore } from "../evidence-store.js";
import { compileInputSchema } from "../mcp/input-schema.js";

export const MAX_MCP_INPUT_SCHEMA_BYTES = 256_000;
export const MAX_MCP_TOOL_ARGUMENT_BYTES = 256_000;

export interface OpenRecordedMcpSessionOptions {
  readonly runId: string;
  readonly experimentId: string;
  readonly store: EvidenceStore;
  readonly server: StdioServerParameters;
  readonly timeoutMs: number;
  /**
   * Run-relative directory for this session's interface, transcript, stderr,
   * and phase artifacts. EvidenceStore rejects absolute and escaping paths.
   */
  readonly evidencePath: string;
}

export interface RecordedMcpSession {
  readonly mcpInterface: McpInterfaceV1;
  readonly phases: readonly PhaseV1[];

  callTool(
    toolName: string,
    toolArguments: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): Promise<unknown>;
  cooldown(durationMs: number): Promise<void>;
  close(): Promise<void>;
}

type SessionState = "opening" | "open" | "closing" | "closed";

interface AdvertisedTool {
  readonly validateInput: ValidateFunction<unknown>;
}

function timestamp(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return "unknown schema validation error";
  }
  return errors
    .map(
      (error) =>
        `${error.instancePath || "input"} ${error.message ?? "is invalid"}`,
    )
    .join("; ");
}

function artifactPath(basePath: string, fileName: string): string {
  const trimmed = basePath.replace(/\/+$/u, "");
  if (trimmed.length === 0) {
    throw new Error("MCP evidence path must be a non-empty run-relative path");
  }
  return `${trimmed}/${fileName}`;
}

function cloneJson<T>(value: T, label: string): T {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} must be JSON serializable: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  if (serialized === undefined) {
    throw new Error(`${label} must be JSON serializable`);
  }

  return JSON.parse(serialized) as T;
}

function boundedArguments(
  toolName: string,
  toolArguments: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (
    typeof toolArguments !== "object" ||
    toolArguments === null ||
    Array.isArray(toolArguments)
  ) {
    throw new Error(`arguments for MCP tool '${toolName}' must be a JSON object`);
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(toolArguments);
  } catch (error) {
    throw new Error(
      `arguments for MCP tool '${toolName}' must be JSON serializable: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (Buffer.byteLength(serialized, "utf8") > MAX_MCP_TOOL_ARGUMENT_BYTES) {
    throw new Error(
      `arguments for MCP tool '${toolName}' exceed the 256 KB evaluator limit`,
    );
  }

  return JSON.parse(serialized) as Record<string, unknown>;
}

class RecordingTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;

  private recordQueue: Promise<void> = Promise.resolve();
  private recordingError: unknown;
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

    const record = this.recordQueue.then(() =>
      this.recordMessage(direction, sequence, message),
    );
    this.recordQueue = record.catch((error: unknown) => {
      this.recordingError ??= error;
    });
    return record;
  }

  public async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = <T extends JSONRPCMessage>(
      message: T,
      extra?: MessageExtraInfo,
    ) => {
      void this.enqueue("server_to_client", message).catch(() => undefined);
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

  public async flush(): Promise<void> {
    await this.recordQueue;
    if (this.recordingError !== undefined) {
      throw this.recordingError;
    }
  }

  public async close(): Promise<void> {
    await this.inner.close();
    await this.flush();
  }
}

class RecordedMcpSessionImpl implements RecordedMcpSession {
  private readonly phaseRecords: PhaseV1[] = [];
  private readonly toolsByName = new Map<string, AdvertisedTool>();
  private connected = false;
  private closePromise: Promise<void> | undefined;
  private nextPhaseNumber = 1;
  private state: SessionState = "opening";
  private discoveredInterface: McpInterfaceV1 | undefined;

  public constructor(
    private readonly options: OpenRecordedMcpSessionOptions,
    private readonly client: Client,
    private readonly stdio: StdioClientTransport,
    private readonly recording: RecordingTransport,
    private readonly stderrOutput: WriteStream,
  ) {}

  public get mcpInterface(): McpInterfaceV1 {
    if (this.discoveredInterface === undefined) {
      throw new Error("MCP session has not finished interface discovery");
    }
    return this.discoveredInterface;
  }

  public get phases(): readonly PhaseV1[] {
    return [...this.phaseRecords];
  }

  public async initialize(): Promise<void> {
    if (this.state !== "opening") {
      throw new Error("MCP session initialization can only run once");
    }

    const discovery = await this.inPhase(
      "initialization",
      "initialize and list tools",
      async () => {
        await this.client.connect(this.recording, {
          timeout: this.options.timeoutMs,
        });
        this.connected = true;

        const listedTools = await this.client.listTools(undefined, {
          timeout: this.options.timeoutMs,
        });
        const interfaceTools: McpInterfaceV1["tools"] = [];
        const validators = new Map<string, AdvertisedTool>();

        for (const tool of listedTools.tools) {
          const inputSchema = cloneJson(
            tool.inputSchema,
            `input schema for MCP tool '${tool.name}'`,
          ) as McpInterfaceV1["tools"][number]["inputSchema"];
          if (
            Buffer.byteLength(JSON.stringify(inputSchema), "utf8") >
            MAX_MCP_INPUT_SCHEMA_BYTES
          ) {
            throw new Error(
              `input schema for MCP tool '${tool.name}' exceeds the 256 KB evaluator limit`,
            );
          }

          let validateInput: ValidateFunction<unknown>;
          try {
            validateInput = compileInputSchema(inputSchema).validate;
          } catch (error) {
            throw new Error(
              `could not compile advertised input schema for MCP tool '${tool.name}': ${errorMessage(error)}`,
              { cause: error },
            );
          }
          validators.set(tool.name, { validateInput });

          interfaceTools.push({
            name: tool.name,
            ...(tool.title === undefined ? {} : { title: tool.title }),
            ...(tool.description === undefined
              ? {}
              : { description: tool.description }),
            inputSchema,
            ...(tool.annotations === undefined
              ? {}
              : {
                  annotations: cloneJson(
                    tool.annotations,
                    `annotations for MCP tool '${tool.name}'`,
                  ) as NonNullable<
                    McpInterfaceV1["tools"][number]["annotations"]
                  >,
                }),
          });
        }

        const serverVersion = this.client.getServerVersion();
        const mcpInterface = mcpInterfaceV1Schema.parse({
          schema: "forge.mcp-interface/v1",
          runId: this.options.runId,
          experimentId: this.options.experimentId,
          server: {
            name: serverVersion?.name ?? "unknown-server",
            version: serverVersion?.version ?? "unknown-version",
          },
          tools: interfaceTools,
        });

        await this.options.store.writeJson(
          artifactPath(this.options.evidencePath, "interface.json"),
          mcpInterfaceV1Schema,
          mcpInterface,
        );
        return { mcpInterface, validators };
      },
    );

    this.discoveredInterface = discovery.mcpInterface;
    for (const [toolName, advertisedTool] of discovery.validators) {
      this.toolsByName.set(toolName, advertisedTool);
    }
    this.state = "open";
  }

  public async callTool(
    toolName: string,
    toolArguments: Readonly<Record<string, unknown>>,
    timeoutMs = this.options.timeoutMs,
  ): Promise<unknown> {
    this.assertOpen();

    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("MCP tool timeout must be a positive integer");
    }

    const advertisedTool = this.toolsByName.get(toolName);
    if (advertisedTool === undefined) {
      throw new Error(`MCP did not advertise requested tool '${toolName}'`);
    }

    const argumentsCopy = boundedArguments(toolName, toolArguments);
    if (!advertisedTool.validateInput(argumentsCopy)) {
      throw new Error(
        `arguments do not match MCP tool '${toolName}' schema: ${formatAjvErrors(advertisedTool.validateInput.errors)}`,
      );
    }

    return this.inPhase(
      "tool",
      `call ${toolName}`,
      () =>
        this.client.callTool(
          { name: toolName, arguments: argumentsCopy },
          undefined,
          { timeout: Math.min(timeoutMs, this.options.timeoutMs) },
        ),
      toolName,
    );
  }

  public async cooldown(durationMs: number): Promise<void> {
    this.assertOpen();
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
      throw new Error("MCP cooldown duration must be a non-negative integer");
    }

    await this.inPhase("cooldown", "observe background activity", async () => {
      if (durationMs > 0) {
        await delay(durationMs);
      }
    });
  }

  public async close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    this.state = "closing";
    this.closePromise = this.closeResources().finally(() => {
      this.state = "closed";
    });
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.state !== "open") {
      throw new Error("MCP session is not open");
    }
  }

  private async inPhase<T>(
    kind: PhaseV1["kind"],
    name: string,
    task: () => Promise<T>,
    toolName?: string,
  ): Promise<T> {
    const phaseNumber = this.nextPhaseNumber;
    this.nextPhaseNumber += 1;
    const startedAt = timestamp();
    let result: T;

    try {
      result = await task();
      await this.recording.flush();
    } catch (error) {
      await this.recording.flush().catch(() => undefined);
      await this.recordPhase({
        kind,
        name,
        ...(toolName === undefined ? {} : { toolName }),
        phaseNumber,
        startedAt,
        status: "failed",
      });
      throw error;
    }

    await this.recordPhase({
      kind,
      name,
      ...(toolName === undefined ? {} : { toolName }),
      phaseNumber,
      startedAt,
      status: "completed",
    });
    return result;
  }

  private async recordPhase(options: {
    readonly kind: PhaseV1["kind"];
    readonly name: string;
    readonly toolName?: string;
    readonly phaseNumber: number;
    readonly startedAt: string;
    readonly status: PhaseV1["status"];
  }): Promise<void> {
    const phase = phaseV1Schema.parse({
      schema: "forge.phase/v1",
      phaseId: `${this.options.experimentId}-${options.kind}-${options.phaseNumber}`,
      runId: this.options.runId,
      experimentId: this.options.experimentId,
      kind: options.kind,
      name: options.name,
      ...(options.toolName === undefined
        ? {}
        : { toolName: options.toolName }),
      startedAt: options.startedAt,
      endedAt: timestamp(),
      status: options.status,
    });
    this.phaseRecords.push(phase);
    await this.options.store.appendJsonl(
      artifactPath(this.options.evidencePath, "phases.jsonl"),
      phaseV1Schema,
      phase,
    );
  }

  private async closeResources(): Promise<void> {
    let closeError: unknown;
    try {
      if (this.connected) {
        await this.client.close();
      } else {
        await this.recording.close();
      }
      await this.recording.flush();
    } catch (error) {
      closeError = error;
    }

    if (!this.stderrOutput.writableEnded) {
      this.stderrOutput.end();
    }
    await finished(this.stderrOutput).catch((error: unknown) => {
      closeError ??= error;
    });

    if (closeError !== undefined) {
      throw closeError;
    }
  }
}

export async function openRecordedMcpSession(
  options: OpenRecordedMcpSessionOptions,
): Promise<RecordedMcpSession> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("MCP timeout must be a positive integer");
  }

  const stderrPath = options.store.pathFor(
    artifactPath(options.evidencePath, "server-stderr.log"),
  );
  await mkdir(dirname(stderrPath), { recursive: true });

  const stdio = new StdioClientTransport({
    ...options.server,
    stderr: "pipe",
  });
  const stderrOutput = createWriteStream(stderrPath, {
    flags: "a",
    mode: 0o600,
  });
  stdio.stderr?.pipe(stderrOutput);

  const recording = new RecordingTransport(
    stdio,
    async (direction, sequence, message) => {
      const entry: McpMessageV1 = {
        schema: "forge.mcp-message/v1",
        runId: options.runId,
        experimentId: options.experimentId,
        sequence,
        timestamp: timestamp(),
        direction,
        message: cloneJson(message, "MCP JSON-RPC message") as McpMessageV1["message"],
      };
      await options.store.appendJsonl(
        artifactPath(options.evidencePath, "mcp-transcript.jsonl"),
        mcpMessageV1Schema,
        entry,
      );
    },
  );
  const client = new Client({
    name: "forge-agent-rollout",
    version: "0.1.0",
  });
  const session = new RecordedMcpSessionImpl(
    options,
    client,
    stdio,
    recording,
    stderrOutput,
  );

  try {
    await session.initialize();
    return session;
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
}
