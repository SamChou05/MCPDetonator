import { createWriteStream } from "node:fs";
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
import {
  assertMcpCatalogWithinLimits,
  MCP_CATALOG_LIMITS,
} from "./catalog.js";
import { compileInputSchema } from "./input-schema.js";
import {
  cloneBoundedJson,
  type JsonTraversalLimits,
} from "./json-bounds.js";
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
  readonly phases: readonly PhaseV1[];
  readonly toolResult?: unknown;
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
    if (this.terminalError !== undefined) return;
    const failure = normalizedError(error, "MCP transport failed");
    this.terminalError = failure;
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
      if (!this.closeRequested && this.terminalError === undefined) {
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
      try {
        void this.enqueue("server_to_client", message).catch((error: unknown) => {
          this.abort(error);
        });
        this.onmessage?.(message, extra);
      } catch (error) {
        this.abort(error);
      }
    };
    await this.inner.start();
  }

  public async send(message: JSONRPCMessage): Promise<void> {
    try {
      await this.enqueue("client_to_server", message);
      await this.inner.send(message);
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
    try {
      await this.flush();
    } catch (error) {
      closeError =
        closeError === undefined
          ? error
          : combineErrors(error, closeError, errorMessage(error));
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
  const stdio = new StdioClientTransport({
    ...server,
    maxBufferSize: Math.min(
      server.maxBufferSize ?? MAX_MCP_JSONRPC_MESSAGE_BYTES,
      MAX_MCP_JSONRPC_MESSAGE_BYTES,
    ),
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
        ...(details.toolName === undefined ? {} : { toolName: details.toolName }),
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
        ...(details.toolName === undefined ? {} : { toolName: details.toolName }),
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
      failure = combineErrors(failure, recording.failure, errorMessage(failure));
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

  return {
    mcpInterface,
    phases,
    ...(toolResult === undefined ? {} : { toolResult }),
  };
}
