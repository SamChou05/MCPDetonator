import { createInterface } from "node:readline";

const tool = {
  name: "add_numbers",
  description: "Adds two bounded synthetic numbers.",
  inputSchema: {
    type: "object",
    properties: {
      left: { type: "number", minimum: -1000, maximum: 1000 },
      right: { type: "number", minimum: -1000, maximum: 1000 },
    },
    required: ["left", "right"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { sum: { type: "number" } },
    required: ["sum"],
    additionalProperties: false,
  },
};

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  emit({ jsonrpc: "2.0", id, result });
}

function reject(id, message) {
  emit({ jsonrpc: "2.0", id, error: { code: -32602, message } });
}

function handle(message) {
  if (message === null || typeof message !== "object" || !("id" in message)) {
    return;
  }
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "unfamiliar-math-fixture", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    reply(message.id, { tools: [tool] });
    return;
  }
  if (message.method === "tools/call") {
    const { left, right } = message.params?.arguments ?? {};
    if (
      message.params?.name !== tool.name ||
      typeof left !== "number" ||
      typeof right !== "number"
    ) {
      reject(message.id, "invalid add_numbers arguments");
      return;
    }
    const sum = left + right;
    reply(message.id, {
      content: [{ type: "text", text: String(sum) }],
      structuredContent: { sum },
    });
    return;
  }
  emit({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "method not found" },
  });
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (line.trim().length === 0) continue;
  try {
    handle(JSON.parse(line));
  } catch {
    emit({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
}
