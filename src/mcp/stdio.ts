import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Transform, type TransformCallback } from "node:stream";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  ListToolsResult,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { z } from "zod";

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
import { assertMcpCatalogWithinLimits, MCP_CATALOG_LIMITS } from "./catalog.js";
import { compileInputSchema } from "./input-schema.js";
import { cloneBoundedJson, type JsonTraversalLimits } from "./json-bounds.js";
import { parseBoundedToolsListResult } from "./tools-list.js";

type ToolExperimentV1 = TargetConfigV1["experiments"]["tools"][number];

export const MAX_MCP_JSONRPC_MESSAGE_BYTES = 1_000_000;
export const MAX_MCP_TRANSCRIPT_MESSAGES = 256;
export const MAX_MCP_TRANSCRIPT_BYTES = 2_000_000;
export const MAX_MCP_STDERR_BYTES = 256_000;

export const MCP_JSONRPC_MESSAGE_LIMITS = Object.freeze({
  maxDepth: 128,
  maxNodes: MCP_CATALOG_LIMITS.maxJsonNodes,
  maxObjectKeys: MCP_CATALOG_LIMITS.maxObjectKeys,
  maxStringCharacters: MCP_CATALOG_LIMITS.maxTotalStringCharacters,
  // Reserve one byte for the newline-delimited STDIO record boundary.
  maxSerializedBytes: MAX_MCP_JSONRPC_MESSAGE_BYTES - 1,
}) satisfies JsonTraversalLimits;

const rawMcpResultSchema = z.unknown();

export interface McpExperimentResult {
  readonly mcpInterface: McpInterfaceV1;
  readonly discoveredCatalog: DiscoveredMcpCatalog;
  readonly phases: readonly PhaseV1[];
  readonly toolResult?: unknown;
}

export interface DiscoveredMcpCatalog {
  readonly protocolVersion: string;
  readonly server: { readonly name: string; readonly version: string };
  readonly acquisition: {
    readonly complete: boolean;
    readonly pageCount: 1;
    readonly listChangedDuringDiscovery: boolean;
  };
  readonly tools: ListToolsResult["tools"];
}

export interface BeforeMcpToolCallContext {
  readonly catalog: DiscoveredMcpCatalog;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedError(error: unknown, prefix: string): Error {
  return error instanceof Error
    ? error
    : new Error(`${prefix}: ${String(error)}`);
}

function combineErrors(
  primary: unknown,
  secondary: unknown,
  message: string,
): unknown {
  if (secondary === undefined || secondary === primary) return primary;
  return new AggregateError([primary, secondary], message, { cause: primary });
}

const MCP_TRANSPORT_FINALIZATION_TIMEOUT_MS = 5_000;

async function withinTransportFinalizationDeadline<T>(
  operation: Promise<T>,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  try {
    return await Promise.race([
      operation,
      delay(MCP_TRANSPORT_FINALIZATION_TIMEOUT_MS, undefined, {
        signal: controller.signal,
        ref: false,
      }).then(() => {
        throw new Error(
          `${label} exceeded ${MCP_TRANSPORT_FINALIZATION_TIMEOUT_MS} ms`,
        );
      }),
    ]);
  } finally {
    controller.abort();
  }
}

export class RecordingTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;

  private recordQueue: Promise<void> = Promise.resolve();
  private abortPromise: Promise<void> | undefined;
  private abortCloseError: unknown;
  private closePromise: Promise<void> | undefined;
  private terminalError: Error | undefined;
  private closeRequested = false;
  private closed = false;
  private innerStarted = false;
  private innerClosed = false;
  private readonly activeSends = new Set<Promise<void>>();
  private readonly innerCloseBarrier: Promise<void>;
  private resolveInnerClose!: () => void;
  private acceptedMessageCount = 0;
  private acceptedMessageBytes = 0;
  private sequence = 0;
  private initializeRequestId: string | undefined;
  private observedProtocolVersion: string | undefined;
  private observedToolsListChanged = false;
  private armedToolCall:
    { readonly canonicalParams: string; sent: boolean } | undefined;

