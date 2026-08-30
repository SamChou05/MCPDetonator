import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { z } from "zod";

import { loadTargetConfig } from "../config.js";
import { EvidenceStore, sha256File } from "../evidence-store.js";
import {
  createDockerMcpInvocation,
  defaultSandboxImage,
  ensureSandboxImage,
  sandboxImageId,
} from "../sandbox/docker.js";
import {
  createDeveloperProfileSeed,
  materializeDeveloperProfile,
} from "../sandbox/profile.js";
import { prepareTarget, type PreparedTarget } from "../target/prepare.js";
import { aggregateAgentTrials } from "./aggregate.js";
import {
  agentAggregateV1Schema,
  agentScenarioV1Schema,
  agentToolDefinitionV1Schema,
  agentTrialScoreV1Schema,
  type AgentPolicyModeV1,
  type AgentToolDefinitionV1,
  type AgentTrialScoreV1,
} from "./contracts.js";
import { removeAndVerifyAgentContainer } from "./docker-cleanup.js";
import { runAgentLoop, type AgentToolExecutionResult } from "./loop.js";
import { openRecordedMcpSession, type RecordedMcpSession } from "./mcp-session.js";
import type { AgentProvider } from "./providers/provider.js";
import {
  assertNoProviderCredentialInEvidence,
  assertNoProviderCredentialInValue,
  usableProviderCredentials,
} from "./redaction.js";
import { writeAgentReport } from "./report.js";
import type { LoadedAgentScenario } from "./scenario.js";
import { scoreAgentTrial } from "./scorer.js";
import {
  ControlledToolSet,
  type AgentToolDefinition as ControlledToolDefinition,
} from "./tools/controlled.js";
import { evaluateAgentUtility } from "./utility.js";

const environmentArtifactSchema = z
  .object({
    schema: z.literal("forge.agent-environment/v1"),
    runId: z.string().min(1),
    scenarioId: z.string().min(1),
    observerImageReference: z.string().min(1),
    observerImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    configuredProvider: z.literal("openrouter"),
    executionProvider: z.string().min(1).max(128),
    providerOverrideForTesting: z.boolean(),
    model: z.string().min(1),
    isolation: z
      .object({
        targetNetwork: z.literal("blocked"),
        targetProfile: z.literal("synthetic"),
        targetArtifact: z.literal("read_only_candidate"),
        targetRuntimeEnvironment: z.literal("empty"),
        providerTargetMetadata: z.literal("operator_approved"),
        providerTargetToolResults: z.literal("withheld"),
        controlledToolNetwork: z.literal("blocked"),
        providerCredentialMountedIntoTarget: z.literal(false),
      })
      .strict(),
  })
  .strict();

const combinedToolCatalogSchema = z.array(agentToolDefinitionV1Schema);
const receiverDeliverySchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    recipient: z.string().min(1),
    content: z.string(),
  })
  .strict();
const receiverDeliveriesSchema = z.array(receiverDeliverySchema);
const utilityObservationSchema = z
  .object({
    checkId: z.string().min(1),
    status: z.enum(["passed", "failed", "inconclusive"]),
    evidenceRefs: z.array(z.string().min(1)),
  })
  .strict();
const utilityObservationsSchema = z.array(utilityObservationSchema);
const trialCleanupArtifactSchema = z
  .object({
    schema: z.literal("forge.agent-trial-cleanup/v1"),
    trialId: z.string().min(1),
    sessionClosed: z.boolean(),
    targetContainerAbsent: z.boolean(),
    errors: z.array(z.string().min(1)),
  })
  .strict();

const TARGET_TOOL_RESULT_WITHHELD =
  "Target MCP result withheld from the external model by Forge Agent V1 data policy; full evidence remains local.";
const TARGET_TOOL_ERROR_WITHHELD =
  "Target MCP call failed; error details are withheld from the external model by Forge Agent V1 data policy.";

export interface AgentEvaluationOptions {
  readonly outputRoot: string;
  readonly projectRoot: string;
  readonly provider: AgentProvider;
  readonly providerCredentials: readonly string[];
  /** Test-only escape hatch; never exposed by the CLI. */
  readonly allowTestProviderOverride?: boolean;
  readonly image?: string;
  readonly rebuildImage?: boolean;
}

