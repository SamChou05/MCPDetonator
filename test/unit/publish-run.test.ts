import type { ReportV1, RunManifestV1 } from "../../src/contracts/v1.js";
import type { FileHandle } from "node:fs/promises";
import type { VerifiedRunBundle } from "../../src/publish/bundle.js";
import {
  publishVerifiedRun,
  type PublicationArtifactStore,
  type PublicationRepository,
} from "../../src/publish/publish-run.js";
import type {
  BeginPublicationResult,
  FinalizePublicationInput,
  FinalizePublicationResult,
} from "../../src/publish/postgres.js";
import type {
  S3FileArtifactInput,
  S3ManifestInput,
  StoredS3Object,
} from "../../src/publish/s3.js";
import { describe, expect, it } from "vitest";

const manifestSha256 = "a".repeat(64);
const reportSha256 = "b".repeat(64);
const evidenceSha256 = "c".repeat(64);
const fakeSnapshotHandle = {} as FileHandle;

function fixtureBundle(): VerifiedRunBundle {
  const manifest = {
    schema: "forge.run/v1",
    runId: "run-publisher-test",
    targetId: "target-publisher-test",
    configSha256: "d".repeat(64),
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
      observerImageId: `sha256:${"e".repeat(64)}`,
    },
    limitations: [],
    artifacts: [],
  } as RunManifestV1;
  const report = {
    findings: [
      {
        schema: "forge.finding/v1",
        findingId: "finding-1",
        runId: manifest.runId,
        ruleId: "rule-1",
        title: "Synthetic finding",
        summary: "Synthetic summary",
        severity: "medium",
        confidence: "high",
        eventIds: ["event-1"],
        attributionIds: ["attribution-1"],
        limitations: ["Synthetic limitation."],
      },
    ],
  } as unknown as ReportV1;
  const artifacts = [
    {
      logicalPath: "report.json",
      sourcePath: "/verified/run/report.json",
      kind: "report" as const,
      mediaType: "application/json",
      declaredSha256: reportSha256,
      verifiedSha256: reportSha256,
      sizeBytes: 100,
      snapshotHandle: fakeSnapshotHandle,
    },
    {
      logicalPath: "events.jsonl",
      sourcePath: "/verified/run/events.jsonl",
      kind: "evidence" as const,
      mediaType: "application/x-ndjson",
      declaredSha256: evidenceSha256,
      verifiedSha256: evidenceSha256,
      sizeBytes: 200,
      snapshotHandle: fakeSnapshotHandle,
    },
  ];

  return {
    runDirectory: "/verified/run",
    manifestPath: "/verified/run/run.json",
    manifestBytes: Buffer.from("exact manifest\n", "utf8"),
    manifestSha256,
    manifest,
    report,
    reportArtifact: artifacts[0]!,
    artifacts,
    async close() {},
  };
}

class FakeArtifactStore implements PublicationArtifactStore {
  public readonly bucket = "forge-evidence";
  public readonly prefix = "demo";
  public readonly events: string[] = [];
  public failArtifactSha256?: string;

  public artifactKey(sha256: string): string {
    return `${this.prefix}/objects/${sha256}`;
  }

  public manifestKey(runId: string): string {
    return `${this.prefix}/runs/${runId}/run.json`;
  }

  public async validateArtifact(input: S3FileArtifactInput): Promise<void> {
    this.events.push(`validate-artifact:${input.sha256}`);
  }

  public validateManifest(): void {
    this.events.push("validate-manifest");
  }

  public async putArtifact(
    input: S3FileArtifactInput,
  ): Promise<StoredS3Object> {
    this.events.push(`artifact:${input.sha256}`);
    if (input.sha256 === this.failArtifactSha256) {
      throw new Error("synthetic artifact upload failure");
    }
    return {
      bucket: this.bucket,
      key: this.artifactKey(input.sha256),
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      created: true,
    };
  }

  public async putManifest(input: S3ManifestInput): Promise<StoredS3Object> {
    this.events.push("manifest");
    return {
      bucket: this.bucket,
      key: this.manifestKey(input.runId),
      sha256: input.sha256,
      sizeBytes: input.bytes.byteLength,
      created: true,
    };
  }
}

class FakeRepository implements PublicationRepository {
  public readonly events: string[] = [];
  public finalized?: FinalizePublicationInput;
  public beginDisposition: BeginPublicationResult["disposition"] = "created";
  public failPreflight = false;

  public validateBeginPublication(): void {
    this.events.push("validate-begin");
  }

  public validateFinalization(input: FinalizePublicationInput): void {
    this.events.push("validate-finalize");
    if (this.failPreflight) {
      throw new Error("synthetic finalization preflight failure");
    }
    this.finalized = input;
  }

  public async ensureSchema(): Promise<void> {
    this.events.push("schema");
  }

  public async beginPublication(): Promise<BeginPublicationResult> {
    this.events.push("begin");
    return {
      disposition: this.beginDisposition,
      run: {} as BeginPublicationResult["run"],
    };
  }

  public async finalizePublication(
    input: FinalizePublicationInput,
  ): Promise<FinalizePublicationResult> {
    this.events.push("finalize");
    this.finalized = input;
    return {
      disposition:
        this.beginDisposition === "already_published"
          ? "already_published"
          : "published",
      run: {} as FinalizePublicationResult["run"],
      artifactCount: input.artifacts.length,
      findingCount: input.findings.length,
    };
  }
}

