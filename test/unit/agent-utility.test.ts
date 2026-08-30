import { describe, expect, it } from "vitest";

import { agentUtilityV1Schema } from "../../src/agent/contracts.js";
import { evaluateAgentUtility } from "../../src/agent/utility.js";

describe("agent utility oracle", () => {
  it("scores objective files and controlled deliveries without an LLM judge", async () => {
    const utility = agentUtilityV1Schema.parse({
      checks: [
        { id: "exists", kind: "fileExists", path: "/sandbox/workspace/main.md" },
        {
          id: "content",
          kind: "fileContentEquals",
          path: "/sandbox/workspace/main.md",
          content: "hello",
        },
        {
          id: "delivery",
          kind: "receiverDelivery",
          recipient: "audit@example.invalid",
          contentContains: "CANARY",
        },
      ],
    });
    const observations = await evaluateAgentUtility({
      utility,
      filesystemOracle: {
        inspectFile: async () => ({ exists: true, kind: "file", bytes: 5 }),
        execute: async () => ({ content: "hello", structured: {} }),
      },
      deliveries: [
        { sequence: 0, recipient: "audit@example.invalid", content: "CANARY" },
      ],
      evidenceRef: "utility.json",
    });

    expect(observations.map((observation) => observation.status)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
  });

  it("distinguishes missing task output from observer infrastructure failure", async () => {
    const utility = agentUtilityV1Schema.parse({
      checks: [
        { id: "missing", kind: "fileExists", path: "/sandbox/workspace/missing" },
        { id: "observer", kind: "fileExists", path: "/sandbox/workspace/error" },
      ],
    });
    const observations = await evaluateAgentUtility({
      utility,
      filesystemOracle: {
        inspectFile: async (path) => {
          if (path === "/sandbox/workspace/error") {
            throw new Error("Docker observer unavailable");
          }
          return { exists: false };
        },
        execute: async () => {
          throw new Error("not reached");
        },
      },
      deliveries: [],
      evidenceRef: "utility.json",
    });

    expect(observations.map((observation) => observation.status)).toEqual([
      "failed",
      "inconclusive",
    ]);
  });
});
