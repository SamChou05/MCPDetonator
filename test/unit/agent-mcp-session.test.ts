import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_MCP_STDERR_BYTES,
  MAX_MCP_TRANSCRIPT_BYTES,
  MAX_MCP_TRANSCRIPT_MESSAGES,
  MAX_MCP_TOOL_ARGUMENT_BYTES,
  McpSessionInitializationCleanupError,
  closeFailedMcpSession,
  openRecordedMcpSession,
} from "../../src/agent/mcp-session.js";
import { EvidenceStore } from "../../src/evidence-store.js";

const TEST_SERVER = String.raw`
let buffer = "";
let listCount = 0;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "recorded-session-fixture", version: "1.2.3" }
      }
    });
    return;
  }

  if (message.method === "tools/list") {
    listCount += 1;
    const inputSchema = process.env.FORGE_OVERSIZED_SCHEMA === "1"
      ? { type: "object", description: "x".repeat(256_100) }
      : process.env.FORGE_INVALID_REGEX_SCHEMA === "1"
      ? {
          type: "object",
          properties: { message: { type: "string", pattern: "[" } }
        }
      : {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false
        };
    const notificationCount = Number(process.env.FORGE_NOTIFICATION_FLOOD || 0);
    for (let index = 0; index < notificationCount; index += 1) {
      send({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "info", data: "flood-" + index }
      });
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: "echo",
          title: "Exact echo title",
          description: "Exact untrusted tool description.",
          inputSchema,
          annotations: {
            title: "Exact annotation title",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
          }
        }]
      }
    });
    return;
  }

  if (message.method === "tools/call") {
    const sendResult = () => {
      const responseBytes = Number(process.env.FORGE_RESPONSE_BYTES || 0);
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{
            type: "text",
            text: responseBytes > 0
              ? "x".repeat(responseBytes)
              : message.params.arguments.message + ":list-count=" + listCount
          }]
        }
      });
    };
    const stderrBytes = Number(process.env.FORGE_STDERR_ON_CALL_BYTES || 0);
    if (stderrBytes > 0) {
      process.stderr.write("e".repeat(stderrBytes));
      setTimeout(sendResult, 100);
    } else {
      sendResult();
    }
    if (process.env.FORGE_EXIT_AFTER_CALL === "1") {
      setTimeout(() => process.exit(0), 30);
    }
    return;
  }

  if (Object.prototype.hasOwnProperty.call(message, "id")) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "unknown method" }
    });
  }
}

process.stderr.write("fixture stderr marker\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
`;

describe("failed MCP initialization cleanup", () => {
  it("surfaces an unverified close instead of hiding it", async () => {
    const initializationError = new Error("initialize failed");
    const cleanupError = new Error("close failed");

    await expect(
      closeFailedMcpSession(
        { close: async () => Promise.reject(cleanupError) },
        initializationError,
      ),
    ).rejects.toMatchObject({
      name: "McpSessionInitializationCleanupError",
      initializationError,
      cleanupError,
    } satisfies Partial<McpSessionInitializationCleanupError>);
  });
});

const temporaryRoots: string[] = [];

async function createStore(runId: string): Promise<EvidenceStore> {
  const root = await mkdtemp(join(tmpdir(), "forge-agent-mcp-session-"));
  temporaryRoots.push(root);
  return EvidenceStore.create(root, runId);
}

