import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  reportV1Schema,
  runManifestV1Schema,
  type RunManifestV1,
} from "../../src/contracts/v1.js";
import {
  RunBundleVerificationError,
  verifyRunBundle,
} from "../../src/publish/bundle.js";

const sampleReportPath = resolve(
  import.meta.dirname,
  "..",
  "..",
  "examples",
  "reports",
  "deceptive-control.report.json",
);
const temporaryRoots: string[] = [];

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

interface BundleFixture {
  readonly temporaryRoot: string;
  readonly runDirectory: string;
  readonly reportSource: string;
  readonly evidenceSource: string;
  readonly manifest: RunManifestV1;
}

async function createBundleFixture(): Promise<BundleFixture> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "forge-publish-bundle-"));
  temporaryRoots.push(temporaryRoot);
  const reportSource = await readFile(sampleReportPath, "utf8");
  const report = reportV1Schema.parse(JSON.parse(reportSource));
  const requestedRunDirectory = join(temporaryRoot, report.runId);
  const evidenceSource = "bounded synthetic evidence\n";
  await mkdir(requestedRunDirectory);
  const runDirectory = await realpath(requestedRunDirectory);
  await Promise.all([
    writeFile(join(runDirectory, "report.json"), reportSource),
    writeFile(join(runDirectory, "evidence.txt"), evidenceSource),
  ]);

  const referencedEvidencePaths = [
    report.evidence.events,
    report.evidence.phases,
    report.evidence.attributions,
    report.evidence.findings,
    report.evidence.targetProvenance,
    report.evidence.staticInspection,
    report.evidence.preInstallStaticInspection,
    report.evidence.semanticInspection,
    report.evidence.preInstallSemanticInspection,
    report.evidence.installDelta,
    report.evidence.advertisedClaims,
    ...report.runtimeObservations.flatMap((observation) => {
      const refs = observation.filesystemStateDelta?.artifactRefs;
      return refs === undefined ? [] : [refs.before, refs.after, refs.delta];
    }),
  ].filter((path): path is string => path !== undefined);
  const referencedArtifacts = await Promise.all(
    [...new Set(referencedEvidencePaths)].map(async (path) => {
      const contents = `synthetic referenced evidence: ${path}\n`;
      const outputPath = join(runDirectory, path);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, contents);
      return {
        path,
        sha256: sha256(contents),
        mediaType: "application/octet-stream",
      };
    }),
  );

  const manifest = runManifestV1Schema.parse({
    schema: "forge.run/v1",
    runId: report.runId,
    targetId: report.targetId,
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
      observerImageReference: "forge-sandbox:test",
      observerImageId: `sha256:${"a".repeat(64)}`,
    },
    limitations: ["Synthetic publisher verification fixture."],
    artifacts: [
      {
        path: "report.json",
        sha256: sha256(reportSource),
        mediaType: "application/json",
      },
      {
        path: "evidence.txt",
        sha256: sha256(evidenceSource),
        mediaType: "text/plain",
      },
      ...referencedArtifacts,
    ],
  });
  await writeManifest(runDirectory, manifest);

  return {
    temporaryRoot,
    runDirectory,
    reportSource,
    evidenceSource,
    manifest,
  };
}

