import { describe, expect, it, vi } from "vitest";

import {
  AnalyzeCommandUsageError,
  AnalyzePublicationError,
  analyzeCommandExitCode,
  createAnalyzeCommandOutput,
  createAnalyzePublicationFailureOutput,
  executeAnalyzeCommand,
  type AnalyzeCommandDependencies,
  type AnalyzeCommandOptions,
} from "../../src/analyze-command.js";
import { AnalysisError, type AnalyzeResult } from "../../src/analyze.js";
import type { LoadedTargetConfig } from "../../src/config.js";
import type { PublishConfiguration } from "../../src/publish/config.js";
import type {
  DashboardRefreshResult,
  PublishRunResult,
} from "../../src/publish/publish-run.js";

const loadedTarget = {
  config: {},
  configPath: "/repo/target.yaml",
  configDirectory: "/repo",
} as LoadedTargetConfig;

const analysis: AnalyzeResult = {
  runId: "run-20260830123456-12345678",
  runDirectory: "/repo/evidence/run-20260830123456-12345678",
};

const publicationConfiguration: PublishConfiguration = {
  databaseUrl: "postgresql://forge:secret@localhost/forge",
  s3Bucket: "forge-evidence",
  s3Region: "us-east-1",
  s3Prefix: "demo",
  s3ForcePathStyle: true,
  s3Endpoint: "http://127.0.0.1:59000",
};

function publication(
  dashboard: DashboardRefreshResult = { status: "not_configured" },
): PublishRunResult {
  return {
    status: "published",
    runId: analysis.runId,
    targetId: "deceptive-document-summarizer",
    manifestSha256: "a".repeat(64),
    manifestObject: {
      bucket: "forge-evidence",
      key: `demo/runs/${analysis.runId}/run.json`,
      sha256: "a".repeat(64),
      sizeBytes: 1_024,
      created: true,
    },
    artifactCount: 12,
    findingCount: 3,
    beginDisposition: "created",
    finalizeDisposition: "published",
    dashboard,
  };
}

function commandOptions(
  overrides: Partial<AnalyzeCommandOptions> = {},
): AnalyzeCommandOptions {
  return {
    output: "evidence",
    image: "forge-observer:test",
    rebuildImage: false,
    publish: false,
    refreshDashboard: false,
    ...overrides,
  };
}

function commandDependencies() {
  const loadTargetConfig = vi.fn(async (_targetPath: string) => loadedTarget);
  const analyzeTarget = vi.fn(async () => analysis);
  const loadPublishConfiguration = vi.fn(() => publicationConfiguration);
  const publishRunToConfiguredInfrastructure = vi.fn(async () => publication());
  const cwd = vi.fn(() => "/repo");
  const dependencies: AnalyzeCommandDependencies = {
    cwd,
    loadTargetConfig,
    analyzeTarget,
    loadPublishConfiguration,
    publishRunToConfiguredInfrastructure,
  };

  return {
    dependencies,
    cwd,
    loadTargetConfig,
    analyzeTarget,
    loadPublishConfiguration,
    publishRunToConfiguredInfrastructure,
  };
}