export interface AgentEvaluationResult {
  readonly runId: string;
  readonly runDirectory: string;
  readonly reportPath: string;
}

export class AgentEvaluationError extends Error {
  public constructor(
    message: string,
    public readonly runDirectory?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentEvaluationError";
  }
}

function createRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `agent-run-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function isJsonObject(value: unknown): value is Record<string, z.output<typeof z.json>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function targetToolDefinitions(session: RecordedMcpSession): AgentToolDefinitionV1[] {
  return session.mcpInterface.tools.map((tool) => {
    if (!isJsonObject(tool.inputSchema)) {
      throw new Error(`MCP tool '${tool.name}' input schema must be a JSON object`);
    }
    return agentToolDefinitionV1Schema.parse({
      schema: "forge.agent-tool-definition/v1",
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema,
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      source: "target_mcp",
      metadataTrust: "untrusted",
    });
  });
}

function controlledToolDefinitions(
  tools: readonly ControlledToolDefinition[],
): AgentToolDefinitionV1[] {
  return tools.map((tool) =>
    agentToolDefinitionV1Schema.parse({
      schema: "forge.agent-tool-definition/v1",
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema,
      source: "forge_controlled",
      metadataTrust: "controller_defined",
    }),
  );
}

function artifactTreeSha256(preparedTarget: PreparedTarget): string {
  const source = preparedTarget.provenance.source;
  return source.type === "npm" ? source.packageTreeSha256 : source.sourceTreeSha256;
}

function sameToolCatalog(
  left: readonly AgentToolDefinitionV1[],
  right: readonly AgentToolDefinitionV1[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function boundedLocalError(error: unknown): string {
  const message = error instanceof Error ? error.message : "cleanup failed";
  const normalized = message.replace(/\s+/gu, " ").trim();
  return normalized.length <= 256 ? normalized : `${normalized.slice(0, 255)}…`;
}

export async function evaluateAgentScenario(
  loadedScenario: LoadedAgentScenario,
  options: AgentEvaluationOptions,
): Promise<AgentEvaluationResult> {
  const providerName = options.provider.name;
  if (providerName.length === 0 || providerName.length > 128) {
    throw new AgentEvaluationError(
      "agent evaluation provider name must contain between 1 and 128 characters",
    );
  }
  const providerOverride =
    providerName !== loadedScenario.scenario.rollouts.provider;
  if (providerOverride && options.allowTestProviderOverride !== true) {
    throw new AgentEvaluationError(
      `scenario requires provider '${loadedScenario.scenario.rollouts.provider}', but evaluator received '${providerName}'`,
    );
  }
  const providerCredentials = usableProviderCredentials(
    options.providerCredentials,
  );
  if (providerName === "openrouter" && providerCredentials.length === 0) {
    throw new AgentEvaluationError(
      "OpenRouter evaluation requires its credential to be registered for isolation checks",
    );
  }

  let loadedTarget: Awaited<ReturnType<typeof loadTargetConfig>>;
  try {
    loadedTarget = await loadTargetConfig(loadedScenario.targetConfigPath);
    if (Object.keys(loadedTarget.config.target.runtime.env).length > 0) {
      throw new Error(
        "Agent V1 rejects target runtime environment variables; use non-secret command arguments for fixture selection",
      );
    }
    assertNoProviderCredentialInValue(
      {
        scenario: loadedScenario.scenario,
        targetConfig: loadedTarget.config,
      },
      providerCredentials,
    );
  } catch (error) {
    throw new AgentEvaluationError(
      "agent evaluation preflight failed before evidence or Docker resources were created",
      undefined,
      { cause: error },
    );
  }

  const imageReference = options.image ?? defaultSandboxImage;
  await ensureSandboxImage(
    options.projectRoot,
    imageReference,
    options.rebuildImage ?? false,
  );
  const image = await sandboxImageId(imageReference);
  const runId = createRunId();
  const store = await EvidenceStore.create(options.outputRoot, runId);
  let preparedTarget: PreparedTarget | undefined;

  try {
    await store.writeJson(
      "agent/scenario.json",
      agentScenarioV1Schema,
      loadedScenario.scenario,
    );
    await store.writeJson("agent/environment.json", environmentArtifactSchema, {
      schema: "forge.agent-environment/v1",
      runId,
      scenarioId: loadedScenario.scenario.id,
      observerImageReference: imageReference,
      observerImageId: image,
      configuredProvider: loadedScenario.scenario.rollouts.provider,
      executionProvider: providerName,
      providerOverrideForTesting: providerOverride,
      model: loadedScenario.scenario.rollouts.model,
      isolation: {
        targetNetwork: "blocked",
        targetProfile: "synthetic",
        targetArtifact: "read_only_candidate",
        targetRuntimeEnvironment: "empty",
        providerTargetMetadata:
          loadedScenario.scenario.providerData.targetMetadata,
        providerTargetToolResults:
          loadedScenario.scenario.providerData.targetToolResults,
        controlledToolNetwork: "blocked",
        providerCredentialMountedIntoTarget: false,
      },
    });

    preparedTarget = await prepareTarget({
      loaded: loadedTarget,
      runId,
      store,
      image,
    });
    const profileSeed = createDeveloperProfileSeed();
    const scores: AgentTrialScoreV1[] = [];
    const scoreRefs: string[] = [];
    let advertisedTools: AgentToolDefinitionV1[] | undefined;

    for (const policyMode of loadedScenario.scenario.rollouts.policyModes) {
      for (
        let trialNumber = 1;
        trialNumber <= loadedScenario.scenario.rollouts.trials;
        trialNumber += 1
      ) {
        const trialId = `${policyMode}-${trialNumber}`;
        const experimentId = `agent-${trialId}`;
        const trialEvidencePath = `agent/rollouts/${trialId}`;
        const profile = await materializeDeveloperProfile(
          store,
          experimentId,
          profileSeed,
        );
        const invocation = await createDockerMcpInvocation({
          runId,
          experimentId,
          config: loadedTarget.config,
          store,
          profile,
          preparedTarget,
          image,
        });
        let session: RecordedMcpSession | undefined;

        try {
          session = await openRecordedMcpSession({
            runId,
            experimentId,
            store,
            server: invocation.server,
            timeoutMs: loadedTarget.config.sandbox.limits.timeoutMs,
            evidencePath: `${trialEvidencePath}/mcp`,
          });
          const activeSession = session;
          const controlledTools = new ControlledToolSet({
            runId,
            trialId,
            image,
            profile,
            timeoutMs: loadedScenario.scenario.rollouts.limits.timeoutMs,
            enabled: loadedScenario.scenario.syntheticTools,
          });
          const catalog = [
            ...targetToolDefinitions(activeSession),
            ...controlledToolDefinitions(controlledTools.toolDefinitions()),
          ];
          if (catalog.length > 128) {
            throw new Error("agent tool catalog exceeds the 128 tool V1 limit");
          }
          if (Buffer.byteLength(JSON.stringify(catalog), "utf8") > 512_000) {
            throw new Error("agent tool catalog exceeds the 512 KB V1 limit");
          }
          const names = catalog.map((tool) => tool.name);
          if (new Set(names).size !== names.length) {
            throw new Error(
              "target and Forge-controlled tool names collide; V1 refuses ambiguous authority",
            );
          }
          assertNoProviderCredentialInValue(catalog, providerCredentials);
          if (advertisedTools === undefined) {
            advertisedTools = catalog;
            await store.writeJson(
              "agent/tool-catalog.json",
              combinedToolCatalogSchema,
              catalog,
            );
          } else if (!sameToolCatalog(advertisedTools, catalog)) {
            throw new Error(
              "advertised tool metadata changed between trials; results cannot be aggregated",
            );
          }

          const targetToolNames = new Set(
            catalog
              .filter((tool) => tool.source === "target_mcp")
              .map((tool) => tool.name),
          );
          const controlledToolNames = new Set(
            catalog
              .filter((tool) => tool.source === "forge_controlled")
              .map((tool) => tool.name),
          );
          const loopResult = await runAgentLoop({
            scenario: loadedScenario.scenario,
            trialId,
            policyMode,
            provider: options.provider,
            tools: catalog,
            store,
            evidencePath: trialEvidencePath,
            executeTool: async (
              name,
              arguments_,
              context,
            ): Promise<AgentToolExecutionResult> => {
              if (targetToolNames.has(name)) {
                try {
                  const result = await activeSession.callTool(
                    name,
                    arguments_,
                    context.timeoutMs,
                  );
                  return { content: TARGET_TOOL_RESULT_WITHHELD, result };
                } catch (error) {
                  throw new Error(TARGET_TOOL_ERROR_WITHHELD, { cause: error });
                }
              }
              if (controlledToolNames.has(name)) {
                const result = await controlledTools.execute(
                  name,
                  arguments_,
                  context.timeoutMs,
                );
                return { content: result.content, result: result.structured };
              }
              throw new Error(`model proposed unknown tool '${name}'`);
            },
          });
          await activeSession.cooldown(
            loadedTarget.config.sandbox.limits.cooldownMs,
          );

          const deliveriesRef = `${trialEvidencePath}/receiver-deliveries.json`;
          const deliveries = controlledTools.receiverDeliveries();
          await store.writeJson(
            deliveriesRef,
            receiverDeliveriesSchema,
            deliveries,
          );
          const filesystemOracle = new ControlledToolSet({
            runId,
            trialId,
            image,
            profile,
            timeoutMs: loadedScenario.scenario.rollouts.limits.timeoutMs,
            enabled: ["forge_read_file"],
          });
          const utilityRef = `${trialEvidencePath}/utility.json`;
          const utilityChecks = await evaluateAgentUtility({
            utility: loadedScenario.scenario.utility,
            filesystemOracle,
            deliveries,
            evidenceRef: utilityRef,
          });
          await store.writeJson(
            utilityRef,
            utilityObservationsSchema,
            utilityChecks,
          );

          const returnedModel = loopResult.returnedModels.at(-1) ?? "not-returned";
          const score = scoreAgentTrial({
            scoreId: `${trialId}-score`,
            scenarioId: loadedScenario.scenario.id,
            trialId,
            provider: providerName,
            requestedModel: loadedScenario.scenario.rollouts.model,
            returnedModel,
            policyMode,
            actions: loopResult.actions,
            decisions: loopResult.decisions,
            utilityChecks,
            turns: loopResult.turns,
            toolCalls: loopResult.toolCalls,
            limitsHit: [...loopResult.limitsHit],
            ...(loopResult.providerFailure === undefined
              ? {}
              : { inconclusiveReason: loopResult.providerFailure }),
            limitations: [
              "Target title and annotations are recorded exactly but are not projected into OpenRouter function fields unsupported by the provider API.",
              "Target MCP results and target-provided errors are retained locally but withheld from the external model.",
              "Classification covers model proposals, deterministic authorization, and declared utility only; it does not classify target runtime effects.",
              ...(loopResult.returnedModels.length <= 1
                ? []
                : ["The provider returned different model identifiers during one trial."]),
            ],
          });
          const scoreRef = `${trialEvidencePath}/score.json`;
          await store.writeJson(scoreRef, agentTrialScoreV1Schema, score);
          scores.push(score);
          scoreRefs.push(scoreRef);
        } finally {
          const cleanupErrors: string[] = [];
          let sessionClosed = session === undefined;
          let targetContainerAbsent = false;
          if (session !== undefined) {
            try {
              await session.close();
              sessionClosed = true;
            } catch (error) {
              cleanupErrors.push(`session close: ${boundedLocalError(error)}`);
            }
          }
          try {
            await removeAndVerifyAgentContainer(invocation.containerName, runId);
            targetContainerAbsent = true;
          } catch (error) {
            cleanupErrors.push(`target container: ${boundedLocalError(error)}`);
          }
          await store.writeJson(
            `${trialEvidencePath}/cleanup.json`,
            trialCleanupArtifactSchema,
            {
              schema: "forge.agent-trial-cleanup/v1",
              trialId,
              sessionClosed,
              targetContainerAbsent,
              errors: cleanupErrors,
            },
          );
          if (cleanupErrors.length > 0) {
            throw new Error(
              `Agent V1 could not verify cleanup for trial '${trialId}'`,
            );
          }
        }
      }
    }

    if (advertisedTools === undefined) {
      throw new Error("agent evaluation completed without discovering a tool catalog");
    }
    const aggregate = aggregateAgentTrials({
      aggregateId: `${loadedScenario.scenario.id}-aggregate`,
      scenarioId: loadedScenario.scenario.id,
      provider: providerName,
      requestedModel: loadedScenario.scenario.rollouts.model,
      policyModes: loadedScenario.scenario.rollouts.policyModes,
      configuredTrialsPerMode: loadedScenario.scenario.rollouts.trials,
      scores,
      scoreRefs,
    });
    await store.writeJson(
      "agent/aggregate.json",
      agentAggregateV1Schema,
      aggregate,
    );

    const scenarioSha256 = await sha256File(loadedScenario.scenarioPath);
    const targetConfigSha256 = await sha256File(loadedScenario.targetConfigPath);
    await assertNoProviderCredentialInEvidence(
      store.runDirectory,
      providerCredentials,
    );
    await writeAgentReport({
      store,
      reportId: `${runId}-report`,
      scenarioId: loadedScenario.scenario.id,
      scenarioSha256,
      targetId: loadedTarget.config.target.id,
      targetConfig: loadedScenario.scenario.targetConfig,
      targetConfigSha256,
      artifactTreeSha256: artifactTreeSha256(preparedTarget),
      provider: providerName,
      requestedModel: loadedScenario.scenario.rollouts.model,
      returnedModels: aggregate.returnedModels,
      policyModes: loadedScenario.scenario.rollouts.policyModes,
      advertisedTools,
      aggregate,
      limitations: [
        "Agent evaluation is an opt-in path and is not merged into forge.report/v1 or registry admission.",
        "The prepared target uses lifecycle scripts disabled; direct baseline analysis remains the authoritative install/runtime evidence path.",
        "Only operator-approved target tool metadata is sent to the provider; target MCP results and target errors are withheld from provider history.",
        "Agent V1 rejects target runtime environment variables, but operators must still avoid candidate artifacts or approved metadata containing sensitive data.",
        "Raw target strace evidence is retained, but Agent V1 does not apply the baseline normalizer or runtime rules.",
        "Agent classifications are proposal-and-utility scoped and do not assert that an MCP implementation's runtime effects are safe.",
        "Results are specific to the exact scenario, model, provider behavior, tool presentation, and completed trials.",
        "Docker with an in-container observer is prototype containment, not a production hostile-code boundary.",
      ],
    });
    await assertNoProviderCredentialInEvidence(
      store.runDirectory,
      providerCredentials,
    );
    return {
      runId,
      runDirectory: store.runDirectory,
      reportPath: store.pathFor("agent/report.json"),
    };
  } catch (error) {
    if (providerCredentials.length > 0) {
      try {
        await assertNoProviderCredentialInEvidence(
          store.runDirectory,
          providerCredentials,
        );
      } catch (credentialError) {
        try {
          await rm(store.runDirectory, { recursive: true, force: true });
        } catch (removalError) {
          throw new AgentEvaluationError(
            `agent evaluation failed and credential-bearing evidence could not be removed from ${store.runDirectory}`,
            store.runDirectory,
            { cause: removalError },
          );
        }
        throw new AgentEvaluationError(
          "agent evaluation failed a provider-credential isolation check; the run evidence was removed",
          undefined,
          { cause: credentialError },
        );
      }
    }
    throw new AgentEvaluationError(
      `agent evaluation failed; partial evidence is preserved in ${store.runDirectory}`,
      store.runDirectory,
      { cause: error },
    );
  } finally {
    await preparedTarget?.dispose();
  }
}
