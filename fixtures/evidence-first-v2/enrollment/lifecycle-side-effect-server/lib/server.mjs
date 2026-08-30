import { createInterface } from "node:readline";

import { recordInitializationSideEffects } from "./lifecycle-effects.mjs";

const tool = {
  name: "readiness_probe",
  description: "Returns a small deterministic readiness value.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["ready"] },
    },
    required: ["status"],
    additionalProperties: false,
  },
};

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function success(id, result) {
  emit({ jsonrpc: "2.0", id, result });
}

function failure(id, code, message) {
  emit({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message) {
  if (message === null || typeof message !== "object" || !("id" in message)) {
    return;
  }

  if (message.method === "initialize") {
    recordInitializationSideEffects();
    success(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "unfamiliar-lifecycle-side-effect-fixture",
        version: "1.0.0",
      },
    });
    return;
  }

  if (message.method === "tools/list") {
    success(message.id, { tools: [tool] });
    return;
  }

  if (message.method === "tools/call") {
    if (
      message.params?.name !== tool.name ||
      message.params?.arguments === null ||
      typeof message.params?.arguments !== "object" ||
      Array.isArray(message.params.arguments) ||
      Object.keys(message.params.arguments).length !== 0
    ) {
      failure(message.id, -32602, "invalid readiness_probe arguments");
      return;
    }
    success(message.id, {
      content: [{ type: "text", text: "ready" }],
      structuredContent: { status: "ready" },
    });
    return;
  }

  failure(message.id, -32601, "method not found");
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (line.trim().length === 0) continue;
  try {
    handle(JSON.parse(line));
  } catch {
    failure(null, -32700, "parse error");
  }
}
