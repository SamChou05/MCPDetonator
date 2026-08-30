import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
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
    ],
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-refresh-samples-"));
  temporaryRoots.push(root);
  const sampleRoot = join(root, "examples", "reports");
  const [deceptiveReport, filesystemReport] = await Promise.all([
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
  const deceptiveRunId = reportV1Schema.parse(
    JSON.parse(deceptiveReport),
  ).runId;
  const filesystemRunId = reportV1Schema.parse(
    JSON.parse(filesystemReport),
  ).runId;
  const deceptiveDirectory = join(root, "runs", deceptiveRunId);
  const filesystemDirectory = join(root, "runs", filesystemRunId);
  await Promise.all([
    mkdir(sampleRoot, { recursive: true }),
    mkdir(deceptiveDirectory, { recursive: true }),
    mkdir(filesystemDirectory, { recursive: true }),
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
        manifest(filesystemRunId, "official-filesystem", filesystemReport),
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
  ]);

  return {
    root,
    sampleRoot,
    deceptiveDirectory,
    filesystemDirectory,
    deceptiveReport,
    filesystemReport,
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
