import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import { EvidenceStore } from "../../src/evidence-store.js";
import { JsonLimitError } from "../../src/mcp/json-bounds.js";
import {
  BoundedStderrTransform,
  MAX_MCP_STDERR_BYTES,
  MAX_MCP_TRANSCRIPT_BYTES,
  MAX_MCP_TRANSCRIPT_MESSAGES,
  MCP_JSONRPC_MESSAGE_LIMITS,
  RecordingTransport,
  runMcpExperiment,
} from "../../src/mcp/stdio.js";
import {
  MCP_TOOLS_LIST_RESULT_LIMITS,
  parseBoundedToolsListResult,
} from "../../src/mcp/tools-list.js";

class FakeStdioTransport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;
  public closeCalls = 0;

  public async start(): Promise<void> {}
  public async send(): Promise<void> {}
  public async close(): Promise<void> {
    this.closeCalls += 1;
    this.onclose?.();
  }

  public emit(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }
}

function deeplyNestedArray(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

function notification(data: unknown): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    method: "notifications/message",
    params: { level: "info", data },
  } as JSONRPCMessage;
}

describe("bounded MCP acquisition", () => {
  it("rejects a deeply nested outputSchema before recursive schema handling", () => {
    const result = {
      tools: [
        {
          name: "deep-output",
          inputSchema: { type: "object" },
          outputSchema: {
            type: "object",
            nested: deeplyNestedArray(
              MCP_TOOLS_LIST_RESULT_LIMITS.maxDepth + 2,
            ),
          },
        },
      ],
    };

    try {
      parseBoundedToolsListResult(result);
      throw new Error("expected tools/list preflight to reject deep outputSchema");
    } catch (error) {
      expect(error).toBeInstanceOf(JsonLimitError);
      expect(error).toMatchObject({ reason: "json_depth_limit" });
      expect(error).not.toBeInstanceOf(RangeError);
    }
  });

  it("uses raw tools/list without compiling an advertised outputSchema", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "forge-mcp-raw-list-"));
    try {
      const store = await EvidenceStore.create(temporaryRoot, "run-raw-list");
      await mkdir(store.pathFor("raw/raw-list"), { recursive: true });
      const serverPath = join(temporaryRoot, "server.mjs");
      const serverModule = import.meta.resolve(
        "@modelcontextprotocol/sdk/server/index.js",
      );
      const stdioModule = import.meta.resolve(
        "@modelcontextprotocol/sdk/server/stdio.js",
      );
      const typesModule = import.meta.resolve(
        "@modelcontextprotocol/sdk/types.js",
      );
      await writeFile(
        serverPath,
        [
          `import { Server } from ${JSON.stringify(serverModule)};`,
          `import { StdioServerTransport } from ${JSON.stringify(stdioModule)};`,
          `import { ListToolsRequestSchema } from ${JSON.stringify(typesModule)};`,
          "const server = new Server({ name: 'raw-list', version: '1' }, { capabilities: { tools: {} } });",
          "server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{",
          "  name: 'invalid-output-pattern',",
          "  inputSchema: { type: 'object' },",
          "  outputSchema: { type: 'object', properties: { value: { type: 'string', pattern: '[' } } },",
          "}] }));",
          "await server.connect(new StdioServerTransport());",
        ].join("\n"),
        "utf8",
      );

      const result = await runMcpExperiment({
        runId: "run-raw-list",
        experimentId: "raw-list",
        store,
        server: {
          command: process.execPath,
          args: [serverPath],
          stderr: "pipe",
        },
        timeoutMs: 5_000,
        cooldownMs: 0,
      });

      expect(result.mcpInterface.tools).toEqual([
        {
          name: "invalid-output-pattern",
          inputSchema: { type: "object" },
        },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects a deep inbound message without recursive cloning", async () => {
    const inner = new FakeStdioTransport();
    const record = vi.fn(async () => undefined);
    const recording = new RecordingTransport(inner as never, record);
    const delivered = vi.fn();
    recording.onmessage = delivered;
    await recording.start();

    inner.emit(
      notification(deeplyNestedArray(MCP_JSONRPC_MESSAGE_LIMITS.maxDepth + 2)),
    );

    await expect(recording.flush()).rejects.toMatchObject({
      reason: "json_depth_limit",
    });
    expect(delivered).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(inner.closeCalls).toBe(1);
  });

  it("aborts deterministically when transcript message count is exhausted", async () => {
    const inner = new FakeStdioTransport();
    const record = vi.fn(async () => undefined);
    const recording = new RecordingTransport(inner as never, record);
    await recording.start();

    for (let index = 0; index <= MAX_MCP_TRANSCRIPT_MESSAGES; index += 1) {
      inner.emit(notification(index));
    }

    await expect(recording.flush()).rejects.toThrow(
      `${MAX_MCP_TRANSCRIPT_MESSAGES}-message evaluator limit`,
    );
    expect(record).toHaveBeenCalledTimes(MAX_MCP_TRANSCRIPT_MESSAGES);
  });

  it("aborts deterministically when aggregate transcript bytes are exhausted", async () => {
    const inner = new FakeStdioTransport();
    const record = vi.fn(async () => undefined);
    const recording = new RecordingTransport(inner as never, record);
    await recording.start();
    const payload = "x".repeat(Math.floor(MAX_MCP_TRANSCRIPT_BYTES / 3));

    inner.emit(notification(payload));
    inner.emit(notification(payload));
    inner.emit(notification(payload));

    await expect(recording.flush()).rejects.toThrow(
      `${MAX_MCP_TRANSCRIPT_BYTES}-byte evaluator limit`,
    );
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("surfaces transcript persistence failures", async () => {
    const inner = new FakeStdioTransport();
    const recording = new RecordingTransport(inner as never, async () => {
      throw new Error("forced transcript write failure");
    });
    await recording.start();

    inner.emit(notification("test"));

    await expect(recording.flush()).rejects.toThrow(
      "forced transcript write failure",
    );
    expect(recording.failure?.message).toBe("forced transcript write failure");
    expect(inner.closeCalls).toBe(1);
  });

  it("caps captured stderr and reports overflow", async () => {
    const overflows: Error[] = [];
    const capture = new BoundedStderrTransform((error) =>
      overflows.push(error),
    );
    const chunks: Buffer[] = [];
    capture.on("data", (chunk: Buffer) => chunks.push(chunk));

    capture.end(Buffer.alloc(MAX_MCP_STDERR_BYTES + 1, 0x78));
    await finished(capture);

    expect(Buffer.concat(chunks)).toHaveLength(MAX_MCP_STDERR_BYTES);
    expect(overflows).toHaveLength(1);
    expect(overflows[0]?.message).toContain("stderr exceeded");
  });
});