  public constructor(
    private readonly inner: StdioClientTransport,
    private readonly recordMessage: (
      direction: McpMessageV1["direction"],
      sequence: number,
      message: JSONRPCMessage,
    ) => Promise<void>,
    private readonly onToolCallSent?: () => void,
  ) {
    this.innerCloseBarrier = new Promise<void>((resolveClose) => {
      this.resolveInnerClose = resolveClose;
    });
  }

  public get failure(): Error | undefined {
    return this.terminalError;
  }

  public get negotiatedProtocolVersion(): string | undefined {
    return this.observedProtocolVersion;
  }

  public get toolsListChanged(): boolean {
    return this.observedToolsListChanged;
  }

  public armSingleToolCall(name: string, arguments_: unknown): void {
    if (this.closeRequested) {
      throw new Error("MCP transport is closing or closed");
    }
    if (this.armedToolCall !== undefined) {
      throw new Error("MCP transport tool-call guard can be armed only once");
    }
    this.armedToolCall = {
      canonicalParams: JSON.stringify({ name, arguments: arguments_ }),
      sent: false,
    };
  }

  private inspectMessage(
    direction: McpMessageV1["direction"],
    message: JSONRPCMessage,
  ): void {
    const record = message as unknown as Record<string, unknown>;
    if (direction === "client_to_server" && record["method"] === "initialize") {
      if (this.initializeRequestId !== undefined) {
        throw new Error(
          "MCP transport observed more than one initialize request",
        );
      }
      this.initializeRequestId = JSON.stringify(record["id"]);
      return;
    }
    if (
      direction === "server_to_client" &&
      record["method"] === "notifications/tools/list_changed"
    ) {
      this.observedToolsListChanged = true;
      return;
    }
    if (
      direction === "server_to_client" &&
      this.initializeRequestId !== undefined &&
      JSON.stringify(record["id"]) === this.initializeRequestId
    ) {
      const result = record["result"];
      if (
        typeof result !== "object" ||
        result === null ||
        Array.isArray(result)
      ) {
        return;
      }
      const protocolVersion = (result as Record<string, unknown>)[
        "protocolVersion"
      ];
      if (typeof protocolVersion === "string" && protocolVersion.length > 0) {
        this.observedProtocolVersion = protocolVersion;
      }
    }
  }

  private guardToolCallSend(message: JSONRPCMessage): void {
    const record = message as unknown as Record<string, unknown>;
    if (record["method"] !== "tools/call") return;
    if (this.armedToolCall === undefined || this.armedToolCall.sent) {
      throw new Error(
        "MCP transport rejected an unarmed or repeated tools/call",
      );
    }
    if (this.observedToolsListChanged) {
      throw new Error("MCP tool catalog changed before the guarded tools/call");
    }
    if (
      JSON.stringify(record["params"]) !== this.armedToolCall.canonicalParams
    ) {
      throw new Error(
        "MCP tools/call parameters changed after pre-dispatch validation",
      );
    }
    this.armedToolCall.sent = true;
  }

  private recheckToolCallSend(message: JSONRPCMessage): void {
    const record = message as unknown as Record<string, unknown>;
    if (record["method"] !== "tools/call") return;
    if (this.armedToolCall === undefined || !this.armedToolCall.sent) {
      throw new Error("MCP transport lost its armed tools/call state");
    }
    if (this.observedToolsListChanged) {
      throw new Error("MCP tool catalog changed before the guarded tools/call");
    }
    if (
      JSON.stringify(record["params"]) !== this.armedToolCall.canonicalParams
    ) {
      throw new Error("MCP tools/call parameters changed before wire dispatch");
    }
  }

