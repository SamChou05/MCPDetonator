import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
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
import {
  mcpInterfaceV1Schema,
  mcpMessageV1Schema,
  phaseV1Schema,
  type McpInterfaceV1,
  type McpMessageV1,
  type PhaseV1,
} from "../contracts/v1.js";
import type { EvidenceStore } from "../evidence-store.js";

export const MAX_MCP_INPUT_SCHEMA_BYTES = 256_000;
export const MAX_MCP_TOOL_ARGUMENT_BYTES = 256_000;
export const MAX_MCP_TOOL_CATALOG_BYTES = 512_000;
export const MAX_MCP_TOOL_COUNT = 128;
export const MAX_MCP_TRANSCRIPT_MESSAGES = 256;
export const MAX_MCP_TRANSCRIPT_BYTES = 2_000_000;
export const MAX_MCP_STDERR_BYTES = 256_000;
export const MAX_MCP_CLOSE_MS = 5_000;

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

/** Initialization failed and the partially opened MCP process could not be closed. */
export class McpSessionInitializationCleanupError extends Error {
  public constructor(
    public readonly initializationError: unknown,
    public readonly cleanupError: unknown,
  ) {
    super("MCP session initialization failed and its cleanup could not be verified", {
      cause: new AggregateError(
        [initializationError, cleanupError],
        "MCP initialization and cleanup both failed",
      ),
    });
    this.name = "McpSessionInitializationCleanupError";
  }
}

/** Close a partially initialized session without hiding a close failure. */
export async function closeFailedMcpSession(
  session: Pick<RecordedMcpSession, "close">,
  initializationError: unknown,
): Promise<never> {
  try {
    await session.close();
  } catch (cleanupError) {
    throw new McpSessionInitializationCleanupError(
      initializationError,
      cleanupError,
    );
  }
  throw initializationError;
}

type SessionState = "opening" | "open" | "closing" | "closed";

function timestamp(): string {
  return new Date().toISOString();
}