function resultText(result: unknown): string | undefined {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })
    .content;
  return content?.find((item) => item.type === "text")?.text;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("recorded agent MCP session", () => {
  it("discovers once, forwards calls without executing target schemas, and records scoped evidence", async () => {
    const store = await createStore("run-agent-mcp");
    const evidencePath = "agent/rollouts/trial-1/raw/mcp";
    const session = await openRecordedMcpSession({
      runId: "run-agent-mcp",
      experimentId: "agent-trial-1",
      store,
      server: {
        command: process.execPath,
        args: ["--eval", TEST_SERVER],
      },
      timeoutMs: 5_000,
      evidencePath,
    });

    try {
      expect(session.mcpInterface).toEqual({
        schema: "forge.mcp-interface/v1",
        runId: "run-agent-mcp",
        experimentId: "agent-trial-1",
        server: { name: "recorded-session-fixture", version: "1.2.3" },
        tools: [
          {
            name: "echo",
            title: "Exact echo title",
            description: "Exact untrusted tool description.",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
              additionalProperties: false,
            },
            annotations: {
              title: "Exact annotation title",
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
        ],
      });

      expect(resultText(await session.callTool("echo", { message: "first" }))).toBe(
        "first:list-count=1",
      );
      expect(resultText(await session.callTool("echo", { message: "second" }))).toBe(
        "second:list-count=1",
      );

      expect(resultText(await session.callTool("echo", { message: 123 }))).toBe(
        "123:list-count=1",
      );
      await expect(session.callTool("missing", {})).rejects.toThrow(
        "MCP did not advertise requested tool 'missing'",
      );
      await expect(
        session.callTool("echo", {
          message: "x".repeat(MAX_MCP_TOOL_ARGUMENT_BYTES),
        }),
      ).rejects.toThrow("exceed the 256 KB evaluator limit");

      await session.cooldown(0);
      expect(session.phases.map((phase) => phase.kind)).toEqual([
        "initialization",
        "tool",
        "tool",
        "tool",
        "cooldown",
      ]);
      expect(session.phases.map((phase) => phase.status)).toEqual([
        "completed",
        "completed",
        "completed",
        "completed",
        "completed",
      ]);
    } finally {
      await session.close();
      await session.close();
    }

    const transcript = (
      await readFile(
        store.pathFor(`${evidencePath}/mcp-transcript.jsonl`),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const clientMethods = transcript
      .filter((entry) => entry["direction"] === "client_to_server")
      .map((entry) => (entry["message"] as { method?: string }).method)
      .filter((method): method is string => method !== undefined);
    expect(clientMethods.filter((method) => method === "tools/list")).toHaveLength(1);
    expect(clientMethods.filter((method) => method === "tools/call")).toHaveLength(3);

    const persistedInterface = JSON.parse(
      await readFile(store.pathFor(`${evidencePath}/interface.json`), "utf8"),
    ) as { tools: unknown[] };
    expect(persistedInterface.tools).toEqual(session.mcpInterface.tools);

    const persistedPhases = (
      await readFile(store.pathFor(`${evidencePath}/phases.jsonl`), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string });
    expect(persistedPhases.map((phase) => phase.kind)).toEqual([
      "initialization",
      "tool",
      "tool",
      "tool",
      "cooldown",
    ]);
    await expect(
      readFile(store.pathFor(`${evidencePath}/server-stderr.log`), "utf8"),
    ).resolves.toContain("fixture stderr marker");
  });

  it("rejects an oversized advertised input schema and closes the server", async () => {
    const store = await createStore("run-agent-large-schema");
    const evidencePath = "agent/rollouts/large-schema/raw/mcp";

    await expect(
      openRecordedMcpSession({
        runId: "run-agent-large-schema",
        experimentId: "agent-large-schema",
        store,
        server: {
          command: process.execPath,
          args: ["--eval", TEST_SERVER],
          env: { FORGE_OVERSIZED_SCHEMA: "1" },
        },
        timeoutMs: 5_000,
        evidencePath,
      }),
    ).rejects.toThrow("input schema for MCP tool 'echo' exceeds the 256 KB");

    const phases = (
      await readFile(store.pathFor(`${evidencePath}/phases.jsonl`), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; status: string });
    expect(phases).toEqual([
      expect.objectContaining({ kind: "initialization", status: "failed" }),
    ]);
    await expect(
      readFile(store.pathFor(`${evidencePath}/server-stderr.log`), "utf8"),
    ).resolves.toContain("fixture stderr marker");
  });

  it("preserves but never compiles an invalid target-authored regex schema", async () => {
    const store = await createStore("run-agent-untrusted-schema");
    const evidencePath = "agent/rollouts/untrusted-schema/raw/mcp";
    const session = await openRecordedMcpSession({
      runId: "run-agent-untrusted-schema",
      experimentId: "agent-untrusted-schema",
      store,
      server: {
        command: process.execPath,
        args: ["--eval", TEST_SERVER],
        env: { FORGE_INVALID_REGEX_SCHEMA: "1" },
      },
      timeoutMs: 5_000,
      evidencePath,
    });

    try {
      expect(session.mcpInterface.tools[0]?.inputSchema).toEqual({
        type: "object",
        properties: { message: { type: "string", pattern: "[" } },
      });
      await expect(
        session.callTool("echo", { message: "still forwarded" }),
      ).resolves.toBeDefined();
    } finally {
      await session.close();
    }
  });

  it("aborts initialization when an inbound notification flood exceeds the transcript count quota", async () => {
    const store = await createStore("run-agent-message-flood");
    const evidencePath = "agent/rollouts/message-flood/raw/mcp";

    await expect(
      openRecordedMcpSession({
        runId: "run-agent-message-flood",
        experimentId: "agent-message-flood",
        store,
        server: {
          command: process.execPath,
          args: ["--eval", TEST_SERVER],
          env: {
            FORGE_NOTIFICATION_FLOOD: String(
              MAX_MCP_TRANSCRIPT_MESSAGES + 32,
            ),
          },
        },
        timeoutMs: 5_000,
        evidencePath,
      }),
    ).rejects.toThrow(
      `MCP transcript exceeded the ${MAX_MCP_TRANSCRIPT_MESSAGES}-message evaluator limit`,
    );

    const transcript = (
      await readFile(
        store.pathFor(`${evidencePath}/mcp-transcript.jsonl`),
        "utf8",
      )
    )
      .trim()
      .split("\n");
    expect(transcript.length).toBeLessThanOrEqual(MAX_MCP_TRANSCRIPT_MESSAGES);
    const phases = await readFile(
      store.pathFor(`${evidencePath}/phases.jsonl`),
      "utf8",
    );
    expect(phases).toContain('"kind":"initialization"');
    expect(phases).toContain('"status":"failed"');
  });

  it("rejects an oversized inbound response before recording or returning it", async () => {
    const store = await createStore("run-agent-response-oversize");
    const evidencePath = "agent/rollouts/response-oversize/raw/mcp";
    const session = await openRecordedMcpSession({
      runId: "run-agent-response-oversize",
      experimentId: "agent-response-oversize",
      store,
      server: {
        command: process.execPath,
        args: ["--eval", TEST_SERVER],
        env: {
          FORGE_RESPONSE_BYTES: String(MAX_MCP_TRANSCRIPT_BYTES + 1_024),
        },
      },
      timeoutMs: 5_000,
      evidencePath,
    });

    try {
      await expect(
        session.callTool("echo", { message: "oversized" }),
      ).rejects.toThrow(
        `MCP transcript exceeded the ${MAX_MCP_TRANSCRIPT_BYTES}-byte evaluator limit`,
      );
    } finally {
      await session.close().catch(() => undefined);
    }

    expect(
      (
        await stat(store.pathFor(`${evidencePath}/mcp-transcript.jsonl`))
      ).size,
    ).toBeLessThan(MAX_MCP_TRANSCRIPT_BYTES);
    const phases = await readFile(
      store.pathFor(`${evidencePath}/phases.jsonl`),
      "utf8",
    );
    expect(phases).toContain('"kind":"tool"');
    expect(phases).toContain('"status":"failed"');
  });

  it("caps stderr and aborts a call when the target exceeds the stderr quota", async () => {
    const store = await createStore("run-agent-stderr-oversize");
    const evidencePath = "agent/rollouts/stderr-oversize/raw/mcp";
    const session = await openRecordedMcpSession({
      runId: "run-agent-stderr-oversize",
      experimentId: "agent-stderr-oversize",
      store,
      server: {
        command: process.execPath,
        args: ["--eval", TEST_SERVER],
        env: {
          FORGE_STDERR_ON_CALL_BYTES: String(MAX_MCP_STDERR_BYTES + 1_024),
        },
      },
      timeoutMs: 5_000,
      evidencePath,
    });

    try {
      await expect(
        session.callTool("echo", { message: "stderr flood" }),
      ).rejects.toThrow(
        `MCP stderr exceeded the ${MAX_MCP_STDERR_BYTES}-byte evaluator limit`,
      );
    } finally {
      await session.close().catch(() => undefined);
    }

    expect(
      (await stat(store.pathFor(`${evidencePath}/server-stderr.log`))).size,
    ).toBe(MAX_MCP_STDERR_BYTES);
    const phases = await readFile(
      store.pathFor(`${evidencePath}/phases.jsonl`),
      "utf8",
    );
    expect(phases).toContain('"kind":"tool"');
    expect(phases).toContain('"status":"failed"');
  });

  it("treats an unexpected transport close between calls as a fatal session failure", async () => {
    const store = await createStore("run-agent-unexpected-close");
    const evidencePath = "agent/rollouts/unexpected-close/raw/mcp";
    const session = await openRecordedMcpSession({
      runId: "run-agent-unexpected-close",
      experimentId: "agent-unexpected-close",
      store,
      server: {
        command: process.execPath,
        args: ["--eval", TEST_SERVER],
        env: { FORGE_EXIT_AFTER_CALL: "1" },
      },
      timeoutMs: 5_000,
      evidencePath,
    });

    try {
      await expect(
        session.callTool("echo", { message: "close after response" }),
      ).resolves.toBeDefined();
      await expect(session.cooldown(100)).rejects.toThrow(
        "MCP transport closed unexpectedly before controller cleanup",
      );
    } finally {
      await session.close().catch(() => undefined);
    }

    const phases = await readFile(
      store.pathFor(`${evidencePath}/phases.jsonl`),
      "utf8",
    );
    expect(phases).toContain('"kind":"cooldown"');
    expect(phases).toContain('"status":"failed"');
  });
});
