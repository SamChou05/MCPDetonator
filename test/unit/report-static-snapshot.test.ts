import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { targetConfigV1Schema } from "../../src/config.js";
import type { TargetProvenanceV1 } from "../../src/contracts/v1.js";
import { EvidenceStore, sha256 } from "../../src/evidence-store.js";
import { writeReport } from "../../src/report.js";
import { inspectNodePackage } from "../../src/static/node-package.js";

describe("report static snapshot alignment", () => {
  it("summarizes the selected runtime snapshot and links the earlier inspection", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "forge-report-output-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "forge-report-package-"));
    const store = await EvidenceStore.create(outputRoot, "run-static-alignment");
    const packageJson = join(packageRoot, "package.json");

    await writeFile(
      packageJson,
      `${JSON.stringify({ name: "snapshot-package", version: "1.0.0" })}\n`,
    );
    await inspectNodePackage({
      store,
      runId: "run-static-alignment",
      targetId: "snapshot-package",
      packageRoot,
      artifactPath: "static/pre-install-inspection.json",
    });

    await writeFile(
      packageJson,
      `${JSON.stringify({ name: "snapshot-package", version: "2.0.0" })}\n`,
    );
    const runtimeInspection = await inspectNodePackage({
      store,
      runId: "run-static-alignment",
      targetId: "snapshot-package",
      packageRoot,
    });
    const runtimeTreeSha256 = sha256("selected runtime tree");
    const provenance: TargetProvenanceV1 = {
      schema: "forge.target-provenance/v1",
      runId: "run-static-alignment",
      targetId: "snapshot-package",
      preparedAt: "2026-08-29T20:00:00.000Z",
      containerRoot: "/opt/target",
      containerPackageRoot: "/opt/target",
      source: {
        type: "local",
        configuredPath: "/input/snapshot-package",
        sourceTreeSha256: sha256("source tree"),
        sourceFileCount: 1,
      },
      install: { strategy: "npm-ci", lifecycleScripts: "disabled" },
      runtimeSnapshot: {
        sourceExperimentId: "install-scripts-enabled",
        lifecycleScripts: "enabled",
        treeSha256: runtimeTreeSha256,
        fileCount: 7,
      },
      limitations: [],
    };
    const config = targetConfigV1Schema.parse({
      schema: "forge.target/v1",
      target: {
        id: "snapshot-package",
        source: {
          type: "local",
          path: "/input/snapshot-package",
          install: "npm-ignore-scripts",
        },
        runtime: {
          transport: "stdio",
          command: "node",
          args: ["/opt/target/index.js"],
        },
      },
      sandbox: {
        profile: "developer-v1",
        network: "blocked",
        limits: {
          timeoutMs: 10_000,
          cooldownMs: 0,
          memoryMb: 256,
          cpus: 1,
          pids: 64,
        },
      },
      experiments: {
        initialization: false,
        tools: [
          {
            id: "inspect-snapshot",
            tool: "inspect_snapshot",
            input: {},
            expected: {
              fileReads: [],
              fileWrites: [],
              networkConnections: [],
              childExecutables: [],
            },
          },
        ],
        workflows: [],
      },
    });

    const report = await writeReport({
      store,
      runId: "run-static-alignment",
      config,
      events: [],
      phases: [],
      attributions: [],
      findings: [],
      interfaces: [],
      provenance,
      staticInspection: runtimeInspection,
      limitations: [],
    });

    expect(report.staticAnalysis.snapshot).toEqual({
      basis: "selected-runtime-snapshot",
      sourceExperimentId: "install-scripts-enabled",
      lifecycleScripts: "enabled",
      treeSha256: runtimeTreeSha256,
      fileCount: 7,
    });
    expect(report.staticAnalysis.manifest).toMatchObject({
      status: "parsed",
      name: "snapshot-package",
      version: "2.0.0",
    });
    expect(report.evidence).toMatchObject({
      staticInspection: "static/inspection.json",
      preInstallStaticInspection: "static/pre-install-inspection.json",
    });
  });
});
