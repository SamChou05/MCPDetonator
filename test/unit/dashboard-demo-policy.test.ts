import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  reportV1Schema,
  type ReportV1,
  type RunManifestV1,
} from "../../src/contracts/v1.js";
import {
  DEMO_DASHBOARD_POLICY_ID,
  DEMO_TARGET_POLICIES,
  demoDashboardPolicyIdFor,
  eligibleDemoPolicy,
  publishedDemoReportInput,
  type DemoTargetPolicyDefinition,
} from "../../src/dashboard/demo-policy.js";
import type { VerifiedRunBundle } from "../../src/publish/bundle.js";

const reports = new Map<string, { bytes: Uint8Array; report: ReportV1 }>();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bundleForPolicy(index: number): VerifiedRunBundle {
  const policy = DEMO_TARGET_POLICIES[index]!;
  const fixture = reports.get(policy.targetId)!;
  const manifest: RunManifestV1 = {
    schema: "forge.run/v1",
    runId: fixture.report.runId,
    targetId: policy.targetId,
    configSha256: policy.configSha256,
    status: "completed",
    createdAt: "2026-08-30T18:00:00.000Z",
    completedAt: "2026-08-30T18:20:00.000Z",
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
    declaredSha256: sha256(fixture.bytes),
    verifiedSha256: sha256(fixture.bytes),
    sizeBytes: fixture.bytes.byteLength,
    snapshotHandle: {} as VerifiedRunBundle["reportArtifact"]["snapshotHandle"],
  };
  return {
    runDirectory: "/private/run",
    manifestPath: "/private/run/run.json",
    manifestBytes: new Uint8Array(),
    manifestSha256: "a".repeat(64),
    manifest,
    reportBytes: fixture.bytes,
    report: structuredClone(fixture.report),
    reportArtifact,
    artifacts: [reportArtifact],
    async close() {},
  };
}

beforeAll(async () => {
  await Promise.all(
    DEMO_TARGET_POLICIES.map(async (policy) => {
      const bytes = await readFile(
        join(
          process.cwd(),
          "examples",
          "reports",
          policy.sampleReportFile,
        ),
      );
      reports.set(policy.targetId, {
        bytes,
        report: reportV1Schema.parse(
          JSON.parse(new TextDecoder().decode(bytes)) as unknown,
        ),
      });
    }),
  );
});

describe("dashboard publication policy", () => {
  it("binds the stored policy identity to every reviewed target pin", () => {
    const definitions = DEMO_TARGET_POLICIES.map(
      ({ policyId: _policyId, ...definition }) => definition,
    ) satisfies DemoTargetPolicyDefinition[];
    expect(demoDashboardPolicyIdFor(definitions)).toBe(
      DEMO_DASHBOARD_POLICY_ID,
    );

    const revoked = structuredClone(definitions);
    revoked[0]!.configSha256 = "0".repeat(64);
    expect(demoDashboardPolicyIdFor(revoked)).not.toBe(
      DEMO_DASHBOARD_POLICY_ID,
    );
  });

  it("selects only the two fully pinned target identities", () => {
    for (const [index, policy] of DEMO_TARGET_POLICIES.entries()) {
      expect(eligibleDemoPolicy(bundleForPolicy(index))).toEqual(policy);
    }
  });

  it("rejects a matching target ID with the wrong config or source identity", () => {
    const wrongConfig = bundleForPolicy(0);
    wrongConfig.manifest.configSha256 = "0".repeat(64);
    expect(eligibleDemoPolicy(wrongConfig)).toBeUndefined();

    const wrongSource = bundleForPolicy(0);
    const source = wrongSource.report.artifactProvenance.source;
    if (source.type !== "local") throw new Error("unexpected fixture source");
    source.sourceTreeSha256 = "0".repeat(64);
    expect(eligibleDemoPolicy(wrongSource)).toBeUndefined();
  });

  it("rejects changed experiment scope and arbitrary targets", () => {
    const changedScope = bundleForPolicy(1);
    changedScope.report.behaviorComparison.scopes.reverse();
    expect(eligibleDemoPolicy(changedScope)).toBeUndefined();

    const arbitrary = bundleForPolicy(1);
    arbitrary.manifest.targetId = "arbitrary-target";
    arbitrary.report.targetId = "arbitrary-target";
    arbitrary.report.artifactProvenance.targetId = "arbitrary-target";
    expect(eligibleDemoPolicy(arbitrary)).toBeUndefined();
  });

  it("creates a published input without copying report-authored presentation text", () => {
    const bundle = bundleForPolicy(0);
    bundle.report.summary = "Private controller-authored summary";
    bundle.report.findings[0]!.title = "Private controller-authored title";
    const input = publishedDemoReportInput(
      bundle,
      "2026-08-30T21:00:00.000Z",
    );

    expect(input).toMatchObject({
      role: "controlled",
      expectedTargetId: "deceptive-document-summarizer",
      presentation: {
        source: "published",
        publishedAt: "2026-08-30T21:00:00.000Z",
      },
    });
    expect(input?.description).not.toContain("Private controller");
    expect(input?.limitations).not.toContain("Private controller-authored title");
  });
});