async function closeWithinDeadline<T>(operation: Promise<T>): Promise<T> {
  const controller = new AbortController();
  try {
    return await Promise.race([
      operation,
      delay(MAX_MCP_CLOSE_MS, undefined, { signal: controller.signal }).then(
        () => {
          throw new Error(
            `MCP session close timed out after ${MAX_MCP_CLOSE_MS} ms`,
          );
        },
      ),
    ]);
  } finally {
    controller.abort();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  private abortPromise: Promise<void> | undefined;
  private terminalError: Error | undefined;
  private closeRequested = false;
  private acceptedMessageCount = 0;
  private acceptedMessageBytes = 0;
  private sequence = 0;

  public constructor(
    private readonly inner: StdioClientTransport,
    private readonly recordMessage: (
      direction: McpMessageV1["direction"],
      sequence: number,
      message: JSONRPCMessage,
    ) => Promise<void>,
  ) {}

  public get failure(): Error | undefined {
    return this.terminalError;
  }

  private enqueue(
    direction: McpMessageV1["direction"],
    message: JSONRPCMessage,
  ): Promise<void> {
    if (this.terminalError !== undefined) {
      throw this.terminalError;
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(message);
    } catch (error) {
      const failure = new Error(
        `MCP JSON-RPC message must be JSON serializable: ${errorMessage(error)}`,
        { cause: error },
      );
      this.abort(failure);
      throw failure;
    }
    // Include the STDIO record delimiter so accounting matches wire payloads.
    const messageBytes = Buffer.byteLength(serialized, "utf8") + 1;
    if (this.acceptedMessageCount + 1 > MAX_MCP_TRANSCRIPT_MESSAGES) {
      const failure = new Error(
        `MCP transcript exceeded the ${MAX_MCP_TRANSCRIPT_MESSAGES}-message evaluator limit`,
      );
      this.abort(failure);
      throw failure;
    }
    if (this.acceptedMessageBytes + messageBytes > MAX_MCP_TRANSCRIPT_BYTES) {
      const failure = new Error(
        `MCP transcript exceeded the ${MAX_MCP_TRANSCRIPT_BYTES}-byte evaluator limit`,
      );
      this.abort(failure);
      throw failure;
    }

    const messageCopy = JSON.parse(serialized) as JSONRPCMessage;
    this.acceptedMessageCount += 1;
    this.acceptedMessageBytes += messageBytes;
    const sequence = this.sequence;
    this.sequence += 1;

    const record = this.recordQueue.then(() =>
      this.recordMessage(direction, sequence, messageCopy),
    );
    this.recordQueue = record.catch((error: unknown) => {
      this.abort(error);
    });
    return record;
  }

  public abort(error: unknown): void {
    if (this.terminalError !== undefined) {
      return;
    }

    const failure =
      error instanceof Error
        ? error
        : new Error(`MCP transport failed: ${String(error)}`);
    this.terminalError = failure;
    this.recordingError = failure;
    try {
      this.onerror?.(failure);
    } catch {
      // The terminal transport error is retained and surfaced by flush/close.
    }
    this.abortPromise = this.inner.close().catch((closeError: unknown) => {
      this.recordingError ??= closeError;
    });
  }

  public async start(): Promise<void> {
    this.inner.onclose = () => {
      if (!this.closeRequested && this.terminalError === undefined) {
        const failure = new Error(
          "MCP transport closed unexpectedly before controller cleanup",
        );
        this.terminalError = failure;
        this.recordingError = failure;
        try {
          this.onerror?.(failure);
        } catch {
          // The failure remains available through flush/close.
        }
      }
      this.onclose?.();
    };
    this.inner.onerror = (error) => this.abort(error);
    this.inner.onmessage = <T extends JSONRPCMessage>(
      message: T,
      extra?: MessageExtraInfo,
    ) => {
      try {
        void this.enqueue("server_to_client", message).catch(() => undefined);
        this.onmessage?.(message, extra);
      } catch (error) {
        this.abort(error);
      }
    };
    await this.inner.start();
  }

  public async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    try {
      await this.enqueue("client_to_server", message);
      void options;
      await this.inner.send(message);
    } catch (error) {
      this.abort(error);
      throw error;
    }
  }

  public async flush(): Promise<void> {
    await this.recordQueue;
    if (this.recordingError !== undefined) {
      throw this.recordingError;
    }
  }

  public async close(): Promise<void> {
    this.closeRequested = true;
    if (this.abortPromise === undefined) {
      await this.inner.close();
    } else {
      await this.abortPromise;
    }
    await this.flush();
  }
}

class BoundedStderrTransform extends Transform {
  private capturedBytes = 0;
  private quotaExceeded = false;

  public constructor(private readonly onQuotaExceeded: (error: Error) => void) {
    super();
  }

  public override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (this.quotaExceeded) {
      callback();
      return;
    }

    const remainingBytes = MAX_MCP_STDERR_BYTES - this.capturedBytes;
    if (bytes.byteLength <= remainingBytes) {
      this.capturedBytes += bytes.byteLength;
      callback(null, bytes);
      return;
    }

    if (remainingBytes > 0) {
      this.push(bytes.subarray(0, remainingBytes));
      this.capturedBytes += remainingBytes;
    }
    this.quotaExceeded = true;
    this.onQuotaExceeded(
      new Error(
        `MCP stderr exceeded the ${MAX_MCP_STDERR_BYTES}-byte evaluator limit`,
      ),
    );
    callback();
  }
}

class RecordedMcpSessionImpl implements RecordedMcpSession {
  private readonly phaseRecords: PhaseV1[] = [];
  private readonly advertisedToolNames = new Set<string>();
  private connected = false;
  private closePromise: Promise<void> | undefined;
  private nextPhaseNumber = 1;
  private state: SessionState = "opening";
  private discoveredInterface: McpInterfaceV1 | undefined;
  private observedTransportFailure: Error | undefined;