describe("analyze command orchestration", () => {
  it("requires explicit publication before a dashboard refresh", async () => {
    const mocks = commandDependencies();
    const execution = executeAnalyzeCommand(
      "target.yaml",
      commandOptions({ refreshDashboard: true }),
      mocks.dependencies,
    );

    await expect(execution).rejects.toBeInstanceOf(AnalyzeCommandUsageError);
    await expect(execution).rejects.toThrow(
      "--refresh-dashboard requires explicit --publish",
    );

    expect(mocks.cwd).not.toHaveBeenCalled();
    expect(mocks.loadTargetConfig).not.toHaveBeenCalled();
    expect(mocks.analyzeTarget).not.toHaveBeenCalled();
    expect(mocks.loadPublishConfiguration).not.toHaveBeenCalled();
    expect(mocks.publishRunToConfiguredInfrastructure).not.toHaveBeenCalled();
  });

  it("preserves the original analyze-only output and never loads publication", async () => {
    const mocks = commandDependencies();
    const result = await executeAnalyzeCommand(
      "target.yaml",
      commandOptions(),
      mocks.dependencies,
    );

    expect(result).toEqual({ analysis });
    expect(createAnalyzeCommandOutput(result)).toEqual({
      status: "completed",
      runId: analysis.runId,
      runDirectory: analysis.runDirectory,
    });
    expect(analyzeCommandExitCode(result)).toBe(0);
    expect(mocks.loadTargetConfig).toHaveBeenCalledWith("target.yaml");
    expect(mocks.analyzeTarget).toHaveBeenCalledWith(loadedTarget, {
      outputRoot: "/repo/evidence",
      projectRoot: "/repo",
      image: "forge-observer:test",
      rebuildImage: false,
    });
    expect(mocks.loadPublishConfiguration).not.toHaveBeenCalled();
    expect(mocks.publishRunToConfiguredInfrastructure).not.toHaveBeenCalled();
  });

  it("fails fast on invalid publication configuration before analysis", async () => {
    const mocks = commandDependencies();
    const configurationError = new Error("publication configuration is invalid");
    mocks.loadPublishConfiguration.mockImplementation(() => {
      throw configurationError;
    });

    await expect(
      executeAnalyzeCommand(
        "target.yaml",
        commandOptions({ publish: true }),
        mocks.dependencies,
      ),
    ).rejects.toBe(configurationError);
    expect(mocks.analyzeTarget).not.toHaveBeenCalled();
    expect(mocks.publishRunToConfiguredInfrastructure).not.toHaveBeenCalled();
  });

  it("never publishes when analysis fails", async () => {
    const mocks = commandDependencies();
    const analysisError = new AnalysisError(
      "analysis failed; partial evidence is preserved",
      "/repo/evidence/failed-run",
    );
    mocks.analyzeTarget.mockRejectedValue(analysisError);

    await expect(
      executeAnalyzeCommand(
        "target.yaml",
        commandOptions({ publish: true }),
        mocks.dependencies,
      ),
    ).rejects.toBe(analysisError);
    expect(mocks.loadPublishConfiguration).toHaveBeenCalledOnce();
    expect(mocks.publishRunToConfiguredInfrastructure).not.toHaveBeenCalled();
  });

  it.each([
    { refreshDashboard: false, publisherOptions: undefined },
    {
      refreshDashboard: true,
      publisherOptions: { dashboardRepositoryRoot: "/repo" },
    },
  ])(
    "publishes the exact completed run with refresh=$refreshDashboard",
    async ({ refreshDashboard, publisherOptions }) => {
      const callOrder: string[] = [];
      const mocks = commandDependencies();
      const published = publication();
      mocks.loadTargetConfig.mockImplementation(async () => {
        callOrder.push("load-target");
        return loadedTarget;
      });
      mocks.loadPublishConfiguration.mockImplementation(() => {
        callOrder.push("load-publication");
        return publicationConfiguration;
      });
      mocks.analyzeTarget.mockImplementation(async () => {
        callOrder.push("analyze");
        return analysis;
      });
      mocks.publishRunToConfiguredInfrastructure.mockImplementation(async () => {
        callOrder.push("publish");
        return published;
      });

      const result = await executeAnalyzeCommand(
        "target.yaml",
        commandOptions({ publish: true, refreshDashboard }),
        mocks.dependencies,
      );

      expect(callOrder).toEqual([
        "load-target",
        "load-publication",
        "analyze",
        "publish",
      ]);
      expect(mocks.publishRunToConfiguredInfrastructure).toHaveBeenCalledWith(
        analysis.runDirectory,
        publicationConfiguration,
        publisherOptions,
      );
      expect(createAnalyzeCommandOutput(result)).toEqual({
        status: "completed",
        runId: analysis.runId,
        runDirectory: analysis.runDirectory,
        publication: {
          status: "published",
          runId: analysis.runId,
          targetId: published.targetId,
          manifestSha256: published.manifestSha256,
          artifactCount: published.artifactCount,
          findingCount: published.findingCount,
          manifestObject: published.manifestObject,
          retry: {
            begin: "created",
            finalize: "published",
          },
          dashboard: { status: "not_configured" },
        },
      });
      expect(analyzeCommandExitCode(result)).toBe(0);
    },
  );

  it.each([false, true])(
    "retains structured retry arguments with refresh=%s when publication is not confirmed",
    async (refreshDashboard) => {
      const mocks = commandDependencies();
      const publicationError = new Error(
        "postgresql://forge:secret@localhost/forge disconnected",
      );
      mocks.publishRunToConfiguredInfrastructure.mockRejectedValue(
        publicationError,
      );

      let caught: unknown;
      try {
        await executeAnalyzeCommand(
          "target.yaml",
          commandOptions({ publish: true, refreshDashboard }),
          mocks.dependencies,
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AnalyzePublicationError);
      const error = caught as AnalyzePublicationError;
      expect(error.analysis).toEqual(analysis);
      expect(error.cause).toBe(publicationError);
      const output = createAnalyzePublicationFailureOutput(error);
      expect(output).toEqual({
        status: "analysis_completed_publication_failed",
        runId: analysis.runId,
        runDirectory: analysis.runDirectory,
        publication: {
          status: "not_confirmed",
          message:
            "publication outcome was not confirmed; retry the exact run safely",
        },
        retry: {
          command: "forge",
          args: [
            "publish-run",
            analysis.runDirectory,
            ...(refreshDashboard ? ["--refresh-dashboard"] : []),
          ],
        },
      });
      expect(JSON.stringify(output)).not.toContain("secret");
      expect(mocks.analyzeTarget).toHaveBeenCalledOnce();
      expect(mocks.publishRunToConfiguredInfrastructure).toHaveBeenCalledOnce();
    },
  );

  it("reports dashboard failure without hiding successful publication", async () => {
    const mocks = commandDependencies();
    mocks.publishRunToConfiguredInfrastructure.mockResolvedValue(
      publication({
        status: "failed",
        message: "local snapshot replacement failed",
        retryable: true,
      }),
    );

    const result = await executeAnalyzeCommand(
      "target.yaml",
      commandOptions({ publish: true, refreshDashboard: true }),
      mocks.dependencies,
    );

    expect(createAnalyzeCommandOutput(result)).toMatchObject({
      status: "completed",
      runDirectory: analysis.runDirectory,
      publication: {
        status: "published",
        dashboard: {
          status: "failed",
          retryable: true,
        },
      },
    });
    expect(analyzeCommandExitCode(result)).toBe(2);
  });
});
