import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const script = resolve(process.cwd(), "scripts", "deploy-dashboard.mjs");
const template = resolve(process.cwd(), "infra", "aws", "dashboard.yaml");
const fakeAwsFixture = resolve(
  process.cwd(),
  "test",
  "fixtures",
  "fake-aws-dashboard-cli.mjs",
);
const account = "123456789012";
const stackName = "forge-dashboard-demo";
const region = "us-east-1";
const stackId = `arn:aws:cloudformation:${region}:${account}:stack/${stackName}/12345678-1234-1234-1234-123456789abc`;
const fixtureDirectories: string[] = [];

function sha256(bytes: Uint8Array): { base64: string; hex: string } {
  return {
    base64: createHash("sha256").update(bytes).digest("base64"),
    hex: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function createContentOnlyFixture(
  mode: "success" | "etag-conflict" | "invalidation-wait-failure",
): Promise<{
  readonly commandLogPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly scriptPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "forge-dashboard-deploy-test-"));
  fixtureDirectories.push(root);
  const stateDirectory = join(root, "fake-aws-state");
  const objectDirectory = join(stateDirectory, "objects");
  const binDirectory = join(root, "bin");
  await Promise.all([
    mkdir(join(root, "scripts"), { recursive: true }),
    mkdir(join(root, "infra", "aws"), { recursive: true }),
    mkdir(join(root, "dist", "dashboard-site"), { recursive: true }),
    mkdir(objectDirectory, { recursive: true }),
    mkdir(binDirectory, { recursive: true }),
  ]);

  const scriptPath = join(root, "scripts", "deploy-dashboard.mjs");
  const fakeAwsPath = join(binDirectory, "aws");
  await Promise.all([
    copyFile(script, scriptPath),
    copyFile(template, join(root, "infra", "aws", "dashboard.yaml")),
    copyFile(fakeAwsFixture, fakeAwsPath),
  ]);
  await chmod(fakeAwsPath, 0o755);

  const indexBytes = Buffer.from("<!doctype html><title>Current Forge result</title>\n");
  const styleBytes = Buffer.from("body { color: #111; }\n");
  await Promise.all([
    writeFile(join(root, "dist", "dashboard-site", "index.html"), indexBytes),
    writeFile(join(root, "dist", "dashboard-site", "styles.css"), styleBytes),
  ]);
  const manifest = {
    schemaVersion: "forge.dashboard-build/v1",
    files: [
      {
        path: "index.html",
        sha256: sha256(indexBytes).hex,
        bytes: indexBytes.byteLength,
      },
      {
        path: "styles.css",
        sha256: sha256(styleBytes).hex,
        bytes: styleBytes.byteLength,
      },
    ],
  };
  await writeFile(
    join(root, "dist", "dashboard-site.manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const oldIndexPath = join(objectDirectory, "index.html");
  const oldStylePath = join(objectDirectory, "styles.css");
  const oldIndex = Buffer.from("<!doctype html><title>Old result</title>\n");
  const oldStyle = Buffer.from("body { color: #222; }\n");
  await Promise.all([
    writeFile(oldIndexPath, oldIndex),
    writeFile(oldStylePath, oldStyle),
    writeFile(join(stateDirectory, "commands.jsonl"), ""),
  ]);
  await writeFile(
    join(stateDirectory, "state.json"),
    `${JSON.stringify(
      {
        account,
        bucket: "forge-dashboard-demo-site-1234",
        distributionId: "EDFDVBD6EXAMPLE",
        domain: "d111111abcdef8.cloudfront.net",
        mode,
        objects: {
          "index.html": {
            cacheControl: "no-cache,max-age=0,must-revalidate",
            checksumSha256: sha256(oldIndex).base64,
            contentType: "text/html; charset=utf-8",
            etag: `"${"a".repeat(32)}"`,
            path: oldIndexPath,
          },
          "styles.css": {
            cacheControl: "public,max-age=300,must-revalidate",
            checksumSha256: sha256(oldStyle).base64,
            contentType: "text/css; charset=utf-8",
            etag: `"${"b".repeat(32)}"`,
            path: oldStylePath,
          },
        },
        stackId,
        stackName,
      },
      null,
      2,
    )}\n`,
  );

  return {
    commandLogPath: join(stateDirectory, "commands.jsonl"),
    environment: {
      ...process.env,
      FAKE_AWS_STATE_DIRECTORY: stateDirectory,
      PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
    },
    scriptPath,
  };
}

function runContentOnly(
  fixture: Awaited<ReturnType<typeof createContentOnlyFixture>>,
) {
  return spawnSync(
    process.execPath,
    [
      fixture.scriptPath,
      "--account",
      account,
      "--stack",
      stackName,
      "--stack-id",
      stackId,
      "--region",
      region,
      "--content-only",
      "--yes",
    ],
    {
      encoding: "utf8",
      env: fixture.environment,
      shell: false,
      timeout: 30_000,
    },
  );
}

async function readCommands(path: string): Promise<readonly string[][]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

afterEach(async () => {
  await Promise.all(
    fixtureDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("dashboard deployment CLI", () => {
  it("allows CloudFront to read only the two public presentation objects", () => {
    const source = readFileSync(template, "utf8");

    expect(source).toContain("${DashboardBucket.Arn}/index.html");
    expect(source).toContain("${DashboardBucket.Arn}/styles.css");
    expect(source).not.toContain("Resource: !Sub '${DashboardBucket.Arn}/*'");
  });

  it("documents the explicit content-only refresh mode", () => {
    const result = spawnSync(process.execPath, [script, "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: false,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[--content-only]");
    expect(result.stdout).toContain("skips CloudFormation");
  });

  it("requires an exact existing stack ID before any AWS call", () => {
    const result = spawnSync(
      process.execPath,
      [
        script,
        "--account",
        "123456789012",
        "--stack",
        "forge-dashboard-demo",
        "--region",
        "us-east-1",
        "--content-only",
        "--yes",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        shell: false,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "--content-only requires the exact existing --stack-id",
    );
    expect(result.stderr).not.toContain("AWS CLI v2 must be installed");
  });

  it("refreshes exactly two objects conditionally and waits for invalidation", async () => {
    const fixture = await createContentOnlyFixture("success");
    const result = runContentOnly(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Forge dashboard content refresh complete");
    const commands = await readCommands(fixture.commandLogPath);
    expect(
      commands.some(
        ([service, operation]) =>
          service === "cloudformation" &&
          (operation === "deploy" || operation === "create-stack"),
      ),
    ).toBe(false);
    const puts = commands.filter(
      ([service, operation]) =>
        service === "s3api" && operation === "put-object",
    );
    expect(puts).toHaveLength(2);
    expect(puts.every((command) => command.includes("--if-match"))).toBe(true);
    const indexPut = puts.find(
      (command) => command[command.indexOf("--key") + 1] === "index.html",
    );
    expect(indexPut?.[indexPut.indexOf("--cache-control") + 1]).toBe(
      "no-cache,max-age=0,must-revalidate",
    );
    expect(
      commands.filter(
        ([service, operation]) =>
          service === "s3api" && operation === "get-object",
      ),
    ).toHaveLength(2);
    expect(
      commands.some(
        ([service, operation]) =>
          service === "cloudfront" && operation === "wait",
      ),
    ).toBe(true);
    expect(
      commands.some(
        ([service, operation]) =>
          service === "cloudfront" && operation === "get-invalidation",
      ),
    ).toBe(true);
  });

  it("stops before invalidation when a conditional object write conflicts", async () => {
    const fixture = await createContentOnlyFixture("etag-conflict");
    const result = runContentOnly(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AWS CLI command failed with exit code 94");
    const commands = await readCommands(fixture.commandLogPath);
    expect(
      commands.filter(
        ([service, operation]) =>
          service === "s3api" && operation === "put-object",
      ),
    ).toHaveLength(1);
    expect(commands.some(([service]) => service === "cloudfront")).toBe(false);
  });

  it("fails closed when the CloudFront invalidation wait fails", async () => {
    const fixture = await createContentOnlyFixture(
      "invalidation-wait-failure",
    );
    const result = runContentOnly(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AWS CLI command failed with exit code 97");
    const commands = await readCommands(fixture.commandLogPath);
    expect(
      commands.filter(
        ([service, operation]) =>
          service === "s3api" && operation === "get-object",
      ),
    ).toHaveLength(2);
    expect(
      commands.some(
        ([service, operation]) =>
          service === "cloudfront" && operation === "wait",
      ),
    ).toBe(true);
    expect(
      commands.some(
        ([service, operation]) =>
          service === "cloudfront" && operation === "get-invalidation",
      ),
    ).toBe(false);
  });
});
