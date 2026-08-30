import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { EvidenceStore } from "../../src/evidence-store.js";
import { analyzeNodeSemanticSources } from "../../src/static/node-semantic-engine.js";
import {
  runNodeSemanticAnalysis,
  verifyNodeSemanticAnalysis,
} from "../../src/static/node-semantic.js";
import { inspectNodePackage } from "../../src/static/node-package.js";
import { nodeSemanticStaticV1Schema } from "../../src/static/semantic-contracts.js";

async function packageRoot(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forge-semantic-package-"));
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
  return root;
}

async function storeFor(runId: string): Promise<EvidenceStore> {
  return await EvidenceStore.create(
    await mkdtemp(join(tmpdir(), "forge-semantic-output-")),
    runId,
  );
}

describe("Node semantic sidecar orchestration", () => {
  it("analyzes only revalidated captured bytes and retains a strict artifact", async () => {
    const runId = "run-semantic-sidecar";
    const targetId = "semantic-package";
    const store = await storeFor(runId);
    const root = await packageRoot({
      "package.json": JSON.stringify({ name: targetId, version: "1.0.0" }),
      "src/index.ts": [
        'import { readFile as load } from "node:fs/promises";',
        'await load("/tmp/input");',
      ].join("\n"),
    });
    const inspection = await inspectNodePackage({
      store,
      runId,
      targetId,
      packageRoot: root,
    });

    const result = await runNodeSemanticAnalysis({
      store,
      runId,
      targetId,
      workerRunner: async (input) => analyzeNodeSemanticSources(input),
    });
    const retained = nodeSemanticStaticV1Schema.parse(
      JSON.parse(
        await readFile(store.pathFor(result.artifactPath), "utf8"),
      ),
    );

    expect(result.analysis.status).toBe("completed");
    expect(result.analysis.callsites).toHaveLength(1);
    expect(result.analysis.callsites[0]?.sinkId).toBe(
      "node.fs.promises.readFile.call",
    );
    expect(retained).toEqual(result.analysis);
    expect(() =>
      verifyNodeSemanticAnalysis({
        analysis: retained,
        inspection,
        lexicalInspectionArtifact: "static/inspection.json",
        lexicalInspectionSha256: retained.input.lexicalInspectionSha256,
      }),
    ).not.toThrow();
  });

  it("fails closed when captured content no longer matches its declared digest", async () => {
    const runId = "run-semantic-corrupt";
    const targetId = "corrupt-package";
    const store = await storeFor(runId);
    const root = await packageRoot({
      "package.json": JSON.stringify({ name: targetId, version: "1.0.0" }),
      "index.js": 'fetch("https://example.test");',
    });
    const inspection = await inspectNodePackage({
      store,
      runId,
      targetId,
      packageRoot: root,
    });
    const source = inspection.source.scannedFiles[0];
    if (source === undefined) throw new Error("missing captured test source");
    const rawPath = store.pathFor(source.evidence.artifactPath);
    const raw = JSON.parse(await readFile(rawPath, "utf8")) as Record<
      string,
      unknown
    >;
    raw.content = 'fetch("https://changed.example.test");';
    await writeFile(rawPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const result = await runNodeSemanticAnalysis({
      store,
      runId,
      targetId,
      workerRunner: async (input) => analyzeNodeSemanticSources(input),
    });

    expect(result.analysis.status).toBe("failed");
    expect(result.analysis.failure).toMatchObject({ kind: "invalid_input" });
    expect(result.analysis.callsites).toEqual([]);
    expect(result.analysis.files).toHaveLength(1);
    expect(result.analysis.files[0]?.parseStatus).toBe("not_analyzed");
  });

  it("runs the compiler in the resource-limited worker boundary", async () => {
    const runId = "run-semantic-worker";
    const targetId = "worker-package";
    const store = await storeFor(runId);
    const root = await packageRoot({
      "package.json": JSON.stringify({ name: targetId, version: "1.0.0" }),
      "index.mjs": 'fetch("https://example.test");',
    });
    await inspectNodePackage({
      store,
      runId,
      targetId,
      packageRoot: root,
    });

    const result = await runNodeSemanticAnalysis({ store, runId, targetId });

    expect(result.analysis.status).toBe("completed");
    expect(result.analysis.callsites[0]?.sinkId).toBe(
      "node.global.fetch.call",
    );
  });

  it("returns failed timeout evidence only after terminating the worker", async () => {
    const runId = "run-semantic-timeout";
    const targetId = "timeout-package";
    const store = await storeFor(runId);
    const root = await packageRoot({
      "package.json": JSON.stringify({ name: targetId, version: "1.0.0" }),
      "index.mjs": Array.from(
        { length: 2_000 },
        (_, index) => `fetch("https://example.test/${index}");`,
      ).join("\n"),
    });
    await inspectNodePackage({ store, runId, targetId, packageRoot: root });

    const result = await runNodeSemanticAnalysis({
      store,
      runId,
      targetId,
      limits: { timeoutMs: 1 },
    });

    expect(result.analysis.status).toBe("failed");
    expect(result.analysis.failure).toMatchObject({ kind: "timeout" });
    expect(result.analysis.callsites).toEqual([]);
  });
});
