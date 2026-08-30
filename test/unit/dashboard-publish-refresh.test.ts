import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reportV1Schema, type RunManifestV1 } from "../../src/contracts/v1.js";
import {
  buildDemoExportV1,
  buildDemoRunV1,
} from "../../src/dashboard/demo-export.js";
import {
  DEMO_TARGET_POLICIES,
  type DemoTargetPolicy,
} from "../../src/dashboard/demo-policy.js";
import {
  writeCompleteDashboardSite,
} from "../../src/dashboard/local-site.js";
import { LocalDashboardPublicationRefresher } from "../../src/dashboard/publish-refresh.js";
import { buildDashboardDocument } from "../../src/dashboard/render.js";
import type { VerifiedRunBundle } from "../../src/publish/bundle.js";
import type {
  DashboardProjectionReader,
  DashboardProjectionInput,
  LatestDashboardProjectionQuery,
  PostgresPublicationRepository,
  PublicationRun,
  StoreDashboardProjectionResult,
  StoredDashboardProjection,
} from "../../src/publish/postgres.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

class FakeProjectionRepository {
  private readonly completedAtByRun = new Map<string, string>();
  private readonly projections = new Map<string, StoredDashboardProjection>();

  public register(bundle: VerifiedRunBundle): void {
    this.completedAtByRun.set(
      bundle.manifest.runId,
      bundle.manifest.completedAt!,
    );
  }

  public async storeDashboardProjection(
    input: DashboardProjectionInput,
  ): Promise<StoreDashboardProjectionResult> {
    const key = `${input.runId}\0${input.policyId}`;
    const existing = this.projections.get(key);
    if (existing !== undefined) {
      return { disposition: "already_stored", projection: existing };
    }
    const projection: StoredDashboardProjection = {
      ...input,
      projectionSha256: "f".repeat(64),
      runCompletedAt: this.completedAtByRun.get(input.runId)!,
      createdAt: "2026-08-30T22:00:00.000Z",
    };
    this.projections.set(key, projection);
    return { disposition: "stored", projection };
  }

  public async getLatestPublishedDashboardProjections(
    input: LatestDashboardProjectionQuery,
  ): Promise<readonly StoredDashboardProjection[]> {
    return input.targetIds.flatMap((targetId) => {
      const entries = [...this.projections.values()]
        .filter(
          (entry) =>
            entry.policyId === input.policyId && entry.targetId === targetId,
        )
        .sort(
          (left, right) =>
            Date.parse(right.runCompletedAt) - Date.parse(left.runCompletedAt),
        );
      return entries[0] === undefined ? [] : [entries[0]];
    });
  }

  public async withDashboardRefreshLock<T>(
    operation: (reader: DashboardProjectionReader) => Promise<T>,
  ): Promise<T> {
    return await operation(this);
  }
}

async function bundleForPolicy(
  policy: DemoTargetPolicy,
  runSuffix: string,
  completedAt: string,
): Promise<VerifiedRunBundle> {
  const bytes = await readFile(
    join(process.cwd(), "examples", "reports", policy.sampleReportFile),
  );
  const sourceReport = reportV1Schema.parse(
    JSON.parse(new TextDecoder().decode(bytes)) as unknown,
  );
  const runId = `run-20260830-${runSuffix}`;
  const reportDocument = JSON.parse(
    JSON.stringify(sourceReport).replaceAll(sourceReport.runId, runId),
  ) as Record<string, unknown>;
  reportDocument.generatedAt = completedAt;
  const report = reportV1Schema.parse(reportDocument);
  const reportBytes = Buffer.from(`${JSON.stringify(report)}\n`, "utf8");
  const manifest: RunManifestV1 = {
    schema: "forge.run/v1",
    runId,
    targetId: policy.targetId,
    configSha256: policy.configSha256,
    status: "completed",
    createdAt: "2026-08-30T18:00:00.000Z",
    completedAt,
    sandboxPolicy: {
      profile: "developer-v1",
      network: "blocked",
      timeoutMs: 10_000,
    },
    toolchain: {
      forgeVersion: "0.1.0",
      nodeVersion: process.version,
      observerImageReference: "forge-sandbox:test",
      observerImageId: `sha256:${"d".repeat(64)}`,
    },
    limitations: [],
    artifacts: [],
  };
  const reportArtifact = {
    logicalPath: "report.json",
    sourcePath: "/private/report.json",
    kind: "report" as const,
    mediaType: "application/json",
    declaredSha256: sha256(reportBytes),
    verifiedSha256: sha256(reportBytes),
    sizeBytes: reportBytes.byteLength,
    snapshotHandle: {} as VerifiedRunBundle["reportArtifact"]["snapshotHandle"],
  };
  return {
    runDirectory: "/private/run",
    manifestPath: "/private/run/run.json",
    manifestBytes: new Uint8Array(),
    manifestSha256: sha256(Buffer.from(runId)),
    manifest,
    reportBytes,
    report,
    reportArtifact,
    artifacts: [reportArtifact],
    async close() {},
  };
}