  private enqueue(
    direction: McpMessageV1["direction"],
    message: JSONRPCMessage,
  ): Promise<void> {
    if (this.terminalError !== undefined) {
      throw this.terminalError;
    }
    if (this.acceptedMessageCount + 1 > MAX_MCP_TRANSCRIPT_MESSAGES) {
      const failure = new Error(
        `MCP transcript exceeded the ${MAX_MCP_TRANSCRIPT_MESSAGES}-message evaluator limit`,
      );
      this.abort(failure);
      throw failure;
    }

    let bounded: {
      readonly clone: JSONRPCMessage;
      readonly metrics: { readonly serializedBytes: number };
    };
    try {
      bounded = cloneBoundedJson(
        message,
        MCP_JSONRPC_MESSAGE_LIMITS,
        "MCP JSON-RPC message",
      );
    } catch (error) {
      const failure = normalizedError(error, "MCP JSON-RPC preflight failed");
      this.abort(failure);
      throw failure;
    }
    const messageBytes = bounded.metrics.serializedBytes + 1;
    if (this.acceptedMessageBytes + messageBytes > MAX_MCP_TRANSCRIPT_BYTES) {
      const failure = new Error(
        `MCP transcript exceeded the ${MAX_MCP_TRANSCRIPT_BYTES}-byte evaluator limit`,
      );
      this.abort(failure);
      throw failure;
    }

    this.inspectMessage(direction, bounded.clone);

    const sequence = this.sequence;
    this.sequence += 1;
    this.acceptedMessageCount += 1;
    this.acceptedMessageBytes += messageBytes;
    const record = this.recordQueue.then(() =>
      this.recordMessage(direction, sequence, bounded.clone),
    );
    this.recordQueue = record.catch((error: unknown) => {
      this.abort(error);
      throw error;
    });
    return this.recordQueue;
  }

  public abort(error: unknown): void {
    if (this.closed || this.terminalError !== undefined) return;
    const failure = normalizedError(error, "MCP transport failed");
    this.terminalError = failure;
    this.closeRequested = true;
    try {
      this.onerror?.(failure);
    } catch {
      // The retained failure is surfaced by flush/close even if the callback fails.
    }
    this.abortPromise = this.inner.close().catch((closeError: unknown) => {
      this.abortCloseError = closeError;
    });
  }

  public async start(): Promise<void> {
    this.inner.onclose = () => {
      if (this.closed) return;
      this.innerClosed = true;
      this.resolveInnerClose();
      if (!this.closeRequested && this.terminalError === undefined) {
        this.closeRequested = true;
        this.terminalError = new Error(
          "MCP transport closed unexpectedly before controller cleanup",
        );
      }
      this.onclose?.();
    };
    this.inner.onerror = (error) => this.abort(error);
    this.inner.onmessage = <T extends JSONRPCMessage>(
      message: T,
      extra?: MessageExtraInfo,
    ) => {
      if (this.closeRequested) {
        if (!this.closed && this.terminalError === undefined) {
          this.terminalError = new Error(
            "MCP transport received a message after transcript finalization began",
          );
        }
        return;
      }
      try {
        void this.enqueue("server_to_client", message).catch(
          (error: unknown) => {
            this.abort(error);
          },
        );
        this.onmessage?.(message, extra);
      } catch (error) {
        this.abort(error);
      }
    };
    await this.inner.start();
    this.innerStarted = true;
  }

  public send(message: JSONRPCMessage): Promise<void> {
    if (this.closeRequested) {
      return Promise.reject(new Error("MCP transport is closing or closed"));
    }
    const operation = this.sendWhileOpen(message);
    this.activeSends.add(operation);
    void operation.then(
      () => {
        if (!this.closed) this.activeSends.delete(operation);
      },
      () => {
        if (!this.closed) this.activeSends.delete(operation);
      },
    );
    return operation;
  }

  private async sendWhileOpen(message: JSONRPCMessage): Promise<void> {
    try {
      this.guardToolCallSend(message);
      await this.enqueue("client_to_server", message);
      if (this.closeRequested) {
        throw new Error("MCP transport closed before wire dispatch");
      }
      // A list_changed notification can arrive while the durable transcript
      // append is pending. Recheck synchronously before invoking the wire send;
      // there is no await between this check and inner.send.
      this.recheckToolCallSend(message);
      const wireSend = this.inner.send(message);
      if (
        (message as unknown as Record<string, unknown>)["method"] ===
        "tools/call"
      ) {
        // StdioClientTransport invokes Writable.write synchronously when send
        // is called, but its promise may wait for a later drain event. Account
        // for the handoff now so an early server response cannot race the count.
        this.onToolCallSent?.();
      }
      await wireSend;
    } catch (error) {
      this.abort(error);
      throw error;
    }
  }

