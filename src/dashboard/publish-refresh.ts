import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { VerifiedRunBundle } from "../publish/bundle.js";
import {
  type PostgresPublicationRepository,
  type PublicationPublicMetadata,
  type PublicationRun,
  type StoredDashboardProjection,
} from "../publish/postgres.js";
import type {
  DashboardRefreshResult,
  PreparedDashboardRefresh,
  PublicationDashboardRefresher,
} from "../publish/publish-run.js";
import {
  buildDemoRunV1,
  DEMO_EXPORT_DISCLAIMER,
  demoExportV1Schema,
  demoRunV1Schema,
  type DemoRunV1,
} from "./demo-export.js";
import {
  DEMO_DASHBOARD_POLICY_ID,
  DEMO_TARGET_POLICIES,
  eligibleDemoPolicy,
  publishedDemoReportInput,
  type DemoTargetPolicy,
} from "./demo-policy.js";
import { replaceDashboardIndex } from "./local-site.js";
import {
  buildDashboardDocument,
  DASHBOARD_HISTORY_LIMIT_PER_TARGET,
} from "./render.js";

export interface LocalDashboardPublicationRefresherOptions {
  readonly repository: PostgresPublicationRepository;
  readonly repositoryRoot: string;
}

function projectionJson(run: DemoRunV1): PublicationPublicMetadata {
  return run as unknown as PublicationPublicMetadata;
}

function publishedProjectionForPolicy(
  stored: StoredDashboardProjection,
  policy: DemoTargetPolicy,
): DemoRunV1 {
  if (
    stored.policyId !== policy.policyId ||
    stored.targetId !== policy.targetId ||
    stored.role !== policy.role
  ) {
    throw new Error("stored dashboard projection has an unexpected policy identity");
  }
  const parsed = demoRunV1Schema.parse(stored.projection);
  const expectedScopeLabels = policy.scopeLabels.map((scope) => scope.label);
  const actualScopeLabels = parsed.behaviorScopes.map((scope) => scope.label);
  if (
    parsed.role !== policy.role ||
    parsed.presentation.source !== "published" ||
    parsed.presentation.publishedAt !== stored.publishedAt ||
    parsed.target.displayName !== policy.displayName ||
    parsed.target.description !== policy.description ||
    JSON.stringify(parsed.limitations) !== JSON.stringify(policy.limitations) ||
    JSON.stringify(actualScopeLabels) !== JSON.stringify(expectedScopeLabels)
  ) {
    throw new Error("stored dashboard projection violates its trusted presentation policy");
  }
  return parsed;
}

async function sampleProjection(
  repositoryRoot: string,
  policy: DemoTargetPolicy,
): Promise<DemoRunV1> {
  const reportBytes = await readFile(
    join(repositoryRoot, "examples", "reports", policy.sampleReportFile),
  );
  return buildDemoRunV1({
    role: policy.role,
    reportBytes,
    expectedSha256: policy.sampleReportSha256,
    expectedTargetId: policy.targetId,
    displayName: policy.displayName,
    description: policy.description,
    scopeLabels: policy.scopeLabels,
    limitations: policy.limitations,
    presentation: { source: "sample" },
  });
}

class NotSelectedDashboardRefresh implements PreparedDashboardRefresh {
  public async execute(): Promise<DashboardRefreshResult> {
    return { status: "not_selected" };
  }
}

class PreparedLocalDashboardRefresh implements PreparedDashboardRefresh {
  public constructor(
    private readonly options: LocalDashboardPublicationRefresherOptions,
    private readonly bundle: VerifiedRunBundle,
    private readonly policy: DemoTargetPolicy,
  ) {}

