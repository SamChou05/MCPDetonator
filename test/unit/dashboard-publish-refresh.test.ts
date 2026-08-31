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
  demoRunV1Schema,
} from "../../src/dashboard/demo-export.js";
import {
  DEMO_TARGET_POLICIES,
  type DemoTargetPolicy,
} from "../../src/dashboard/demo-policy.js";
import {
  writeCompleteDashboardSite,
} from "../../src/dashboard/local-site.js";
import { LocalDashboardPublicationRefresher } from "../../src/dashboard/publish-refresh.js";
import {
  buildDashboardDocument,
  type UnseenHoldoutSummary,
} from "../../src/dashboard/render.js";
import type { VerifiedRunBundle } from "../../src/publish/bundle.js";
import type {
  DashboardProjectionReader,
  DashboardProjectionInput,
  RecentDashboardProjectionQuery,
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
    const parsed = demoRunV1Schema.parse(input.projection);
    if (parsed.presentation.source !== "published") {
      throw new Error("fake repository requires a published projection");
    }
    const projection: StoredDashboardProjection = {
      ...input,
      projectionSha256: "f".repeat(64),
      runCompletedAt: this.completedAtByRun.get(input.runId)!,
      publishedAt: parsed.presentation.publishedAt,
      createdAt: "2026-08-30T22:00:00.000Z",
    };
    this.projections.set(key, projection);
    return { disposition: "stored", projection };
  }

  public async getRecentPublishedDashboardProjections(
    input: RecentDashboardProjectionQuery,
  ): Promise<readonly StoredDashboardProjection[]> {
    return input.targetIds.flatMap((targetId) =>
      [...this.projections.values()]
        .filter(
          (entry) =>
            entry.policyId === input.policyId && entry.targetId === targetId,
        )
        .sort((left, right) => {
          const completionDifference =
            Date.parse(right.runCompletedAt) - Date.parse(left.runCompletedAt);
          if (completionDifference !== 0) return completionDifference;
          const publicationDifference =
            Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
          if (publicationDifference !== 0) return publicationDifference;
          return left.runId.localeCompare(right.runId);
        })
        .slice(0, input.limitPerTarget),
    );
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
    expect(firstHtml).toContain("Published run explorer");
    expect(firstHtml).toContain("1 published run");
    expect(firstHtml).toContain('class="run-index"');
    expect(firstHtml).toContain('href="#published-controlled-run-1"');
    expect(firstHtml).toContain(
      'class="history-run" id="published-controlled-run-1"',
    );
    expect(firstHtml).toContain("Selected runtime scopes");
    expect(firstHtml).toContain(
      "2 selected initialization/tool scopes from 4 total experiments",
    );
    expect(firstHtml).toContain("summarize_file tool");
    expect(firstHtml).toContain("Captured source");
    expect(firstHtml).toContain("Not claimed");
    expect(firstHtml).toContain("Aggregate runtime evidence");
    expect(firstHtml).toContain("<strong>Scope:</strong>");
    expect(firstHtml).not.toContain("Interpretation limits");
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
    expect(afterRetry).not.toBe(current);
    expect(afterRetry).toContain("Published 2026-08-30T23:01:00Z");
    expect(afterRetry).toContain("Published 2026-08-30T23:02:00Z");
    expect(afterRetry).toContain("2 published runs");
  });

  it("links both target indexes to unique public ordinal run details", async () => {
    const repository = new FakeProjectionRepository();
    for (const [roleIndex, policy] of DEMO_TARGET_POLICIES.entries()) {
      for (let index = 0; index < 2; index += 1) {
        const hour = 23 - roleIndex * 2 - index;
        const completedAt = new Date(
          Date.UTC(2026, 7, 30, hour, 0, 0),
        ).toISOString();
        const publishedAt = new Date(
          Date.UTC(2026, 7, 30, hour, 1, 0),
        ).toISOString();
        const bundle = await bundleForPolicy(
          policy,
          `dashboard-linked-${roleIndex}-${index}`,
          completedAt,
        );
        repository.register(bundle);
        const refresher = new LocalDashboardPublicationRefresher({
          repository: repository as unknown as PostgresPublicationRepository,
          repositoryRoot,
        });
        await refresher
          .prepare(bundle)
          .execute(publicationFor(bundle, publishedAt));
      }
    }

    const html = await readFile(
      join(repositoryRoot, "dist", "dashboard-site", "index.html"),
      "utf8",
    );
    const indexTargets = [
      ...html.matchAll(
        /href="#(published-(?:controlled|reference)-run-\d+)"/gu,
      ),
    ].map((match) => match[1]!);
    const detailTargets = [
      ...html.matchAll(
        /class="history-run" id="(published-(?:controlled|reference)-run-\d+)"/gu,
      ),
    ].map((match) => match[1]!);
    expect(indexTargets).toEqual([
      "published-controlled-run-1",
      "published-controlled-run-2",
      "published-reference-run-1",
      "published-reference-run-2",
    ]);
    expect(detailTargets).toEqual(indexTargets);
    expect(new Set(detailTargets).size).toBe(detailTargets.length);
    expect(html.match(/<details class="scope-detail" open>/gu)).toHaveLength(2);
    expect(html).not.toContain("dashboard-linked-");
  });

  it("keeps at most five published history rows per selected target", async () => {
    const repository = new FakeProjectionRepository();
    const policy = DEMO_TARGET_POLICIES[0];
    const timestamps: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const completedAt = new Date(
        Date.UTC(2026, 7, 31, index, 0, 0),
      ).toISOString();
      const publishedAt = new Date(
        Date.UTC(2026, 7, 31, index, 1, 0),
      ).toISOString();
      timestamps.push(completedAt.replace(/\.000Z$/u, "Z"));
      const bundle = await bundleForPolicy(
        policy,
        `dashboard-history-${index}`,
        completedAt,
      );
      repository.register(bundle);
      const refresher = new LocalDashboardPublicationRefresher({
        repository: repository as unknown as PostgresPublicationRepository,
        repositoryRoot,
      });
      await refresher.prepare(bundle).execute(publicationFor(bundle, publishedAt));
    }

    const html = await readFile(
      join(repositoryRoot, "dist", "dashboard-site", "index.html"),
      "utf8",
    );
    expect(html).toContain("5 published runs");
    const indexTargets = [
      ...html.matchAll(/href="#(published-controlled-run-\d+)"/gu),
    ].map((match) => match[1]!);
    const detailTargets = [
      ...html.matchAll(
        /class="history-run" id="(published-controlled-run-\d+)"/gu,
      ),
    ].map((match) => match[1]!);
    expect(indexTargets).toHaveLength(5);
    expect(detailTargets).toHaveLength(5);
    expect(new Set(indexTargets).size).toBe(5);
    expect(detailTargets).toEqual(indexTargets);
    expect(html.match(/Latest published run/gu)).toHaveLength(1);
    expect(html).not.toContain(`report generated ${timestamps[0]}`);
    for (const timestamp of timestamps.slice(1)) {
      expect(html).toContain(`report generated ${timestamp}`);
    }
    expect(html).not.toContain("dashboard-history-");
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

describe("unseen MCP holdout summary rendering", () => {
  const holdout: UnseenHoldoutSummary = {
    runDate: "2026-08-30",
    caseCount: 3,
    cases: [
      {
        caseId: "everything",
        packageName: "@modelcontextprotocol/server-everything",
        packageVersion: "2026.8.18",
        probeOutcome: "catalog_discovered",
        invocationStatus: "completed",
        selectedTool: "get-env",
        findings: [],
      },
      {
        caseId: "panda",
        packageName: "@pandacss/mcp",
        packageVersion: "1.12.0",
        probeOutcome: "startup_failed_before_catalog",
        probeFailureClass: "required_project_configuration_absent",
        invocationStatus: "not_attempted_without_catalog",
        findings: [],
      },
      {
        caseId: "mantine",
        packageName: "@mantine/mcp-server",
        packageVersion: "9.5.2",
        probeOutcome: "catalog_discovered",
        invocationStatus: "completed",
        selectedTool: "list_items",
        findings: [{ ruleId: "runtime.unexpected_network_attempt", count: 4 }],
      },
    ],
  };

  it("renders package names, selected-call outcomes, and bounded findings", async () => {
    const template = await readFile(
      join(process.cwd(), "dashboard", "index.html"),
      "utf8",
    );
    const stylesheet = await readFile(
      join(process.cwd(), "dashboard", "styles.css"),
      "utf8",
    );
    const [controlledPolicy, referencePolicy] = DEMO_TARGET_POLICIES;
    const reportFiles = await Promise.all(
      DEMO_TARGET_POLICIES.map((policy) =>
        readFile(join(process.cwd(), "examples", "reports", policy.sampleReportFile)),
      ),
    );
    const reports = DEMO_TARGET_POLICIES.map((policy, index) => ({
        role: policy.role,
        reportBytes: reportFiles[index]!,
        expectedSha256: policy.sampleReportSha256,
        expectedTargetId: policy.targetId,
        displayName: policy.displayName,
        description: policy.description,
        scopeLabels: policy.scopeLabels,
        limitations: policy.limitations,
        presentation: { source: "sample" as const },
    }));
    if (
      reports[0] === undefined ||
      reports[1] === undefined ||
      reports[0].role !== "controlled" ||
      reports[1].role !== "reference"
    ) {
      throw new Error("dashboard policies did not produce a canonical pair");
    }
    const exported = buildDemoExportV1({
      reports: [reports[0], reports[1]],
    });
    const document = buildDashboardDocument({
      template,
      stylesheet,
      exported,
      unseenHoldout: holdout,
    });

    expect(document.html).toContain("Unseen MCP holdout");
    expect(document.html).toContain("@modelcontextprotocol/server-everything");
    expect(document.html).toContain("@pandacss/mcp");
    expect(document.html).toContain("@mantine/mcp-server");
    expect(document.html).toContain("Completed · get-env");
    expect(document.html).toContain(
      "Startup failed: required_project_configuration_absent",
    );
    expect(document.html).toContain("runtime.unexpected_network_attempt ×4");
    expect(document.html).not.toContain("run-2026");
    expect(document.html).not.toMatch(/[0-9a-f]{64}/u);
    expect(controlledPolicy).toBeDefined();
    expect(referencePolicy).toBeDefined();
  });
});