function publicationFor(
  bundle: VerifiedRunBundle,
  publishedAt: string,
): PublicationRun {
  return {
    runId: bundle.manifest.runId,
    targetId: bundle.manifest.targetId,
    manifestSchema: "forge.run/v1",
    manifestSha256: bundle.manifestSha256,
    storageBucket: "forge-evidence",
    storagePrefix: "forge",
    manifestObjectKey: `forge/runs/${bundle.manifest.runId}/run.json`,
    status: "published",
    runCreatedAt: bundle.manifest.createdAt,
    runCompletedAt: bundle.manifest.completedAt!,
    publicationStartedAt: publishedAt,
    publishedAt,
    publicMetadata: {},
  };
}

let repositoryRoot: string;

beforeEach(async () => {
  repositoryRoot = await mkdtemp(join(tmpdir(), "forge-dashboard-refresh-test-"));
  await Promise.all([
    mkdir(join(repositoryRoot, "dashboard"), { recursive: true }),
    mkdir(join(repositoryRoot, "examples", "reports"), { recursive: true }),
  ]);
  const [template, stylesheet, ...sampleBytes] = await Promise.all([
    readFile(join(process.cwd(), "dashboard", "index.html"), "utf8"),
    readFile(join(process.cwd(), "dashboard", "styles.css"), "utf8"),
    ...DEMO_TARGET_POLICIES.map((policy) =>
      readFile(join(process.cwd(), "examples", "reports", policy.sampleReportFile)),
    ),
  ]);
  await Promise.all([
    writeFile(join(repositoryRoot, "dashboard", "index.html"), template),
    writeFile(join(repositoryRoot, "dashboard", "styles.css"), stylesheet),
    ...DEMO_TARGET_POLICIES.map((policy, index) =>
      writeFile(
        join(repositoryRoot, "examples", "reports", policy.sampleReportFile),
        sampleBytes[index]!,
      ),
    ),
  ]);
  const reports = DEMO_TARGET_POLICIES.map((policy, index) => ({
    role: policy.role,
    reportBytes: sampleBytes[index]!,
    expectedSha256: policy.sampleReportSha256,
    expectedTargetId: policy.targetId,
    displayName: policy.displayName,
    description: policy.description,
    scopeLabels: policy.scopeLabels,
    limitations: policy.limitations,
    presentation: { source: "sample" as const },
  }));
  const exported = buildDemoExportV1({ reports: [reports[0]!, reports[1]!] });
  await writeCompleteDashboardSite({
    outputDirectory: join(repositoryRoot, "dist", "dashboard-site"),
    manifestPath: join(repositoryRoot, "dist", "dashboard-site.manifest.json"),
    document: buildDashboardDocument({ template, stylesheet, exported }),
  });
});

afterEach(async () => {
  await rm(repositoryRoot, { recursive: true, force: true });
});