  public constructor(
    private readonly options: OpenRecordedMcpSessionOptions,
    private readonly client: Client,
    private readonly stdio: StdioClientTransport,
    private readonly recording: RecordingTransport,
    private readonly stderrCapture: BoundedStderrTransform,
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
        if (listedTools.tools.length > MAX_MCP_TOOL_COUNT) {
          throw new Error(
            `MCP advertised ${listedTools.tools.length} tools, exceeding the ${MAX_MCP_TOOL_COUNT}-tool evaluator limit`,
          );
        }
        const serializedCatalog = JSON.stringify(listedTools.tools);
        if (
          Buffer.byteLength(serializedCatalog, "utf8") >
          MAX_MCP_TOOL_CATALOG_BYTES
        ) {
          throw new Error(
            "advertised MCP tool catalog exceeds the 512 KB evaluator limit",
          );
        }

        const interfaceTools: McpInterfaceV1["tools"] = [];
        const toolNames = new Set<string>();

        for (const tool of listedTools.tools) {
          if (toolNames.has(tool.name)) {
            throw new Error(`MCP advertised duplicate tool name '${tool.name}'`);
          }
          toolNames.add(tool.name);

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
        return { mcpInterface, toolNames };
      },
    );

    this.discoveredInterface = discovery.mcpInterface;
    for (const toolName of discovery.toolNames) {
      this.advertisedToolNames.add(toolName);
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

    if (!this.advertisedToolNames.has(toolName)) {
      throw new Error(`MCP did not advertise requested tool '${toolName}'`);
    }

    const argumentsCopy = boundedArguments(toolName, toolArguments);

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
    this.closePromise = closeWithinDeadline(this.closeResources()).finally(
      () => {
        this.state = "closed";
      },
    );
    return this.closePromise;
  }

  private assertOpen(): void {
    const transportFailure = this.recording.failure;
    if (transportFailure !== undefined) {
      this.observedTransportFailure = transportFailure;
      throw transportFailure;
    }
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
      let phaseError = error;
      try {
        await this.recording.flush();
      } catch (recordingError) {
        phaseError = recordingError;
      }
      const transportFailure = this.recording.failure;
      if (transportFailure !== undefined) {
        this.observedTransportFailure = transportFailure;
        phaseError = transportFailure;
      }
      await this.recordPhase({
        kind,
        name,
        ...(toolName === undefined ? {} : { toolName }),
        phaseNumber,
        startedAt,
        status: "failed",
      });
      throw phaseError;
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
      if (error !== this.observedTransportFailure) {
        closeError = error;
      }
    }

    const stderrStream = this.stdio.stderr;
    if (stderrStream instanceof Readable) {
      stderrStream.unpipe(this.stderrCapture);
    }
    if (!this.stderrCapture.writableEnded) {
      this.stderrCapture.end();
    }
    await finished(this.stderrCapture).catch((error: unknown) => {
      closeError ??= error;
    });
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
        message: message as McpMessageV1["message"],
      };
      await options.store.appendJsonl(
        artifactPath(options.evidencePath, "mcp-transcript.jsonl"),
        mcpMessageV1Schema,
        entry,
      );
    },
  );
  const stderrCapture = new BoundedStderrTransform((error) => {
    recording.abort(error);
  });
  stderrCapture.on("error", (error) => recording.abort(error));
  stderrOutput.on("error", (error) => recording.abort(error));
  stdio.stderr?.pipe(stderrCapture).pipe(stderrOutput);
  const client = new Client({
    name: "forge-agent-rollout",
    version: "0.1.0",
  });
  const session = new RecordedMcpSessionImpl(
    options,
    client,
    stdio,
    recording,
    stderrCapture,
    stderrOutput,
  );

  try {
    await session.initialize();
    return session;
  } catch (error) {
    return closeFailedMcpSession(session, error);
  }
}
