import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadTargetConfig, TargetConfigError } from "../../src/config.js";

const validTarget = `
schema: forge.target/v1
target:
  id: deceptive-fixture
  source:
    type: fixture
    path: ./package
  runtime:
    transport: stdio
    command: node
    args:
      - /opt/forge/server.js
sandbox:
  profile: developer-v1
  network: blocked
  limits:
    timeoutMs: 10000
    cooldownMs: 500
    memoryMb: 256
    cpus: 1
    pids: 64
experiments:
  initialization: true
  tools:
    - id: summarize-file
      tool: summarize_file
      input:
        path: /sandbox/workspace/report.txt
      expected:
        fileReads:
          - /sandbox/workspace/report.txt
        fileWrites: []
        networkConnections: []
        childExecutables: []
  workflows: []
`;

async function writeTarget(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "forge-config-"));
  const path = join(directory, "target.yaml");
  await writeFile(path, contents, "utf8");
  return path;
}

describe("loadTargetConfig", () => {
  it("loads a deterministic fixture target", async () => {
    const path = await writeTarget(validTarget);
    const loaded = await loadTargetConfig(path);

    expect(loaded.config.schema).toBe("forge.target/v1");
    expect(loaded.config.experiments.tools[0]?.tool).toBe("summarize_file");
  });

  it("rejects npm tags and ranges", async () => {
    const path = await writeTarget(
      validTarget
        .replace("type: fixture\n    path: ./package", "type: npm\n    package: example-mcp\n    version: latest")
        .replace("id: deceptive-fixture", "id: npm-target"),
    );

    await expect(loadTargetConfig(path)).rejects.toThrow(TargetConfigError);
    await expect(loadTargetConfig(path)).rejects.toThrow("exact semantic version");
  });

  it("rejects relative expected filesystem paths", async () => {
    const path = await writeTarget(
      validTarget.replace(
        "/sandbox/workspace/report.txt\n        fileWrites",
        "report.txt\n        fileWrites",
      ),
    );

    await expect(loadTargetConfig(path)).rejects.toThrow("absolute Linux path");
  });

  it("rejects duplicate experiment identifiers", async () => {
    const duplicated = validTarget.replace(
      "  workflows: []",
      `    - id: summarize-file
      tool: summarize_file
      input:
        path: /sandbox/workspace/report.txt
      expected:
        fileReads: [/sandbox/workspace/report.txt]
        fileWrites: []
        networkConnections: []
        childExecutables: []
  workflows: []`,
    );
    const path = await writeTarget(duplicated);

    await expect(loadTargetConfig(path)).rejects.toThrow("must be unique");
  });

  it("reserves the baseline initialization experiment ID while initialization is enabled", async () => {
    const path = await writeTarget(
      validTarget.replace("id: summarize-file", "id: baseline-initialization"),
    );

    await expect(loadTargetConfig(path)).rejects.toThrow(TargetConfigError);
    await expect(loadTargetConfig(path)).rejects.toThrow(
      "'baseline-initialization' is reserved while initialization is enabled",
    );
  });

  it("allows the baseline initialization ID when initialization is disabled", async () => {
    const path = await writeTarget(
      validTarget
        .replace("initialization: true", "initialization: false")
        .replace("id: summarize-file", "id: baseline-initialization"),
    );

    const loaded = await loadTargetConfig(path);
    expect(loaded.config.experiments.tools[0]?.id).toBe(
      "baseline-initialization",
    );
  });

  it.each(["install-scripts-disabled", "install-scripts-enabled"])(
    "reserves internal install experiment ID %s",
    async (experimentId) => {
      const path = await writeTarget(
        validTarget.replace("id: summarize-file", `id: ${experimentId}`),
      );

      await expect(loadTargetConfig(path)).rejects.toThrow(TargetConfigError);
      await expect(loadTargetConfig(path)).rejects.toThrow(
        `'${experimentId}' is reserved for install lifecycle evidence`,
      );
    },
  );

  it("rejects workflow experiments because execution is not implemented", async () => {
    const withWorkflow = validTarget.replace(
      "  workflows: []",
      `  workflows:
    - id: summarize-workflow
      steps:
        - tool: summarize_file
          input: { path: /sandbox/workspace/report.txt }
        - tool: summarize_file
          input: { path: /sandbox/workspace/report.txt }
      expected:
        fileReads: [/sandbox/workspace/report.txt]
        fileWrites: []
        networkConnections: []
        childExecutables: []`,
    );
    const path = await writeTarget(withWorkflow);

    await expect(loadTargetConfig(path)).rejects.toThrow(TargetConfigError);
    await expect(loadTargetConfig(path)).rejects.toThrow(
      "experiments.workflows: workflow experiments are not implemented; workflows must be empty",
    );
  });
});
