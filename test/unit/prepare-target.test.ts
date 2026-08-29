import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadTargetConfig } from "../../src/config.js";
import { EvidenceStore } from "../../src/evidence-store.js";
import { prepareTarget } from "../../src/target/prepare.js";

describe("generic prepared target handoff", () => {
  it("snapshots an unrelated local package before it can execute", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-prepared-target-test-"));
    const sourceRoot = join(root, "independent-server");
    const outputRoot = join(root, "evidence");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(
      join(sourceRoot, "package.json"),
      `${JSON.stringify({
        name: "independent-stdio-server",
        version: "7.3.1",
        type: "module",
      })}\n`,
      "utf8",
    );
    await writeFile(join(sourceRoot, "server.js"), "process.exit(0);\n", "utf8");
    const configPath = join(root, "target.yaml");
    await writeFile(
      configPath,
      `schema: forge.target/v1
target:
  id: independent-server
  source:
    type: local
    path: ./independent-server
    install: none
  runtime:
    transport: stdio
    command: node
    args: [/opt/target/server.js]
sandbox:
  profile: developer-v1
  network: blocked
  limits:
    timeoutMs: 1000
    cooldownMs: 0
    memoryMb: 128
    cpus: 1
    pids: 32
experiments:
  initialization: false
  tools:
    - id: placeholder
      tool: placeholder
      input: {}
      expected:
        fileReads: []
        fileWrites: []
        networkConnections: []
        childExecutables: []
  workflows: []
`,
      "utf8",
    );

    const loaded = await loadTargetConfig(configPath);
    const store = await EvidenceStore.create(outputRoot, "run-independent");
    const prepared = await prepareTarget({
      loaded,
      runId: "run-independent",
      store,
      image: "not-used-for-install-none",
    });

    expect(prepared.containerRoot).toBe("/opt/target");
    expect(prepared.hostRoot).not.toBe(sourceRoot);
    expect(prepared.provenance.source).toMatchObject({
      type: "local",
      sourceFileCount: 2,
    });
    expect(prepared.provenance.install).toEqual({
      strategy: "none",
      lifecycleScripts: "disabled",
    });

    await writeFile(join(sourceRoot, "server.js"), "throw new Error('changed');\n");
    expect(await readFile(join(prepared.hostRoot, "server.js"), "utf8")).toBe(
      "process.exit(0);\n",
    );
    expect(
      JSON.parse(
        await readFile(store.pathFor("target/provenance.json"), "utf8"),
      ),
    ).toMatchObject({
      schema: "forge.target-provenance/v1",
      targetId: "independent-server",
    });

    const preparedRoot = prepared.hostRoot;
    await prepared.dispose();
    await expect(access(preparedRoot)).rejects.toThrow();
  });
});
