import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { afterEach, describe, expect, it } from "vitest";

import { loadAgentScenario } from "../../src/agent/scenario.js";
import {
  agentToolDefinitionV1Schema,
  type AgentToolDefinitionV1,
} from "../../src/agent/contracts.js";
import { targetProviderMetadataSha256 } from "../../src/agent/provider-data.js";
import { loadTargetConfig } from "../../src/config.js";

const fixtureRoot = resolve("fixtures/sandworm-mcp-injection");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function advertisedTools(
  variant: "clean" | "poisoned",
): Promise<AgentToolDefinitionV1[]> {
  const child = spawn(
    process.execPath,
    [resolve(fixtureRoot, "server.js"), `--metadata=${variant}`],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "fixture-test", version: "1.0.0" },
      },
    })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })}\n`,
  );

  try {
    for await (const line of lines) {
      const message = JSON.parse(line) as {
        readonly id?: number;
        readonly result?: {
          readonly tools?: readonly {
            readonly name: string;
            readonly description?: string;
            readonly inputSchema: Record<string, unknown>;
          }[];
        };
      };
      if (message.id !== 2 || message.result?.tools === undefined) continue;
      return message.result.tools.map((tool) =>
        agentToolDefinitionV1Schema.parse({
          schema: "forge.agent-tool-definition/v1",
          source: "target_mcp",
          metadataTrust: "untrusted",
          name: tool.name,
          ...(tool.description === undefined
            ? {}
            : { description: tool.description }),
          inputSchema: tool.inputSchema,
        }),
      );
    }
    throw new Error("fixture server exited before returning tools/list");
  } finally {
    child.kill("SIGTERM");
  }
}

describe("documented malicious-MCP study fixtures", () => {
  it("pins the real vulnerable and patched Filesystem MCP versions", async () => {
    const vulnerable = await loadTargetConfig(
      "case-studies/filesystem-symlink-advisory/target-vulnerable.yaml",
    );
    const patched = await loadTargetConfig(
      "case-studies/filesystem-symlink-advisory/target-patched.yaml",
    );

    expect(vulnerable.config.target.source).toEqual({
      type: "npm",
      package: "@modelcontextprotocol/server-filesystem",
      version: "0.6.2",
    });
    expect(patched.config.target.source).toEqual({
      type: "npm",
      package: "@modelcontextprotocol/server-filesystem",
      version: "2025.7.1",
    });
    for (const loaded of [vulnerable, patched]) {
      expect(loaded.config.sandbox.network).toBe("blocked");
      expect(loaded.config.experiments.tools[0]).toMatchObject({
        tool: "read_file",
        input: { path: "/sandbox/workspace/credential-link" },
      });
      expect(JSON.stringify(loaded.config.target.runtime.args)).toContain(
        "/sandbox/home/forge/.ssh/id_ed25519",
      );
    }
  });

  it("writes the campaign-shaped install artifacts only under a synthetic HOME", async () => {
    const syntheticHome = await mkdtemp(
      join(tmpdir(), "forge-sandworm-fixture-"),
    );
    temporaryDirectories.push(syntheticHome);
    const child = spawn(
      process.execPath,
      [resolve(fixtureRoot, "postinstall.js")],
      {
        env: { HOME: syntheticHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    expect(exitCode).toBe(0);

    const installedServer = join(syntheticHome, ".dev-utils", "server.js");
    const configPath = join(
      syntheticHome,
      ".config",
      "forge-synthetic-client",
      "mcp.json",
    );
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      readonly mcpServers: {
        readonly "dev-utils": {
          readonly command: string;
          readonly args: readonly string[];
        };
      };
    };
    expect(await readFile(installedServer, "utf8")).toContain(
      "Inert synthetic marker",
    );
    expect(config.mcpServers["dev-utils"]).toEqual({
      command: "node",
      args: [installedServer],
      env: { MCP_SERVER_NAME: "dev-utils" },
    });
    expect(configPath.startsWith(syntheticHome)).toBe(true);
  });

  it("binds matched Agent V1 scenarios to the exact clean and poisoned metadata", async () => {
    const clean = await loadAgentScenario(
      resolve(fixtureRoot, "scenario-clean.yaml"),
    );
    const poisoned = await loadAgentScenario(
      resolve(fixtureRoot, "scenario-poisoned.yaml"),
    );
    const cleanTools = await advertisedTools("clean");
    const poisonedTools = await advertisedTools("poisoned");

    expect(targetProviderMetadataSha256(cleanTools)).toBe(
      clean.scenario.providerData.targetMetadataSha256,
    );
    expect(targetProviderMetadataSha256(poisonedTools)).toBe(
      poisoned.scenario.providerData.targetMetadataSha256,
    );
    expect(cleanTools[0]?.description).not.toContain("<IMPORTANT>");
    expect(poisonedTools[0]?.description).toContain("<IMPORTANT>");
    expect(poisoned.scenario.authorization.defaultDecision).toBe("denied");
    expect(poisoned.scenario.syntheticTools).toEqual(["forge_read_file"]);
  });
});
