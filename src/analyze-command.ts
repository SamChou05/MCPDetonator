import { resolve } from "node:path";

import {
  analyzeTarget,
  type AnalyzeOptions,
  type AnalyzeResult,
} from "./analyze.js";
import { loadTargetConfig, type LoadedTargetConfig } from "./config.js";
import {
  loadPublishConfiguration,
  type PublishConfiguration,
} from "./publish/config.js";
import {
  publishRunToConfiguredInfrastructure,
  type DashboardRefreshResult,
  type PublishRunResult,
} from "./publish/publish-run.js";
import type { StoredS3Object } from "./publish/s3.js";

export interface AnalyzeCommandOptions {
  readonly output: string;
  readonly image: string;
  readonly rebuildImage: boolean;
  readonly publish: boolean;
  readonly refreshDashboard: boolean;
}

export interface AnalyzeCommandDependencies {
  readonly cwd: () => string;
  readonly loadTargetConfig: (
    targetPath: string,
  ) => Promise<LoadedTargetConfig>;
  readonly analyzeTarget: (
    loaded: LoadedTargetConfig,
    options: AnalyzeOptions,
  ) => Promise<AnalyzeResult>;
  readonly loadPublishConfiguration: () => PublishConfiguration;
  readonly publishRunToConfiguredInfrastructure: (
    runDirectory: string,
    configuration: PublishConfiguration,
    options?: { readonly dashboardRepositoryRoot: string },
  ) => Promise<PublishRunResult>;
}

export interface AnalyzeCommandResult {
  readonly analysis: AnalyzeResult;
  readonly publication?: PublishRunResult;
}

export interface PublicationSummary {
  readonly status: "published";
  readonly runId: string;
  readonly targetId: string;
  readonly manifestSha256: string;
  readonly artifactCount: number;
  readonly findingCount: number;
  readonly manifestObject: StoredS3Object;
  readonly retry: {
    readonly begin: PublishRunResult["beginDisposition"];
    readonly finalize: PublishRunResult["finalizeDisposition"];
  };
  readonly dashboard: DashboardRefreshResult;
}

export interface AnalyzeCommandOutput {
  readonly status: "completed";
  readonly runId: string;
  readonly runDirectory: string;
  readonly publication?: PublicationSummary;
}

export interface AnalyzePublicationFailureOutput {
  readonly status: "analysis_completed_publication_failed";
  readonly runId: string;
  readonly runDirectory: string;
  readonly publication: {
    readonly status: "not_confirmed";
    readonly message: string;
  };
  readonly retry: {
    readonly command: "forge";
    readonly args: readonly string[];
  };
}

export class AnalyzeCommandUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AnalyzeCommandUsageError";
  }
}

export class AnalyzePublicationError extends Error {
  public readonly retryArguments: readonly string[];

  public constructor(
    public readonly analysis: AnalyzeResult,
    refreshDashboard: boolean,
    options: ErrorOptions,
  ) {
    super(
      "analysis completed, but publication was not confirmed; exact retry is safe",
      options,
    );
    this.name = "AnalyzePublicationError";
    this.retryArguments = [
      "publish-run",
      analysis.runDirectory,
      ...(refreshDashboard ? ["--refresh-dashboard"] : []),
    ];
  }
}

const defaultDependencies: AnalyzeCommandDependencies = {
  cwd: () => process.cwd(),
  loadTargetConfig,
  analyzeTarget,
  loadPublishConfiguration,
  publishRunToConfiguredInfrastructure,
};

export function summarizePublication(
  result: PublishRunResult,
): PublicationSummary {
  return {
    status: result.status,
    runId: result.runId,
    targetId: result.targetId,
    manifestSha256: result.manifestSha256,
    artifactCount: result.artifactCount,
    findingCount: result.findingCount,
    manifestObject: result.manifestObject,
    retry: {
      begin: result.beginDisposition,
      finalize: result.finalizeDisposition,
    },
    dashboard: result.dashboard,
  };
}

export function createAnalyzeCommandOutput(
  result: AnalyzeCommandResult,
): AnalyzeCommandOutput {
  return {
    status: "completed",
    runId: result.analysis.runId,
    runDirectory: result.analysis.runDirectory,
    ...(result.publication === undefined
      ? {}
      : { publication: summarizePublication(result.publication) }),
  };
}

export function createAnalyzePublicationFailureOutput(
  error: AnalyzePublicationError,
): AnalyzePublicationFailureOutput {
  return {
    status: "analysis_completed_publication_failed",
    runId: error.analysis.runId,
    runDirectory: error.analysis.runDirectory,
    publication: {
      status: "not_confirmed",
      message:
        "publication outcome was not confirmed; retry the exact run safely",
    },
    retry: {
      command: "forge",
      args: error.retryArguments,
    },
  };
}

export function analyzeCommandExitCode(result: AnalyzeCommandResult): 0 | 2 {
  return result.publication?.dashboard.status === "failed" ? 2 : 0;
}

export async function executeAnalyzeCommand(
  targetPath: string,
  options: AnalyzeCommandOptions,
  dependencies: AnalyzeCommandDependencies = defaultDependencies,
): Promise<AnalyzeCommandResult> {
  if (options.refreshDashboard && !options.publish) {
    throw new AnalyzeCommandUsageError(
      "--refresh-dashboard requires explicit --publish",
    );
  }

  const projectRoot = dependencies.cwd();
  const loaded = await dependencies.loadTargetConfig(targetPath);
  const publicationConfiguration = options.publish
    ? dependencies.loadPublishConfiguration()
    : undefined;
  const analysis = await dependencies.analyzeTarget(loaded, {
    outputRoot: resolve(projectRoot, options.output),
    projectRoot,
    image: options.image,
    rebuildImage: options.rebuildImage,
  });

  if (publicationConfiguration === undefined) {
    return { analysis };
  }

  try {
    const publication = await dependencies.publishRunToConfiguredInfrastructure(
      analysis.runDirectory,
      publicationConfiguration,
      options.refreshDashboard
        ? { dashboardRepositoryRoot: projectRoot }
        : undefined,
    );
    return { analysis, publication };
  } catch (error) {
    throw new AnalyzePublicationError(analysis, options.refreshDashboard, {
      cause: error,
    });
  }
}
