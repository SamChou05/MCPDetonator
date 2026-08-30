import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_MCP_TOOL_ARGUMENT_BYTES,
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
      : {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false
        };
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
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{
          type: "text",
          text: message.params.arguments.message + ":list-count=" + listCount
        }]
      }
    });
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
  it("discovers once, validates repeated calls, and records scoped evidence", async () => {
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

      await expect(
        session.callTool("echo", { message: 123 }),
      ).rejects.toThrow("arguments do not match MCP tool 'echo' schema");
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
        "cooldown",
      ]);
      expect(session.phases.map((phase) => phase.status)).toEqual([
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
    expect(clientMethods.filter((method) => method === "tools/call")).toHaveLength(2);

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
});