  public async flush(): Promise<void> {
    await this.recordQueue;
    if (this.terminalError !== undefined) throw this.terminalError;
  }

  public close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    this.closeRequested = true;
    let closeError: unknown;
    try {
      if (this.abortPromise === undefined) {
        try {
          await this.inner.close();
        } catch (error) {
          closeError = error;
        }
      } else {
        await this.abortPromise;
        closeError = this.abortCloseError;
      }

      if (this.innerStarted && !this.innerClosed) {
        try {
          await withinTransportFinalizationDeadline(
            this.innerCloseBarrier,
            "MCP child-process close barrier",
          );
        } catch (error) {
          closeError =
            closeError === undefined
              ? error
              : combineErrors(closeError, error, errorMessage(closeError));
        }
      }

      if (this.activeSends.size > 0) {
        try {
          await withinTransportFinalizationDeadline(
            Promise.allSettled([...this.activeSends]).then(() => undefined),
            "MCP active-send finalization",
          );
        } catch (error) {
          closeError =
            closeError === undefined
              ? error
              : combineErrors(closeError, error, errorMessage(closeError));
        }
      }

      try {
        await this.flush();
      } catch (error) {
        closeError =
          closeError === undefined
            ? error
            : combineErrors(error, closeError, errorMessage(error));
      }
    } finally {
      // No callback can mutate transcript state after close() settles.
      this.closed = true;
      this.activeSends.clear();
      delete this.inner.onmessage;
      delete this.inner.onerror;
      delete this.inner.onclose;
      delete this.onmessage;
      delete this.onerror;
      delete this.onclose;
    }
    if (closeError !== undefined) throw closeError;
  }
}

export class BoundedStderrTransform extends Transform {
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
    const remaining = MAX_MCP_STDERR_BYTES - this.capturedBytes;
    if (bytes.byteLength <= remaining) {
      this.capturedBytes += bytes.byteLength;
      callback(null, bytes);
      return;
    }
    if (remaining > 0) {
      this.push(bytes.subarray(0, remaining));
      this.capturedBytes += remaining;
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

async function requestBoundedTools(client: Client, timeoutMs: number) {
  // Client.listTools caches tool metadata and compiles advertised outputSchema
  // values before returning. Keep the result opaque until Forge bounds it.
  const rawResult = await client.request(
    { method: "tools/list" },
    rawMcpResultSchema,
    { timeout: timeoutMs },
  );
  return parseBoundedToolsListResult(rawResult).result;
}

function timestamp(): string {
  return new Date().toISOString();
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

export async function runMcpExperiment(options: {
  readonly runId: string;
  readonly experimentId: string;
  readonly store: EvidenceStore;
  readonly server: StdioServerParameters;
  readonly timeoutMs: number;
  readonly cooldownMs: number;
  readonly toolExperiment?: ToolExperimentV1;
  readonly beforeToolCall?: (
    context: BeforeMcpToolCallContext,
  ) => void | Promise<void>;
  /** Called once after the guarded tools/call write is accepted by transport. */
  readonly onToolCallSent?: () => void;
}): Promise<McpExperimentResult> {
  const {
    runId,
    experimentId,
    store,
    server,
    timeoutMs,
    cooldownMs,
    toolExperiment,
    beforeToolCall,
    onToolCallSent,
  } = options;
  const stdio = new StdioClientTransport({
    ...server,
    maxBufferSize: Math.min(
      server.maxBufferSize ?? MAX_MCP_JSONRPC_MESSAGE_BYTES,
      MAX_MCP_JSONRPC_MESSAGE_BYTES,
    ),
  });
  await mkdir(store.pathFor(`raw/${experimentId}`), {
    recursive: true,
    mode: 0o700,
  });
  const stderrOutput = createWriteStream(
    store.pathFor(`raw/${experimentId}/server-stderr.log`),
    { flags: "a", mode: 0o600 },
  );

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
        // RecordingTransport already produced a bounded, detached JSON clone.
        message: message as McpMessageV1["message"],
      };
      await store.appendJsonl(
        `raw/${experimentId}/mcp-transcript.jsonl`,
        mcpMessageV1Schema,
        entry,
      );
    },
    onToolCallSent,
  );
  const stderrCapture = new BoundedStderrTransform((error) =>
    recording.abort(error),
  );
  stderrCapture.on("error", (error) => recording.abort(error));
  stderrOutput.on("error", (error) => recording.abort(error));
  const stderrInput = stdio.stderr;
  stderrInput?.pipe(stderrCapture).pipe(stderrOutput);
  const client = new Client({ name: "forge-mcp-detonator", version: "0.1.0" });
  const phases: PhaseV1[] = [];