  public async execute(
    publication: PublicationRun,
  ): Promise<DashboardRefreshResult> {
    if (
      publication.status !== "published" ||
      publication.publishedAt === undefined ||
      publication.runId !== this.bundle.manifest.runId ||
      publication.targetId !== this.policy.targetId ||
      publication.manifestSha256 !== this.bundle.manifestSha256
    ) {
      throw new Error("dashboard refresh received an inconsistent publication identity");
    }
    const reportInput = publishedDemoReportInput(
      this.bundle,
      publication.publishedAt,
    );
    if (reportInput === undefined) {
      throw new Error("dashboard eligibility changed after publication finalization");
    }
    const projection = buildDemoRunV1(reportInput);
    await this.options.repository.storeDashboardProjection({
      runId: publication.runId,
      targetId: publication.targetId,
      manifestSha256: publication.manifestSha256,
      policyId: this.policy.policyId,
      role: this.policy.role,
      projection: projectionJson(projection),
    });

    return await this.options.repository.withDashboardRefreshLock(
      async (reader) => {
        const stored = await reader.getRecentPublishedDashboardProjections({
          policyId: DEMO_DASHBOARD_POLICY_ID,
          targetIds: DEMO_TARGET_POLICIES.map((policy) => policy.targetId),
          limitPerTarget: DASHBOARD_HISTORY_LIMIT_PER_TARGET,
        });
        const published = stored.map((entry) => {
          const policy = DEMO_TARGET_POLICIES.find(
            (candidate) => candidate.targetId === entry.targetId,
          );
          if (policy === undefined) {
            throw new Error("dashboard history contains an unexpected target");
          }
          return {
            targetId: entry.targetId,
            run: publishedProjectionForPolicy(entry, policy),
          };
        });
        const latestByTarget = new Map<string, DemoRunV1>();
        for (const entry of published) {
          if (!latestByTarget.has(entry.targetId)) {
            latestByTarget.set(entry.targetId, entry.run);
          }
        }
        const runs = await Promise.all(
          DEMO_TARGET_POLICIES.map(async (policy) => {
            const run = latestByTarget.get(policy.targetId);
            return run === undefined
              ? await sampleProjection(this.options.repositoryRoot, policy)
              : run;
          }),
        );
        const [controlled, reference] = runs;
        if (controlled === undefined || reference === undefined) {
          throw new Error(
            "dashboard policy did not produce its canonical run pair",
          );
        }
        const exported = demoExportV1Schema.parse({
          schema: "forge.demo-export/v1",
          disclaimer: DEMO_EXPORT_DISCLAIMER,
          runs: [controlled, reference],
        });
        const [template, stylesheet] = await Promise.all([
          readFile(
            join(this.options.repositoryRoot, "dashboard", "index.html"),
            "utf8",
          ),
          readFile(
            join(this.options.repositoryRoot, "dashboard", "styles.css"),
            "utf8",
          ),
        ]);
        const document = buildDashboardDocument({
          template,
          stylesheet,
          exported,
          history: published.map((entry) => entry.run),
        });
        const disposition = await replaceDashboardIndex({
          outputDirectory: join(
            this.options.repositoryRoot,
            "dist",
            "dashboard-site",
          ),
          manifestPath: join(
            this.options.repositoryRoot,
            "dist",
            "dashboard-site.manifest.json",
          ),
          document,
        });
        return { status: "refreshed", disposition };
      },
    );
  }
}

export class LocalDashboardPublicationRefresher
  implements PublicationDashboardRefresher
{
  private readonly options: LocalDashboardPublicationRefresherOptions;

  public constructor(options: LocalDashboardPublicationRefresherOptions) {
    this.options = {
      repository: options.repository,
      repositoryRoot: resolve(options.repositoryRoot),
    };
  }

  public prepare(bundle: VerifiedRunBundle): PreparedDashboardRefresh {
    const policy = eligibleDemoPolicy(bundle);
    if (policy === undefined) return new NotSelectedDashboardRefresh();

    const validationInput = publishedDemoReportInput(
      bundle,
      bundle.manifest.completedAt ?? bundle.manifest.createdAt,
    );
    if (validationInput === undefined) {
      return new NotSelectedDashboardRefresh();
    }
    buildDemoRunV1(validationInput);
    return new PreparedLocalDashboardRefresh(this.options, bundle, policy);
  }
}
