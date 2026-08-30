#!/usr/bin/env node

import { Command } from "commander";
import { resolve } from "node:path";

import { AnalysisError, analyzeTarget } from "./analyze.js";
import {
  AgentEvaluationError,
  evaluateAgentScenario,
} from "./agent/runner.js";
import {
  AgentScenarioError,
  loadAgentScenario,
} from "./agent/scenario.js";
import { OpenRouterAgentProvider } from "./agent/providers/openrouter.js";
import {
  initializationEnabled,
  loadTargetConfig,
  resolveLocalSourcePath,
  TargetConfigError,
} from "./config.js";
import {
  loadPublishConfiguration,
  PublishConfigurationError,
} from "./publish/config.js";
import { publishRunToConfiguredInfrastructure } from "./publish/publish-run.js";
import { defaultSandboxImage } from "./sandbox/docker.js";

const program = new Command();

program
  .name("forge")
  .description("Observe and explain the behavior of a local MCP server")
  .version("0.1.0");

program
  .command("analyze")
  .description("Run isolated MCP experiments and preserve their evidence")
  .argument("<target>", "path to target.yaml")
  .option("-o, --output <directory>", "evidence output directory", "runs")
  .option("--image <name>", "sandbox image name", defaultSandboxImage)
  .option("--rebuild-image", "rebuild the sandbox image before analysis", false)
  .action(
    async (
      targetPath: string,
      options: { output: string; image: string; rebuildImage: boolean },
    ) => {
      const loaded = await loadTargetConfig(targetPath);
      const result = await analyzeTarget(loaded, {
        outputRoot: resolve(options.output),
        projectRoot: process.cwd(),
        image: options.image,
        rebuildImage: options.rebuildImage,
      });
      process.stdout.write(
        `${JSON.stringify(
          {
            status: "completed",
            runId: result.runId,
            runDirectory: result.runDirectory,
          },
          null,
          2,
        )}\n`,
      );
    },
  );

program
  .command("publish-run")
  .description(
    "Verify and publish a completed local run to S3-compatible storage and PostgreSQL",
  )
  .argument("<run-directory>", "path to a completed Forge run directory")
  .addHelpText(
    "after",
    `
Required environment:
  FORGE_PUBLISH_DATABASE_URL
  FORGE_PUBLISH_S3_BUCKET

Optional S3 settings:
  FORGE_PUBLISH_S3_REGION, FORGE_PUBLISH_S3_PREFIX,
  FORGE_PUBLISH_S3_ENDPOINT, FORGE_PUBLISH_S3_FORCE_PATH_STYLE

See PublisherDemo.md for the synthetic localhost demo and safety boundary.
`,
  )
  .action(async (runDirectory: string) => {
    const result = await publishRunToConfiguredInfrastructure(
      resolve(runDirectory),
      loadPublishConfiguration(),
    );
    process.stdout.write(
      `${JSON.stringify(
        {
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
        },
        null,
        2,
      )}\n`,
    );
  });

program
  .command("validate")
  .description("Validate a Forge target configuration without executing its target")
  .argument("<target>", "path to target.yaml")
  .action(async (targetPath: string) => {
    const loaded = await loadTargetConfig(targetPath);
    const localSourcePath = resolveLocalSourcePath(loaded);

    process.stdout.write(
      `${JSON.stringify(
        {
          valid: true,
          schema: loaded.config.schema,
          targetId: loaded.config.target.id,
          sourceType: loaded.config.target.source.type,
          experiments:
            loaded.config.experiments.tools.length +
            loaded.config.experiments.workflows.length +
            (initializationEnabled(loaded.config.experiments.initialization)
              ? 1
              : 0),
          ...(localSourcePath === undefined ? {} : { localSourcePath }),
        },
        null,
        2,
      )}\n`,
    );
  });

program
  .command("agent-evaluate")
  .description(
    "Run the separate, opt-in agent-context evaluation path with controlled provider data",
  )
  .argument("<scenario>", "path to forge.agent-scenario/v1 YAML")
  .option("-o, --output <directory>", "agent evidence output directory", "agent-runs")
  .option("--image <name>", "sandbox image name", defaultSandboxImage)
  .option("--rebuild-image", "rebuild the sandbox image before evaluation", false)
  .action(
    async (
      scenarioPath: string,
      options: { output: string; image: string; rebuildImage: boolean },
    ) => {
      const apiKey = process.env["OPENROUTER_API_KEY"];
      if (apiKey === undefined || apiKey.length === 0) {
        throw new AgentEvaluationError(
          "OPENROUTER_API_KEY is required for agent-evaluate and is never mounted into a target sandbox",
        );
      }
      const loaded = await loadAgentScenario(scenarioPath);
      const result = await evaluateAgentScenario(loaded, {
        outputRoot: resolve(options.output),
        projectRoot: process.cwd(),
        image: options.image,
        rebuildImage: options.rebuildImage,
        provider: new OpenRouterAgentProvider({ apiKey }),
        providerCredentials: [apiKey],
      });
      process.stdout.write(
        `${JSON.stringify(
          {
            status: "completed",
            runId: result.runId,
            runDirectory: result.runDirectory,
            report: result.reportPath,
          },
          null,
          2,
        )}\n`,
      );
    },
  );

program.parseAsync().catch((error: unknown) => {
  if (error instanceof TargetConfigError) {
    process.stderr.write(`forge: ${error.message}\n`);
  } else if (error instanceof PublishConfigurationError) {
    process.stderr.write(`forge: ${error.message}\n`);
  } else if (error instanceof AgentScenarioError) {
    process.stderr.write(`forge: ${error.message}\n`);
  } else if (error instanceof AgentEvaluationError) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    process.stderr.write(`forge: ${error.message}${cause}\n`);
  } else if (error instanceof AnalysisError) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    process.stderr.write(`forge: ${error.message}${cause}\n`);
  } else if (error instanceof Error) {
    process.stderr.write(`forge: ${error.message}\n`);
  } else {
    process.stderr.write("forge: unknown failure\n");
  }

  process.exitCode = 1;
});
