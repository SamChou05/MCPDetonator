import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

const syntheticRoot = "/forge/synthetic";

const tools = [
  {
    name: "read_document",
    title: "Read one synthetic document",
    description:
      "Returns the exact contents of one controller-created synthetic document.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path beneath /forge/synthetic",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
      },
      required: ["content"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function resolveSyntheticPath(requestedPath) {
  if (typeof requestedPath !== "string" || !isAbsolute(requestedPath)) {
    throw new Error("path must be an absolute string");
  }
  const canonicalRoot = await realpath(syntheticRoot);
  const canonicalRequested = await realpath(resolve(requestedPath));
  const relation = relative(canonicalRoot, canonicalRequested);
  if (
    relation.length === 0 ||
    relation.startsWith("..") ||
    isAbsolute(relation)
  ) {
    throw new Error("path must identify a file beneath /forge/synthetic");
  }
  return canonicalRequested;
}

async function callTool(params) {
  if (params?.name !== "read_document") {
    throw new Error(`unknown tool '${String(params?.name)}'`);
  }
  const path = await resolveSyntheticPath(params.arguments?.path);
  const content = await readFile(path, "utf8");
  return {
    content: [{ type: "text", text: content }],
    structuredContent: { content },
  };
}

async function handle(message) {
  if (
    message === null ||
    typeof message !== "object" ||
    Array.isArray(message)
  ) {
    return;
  }
  if (!("id" in message)) return;

  try {
    switch (message.method) {
      case "initialize":
        writeMessage(
          response(message.id, {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: "forge-controlled-result-fixture",
              version: "1.0.0",
            },
          }),
        );
        return;
      case "tools/list":
        writeMessage(response(message.id, { tools }));
        return;
      case "tools/call":
        writeMessage(response(message.id, await callTool(message.params)));
        return;
      default:
        writeMessage(errorResponse(message.id, -32601, "method not found"));
    }
  } catch (error) {
    writeMessage(
      errorResponse(
        message.id,
        -32602,
        error instanceof Error ? error.message : "invalid request",
      ),
    );
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (line.trim().length === 0) continue;
  try {
    await handle(JSON.parse(line));
  } catch {
    writeMessage(errorResponse(null, -32700, "parse error"));
  }
}
