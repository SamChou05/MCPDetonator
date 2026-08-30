import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  reportV1Schema,
  runManifestV1Schema,
} from "../../src/contracts/v1.js";
// @ts-expect-error The maintainer script is intentionally plain ESM JavaScript.
import * as sampleRefresh from "../../scripts/refresh-sample-reports.mjs";

const { assertSampleContentSafe, refreshSampleReports } = sampleRefresh;

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const observerImageId = `sha256:${"a".repeat(64)}`;
const temporaryRoots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function manifest(
  runId: string,
  targetId: string,
  reportSource: string,
  semanticArtifacts: readonly { path: string; source: string }[],
  imageId = observerImageId,
) {
  return {
    schema: "forge.run/v1",
    runId,
    targetId,
    configSha256: "b".repeat(64),
    status: "completed",
    createdAt: "2026-08-30T00:00:00.000Z",
    completedAt: "2026-08-30T00:00:01.000Z",
    sandboxPolicy: {
      profile: "developer-v1",
      network: "blocked",
      timeoutMs: 10_000,
    },
    toolchain: {
      forgeVersion: "0.1.0",
      nodeVersion: process.version,
      observerImageReference: "forge-sandbox:dev",
      observerImageId: imageId,
    },
    limitations: ["Synthetic refresh-script test manifest."],
    artifacts: [
      {
        path: "report.json",
        sha256: sha256(reportSource),
        mediaType: "application/json",
      },
      ...semanticArtifacts.map((artifact) => ({
        path: artifact.path,
        sha256: sha256(artifact.source),
        mediaType: "application/json",
      })),
    ],
  };
}

function semanticArtifact(
  runId: string,
  targetId: string,
  lexicalInspectionArtifact: string,
): string {
  return `${JSON.stringify(
    {
      schema: "forge.node-semantic-static/v1",
      runId,
      targetId,
      input: { lexicalInspectionArtifact },
    },
    null,
    2,
  )}\n`;
}