async function writeManifest(
  runDirectory: string,
  manifest: RunManifestV1,
): Promise<void> {
  await writeFile(
    join(runDirectory, "run.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function mutateManifest(
  fixture: BundleFixture,
  mutate: (manifest: RunManifestV1) => void,
): Promise<RunManifestV1> {
  const manifest = structuredClone(fixture.manifest);
  mutate(manifest);
  await writeManifest(fixture.runDirectory, manifest);
  return manifest;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("verifyRunBundle", () => {
  it("returns an exact, identity-bound completed run publication bundle", async () => {
    const fixture = await createBundleFixture();

    const verified = await verifyRunBundle(fixture.runDirectory);
    try {
      const manifestBytes = await readFile(join(fixture.runDirectory, "run.json"));

      expect(verified.runDirectory).toBe(resolve(fixture.runDirectory));
      expect(verified.manifestPath).toBe(join(fixture.runDirectory, "run.json"));
      expect(Buffer.from(verified.manifestBytes)).toEqual(manifestBytes);
      expect(verified.manifestSha256).toBe(sha256(manifestBytes));
      expect(verified.manifest.runId).toBe(verified.report.runId);
      expect(verified.manifest.targetId).toBe(verified.report.targetId);
      expect(verified.reportArtifact).toMatchObject({
        logicalPath: "report.json",
        kind: "report",
        mediaType: "application/json",
        declaredSha256: sha256(fixture.reportSource),
        verifiedSha256: sha256(fixture.reportSource),
        sizeBytes: Buffer.byteLength(fixture.reportSource),
      });
      expect(verified.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          logicalPath: "report.json",
          sourcePath: join(fixture.runDirectory, "report.json"),
          kind: "report",
        }),
        expect.objectContaining({
          logicalPath: "evidence.txt",
          sourcePath: join(fixture.runDirectory, "evidence.txt"),
          kind: "evidence",
          sizeBytes: Buffer.byteLength(fixture.evidenceSource),
        }),
      ]));
    } finally {
      await verified.close();
    }
  });

  it("publishes from an anonymous verified snapshot after the run path changes", async () => {
    const fixture = await createBundleFixture();
    const verified = await verifyRunBundle(fixture.runDirectory);
    try {
      await writeFile(
        join(fixture.runDirectory, "evidence.txt"),
        "host secret replacement bytes\n",
      );
      const evidence = verified.artifacts.find(
        (artifact) => artifact.logicalPath === "evidence.txt",
      );
      expect(evidence).toBeDefined();
      const chunks: Buffer[] = [];
      for await (const chunk of evidence!.snapshotHandle.createReadStream({
        autoClose: false,
        start: 0,
      })) {
        chunks.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString("utf8")).toBe(fixture.evidenceSource);
    } finally {
      await verified.close();
    }
  });

  it("rejects artifact content changed after the manifest was written", async () => {
    const fixture = await createBundleFixture();
    await writeFile(join(fixture.runDirectory, "evidence.txt"), "tampered\n");

    await expect(verifyRunBundle(fixture.runDirectory)).rejects.toThrow(
      "SHA-256 does not match run.json",
    );
  });

  it.each(["../outside.txt", "/tmp/outside.txt", "C:\\outside.txt"])(
    "rejects non-contained artifact path %s",
    async (artifactPath) => {
      const fixture = await createBundleFixture();
      await writeFile(join(fixture.temporaryRoot, "outside.txt"), "outside\n");
      await mutateManifest(fixture, (manifest) => {
        manifest.artifacts[1] = {
          path: artifactPath,
          sha256: sha256("outside\n"),
          mediaType: "text/plain",
        };
      });

      await expect(verifyRunBundle(fixture.runDirectory)).rejects.toBeInstanceOf(
        RunBundleVerificationError,
      );
    },
  );

  it("rejects a symbolic-link parent path component", async () => {
    const fixture = await createBundleFixture();
    const externalDirectory = join(fixture.temporaryRoot, "external");
    await mkdir(externalDirectory);
    await writeFile(join(externalDirectory, "evidence.txt"), "outside\n");
    await symlink(externalDirectory, join(fixture.runDirectory, "linked"), "dir");
    await mutateManifest(fixture, (manifest) => {
      manifest.artifacts[1] = {
        path: "linked/evidence.txt",
        sha256: sha256("outside\n"),
        mediaType: "text/plain",
      };
    });

    await expect(verifyRunBundle(fixture.runDirectory)).rejects.toThrow(
      "symbolic-link path component",
    );
  });

  it("rejects a missing manifest-listed artifact", async () => {
    const fixture = await createBundleFixture();
    await rm(join(fixture.runDirectory, "evidence.txt"));

    await expect(verifyRunBundle(fixture.runDirectory)).rejects.toThrow(
      "is missing or unreadable",
    );
  });

  it("rejects an incomplete run", async () => {
    const fixture = await createBundleFixture();
    await mutateManifest(fixture, (manifest) => {
      manifest.status = "running";
      delete manifest.completedAt;
    });

    await expect(verifyRunBundle(fixture.runDirectory)).rejects.toThrow(
      "does not describe a completed Forge run",
    );
  });

  it("rejects duplicate report artifact paths", async () => {
    const fixture = await createBundleFixture();
    await mutateManifest(fixture, (manifest) => {
      manifest.artifacts.push({ ...manifest.artifacts[0]! });
    });

    await expect(verifyRunBundle(fixture.runDirectory)).rejects.toThrow(
      "duplicate artifact path 'report.json'",
    );
  });

  it.each(["missing", "wrong-media-type"] as const)(
    "rejects a %s usable report binding",
    async (variant) => {
      const fixture = await createBundleFixture();
      await mutateManifest(fixture, (manifest) => {
        if (variant === "missing") {
          manifest.artifacts = manifest.artifacts.filter(
            (artifact) => artifact.path !== "report.json",
          );
        } else {
          manifest.artifacts[0] = {
            ...manifest.artifacts[0]!,
            mediaType: "text/plain",
          };
        }
      });

      await expect(verifyRunBundle(fixture.runDirectory)).rejects.toThrow(
        "must bind exactly one application/json report.json artifact",
      );
    },
  );

  it("rejects report identity that does not match the run manifest", async () => {
    const fixture = await createBundleFixture();
    await mutateManifest(fixture, (manifest) => {
      manifest.targetId = `${manifest.targetId}-substituted`;
    });

    await expect(verifyRunBundle(fixture.runDirectory)).rejects.toThrow(
      "report.json run and target identity do not match run.json",
    );
  });

  it("rejects a report evidence reference omitted from the manifest", async () => {
    const fixture = await createBundleFixture();
    const report = reportV1Schema.parse(JSON.parse(fixture.reportSource));
    await mutateManifest(fixture, (manifest) => {
      manifest.artifacts = manifest.artifacts.filter(
        (artifact) => artifact.path !== report.evidence.events,
      );
    });

    await expect(verifyRunBundle(fixture.runDirectory)).rejects.toThrow(
      `report.json references unmanifested evidence artifact '${report.evidence.events}'`,
    );
  });
});
