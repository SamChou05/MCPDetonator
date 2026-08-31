import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDemoExportV1 } from "../dist/dashboard/demo-export.js";
import { DEMO_TARGET_POLICIES } from "../dist/dashboard/demo-policy.js";
import { loadUnseenHoldoutSummary } from "../dist/dashboard/holdout-summary.js";
import { writeCompleteDashboardSite } from "../dist/dashboard/local-site.js";
import { buildDashboardDocument } from "../dist/dashboard/render.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const outputDirectory = resolve(repositoryRoot, "dist", "dashboard-site");
const manifestPath = resolve(
  repositoryRoot,
  "dist",
  "dashboard-site.manifest.json",
);

async function build() {
  if (outputDirectory !== join(repositoryRoot, "dist", "dashboard-site")) {
    throw new Error("refusing to write an unexpected dashboard output path");
  }
  const [template, stylesheet, unseenHoldout, ...reportBytes] = await Promise.all([
    readFile(join(repositoryRoot, "dashboard", "index.html"), "utf8"),
    readFile(join(repositoryRoot, "dashboard", "styles.css"), "utf8"),
    loadUnseenHoldoutSummary(repositoryRoot),
    ...DEMO_TARGET_POLICIES.map((policy) =>
      readFile(join(repositoryRoot, "examples", "reports", policy.sampleReportFile)),
    ),
  ]);
  const reports = DEMO_TARGET_POLICIES.map((policy, index) => ({
    role: policy.role,
    reportBytes: reportBytes[index],
    expectedSha256: policy.sampleReportSha256,
    expectedTargetId: policy.targetId,
    displayName: policy.displayName,
    description: policy.description,
    scopeLabels: policy.scopeLabels,
    limitations: policy.limitations,
    presentation: { source: "sample" },
  }));
  if (reports.length !== 2 || reports[0] === undefined || reports[1] === undefined) {
    throw new Error("dashboard policy must contain exactly two targets");
  }
  const exported = buildDemoExportV1({ reports: [reports[0], reports[1]] });
  const document = buildDashboardDocument({
    template,
    stylesheet,
    exported,
    unseenHoldout,
  });
  await writeCompleteDashboardSite({ outputDirectory, manifestPath, document });
  process.stdout.write(
    "Built dist/dashboard-site/index.html, styles.css, and the private deployment manifest\n",
  );
}

await build();