function prepareReport(reportSource: string) {
  const report = reportV1Schema.parse(JSON.parse(reportSource));
  if (
    report.semanticAnalysis === undefined ||
    report.evidence.semanticInspection === undefined ||
    report.evidence.preInstallSemanticInspection === undefined
  ) {
    throw new Error("sample fixture requires semantic report evidence");
  }
  const semanticArtifacts = [
    {
      path: report.evidence.semanticInspection,
      source: semanticArtifact(
        report.runId,
        report.targetId,
        "static/inspection.json",
      ),
    },
    {
      path: report.evidence.preInstallSemanticInspection,
      source: semanticArtifact(
        report.runId,
        report.targetId,
        "static/pre-install-inspection.json",
      ),
    },
  ];
  report.semanticAnalysis.artifactSha256 = sha256(semanticArtifacts[0]!.source);
  return {
    reportSource: `${JSON.stringify(report, null, 2)}\n`,
    semanticArtifacts,
    runId: report.runId,
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-refresh-samples-"));
  temporaryRoots.push(root);
  const sampleRoot = join(root, "examples", "reports");
  const [deceptiveReportSource, filesystemReportSource] = await Promise.all([
    readFile(
      join(
        repositoryRoot,
        "examples",
        "reports",
        "deceptive-control.report.json",
      ),
      "utf8",
    ),
    readFile(
      join(
        repositoryRoot,
        "examples",
        "reports",
        "official-filesystem.report.json",
      ),
      "utf8",
    ),
  ]);
  const deceptive = prepareReport(deceptiveReportSource);
  const filesystem = prepareReport(filesystemReportSource);
  const deceptiveReport = deceptive.reportSource;
  const filesystemReport = filesystem.reportSource;
  const deceptiveRunId = deceptive.runId;
  const filesystemRunId = filesystem.runId;
  const deceptiveDirectory = join(root, "runs", deceptiveRunId);
  const filesystemDirectory = join(root, "runs", filesystemRunId);
  await Promise.all([
    mkdir(sampleRoot, { recursive: true }),
    mkdir(deceptiveDirectory, { recursive: true }),
    mkdir(filesystemDirectory, { recursive: true }),
    mkdir(join(deceptiveDirectory, "static"), { recursive: true }),
    mkdir(join(filesystemDirectory, "static"), { recursive: true }),
  ]);
  const readme = [
    "# Sample reports",
    "",
    "- `deceptive-control.report.json` is the report from `run-old-deceptive`.",
    "- `official-filesystem.report.json` is the report from `run-old-filesystem`.",
    "",
  ].join("\n");

  await Promise.all([
    writeFile(join(deceptiveDirectory, "report.json"), deceptiveReport, "utf8"),
    writeFile(
      join(deceptiveDirectory, "run.json"),
      `${JSON.stringify(
        manifest(
          deceptiveRunId,
          "deceptive-document-summarizer",
          deceptiveReport,
          deceptive.semanticArtifacts,
        ),
        null,
        2,
      )}\n`,
      "utf8",
    ),
    writeFile(join(filesystemDirectory, "report.json"), filesystemReport, "utf8"),
    writeFile(
      join(filesystemDirectory, "run.json"),
      `${JSON.stringify(
        manifest(
          filesystemRunId,
          "official-filesystem",
          filesystemReport,
          filesystem.semanticArtifacts,
        ),
        null,
        2,
      )}\n`,
      "utf8",
    ),
    writeFile(join(sampleRoot, "deceptive-control.report.json"), "old deceptive\n"),
    writeFile(
      join(sampleRoot, "official-filesystem.report.json"),
      "old filesystem\n",
    ),
    writeFile(join(sampleRoot, "README.md"), readme, "utf8"),
    ...deceptive.semanticArtifacts.map((artifact) =>
      writeFile(join(deceptiveDirectory, artifact.path), artifact.source, "utf8"),
    ),
    ...filesystem.semanticArtifacts.map((artifact) =>
      writeFile(join(filesystemDirectory, artifact.path), artifact.source, "utf8"),
    ),
  ]);

  return {
    root,
    sampleRoot,
    deceptiveDirectory,
    filesystemDirectory,
    deceptiveReport,
    filesystemReport,
    deceptiveSemanticArtifacts: deceptive.semanticArtifacts,
    filesystemSemanticArtifacts: filesystem.semanticArtifacts,
    readme,
    deceptiveRunId,
    filesystemRunId,
  };
}

const schemas = { reportV1Schema, runManifestV1Schema };

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("sample report refresher", () => {
  it("validates a paired run and atomically replaces all sample documents", async () => {
    const fixture = await createFixture();
    const result = await refreshSampleReports({
      projectRoot: fixture.root,
      sampleRoot: fixture.sampleRoot,
      args: [
        `runs/${fixture.deceptiveRunId}`,
        `runs/${fixture.filesystemRunId}`,
      ],
      schemas,
    });

    expect(result).toEqual({
      deceptiveRunId: fixture.deceptiveRunId,
      filesystemRunId: fixture.filesystemRunId,
      observerImageId,
    });
    await expect(
      readFile(join(fixture.sampleRoot, "deceptive-control.report.json"), "utf8"),
    ).resolves.toBe(fixture.deceptiveReport);
    await expect(
      readFile(
        join(fixture.sampleRoot, "official-filesystem.report.json"),
        "utf8",
      ),
    ).resolves.toBe(fixture.filesystemReport);
    const refreshedReadme = await readFile(
      join(fixture.sampleRoot, "README.md"),
      "utf8",
    );
    expect(refreshedReadme).toContain(
      `report from \`${fixture.deceptiveRunId}\``,
    );
    expect(refreshedReadme).toContain(
      `report from \`${fixture.filesystemRunId}\``,
    );
    expect((await readdir(fixture.sampleRoot)).sort()).toEqual([
      "README.md",
      "deceptive-control.report.json",
      "official-filesystem.report.json",
    ]);
  });

  it("rejects mismatched observer images before changing destinations", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.filesystemDirectory, "run.json"),
      `${JSON.stringify(
        manifest(
          fixture.filesystemRunId,
          "official-filesystem",
          fixture.filesystemReport,
          fixture.filesystemSemanticArtifacts,
          `sha256:${"c".repeat(64)}`,
        ),
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("same immutable observer image");
    await expect(
      readFile(join(fixture.sampleRoot, "deceptive-control.report.json"), "utf8"),
    ).resolves.toBe("old deceptive\n");
    await expect(
      readFile(
        join(fixture.sampleRoot, "official-filesystem.report.json"),
        "utf8",
      ),
    ).resolves.toBe("old filesystem\n");
    await expect(
      readFile(join(fixture.sampleRoot, "README.md"), "utf8"),
    ).resolves.toBe(fixture.readme);
  });

  it("rejects a report that no longer matches its manifest hash", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.deceptiveDirectory, "report.json"),
      `${fixture.deceptiveReport}\n`,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("does not bind report.json to its manifest");
    await expect(
      readFile(join(fixture.sampleRoot, "deceptive-control.report.json"), "utf8"),
    ).resolves.toBe("old deceptive\n");
    expect((await readdir(fixture.sampleRoot)).sort()).toEqual([
      "README.md",
      "deceptive-control.report.json",
      "official-filesystem.report.json",
    ]);
  });

  it("requires both semantic artifact rows with JSON media types", async () => {
    const fixture = await createFixture();
    const manifestPath = join(fixture.deceptiveDirectory, "run.json");
    const runManifest = runManifestV1Schema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    const preInstallPath = fixture.deceptiveSemanticArtifacts[1]!.path;
    runManifest.artifacts = runManifest.artifacts.filter(
      (artifact) => artifact.path !== preInstallPath,
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify(runManifest, null, 2)}\n`,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("exactly one pre-install semantic artifact");

    const restoredManifest = manifest(
      fixture.deceptiveRunId,
      "deceptive-document-summarizer",
      fixture.deceptiveReport,
      fixture.deceptiveSemanticArtifacts,
    );
    const selectedPath = fixture.deceptiveSemanticArtifacts[0]!.path;
    const selectedRow = restoredManifest.artifacts.find(
      (artifact) => artifact.path === selectedPath,
    );
    if (selectedRow === undefined) throw new Error("missing selected artifact row");
    selectedRow.mediaType = "text/plain";
    await writeFile(
      manifestPath,
      `${JSON.stringify(restoredManifest, null, 2)}\n`,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("selected semantic artifact is not JSON");
  });

  it("binds selected semantic bytes to both the manifest and report summary", async () => {
    const fixture = await createFixture();
    const selected = fixture.deceptiveSemanticArtifacts[0]!;
    const changedSource = `${selected.source}\n`;
    await writeFile(
      join(fixture.deceptiveDirectory, selected.path),
      changedSource,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow(
      "does not bind its selected semantic artifact to the manifest",
    );

    const manifestPath = join(fixture.deceptiveDirectory, "run.json");
    const runManifest = runManifestV1Schema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    const selectedRow = runManifest.artifacts.find(
      (artifact) => artifact.path === selected.path,
    );
    if (selectedRow === undefined) throw new Error("missing selected artifact row");
    selectedRow.sha256 = sha256(changedSource);
    await writeFile(
      manifestPath,
      `${JSON.stringify(runManifest, null, 2)}\n`,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("does not match the report summary");
  });

  it("rejects semantic identity drift and paths resolving outside the run", async () => {
    const fixture = await createFixture();
    const preInstall = fixture.deceptiveSemanticArtifacts[1]!;
    const changed = JSON.parse(preInstall.source) as {
      input: { lexicalInspectionArtifact: string };
    };
    changed.input.lexicalInspectionArtifact = "static/inspection.json";
    const changedSource = `${JSON.stringify(changed, null, 2)}\n`;
    await writeFile(
      join(fixture.deceptiveDirectory, preInstall.path),
      changedSource,
      "utf8",
    );
    const manifestPath = join(fixture.deceptiveDirectory, "run.json");
    const runManifest = runManifestV1Schema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    const preInstallRow = runManifest.artifacts.find(
      (artifact) => artifact.path === preInstall.path,
    );
    if (preInstallRow === undefined) throw new Error("missing pre-install row");
    preInstallRow.sha256 = sha256(changedSource);
    await writeFile(
      manifestPath,
      `${JSON.stringify(runManifest, null, 2)}\n`,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("pre-install semantic artifact identity is inconsistent");

    const escapeFixture = await createFixture();
    const selected = escapeFixture.filesystemSemanticArtifacts[0]!;
    const selectedPath = join(escapeFixture.filesystemDirectory, selected.path);
    const outsidePath = join(escapeFixture.root, "outside-semantic.json");
    await writeFile(outsidePath, selected.source, "utf8");
    await rm(selectedPath);
    await symlink(outsidePath, selectedPath);

    await expect(
      refreshSampleReports({
        projectRoot: escapeFixture.root,
        sampleRoot: escapeFixture.sampleRoot,
        args: [
          `runs/${escapeFixture.deceptiveRunId}`,
          `runs/${escapeFixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("semantic artifact path resolves outside its Forge run");
  });

  it("rejects an incomplete run before changing destinations", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.deceptiveDirectory, "run.json"),
      `${JSON.stringify(
        {
          ...manifest(
            fixture.deceptiveRunId,
            "deceptive-document-summarizer",
            fixture.deceptiveReport,
            fixture.deceptiveSemanticArtifacts,
          ),
          status: "failed",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("is not a completed Forge analysis");
    await expect(
      readFile(join(fixture.sampleRoot, "deceptive-control.report.json"), "utf8"),
    ).resolves.toBe("old deceptive\n");
  });

  it("validates README markers before changing destinations", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.sampleRoot, "README.md"),
      "# Missing sample identifiers\n",
      "utf8",
    );

    await expect(
      refreshSampleReports({
        projectRoot: fixture.root,
        sampleRoot: fixture.sampleRoot,
        args: [
          `runs/${fixture.deceptiveRunId}`,
          `runs/${fixture.filesystemRunId}`,
        ],
        schemas,
      }),
    ).rejects.toThrow("README run identifier lines are missing");
    await expect(
      readFile(join(fixture.sampleRoot, "deceptive-control.report.json"), "utf8"),
    ).resolves.toBe("old deceptive\n");
    await expect(
      readFile(
        join(fixture.sampleRoot, "official-filesystem.report.json"),
        "utf8",
      ),
    ).resolves.toBe("old filesystem\n");
    expect((await readdir(fixture.sampleRoot)).sort()).toEqual([
      "README.md",
      "deceptive-control.report.json",
      "official-filesystem.report.json",
    ]);
  });

  it("rejects high-confidence host and secret patterns but permits container paths", () => {
    expect(() =>
      assertSampleContentSafe(
        "/sandbox/home/forge/.ssh/id_ed25519 and /home/node/runtime.txt",
        "sample",
      ),
    ).not.toThrow();
    expect(() =>
      assertSampleContentSafe("/Users/alice/project/report.json", "sample"),
    ).toThrow("macOS host home path");
    expect(() =>
      assertSampleContentSafe(
        "github_pat_abcdefghijklmnopqrstuvwxyz0123456789",
        "sample",
      ),
    ).toThrow("GitHub token");
    expect(() =>
      assertSampleContentSafe(
        "-----BEGIN ENCRYPTED PRIVATE KEY-----",
        "sample",
      ),
    ).toThrow("private key");
  });
});