describe("publish-driven local dashboard refresh", () => {
  it("replaces one sample with the latest published projection and converges on retry", async () => {
    const repository = new FakeProjectionRepository();
    const bundle = await bundleForPolicy(
      DEMO_TARGET_POLICIES[0],
      "dashboard-new",
      "2026-08-30T22:10:00.000Z",
    );
    repository.register(bundle);
    const refresher = new LocalDashboardPublicationRefresher({
      repository: repository as unknown as PostgresPublicationRepository,
      repositoryRoot,
    });
    const plan = refresher.prepare(bundle);

    await expect(
      plan.execute(publicationFor(bundle, "2026-08-30T22:11:00.000Z")),
    ).resolves.toEqual({ status: "refreshed", disposition: "changed" });
    const firstHtml = await readFile(
      join(repositoryRoot, "dist", "dashboard-site", "index.html"),
      "utf8",
    );
    expect(firstHtml).toContain("Published 2026-08-30T22:11:00Z");
    expect(firstHtml).toContain("Pinned sample");
    expect(firstHtml).not.toContain(bundle.manifest.runId);
    expect(firstHtml).not.toContain(bundle.manifestSha256);
    expect(firstHtml).not.toContain("/private/");
    const manifestPath = join(
      repositoryRoot,
      "dist",
      "dashboard-site.manifest.json",
    );
    const expectedManifest = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, '{"stale":true}\n');
    await Promise.all([
      writeFile(
        join(repositoryRoot, "dist", ".dashboard-site-index-crashed"),
        "orphaned next page",
      ),
      writeFile(
        join(repositoryRoot, "dist", ".dashboard-site-rollback-crashed"),
        "orphaned rollback page",
      ),
    ]);

    await expect(
      plan.execute(publicationFor(bundle, "2026-08-30T22:11:00.000Z")),
    ).resolves.toEqual({ status: "refreshed", disposition: "unchanged" });
    expect(
      await readFile(
        join(repositoryRoot, "dist", "dashboard-site", "index.html"),
        "utf8",
      ),
    ).toBe(firstHtml);
    expect(await readFile(manifestPath, "utf8")).toBe(expectedManifest);
  });

  it("does not let an older retry replace a newer published projection", async () => {
    const repository = new FakeProjectionRepository();
    const policy = DEMO_TARGET_POLICIES[0];
    const newer = await bundleForPolicy(
      policy,
      "dashboard-newer",
      "2026-08-30T23:00:00.000Z",
    );
    const older = await bundleForPolicy(
      policy,
      "dashboard-older",
      "2026-08-30T22:00:00.000Z",
    );
    repository.register(newer);
    repository.register(older);
    const refresher = new LocalDashboardPublicationRefresher({
      repository: repository as unknown as PostgresPublicationRepository,
      repositoryRoot,
    });
    await refresher
      .prepare(newer)
      .execute(publicationFor(newer, "2026-08-30T23:01:00.000Z"));
    const current = await readFile(
      join(repositoryRoot, "dist", "dashboard-site", "index.html"),
      "utf8",
    );

    await refresher
      .prepare(older)
      .execute(publicationFor(older, "2026-08-30T23:02:00.000Z"));
    const afterRetry = await readFile(
      join(repositoryRoot, "dist", "dashboard-site", "index.html"),
      "utf8",
    );
    expect(afterRetry).toBe(current);
    expect(afterRetry).toContain("Published 2026-08-30T23:01:00Z");
    expect(afterRetry).not.toContain("2026-08-30T23:02:00Z");
  });

  it("leaves the page intact when the reviewed stylesheet does not match", async () => {
    const repository = new FakeProjectionRepository();
    const bundle = await bundleForPolicy(
      DEMO_TARGET_POLICIES[1],
      "dashboard-css",
      "2026-08-30T22:30:00.000Z",
    );
    repository.register(bundle);
    const previous = await readFile(
      join(repositoryRoot, "dist", "dashboard-site", "index.html"),
      "utf8",
    );
    await writeFile(
      join(repositoryRoot, "dist", "dashboard-site", "styles.css"),
      "body { color: red; }\n",
    );
    const refresher = new LocalDashboardPublicationRefresher({
      repository: repository as unknown as PostgresPublicationRepository,
      repositoryRoot,
    });

    await expect(
      refresher
        .prepare(bundle)
        .execute(publicationFor(bundle, "2026-08-30T22:31:00.000Z")),
    ).rejects.toThrow("stylesheet differs from the reviewed source");
    expect(
      await readFile(
        join(repositoryRoot, "dist", "dashboard-site", "index.html"),
        "utf8",
      ),
    ).toBe(previous);
  });

  it("returns not_selected without touching the repository for an untrusted identity", async () => {
    const repository = new FakeProjectionRepository();
    const bundle = await bundleForPolicy(
      DEMO_TARGET_POLICIES[0],
      "dashboard-untrusted",
      "2026-08-30T22:40:00.000Z",
    );
    bundle.manifest.configSha256 = "0".repeat(64);
    const refresher = new LocalDashboardPublicationRefresher({
      repository: repository as unknown as PostgresPublicationRepository,
      repositoryRoot,
    });

    await expect(
      refresher
        .prepare(bundle)
        .execute(publicationFor(bundle, "2026-08-30T22:41:00.000Z")),
    ).resolves.toEqual({ status: "not_selected" });
  });

  it("renders only canonical finding prose", async () => {
    const policy = DEMO_TARGET_POLICIES[0];
    const bytes = await readFile(
      join(repositoryRoot, "examples", "reports", policy.sampleReportFile),
    );
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
    (parsed.findings as Array<Record<string, unknown>>)[0]!.ruleId =
      "runtime.unknown_private_rule";
    (parsed.findings as Array<Record<string, unknown>>)[0]!.title =
      "Leaked but syntactically safe internal hostname";
    const mutated = Buffer.from(JSON.stringify(parsed), "utf8");
    const projection = buildDemoRunV1({
      role: policy.role,
      reportBytes: mutated,
      expectedSha256: sha256(mutated),
      expectedTargetId: policy.targetId,
      displayName: policy.displayName,
      description: policy.description,
      scopeLabels: policy.scopeLabels,
      limitations: policy.limitations,
    });
    expect(projection.findings).toContainEqual({
      title: "Deterministic behavioral rule matched",
      severity: "high",
      confidence: "high",
    });
    expect(JSON.stringify(projection)).not.toContain("internal hostname");
  });
});
