import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadTargetConfig, type TargetConfigV1 } from "../../src/config.js";

const corpusRoot = resolve("case-studies/trace-corpus");

const targetFiles = [
  "memory.target.yaml",
  "everything.target.yaml",
  "sequential-thinking.target.yaml",
  "shell.target.yaml",
] as const;

async function loadCorpus(): Promise<ReadonlyMap<string, TargetConfigV1>> {
  const entries = await Promise.all(
    targetFiles.map(async (file) => {
      const loaded = await loadTargetConfig(join(corpusRoot, file));
      return [file, loaded.config] as const;
    }),
  );
  return new Map(entries);
}

function configFor(
  corpus: ReadonlyMap<string, TargetConfigV1>,
  file: (typeof targetFiles)[number],
): TargetConfigV1 {
  const config = corpus.get(file);
  if (config === undefined) {
    throw new Error(`missing trace-corpus target config: ${file}`);
  }
  return config;
}

describe("evidence-driven trace-corpus target configs", () => {
  it("loads the four exact npm pins with stable target and experiment identities", async () => {
    const corpus = await loadCorpus();

    expect([...corpus.keys()]).toEqual(targetFiles);
    expect(
      targetFiles.map((file) => {
        const config = configFor(corpus, file);
        return {
          file,
          targetId: config.target.id,
          source: config.target.source,
          experimentIds: config.experiments.tools.map(
            (experiment) => experiment.id,
          ),
        };
      }),
    ).toEqual([
      {
        file: "memory.target.yaml",
        targetId: "corpus-official-memory",
        source: {
          type: "npm",
          package: "@modelcontextprotocol/server-memory",
          version: "2026.7.4",
        },
        experimentIds: ["create-synthetic-entity"],
      },
      {
        file: "everything.target.yaml",
        targetId: "corpus-official-everything",
        source: {
          type: "npm",
          package: "@modelcontextprotocol/server-everything",
          version: "2026.8.18",
        },
        experimentIds: ["gzip-synthetic-data", "blocked-network-attempt"],
      },
      {
        file: "sequential-thinking.target.yaml",
        targetId: "corpus-official-sequential-thinking",
        source: {
          type: "npm",
          package: "@modelcontextprotocol/server-sequential-thinking",
          version: "2026.7.4",
        },
        experimentIds: ["one-synthetic-thought"],
      },
      {
        file: "shell.target.yaml",
        targetId: "corpus-community-shell",
        source: {
          type: "npm",
          package: "@mkusaka/mcp-shell-server",
          version: "0.1.1",
        },
        experimentIds: ["controlled-shell-write"],
      },
    ]);
  });

  it("keeps every target credential-free, network-blocked, and resource-bounded", async () => {
    const corpus = await loadCorpus();
    const allowedEnvironment = new Map([
      [
        "memory.target.yaml",
        { MEMORY_FILE_PATH: "/sandbox/workspace/memory.jsonl" },
      ],
      ["everything.target.yaml", {}],
      [
        "sequential-thinking.target.yaml",
        { DISABLE_THOUGHT_LOGGING: "true" },
      ],
      ["shell.target.yaml", {}],
    ]);

    for (const file of targetFiles) {
      const config = configFor(corpus, file);
      expect(config.target.source.type).toBe("npm");
      expect(config.target.runtime.transport).toBe("stdio");
      expect(config.target.runtime.command).toBe("node");
      expect(config.target.runtime.env).toEqual(allowedEnvironment.get(file));
      expect(config.sandbox).toMatchObject({
        profile: "developer-v1",
        network: "blocked",
      });
      expect(config.sandbox.limits.timeoutMs).toBeLessThanOrEqual(20_000);
      expect(config.sandbox.limits.installTimeoutMs).toBeLessThanOrEqual(
        120_000,
      );
      expect(config.sandbox.limits.cooldownMs).toBeLessThanOrEqual(500);
      expect(config.sandbox.limits.memoryMb).toBeLessThanOrEqual(256);
      expect(config.sandbox.limits.cpus).toBeLessThanOrEqual(1);
      expect(config.sandbox.limits.pids).toBeLessThanOrEqual(96);
      expect(config.experiments.workflows).toEqual([]);

      for (const experiment of config.experiments.tools) {
        for (const destination of experiment.expected.networkConnections) {
          expect(destination.address).toBe("127.0.0.1");
        }
      }
    }
  });

  it("pins the Everything probe to a syscall-reachable high loopback port", async () => {
    const everything = configFor(await loadCorpus(), "everything.target.yaml");
    const blockedAttempt = everything.experiments.tools.find(
      (experiment) => experiment.id === "blocked-network-attempt",
    );

    expect(blockedAttempt).toMatchObject({
      tool: "gzip-file-as-resource",
      input: {
        name: "unreachable.txt.gz",
        data: "http://127.0.0.1:54321/forge-synthetic",
        outputType: "resource",
      },
      expected: {
        networkConnections: [{ address: "127.0.0.1", port: 54_321 }],
      },
    });
  });

  it("bounds the community Shell case to one synthetic-home command and workspace write", async () => {
    const shell = configFor(await loadCorpus(), "shell.target.yaml");
    const experiment = shell.experiments.tools[0];

    expect(shell.target.runtime.cwd).toBe("/sandbox/home/forge");
    expect(experiment).toEqual({
      id: "controlled-shell-write",
      tool: "shell_exec",
      input: {
        command:
          "printf '%s\\n' 'Forge bounded shell output' > /sandbox/workspace/shell-output.txt",
        workingDir: "/sandbox/home/forge",
      },
      expected: {
        fileReads: [],
        fileReadPrefixes: [],
        fileWrites: [
          "/sandbox/home/forge/mcp-shell.log",
          "/sandbox/workspace/shell-output.txt",
        ],
        fileWritePrefixes: [],
        networkConnections: [],
        childExecutables: ["/bin/bash", "/usr/bin/bash"],
        childExecutablePrefixes: [],
      },
    });
  });
});