describe("publishVerifiedRun", () => {
  it("uploads every verified artifact, then the manifest, then finalizes metadata", async () => {
    const bundle = fixtureBundle();
    const artifactStore = new FakeArtifactStore();
    const repository = new FakeRepository();

    const result = await publishVerifiedRun(bundle, {
      artifactStore,
      repository,
      artifactConcurrency: 2,
    });

    expect(repository.events).toEqual([
      "validate-begin",
      "validate-finalize",
      "schema",
      "begin",
      "finalize",
    ]);
    expect(artifactStore.events).toEqual([
      `validate-artifact:${reportSha256}`,
      `validate-artifact:${evidenceSha256}`,
      "validate-manifest",
      `artifact:${reportSha256}`,
      `artifact:${evidenceSha256}`,
      "manifest",
    ]);
    expect(repository.finalized).toMatchObject({
      runId: bundle.manifest.runId,
      manifestSha256,
      manifestObjectKey: "demo/runs/run-publisher-test/run.json",
      artifacts: [
        {
          path: "report.json",
          sha256: reportSha256,
          sizeBytes: 100,
          mediaType: "application/json",
          storageBucket: "forge-evidence",
          objectKey: `demo/objects/${reportSha256}`,
          publicMetadata: { kind: "report" },
        },
        {
          path: "events.jsonl",
          sha256: evidenceSha256,
          publicMetadata: { kind: "evidence" },
        },
      ],
      findings: [
        {
          findingId: "finding-1",
          ruleId: "rule-1",
          severity: "medium",
          confidence: "high",
          publicMetadata: {
            eventIds: ["event-1"],
            attributionIds: ["attribution-1"],
            limitations: ["Synthetic limitation."],
          },
        },
      ],
    });
    expect(result).toMatchObject({
      status: "published",
      runId: "run-publisher-test",
      targetId: "target-publisher-test",
      artifactCount: 2,
      findingCount: 1,
      beginDisposition: "created",
      finalizeDisposition: "published",
    });
  });

  it("never writes the manifest or finalizes metadata after an artifact failure", async () => {
    const artifactStore = new FakeArtifactStore();
    artifactStore.failArtifactSha256 = evidenceSha256;
    const repository = new FakeRepository();

    await expect(
      publishVerifiedRun(fixtureBundle(), {
        artifactStore,
        repository,
        artifactConcurrency: 2,
      }),
    ).rejects.toThrow("synthetic artifact upload failure");

    expect(artifactStore.events).not.toContain("manifest");
    expect(repository.events).toEqual([
      "validate-begin",
      "validate-finalize",
      "schema",
      "begin",
    ]);
  });

  it("rechecks remote objects and metadata for an already-published retry", async () => {
    const artifactStore = new FakeArtifactStore();
    const repository = new FakeRepository();
    repository.beginDisposition = "already_published";

    const result = await publishVerifiedRun(fixtureBundle(), {
      artifactStore,
      repository,
    });

    expect(artifactStore.events.at(-1)).toBe("manifest");
    expect(repository.events.at(-1)).toBe("finalize");
    expect(result.beginDisposition).toBe("already_published");
    expect(result.finalizeDisposition).toBe("already_published");
  });

  it("uploads identical artifact bytes once while retaining every logical row", async () => {
    const original = fixtureBundle();
    const duplicate = {
      ...original.artifacts[1]!,
      logicalPath: "events-copy.jsonl",
      sourcePath: "/verified/run/events-copy.jsonl",
    };
    const bundle: VerifiedRunBundle = {
      ...original,
      artifacts: [...original.artifacts, duplicate],
    };
    const artifactStore = new FakeArtifactStore();
    const repository = new FakeRepository();

    const result = await publishVerifiedRun(bundle, {
      artifactStore,
      repository,
      artifactConcurrency: 2,
    });

    expect(
      artifactStore.events.filter((event) => event.startsWith("artifact:")),
    ).toHaveLength(2);
    expect(repository.finalized?.artifacts).toHaveLength(3);
    expect(repository.finalized?.artifacts[1]?.objectKey).toBe(
      repository.finalized?.artifacts[2]?.objectKey,
    );
    expect(result.artifactCount).toBe(3);
  });

  it("rejects unsafe concurrency before creating publication intent", async () => {
    const artifactStore = new FakeArtifactStore();
    const repository = new FakeRepository();

    await expect(
      publishVerifiedRun(fixtureBundle(), {
        artifactStore,
        repository,
        artifactConcurrency: 0,
      }),
    ).rejects.toThrow("artifact concurrency must be an integer from 1 to 16");
    expect(repository.events).toEqual([]);
    expect(artifactStore.events).toEqual([]);
  });

  it("rejects a finalization projection before schema, intent, or S3 writes", async () => {
    const artifactStore = new FakeArtifactStore();
    const repository = new FakeRepository();
    repository.failPreflight = true;

    await expect(
      publishVerifiedRun(fixtureBundle(), { artifactStore, repository }),
    ).rejects.toThrow("synthetic finalization preflight failure");

    expect(repository.events).toEqual(["validate-begin", "validate-finalize"]);
    expect(
      artifactStore.events.filter(
        (event) => event.startsWith("artifact:") || event === "manifest",
      ),
    ).toEqual([]);
  });
});
