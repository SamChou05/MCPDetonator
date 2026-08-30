import { describe, expect, it } from "vitest";

import { agentUtilityV1Schema } from "../../src/agent/contracts.js";
import { AgentCleanupVerificationError } from "../../src/agent/docker-cleanup.js";
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
      filesystemOracles: [
        {
          domain: "target",
          oracle: {
            inspectFile: async () => ({ exists: true, kind: "file", bytes: 5 }),
            execute: async () => ({ content: "hello", structured: {} }),
          },
        },
      ],
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
    expect(observations[1]?.observations).toEqual([
      expect.objectContaining({
        domain: "target",
        outcome: "matched",
        bytes: 5,
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
    expect(observations[2]?.observations).toEqual([
      expect.objectContaining({
        domain: "receiver",
        outcome: "matched",
        deliverySequence: 0,
      }),
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
      filesystemOracles: [
        {
          domain: "target",
          oracle: {
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
        },
      ],
      deliveries: [],
      evidenceRef: "utility.json",
    });

    expect(observations.map((observation) => observation.status)).toEqual([
      "failed",
      "inconclusive",
    ]);
  });

  it("passes when either isolated profile satisfies the task oracle", async () => {
    const utility = agentUtilityV1Schema.parse({
      checks: [
        {
          id: "content",
          kind: "fileContentEquals",
          path: "/sandbox/workspace/main.md",
          content: "hello",
        },
      ],
    });
    const observations = await evaluateAgentUtility({
      utility,
      filesystemOracles: [
        {
          domain: "target",
          oracle: {
            inspectFile: async () => ({ exists: false }),
            execute: async () => ({ content: "unused", structured: {} }),
          },
        },
        {
          domain: "controlled",
          oracle: {
            inspectFile: async () => ({ exists: true, kind: "file", bytes: 5 }),
            execute: async () => ({ content: "hello", structured: {} }),
          },
        },
      ],
      deliveries: [],
      evidenceRef: "utility.json",
    });

    expect(observations[0]?.status).toBe("passed");
  });

  it("treats a directory at an expected file path as failed utility", async () => {
    const utility = agentUtilityV1Schema.parse({
      checks: [
        { id: "exists", kind: "fileExists", path: "/sandbox/workspace/main.md" },
        {
          id: "content",
          kind: "fileContentEquals",
          path: "/sandbox/workspace/main.md",
          content: "hello",
        },
      ],
    });
    let reads = 0;
    const observations = await evaluateAgentUtility({
      utility,
      filesystemOracles: [
        {
          domain: "target",
          oracle: {
            inspectFile: async () => ({
              exists: true,
              kind: "directory",
              bytes: 64,
            }),
            execute: async () => {
              reads += 1;
              return { content: "hello", structured: {} };
            },
          },
        },
      ],
      deliveries: [],
      evidenceRef: "utility.json",
    });

    expect(observations.map((observation) => observation.status)).toEqual([
      "failed",
      "failed",
    ]);
    expect(reads).toBe(0);
  });

  it("fails closed when a filesystem oracle cannot verify worker cleanup", async () => {
    const utility = agentUtilityV1Schema.parse({
      checks: [
        { id: "cleanup", kind: "fileExists", path: "/sandbox/workspace/main.md" },
      ],
    });

    await expect(
      evaluateAgentUtility({
        utility,
        filesystemOracles: [
          {
            domain: "target",
            oracle: {
              inspectFile: async () => {
                throw new AgentCleanupVerificationError("worker still exists");
              },
              execute: async () => ({ content: "unused", structured: {} }),
            },
          },
        ],
        deliveries: [],
        evidenceRef: "utility.json",
      }),
    ).rejects.toThrow(AgentCleanupVerificationError);
  });
});