  async function inPhase<T>(
    kind: PhaseV1["kind"],
    name: string,
    task: () => Promise<T>,
    details: {
      readonly stage?: PhaseV1["stage"];
      readonly toolName?: string;
    } = {},
  ): Promise<T> {
    const startedAt = timestamp();
    try {
      const result = await task();
      await recording.flush();
      const phase: PhaseV1 = {
        schema: "forge.phase/v1",
        phaseId: `${experimentId}-${kind}-${phases.length + 1}`,
        runId,
        experimentId,
        kind,
        name,
        ...(details.stage === undefined ? {} : { stage: details.stage }),
        ...(details.toolName === undefined
          ? {}
          : { toolName: details.toolName }),
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
        ...(details.stage === undefined ? {} : { stage: details.stage }),
        ...(details.toolName === undefined
          ? {}
          : { toolName: details.toolName }),
        startedAt,
        endedAt: timestamp(),
        status: "failed",
      };
      phases.push(phase);
      let failure: unknown = recording.failure ?? error;
      try {
        await store.appendJsonl("phases.jsonl", phaseV1Schema, phase);
      } catch (phaseWriteError) {
        failure = combineErrors(
          failure,
          phaseWriteError,
          errorMessage(failure),
        );
      }
      throw failure;
    }
  }

  let connected = false;
  let mcpInterface: McpInterfaceV1 | undefined;
  let discoveredCatalog: DiscoveredMcpCatalog | undefined;
  let toolResult: unknown;
  let primaryError: unknown;

