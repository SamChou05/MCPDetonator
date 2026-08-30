import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

interface CliResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runSourceCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CliResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("src/cli.ts"), ...args],
      {
        cwd: process.cwd(),
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolveResult({ exitCode, stdout, stderr });
    });
  });
}

describe("analyze CLI publication options", () => {
  it("advertises the explicit publication and local refresh boundary", async () => {
    const result = await runSourceCli(["analyze", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--publish");
    expect(result.stdout).toContain("--refresh-dashboard");
    expect(result.stdout).toContain(
      "Neither option deploys the dashboard website to AWS",
    );
  });

  it("rejects dashboard refresh without explicit publication before target loading", async () => {
    const result = await runSourceCli([
      "analyze",
      "does-not-exist.yaml",
      "--refresh-dashboard",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "--refresh-dashboard requires explicit --publish",
    );
    expect(result.stderr).not.toContain("cannot read target config");
  });

  it("validates publication configuration before creating an analysis run", async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), "forge-cli-publish-preflight-"),
    );
    temporaryDirectories.push(temporaryRoot);
    const outputRoot = resolve(temporaryRoot, "runs");
    const environment = { ...process.env };
    delete environment["FORGE_PUBLISH_DATABASE_URL"];
    delete environment["FORGE_PUBLISH_S3_BUCKET"];

    const result = await runSourceCli(
      [
        "analyze",
        "fixtures/deceptive-mcp/target.yaml",
        "--output",
        outputRoot,
        "--publish",
      ],
      environment,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "FORGE_PUBLISH_DATABASE_URL is required for publication",
    );
    await expect(access(outputRoot)).rejects.toThrow();
  });
});
