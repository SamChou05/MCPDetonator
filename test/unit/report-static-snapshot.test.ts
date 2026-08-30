import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { targetConfigV1Schema } from "../../src/config.js";
import {
  reportV1Schema,
  type TargetProvenanceV1,
} from "../../src/contracts/v1.js";
import { EvidenceStore, sha256 } from "../../src/evidence-store.js";
import { assertReportStaticIdentity, writeReport } from "../../src/report.js";
import { analyzeNodeSemanticSources } from "../../src/static/node-semantic-engine.js";
import { runNodeSemanticAnalysis } from "../../src/static/node-semantic.js";
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
    await runNodeSemanticAnalysis({
      store,
      runId: "run-static-alignment",
      targetId: "snapshot-package",
      lexicalInspectionArtifact: "static/pre-install-inspection.json",
      artifactPath: "static/pre-install-semantic-inspection.json",
      workerRunner: async (input) => analyzeNodeSemanticSources(input),
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
    const semanticAnalysis = await runNodeSemanticAnalysis({
      store,
      runId: "run-static-alignment",
      targetId: "snapshot-package",
      workerRunner: async (input) => analyzeNodeSemanticSources(input),
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
      interfaces: [
        {
          schema: "forge.mcp-interface/v1",
          runId: "run-static-alignment",
          experimentId: "inspect-snapshot",
          server: { name: "snapshot-server", version: "2.0.0" },
          tools: [
            {
              name: "inspect_snapshot",
              title: "Inspect selected snapshot",
              description: "Returns bounded snapshot metadata.",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
              },
            },
          ],
        },
      ],
      provenance,
      staticInspection: runtimeInspection,
      semanticAnalysis,
      profileRootsByExperiment: new Map([
        [
          "inspect-snapshot",
          { home: "/sandbox/home/forge", workspace: "/sandbox/workspace" },
        ],
      ]),
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
      semanticInspection: "static/semantic-inspection.json",
      preInstallSemanticInspection:
        "static/pre-install-semantic-inspection.json",
      advertisedClaims: "mcp/advertised-claims.json",
    });
    expect(report.semanticAnalysis).toMatchObject({
      status: "completed",
      artifactPath: "static/semantic-inspection.json",
      artifactSha256: semanticAnalysis.artifactSha256,
      callsiteCount: 0,
    });
    const withoutSemanticEvidence = structuredClone(report);
    delete withoutSemanticEvidence.evidence.semanticInspection;
    expect(reportV1Schema.safeParse(withoutSemanticEvidence).success).toBe(false);
    const wrongSemanticPath = structuredClone(report);
    if (wrongSemanticPath.semanticAnalysis === undefined) {
      throw new Error("semantic report summary was not retained");
    }
    wrongSemanticPath.semanticAnalysis.artifactPath =
      "static/not-the-retained-semantic-artifact.json";
    expect(reportV1Schema.safeParse(wrongSemanticPath).success).toBe(false);
    const contradictorySemanticStatus = structuredClone(report);
    if (contradictorySemanticStatus.semanticAnalysis === undefined) {
      throw new Error("semantic report summary was not retained");
    }
    contradictorySemanticStatus.semanticAnalysis.coverage.resolutionIncomplete =
      true;
    expect(reportV1Schema.safeParse(contradictorySemanticStatus).success).toBe(
      false,
    );
    const duplicateSemanticTruncations = structuredClone(report);
    if (duplicateSemanticTruncations.semanticAnalysis === undefined) {
      throw new Error("semantic report summary was not retained");
    }
    duplicateSemanticTruncations.semanticAnalysis.status = "partial";
    duplicateSemanticTruncations.semanticAnalysis.coverage.resolutionIncomplete =
      true;
    duplicateSemanticTruncations.semanticAnalysis.truncations = [
      "ast_nodes",
      "ast_nodes",
    ];
    expect(reportV1Schema.safeParse(duplicateSemanticTruncations).success).toBe(
      false,
    );

    const wrongSemanticRun = structuredClone(semanticAnalysis);
    wrongSemanticRun.analysis.runId = "run-not-this-report";
    expect(() =>
      assertReportStaticIdentity({
        runId: "run-static-alignment",
        targetId: "snapshot-package",
        inspection: runtimeInspection,
        semanticAnalysis: wrongSemanticRun,
      }),
    ).toThrow("semantic inspection does not belong");
    const wrongLexicalTarget = structuredClone(runtimeInspection);
    wrongLexicalTarget.targetId = "another-package";
    expect(() =>
      assertReportStaticIdentity({
        runId: "run-static-alignment",
        targetId: "snapshot-package",
        inspection: wrongLexicalTarget,
        semanticAnalysis,
      }),
    ).toThrow("static inspection does not belong");
    expect(report.advertisedTools[0]).toMatchObject({
      name: "inspect_snapshot",
      title: "Inspect selected snapshot",
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(report.advertisedClaims.interfaces[0]?.annotations).toHaveLength(2);
  });
});
