import { describe, expect, it } from "vitest";

import { agentActionV1Schema } from "../../src/agent/contracts.js";
import { sha256 } from "../../src/evidence-store.js";
import {
  observeTargetActionPaths,
  targetActionPathCandidates,
  targetContainerReadWorkerSource,
  targetContainerStatWorkerSource,
} from "../../src/agent/tools/target-container.js";

function action(arguments_: Record<string, unknown>, status: "succeeded" | "blocked") {
  return agentActionV1Schema.parse({
    schema: "forge.agent-action/v1",
    actionId: `action-${status}`,
    scenarioId: "scenario",
    trialId: "trial",
    sequence: 0,
    proposedAt: "2026-01-01T00:00:00.000Z",
    toolSource: "target_mcp",
    toolCall: {
      schema: "forge.agent-tool-call/v1",
      id: "call",
      name: "write_note",
      arguments: arguments_,
    },
    policyDecisionId: "decision",
    outcome:
      status === "succeeded"
        ? {
            status,
            dispatchedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:00.000Z",
          }
        : { status, blockedAt: "2026-01-01T00:00:00.000Z" },
  });
}

describe("target-container trusted observer", () => {
  it("extracts only dispatched synthetic paths and records bounded content hashes", async () => {
    const actions = [
      action(
        {
          path: "/sandbox/workspace/note.txt",
          content: "not a path",
          ignored: "/etc/passwd",
        },
        "succeeded",
      ),
      action({ path: "/sandbox/workspace/blocked.txt" }, "blocked"),
    ];

    expect(targetActionPathCandidates(actions)).toEqual([
      {
        actionId: "action-succeeded",
        toolName: "write_note",
        path: "/sandbox/workspace/note.txt",
      },
    ]);
    await expect(
      observeTargetActionPaths(actions, {
        inspectFile: async () => ({ exists: true, kind: "file", bytes: 5 }),
        execute: async () => ({
          content: "hello",
          structured: { bytes: 5, contentSha256: sha256("hello") },
        }),
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        path: "/sandbox/workspace/note.txt",
        exists: true,
        kind: "file",
        bytes: 5,
        readStatus: "hashed",
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
  });

  it("keeps the embedded workers fd-bound, no-follow, and base64 bounded", () => {
    for (const source of [
      targetContainerStatWorkerSource,
      targetContainerReadWorkerSource,
    ]) {
      expect(source).toContain("O_NOFOLLOW");
      expect(source).toContain("realpath(fdRoot + \"/\" + handle.fd)");
      expect(source).not.toContain("lstat(normalized)");
    }
    expect(targetContainerReadWorkerSource).toContain('toString("base64")');
  });

  it("preserves an unknown existence state when trusted observation fails", async () => {
    const observations = await observeTargetActionPaths(
      [
        action(
          { path: "/sandbox/workspace/unavailable.txt" },
          "succeeded",
        ),
      ],
      {
        inspectFile: async () => Promise.reject(new Error("observer unavailable")),
        execute: async () => Promise.reject(new Error("not reached")),
      },
    );

    expect(observations).toEqual([
      {
        actionId: "action-succeeded",
        toolName: "write_note",
        path: "/sandbox/workspace/unavailable.txt",
        readStatus: "observer_error",
      },
    ]);
  });
});
