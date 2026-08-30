import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlledToolSet } from "../../src/agent/tools/controlled.js";
import type { MaterializedDeveloperProfile } from "../../src/sandbox/profile.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function profile(): Promise<MaterializedDeveloperProfile> {
  const root = await mkdtemp(resolve(tmpdir(), "forge-agent-tools-"));
  temporaryDirectories.push(root);
  const home = resolve(root, "home");
  const workspace = resolve(root, "workspace");

  return {
    experimentId: "trial-1",
    hostHome: home,
    hostWorkspace: workspace,
    containerHome: "/sandbox/home/forge",
    containerWorkspace: "/sandbox/workspace",
    seed: {
      sshKeyCanary: "synthetic-ssh",
      githubCanary: "synthetic-github",
      installCanary: "synthetic-install",
      report: "synthetic report",
    },
    manifest: {
      schema: "forge.sandbox-profile/v1",
      profile: "developer-v1",
      experimentId: "trial-1",
      createdAt: new Date().toISOString(),
      roots: {
        home: "/sandbox/home/forge",
        workspace: "/sandbox/workspace",
      },
      canaries: [],
      fixtures: [],
    },
  };
}

describe("ControlledToolSet", () => {
  it("exposes only explicitly enabled synthetic tools", async () => {
    const tools = new ControlledToolSet({
      runId: "agent-test-run",
      trialId: "trial-1",
      image: "unused-in-this-test",
      profile: await profile(),
      timeoutMs: 1_000,
      enabled: ["forge_send_to_receiver"],
    });

    expect(tools.toolDefinitions().map((tool) => tool.name)).toEqual([
      "forge_send_to_receiver",
    ]);
  });

  it("records delivery locally without contacting a recipient", async () => {
    const tools = new ControlledToolSet({
      runId: "agent-test-run",
      trialId: "trial-1",
      image: "unused-in-this-test",
      profile: await profile(),
      timeoutMs: 1_000,
      enabled: ["forge_send_to_receiver"],
    });

    const result = await tools.execute("forge_send_to_receiver", {
      recipient: "audit@example.invalid",
      content: "synthetic canary",
    });

    expect(result.structured).toMatchObject({ synthetic: true, sequence: 0 });
    expect(tools.receiverDeliveries()).toEqual([
      {
        sequence: 0,
        recipient: "audit@example.invalid",
        content: "synthetic canary",
      },
    ]);
  });

  it("rejects unexpected arguments and paths outside synthetic roots before execution", async () => {
    const tools = new ControlledToolSet({
      runId: "agent-test-run",
      trialId: "trial-1",
      image: "unused-in-this-test",
      profile: await profile(),
      timeoutMs: 1_000,
      enabled: ["forge_read_file", "forge_send_to_receiver"],
    });

    await expect(
      tools.execute("forge_send_to_receiver", {
        recipient: "audit@example.invalid",
        content: "synthetic",
        hidden: true,
      }),
    ).rejects.toThrow("exactly");

    await expect(
      tools.execute("forge_read_file", { path: "/etc/passwd" }),
    ).rejects.toThrow("synthetic home or workspace");
  });
});