  try {
    await inPhase(
      "initialization",
      "initialize MCP session",
      async () => {
        await client.connect(recording, { timeout: timeoutMs });
        connected = true;
      },
      { stage: "handshake" },
    );
    const listedTools = await inPhase(
      "initialization",
      "list advertised tools",
      () => requestBoundedTools(client, timeoutMs),
      { stage: "tool_discovery" },
    );

    const serverVersion = client.getServerVersion();
    const advertisedServer = {
      name: serverVersion?.name ?? "unknown-server",
      version: serverVersion?.version ?? "unknown-version",
    };
    const protocolVersion = recording.negotiatedProtocolVersion;
    if (protocolVersion === undefined) {
      throw new Error(
        "MCP initialization did not retain a negotiated protocol version",
      );
    }
    // Validate the exact fields Forge retains before recursively cloning or
    // serializing attacker-controlled schemas. This makes the accepted catalog
    // depth and work explicit instead of relying only on the STDIO byte bound.
    assertMcpCatalogWithinLimits(advertisedServer, listedTools.tools);
    mcpInterface = {
      schema: "forge.mcp-interface/v1",
      runId,
      experimentId,
      server: advertisedServer,
      tools: listedTools.tools.map((tool) => ({
        name: tool.name,
        ...(tool.title === undefined ? {} : { title: tool.title }),
        ...(tool.description === undefined
          ? {}
          : { description: tool.description }),
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
    discoveredCatalog = cloneBoundedJson(
      {
        protocolVersion,
        server: advertisedServer,
        acquisition: {
          complete: listedTools.nextCursor === undefined,
          pageCount: 1,
          listChangedDuringDiscovery: recording.toolsListChanged,
        },
        tools: listedTools.tools,
      },
      MCP_JSONRPC_MESSAGE_LIMITS,
      "discovered MCP catalog",
    ).clone as DiscoveredMcpCatalog;
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
        throw new Error(
          `MCP did not advertise configured tool '${toolExperiment.tool}'`,
        );
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
      const argumentsCopy = cloneBoundedJson(
        toolExperiment.input,
        MCP_JSONRPC_MESSAGE_LIMITS,
        `configured input for '${toolExperiment.tool}'`,
      ).clone as Readonly<Record<string, unknown>>;
      if (!validateInput(argumentsCopy)) {
        throw new Error(
          `configured input does not match '${toolExperiment.tool}' schema: ${formatAjvErrors(validateInput.errors)}`,
        );
      }

      await recording.flush();
      if (beforeToolCall !== undefined) {
        const beforeArguments = JSON.stringify(argumentsCopy);
        const beforeCatalog = JSON.stringify(discoveredCatalog);
        await beforeToolCall({
          catalog: discoveredCatalog,
          toolName: toolExperiment.tool,
          arguments: argumentsCopy,
        });
        if (
          JSON.stringify(argumentsCopy) !== beforeArguments ||
          JSON.stringify(discoveredCatalog) !== beforeCatalog
        ) {
          throw new Error("pre-dispatch hook mutated frozen call inputs");
        }
        if (!validateInput(argumentsCopy)) {
          throw new Error(
            `configured input no longer matches '${toolExperiment.tool}' schema after pre-dispatch validation`,
          );
        }
      }
      recording.armSingleToolCall(toolExperiment.tool, argumentsCopy);

      toolResult = await inPhase(
        "tool",
        `call ${toolExperiment.tool}`,
        () =>
          client.callTool(
            { name: toolExperiment.tool, arguments: argumentsCopy },
            undefined,
            { timeout: timeoutMs },
          ),
        { stage: "tool_invocation", toolName: toolExperiment.tool },
      );
    }

    await inPhase(
      "cooldown",
      "observe background activity",
      async () => {
        if (cooldownMs > 0) {
          await delay(cooldownMs);
        }
      },
      { stage: "observation_window" },
    );
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  try {
    if (connected) {
      await client.close();
    }
  } catch (error) {
    cleanupError = error;
  }
  try {
    await recording.close();
  } catch (error) {
    cleanupError =
      cleanupError === undefined
        ? error
        : combineErrors(cleanupError, error, errorMessage(cleanupError));
  }

  if (!stderrCapture.writableEnded) stderrCapture.end();
  try {
    await finished(stderrCapture);
  } catch (error) {
    cleanupError =
      cleanupError === undefined
        ? error
        : combineErrors(cleanupError, error, errorMessage(cleanupError));
  }
  if (!stderrOutput.writableEnded) stderrOutput.end();
  try {
    await finished(stderrOutput);
  } catch (error) {
    cleanupError =
      cleanupError === undefined
        ? error
        : combineErrors(cleanupError, error, errorMessage(cleanupError));
  }

  if (primaryError !== undefined) {
    let failure: unknown = primaryError;
    if (recording.failure !== undefined && recording.failure !== failure) {
      failure = combineErrors(
        failure,
        recording.failure,
        errorMessage(failure),
      );
    }
    if (cleanupError !== undefined && cleanupError !== failure) {
      failure = combineErrors(failure, cleanupError, errorMessage(failure));
    }
    throw failure;
  }
  if (recording.failure !== undefined) throw recording.failure;
  if (cleanupError !== undefined) throw cleanupError;

  if (mcpInterface === undefined) {
    throw new Error("MCP initialization did not produce an interface");
  }
  if (discoveredCatalog === undefined) {
    throw new Error("MCP initialization did not produce a discovered catalog");
  }

  return {
    mcpInterface,
    discoveredCatalog,
    phases,
    ...(toolResult === undefined ? {} : { toolResult }),
  };
}
