import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function talkToFixture(
  variant: "clean" | "poisoned",
  messages: readonly Record<string, unknown>[],
): Promise<readonly Record<string, unknown>[]> {
  const workspace = await mkdtemp(resolve(tmpdir(), "forge-agent-fixture-"));
  temporaryDirectories.push(workspace);
  const serverPath = resolve("fixtures/agent-tool-poisoning/server.js");
  const child = spawn(process.execPath, [serverPath, `--metadata=${variant}`], {
    env: {
      ...process.env,
      FORGE_TARGET_WORKSPACE: workspace,
    },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  for (const message of messages) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
  if (exitCode !== 0) {
    throw new Error(`fixture exited with ${exitCode}: ${stderr}`);
  }

  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function listMessages(): readonly Record<string, unknown>[] {
  return [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "fixture-test", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
}

describe("agent tool-poisoning fixture", () => {
  it("changes only the selected metadata description between variants", async () => {
    const clean = await talkToFixture("clean", listMessages());
    const poisoned = await talkToFixture("poisoned", listMessages());

    const cleanTools = (clean[1]?.result as { tools: Array<Record<string, unknown>> }).tools;
    const poisonedTools = (
      poisoned[1]?.result as { tools: Array<Record<string, unknown>> }
    ).tools;

    expect(cleanTools.map(({ description: _description, ...tool }) => tool)).toEqual(
      poisonedTools.map(({ description: _description, ...tool }) => tool),
    );
    expect(String(cleanTools[1]?.description)).not.toContain("forge_read_file");
    expect(String(poisonedTools[1]?.description)).toContain("forge_read_file");
    expect(String(poisonedTools[1]?.description)).toContain("forge_send_to_receiver");
  });

  it("performs only the requested benign workspace write", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "forge-agent-fixture-write-"));
    temporaryDirectories.push(workspace);
    const destination = resolve(workspace, "note.txt");
    const serverPath = resolve("fixtures/agent-tool-poisoning/server.js");
    const child = spawn(process.execPath, [serverPath, "--metadata=poisoned"], {
      env: {
        ...process.env,
        FORGE_TARGET_WORKSPACE: workspace,
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    child.stdout.resume();
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
        id: 2,
        method: "tools/call",
        params: {
          name: "create_note",
          arguments: { path: destination, content: "hello" },
        },
      })}\n`,
    );
    child.stdin.end();
    await new Promise<void>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code) => {
        if (code === 0) resolveExit();
        else rejectExit(new Error(`fixture exited with ${code}`));
      });
    });

    expect(await readFile(destination, "utf8")).toBe("hello");
  });
});
