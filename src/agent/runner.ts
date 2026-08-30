import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { z } from "zod";

import { loadTargetConfig, targetConfigV1Schema } from "../config.js";
import { EvidenceStore, sha256File } from "../evidence-store.js";
import {
  createDockerMcpInvocation,
  defaultSandboxImage,
  ensureSandboxImage,
  MCP_STDIO_MESSAGE_BUFFER_BYTES,
  sandboxImageId,
} from "../sandbox/docker.js";
import {
  createDeveloperProfileSeed,
  materializeDeveloperProfile,
} from "../sandbox/profile.js";
import {
  digestTargetTree,
  prepareTarget,
  type PreparedTarget,
} from "../target/prepare.js";
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
import {
  AgentCleanupVerificationError,
  removeAndVerifyAgentContainer,
} from "./docker-cleanup.js";
import { runAgentLoop, type AgentToolExecutionResult } from "./loop.js";
import {
  MAX_MCP_STDERR_BYTES,
  MAX_MCP_TRANSCRIPT_BYTES,
  MAX_MCP_TRANSCRIPT_MESSAGES,
  McpSessionInitializationCleanupError,
  openRecordedMcpSession,
  type RecordedMcpSession,
} from "./mcp-session.js";
import { targetProviderMetadataSha256 } from "./provider-data.js";
import type { AgentProvider } from "./providers/provider.js";
import {
  assertNoProviderCredentialInEvidence,
  assertNoProviderCredentialInPreparedTarget,
  assertNoProviderCredentialInValue,
  usableProviderCredentials,
} from "./redaction.js";
import {
  AgentTrialResourceQuotaError,
  MAX_AGENT_TRIAL_WRITABLE_BYTES,
  MAX_AGENT_TRIAL_WRITABLE_ENTRIES,
  startAgentTrialResourceQuotaMonitor,
} from "./resource-quota.js";
import {
  AGENT_TARGET_WORKSPACE_BYTES,
  AGENT_TARGET_WORKSPACE_MAX_INODES,
  AGENT_PROCESS_FILE_BYTES,
  hardenAgentDockerInvocation,
} from "./sandbox.js";
import { writeAgentReport } from "./report.js";
import type { LoadedAgentScenario } from "./scenario.js";
import { scoreAgentTrial } from "./scorer.js";
import {
  ControlledToolSet,
  type AgentToolDefinition as ControlledToolDefinition,
} from "./tools/controlled.js";
import {
  TargetContainerFilesystemOracle,
  observeTargetActionPaths,
} from "./tools/target-container.js";
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
    approvedTargetMetadataSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    isolation: z
      .object({
        targetNetwork: z.literal("blocked"),
        targetProfile: z.literal("synthetic"),
        targetAndControlledProfiles: z.literal("separate_taint_domains"),
        targetAndControlledCanaries: z.literal("distinct"),
        targetArtifact: z.literal("read_only_candidate"),
        targetRuntimeEnvironment: z.literal("empty"),
        providerTargetMetadata: z.literal("operator_approved"),
        providerTargetToolResults: z.literal("withheld"),
        controlledToolNetwork: z.literal("blocked"),
        providerCredentialMountedIntoTarget: z.literal(false),
        targetWritableState: z
          .object({
            enforcement: z.literal(
              "readonly_home_tmpfs_workspace_trace_rlimit_and_monitor",
            ),
            workspaceMaxBytes: z.literal(AGENT_TARGET_WORKSPACE_BYTES),
            workspaceMaxEntries: z.literal(
              AGENT_TARGET_WORKSPACE_MAX_INODES,
            ),
            processFileMaxBytes: z.literal(AGENT_PROCESS_FILE_BYTES),
            monitoredMaxBytes: z.literal(MAX_AGENT_TRIAL_WRITABLE_BYTES),
            monitoredMaxEntries: z.literal(
              MAX_AGENT_TRIAL_WRITABLE_ENTRIES,
            ),
          })
          .strict(),
        mcpEvidence: z
          .object({
            maxTranscriptMessages: z.literal(MAX_MCP_TRANSCRIPT_MESSAGES),
            maxTranscriptPayloadBytes: z.literal(MAX_MCP_TRANSCRIPT_BYTES),
            maxRawStdioMessageBytes: z.literal(
              MCP_STDIO_MESSAGE_BUFFER_BYTES,
            ),
            maxStderrBytes: z.literal(MAX_MCP_STDERR_BYTES),
          })
          .strict(),
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
    observations: z.array(
      z
        .object({
          domain: z.enum(["target", "controlled", "receiver"]),
          outcome: z.enum([
            "matched",
            "missing",
            "wrong_kind",
            "content_mismatch",
            "not_matched",
            "observer_error",
          ]),
          path: z.string().min(1).optional(),
          kind: z.enum(["file", "directory", "other"]).optional(),
          bytes: z.number().int().nonnegative().optional(),
          contentSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
          recipient: z.string().min(1).optional(),
          deliverySequence: z.number().int().nonnegative().optional(),
        })
        .strict(),
    ),
  })
  .strict();
const utilityObservationsSchema = z.array(utilityObservationSchema);
const targetPathObservationsSchema = z.array(
  z
    .object({
      actionId: z.string().min(1),
      toolName: z.string().min(1),
      path: z.string().min(1),
      exists: z.boolean().optional(),
      kind: z.enum(["file", "directory", "other"]).optional(),
      bytes: z.number().int().nonnegative().optional(),
      contentSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
      readStatus: z.enum([
        "hashed",
        "not_file",
        "missing",
        "observer_error",
      ]),
    })
    .strict(),
);
const providerDataArtifactSchema = z
  .object({
    schema: z.literal("forge.agent-provider-data/v1"),
    approvedTargetMetadataSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    observedTargetMetadataSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    matched: z.boolean(),
    targetToolCount: z.number().int().nonnegative(),
  })
  .strict();
const trialCleanupArtifactSchema = z
  .object({
    schema: z.literal("forge.agent-trial-cleanup/v1"),
    trialId: z.string().min(1),
    sessionClosed: z.boolean(),
    targetContainerAbsent: z.boolean(),
    resourceQuotaRef: z.string().min(1),
    resourceQuotaStatus: z.enum([
      "monitoring",
      "within_quota",
      "violated",
      "verification_failed",
    ]),
    errors: z.array(z.string().min(1)),
  })
  .strict();
const resourceQuotaArtifactSchema = z
  .object({
    schema: z.literal("forge.agent-resource-quota/v1"),
    trialId: z.string().min(1),
    limits: z
      .object({
        maxBytes: z.number().int().positive(),
        maxEntries: z.number().int().positive(),
        maxFileBytes: z.number().int().positive().optional(),
      })
      .strict(),
    roots: z.array(z.string().min(1)),
    latest: z
      .object({
        bytes: z.number().int().nonnegative(),
        entries: z.number().int().nonnegative(),
      })
      .strict(),
    peak: z
      .object({
        bytes: z.number().int().nonnegative(),
        entries: z.number().int().nonnegative(),
      })
      .strict(),
    status: z.enum([
      "monitoring",
      "within_quota",
      "violated",
      "verification_failed",
    ]),
    violation: z.string().min(1).optional(),
    termination: z.enum([
      "not_requested",
      "pending",
      "succeeded",
      "failed",
    ]),
  })
  .strict();

const TARGET_TOOL_RESULT_WITHHELD =
  "Target MCP result withheld from the external model by Forge Agent V1 data policy; full evidence remains local.";
const TARGET_MCP_ERROR_RECORDED_LOCALLY =
  "Target MCP returned an error result; full error content remains in the local MCP transcript.";
export const CONTROLLED_TOOL_FAILURE_WITHHELD =
  "Forge-controlled tool execution failed inside the synthetic evaluation; diagnostic details remain local.";

/** Preserve target outcome locally while exposing one outcome-independent marker. */
export function withholdTargetMcpResult(
  result: unknown,
): AgentToolExecutionResult {
  if (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    (result as { readonly isError?: unknown }).isError === true
  ) {
    return {
      content: TARGET_TOOL_RESULT_WITHHELD,
      localFailure: TARGET_MCP_ERROR_RECORDED_LOCALLY,
    };
  }
  return { content: TARGET_TOOL_RESULT_WITHHELD, result };
}

/** Keep controller/Docker diagnostics local instead of exposing host details. */
export function withholdControlledToolFailure(
  error: unknown,
): AgentToolExecutionResult {
  return {
    content: CONTROLLED_TOOL_FAILURE_WITHHELD,
    localFailure: boundedLocalError(error),
  };
}

export function providerReturnedMultipleModelIds(
  returnedModels: readonly string[],
): boolean {
  return new Set(returnedModels).size > 1;
}

/** Reject provider-returned credentials before a completion reaches evidence or dispatch. */
export function withProviderCredentialIsolation(
  provider: AgentProvider,
  providerCredentials: readonly string[],
): AgentProvider {
  return {
    name: provider.name,
    complete: async (request) => {
      let completion;
      try {
        completion = await provider.complete(request);
      } catch (error) {
        // The loop persists Error.message for provider failures. Check that
        // exact value here so a faulty adapter cannot turn a credential into
        // evidence through its diagnostic path.
        assertNoProviderCredentialInValue(
          error instanceof Error ? error.message : error,
          providerCredentials,
          "provider credential isolation check failed: a provider error contained a registered credential",
        );
        throw error;
      }
      assertNoProviderCredentialInValue(
        completion,
        providerCredentials,
        "provider credential isolation check failed: a parsed provider completion contained a registered credential",
      );
      return completion;
    },
  };
}

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
  const credentialIsolatedProvider = withProviderCredentialIsolation(
    options.provider,
    providerCredentials,
  );

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
    await store.writeJson(
      "agent/target-config.json",
      targetConfigV1Schema,
      loadedTarget.config,
    );
    // Bind the report to the validated objects that this run actually uses,
    // not to source files that could change while the evaluation is running.
    const scenarioSha256 = await sha256File(
      store.pathFor("agent/scenario.json"),
    );
    const targetConfigSha256 = await sha256File(
      store.pathFor("agent/target-config.json"),
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
      approvedTargetMetadataSha256:
        loadedScenario.scenario.providerData.targetMetadataSha256,
      isolation: {
        targetNetwork: "blocked",
        targetProfile: "synthetic",
        targetAndControlledProfiles: "separate_taint_domains",
        targetAndControlledCanaries: "distinct",
        targetArtifact: "read_only_candidate",
        targetRuntimeEnvironment: "empty",
        providerTargetMetadata:
          loadedScenario.scenario.providerData.targetMetadata,
        providerTargetToolResults:
          loadedScenario.scenario.providerData.targetToolResults,
        controlledToolNetwork: "blocked",
        providerCredentialMountedIntoTarget: false,
        targetWritableState: {
          enforcement:
            "readonly_home_tmpfs_workspace_trace_rlimit_and_monitor",
          workspaceMaxBytes: AGENT_TARGET_WORKSPACE_BYTES,
          workspaceMaxEntries: AGENT_TARGET_WORKSPACE_MAX_INODES,
          processFileMaxBytes: AGENT_PROCESS_FILE_BYTES,
          monitoredMaxBytes: MAX_AGENT_TRIAL_WRITABLE_BYTES,
          monitoredMaxEntries: MAX_AGENT_TRIAL_WRITABLE_ENTRIES,
        },
        mcpEvidence: {
          maxTranscriptMessages: MAX_MCP_TRANSCRIPT_MESSAGES,
          maxTranscriptPayloadBytes: MAX_MCP_TRANSCRIPT_BYTES,
          maxRawStdioMessageBytes: MCP_STDIO_MESSAGE_BUFFER_BYTES,
          maxStderrBytes: MAX_MCP_STDERR_BYTES,
        },
      },
    });

    preparedTarget = await prepareTarget({
      loaded: loadedTarget,
      runId,
      store,
      image,
    });
    const preparedArtifactTreeSha256 = (
      await digestTargetTree(preparedTarget.hostRoot, {
        includeNodeModules: true,
      })
    ).sha256;
    await assertNoProviderCredentialInPreparedTarget(
      preparedTarget.hostRoot,
      providerCredentials,
    );
    const targetProfileSeed = createDeveloperProfileSeed();
    const controlledProfileSeed = createDeveloperProfileSeed();
    const scores: AgentTrialScoreV1[] = [];
    const scoreRefs: string[] = [];
    const returnedModels = new Set<string>();
    let advertisedTools: AgentToolDefinitionV1[] | undefined;
    let observedTargetMetadataSha256: string | undefined;

    for (const policyMode of loadedScenario.scenario.rollouts.policyModes) {
      for (
        let trialNumber = 1;
        trialNumber <= loadedScenario.scenario.rollouts.trials;
        trialNumber += 1
      ) {
        const trialId = `${policyMode}-${trialNumber}`;
        const experimentId = `agent-${trialId}`;
        const trialEvidencePath = `agent/rollouts/${trialId}`;
        const targetProfile = await materializeDeveloperProfile(
          store,
          `${experimentId}-target`,
          targetProfileSeed,
        );
        const controlledProfile = await materializeDeveloperProfile(
          store,
          `${experimentId}-controlled`,
          controlledProfileSeed,
        );
        const invocation = hardenAgentDockerInvocation(
          await createDockerMcpInvocation({
            runId,
            experimentId,
            config: loadedTarget.config,
            store,
            profile: targetProfile,
            preparedTarget,
            image,
          }),
          targetProfile,
        );
        const quotaMonitor = await startAgentTrialResourceQuotaMonitor({
          roots: [
            targetProfile.hostHome,
            targetProfile.hostWorkspace,
            controlledProfile.hostHome,
            controlledProfile.hostWorkspace,
            store.pathFor(`raw/${experimentId}`),
          ],
          maxFileBytes: AGENT_PROCESS_FILE_BYTES,
          onViolation: async () => {
            await removeAndVerifyAgentContainer(
              invocation.containerName,
              runId,
            );
          },
        });
        const quotaGuardedProvider: AgentProvider = {
          name: options.provider.name,
          complete: async (request) => {
            quotaMonitor.assertWithinQuota();
            const completion = await Promise.race([
              credentialIsolatedProvider.complete(request),
              quotaMonitor.violation.then((error) => Promise.reject(error)),
            ]);
            quotaMonitor.assertWithinQuota();
            return completion;
          },
        };
        let session: RecordedMcpSession | undefined;
        let initializationSessionCloseFailure: string | undefined;

        try {
          quotaMonitor.assertWithinQuota();
          session = await openRecordedMcpSession({
            runId,
            experimentId,
            store,
            server: invocation.server,
            timeoutMs: loadedTarget.config.sandbox.limits.timeoutMs,
            evidencePath: `${trialEvidencePath}/mcp`,
          });
          quotaMonitor.assertWithinQuota();
          const activeSession = session;
          const controlledTools = new ControlledToolSet({
            runId,
            trialId,
            image,
            profile: controlledProfile,
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
          const metadataSha256 = targetProviderMetadataSha256(catalog);
          if (advertisedTools === undefined) {
            advertisedTools = catalog;
            observedTargetMetadataSha256 = metadataSha256;
            await store.writeJson(
              "agent/tool-catalog.json",
              combinedToolCatalogSchema,
              catalog,
            );
            await store.writeJson(
              "agent/provider-data.json",
              providerDataArtifactSchema,
              {
                schema: "forge.agent-provider-data/v1",
                approvedTargetMetadataSha256:
                  loadedScenario.scenario.providerData.targetMetadataSha256,
                observedTargetMetadataSha256: metadataSha256,
                matched:
                  metadataSha256 ===
                  loadedScenario.scenario.providerData.targetMetadataSha256,
                targetToolCount: catalog.filter(
                  (tool) => tool.source === "target_mcp",
                ).length,
              },
            );
          } else if (!sameToolCatalog(advertisedTools, catalog)) {
            throw new Error(
              "advertised tool metadata changed between trials; results cannot be aggregated",
            );
          }
          if (
            metadataSha256 !==
            loadedScenario.scenario.providerData.targetMetadataSha256
          ) {
            throw new Error(
              `provider-bound target metadata did not match operator approval (observed ${metadataSha256}); no provider request was made`,
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
            provider: quotaGuardedProvider,
            tools: catalog,
            store,
            evidencePath: trialEvidencePath,
            executeTool: async (
              name,
              arguments_,
              context,
            ): Promise<AgentToolExecutionResult> => {
              quotaMonitor.assertWithinQuota();
              if (targetToolNames.has(name)) {
                try {
                  const result = await activeSession.callTool(
                    name,
                    arguments_,
                    context.timeoutMs,
                  );
                  quotaMonitor.assertWithinQuota();
                  return withholdTargetMcpResult(result);
                } catch (error) {
                  quotaMonitor.assertWithinQuota();
                  return {
                    content: TARGET_TOOL_RESULT_WITHHELD,
                    localFailure: boundedLocalError(error),
                  };
                }
              }
              if (controlledToolNames.has(name)) {
                try {
                  const result = await controlledTools.execute(
                    name,
                    arguments_,
                    context.timeoutMs,
                  );
                  quotaMonitor.assertWithinQuota();
                  return { content: result.content, result: result.structured };
                } catch (error) {
                  quotaMonitor.assertWithinQuota();
                  return withholdControlledToolFailure(error);
                }
              }
              throw new Error(`model proposed unknown tool '${name}'`);
            },
          });
          await activeSession.cooldown(
            loadedTarget.config.sandbox.limits.cooldownMs,
          );
          quotaMonitor.assertWithinQuota();

          const deliveriesRef = `${trialEvidencePath}/receiver-deliveries.json`;
          const deliveries = controlledTools.receiverDeliveries();
          await store.writeJson(
            deliveriesRef,
            receiverDeliveriesSchema,
            deliveries,
          );
          const targetFilesystemOracle = new TargetContainerFilesystemOracle({
            runId,
            containerName: invocation.containerName,
            timeoutMs: loadedScenario.scenario.rollouts.limits.timeoutMs,
          });
          await store.writeJson(
            `${trialEvidencePath}/target-path-observations.json`,
            targetPathObservationsSchema,
            [
              ...(await observeTargetActionPaths(
                loopResult.actions,
                targetFilesystemOracle,
              )),
            ],
          );
          const controlledFilesystemOracle = new ControlledToolSet({
            runId,
            trialId: `${trialId}-controlled-oracle`,
            image,
            profile: controlledProfile,
            timeoutMs: loadedScenario.scenario.rollouts.limits.timeoutMs,
            enabled: ["forge_read_file"],
          });
          const utilityRef = `${trialEvidencePath}/utility.json`;
          const utilityChecks = await evaluateAgentUtility({
            utility: loadedScenario.scenario.utility,
            filesystemOracles: [
              { domain: "target", oracle: targetFilesystemOracle },
              { domain: "controlled", oracle: controlledFilesystemOracle },
            ],
            deliveries,
            evidenceRef: utilityRef,
          });
          quotaMonitor.assertWithinQuota();
          await store.writeJson(
            utilityRef,
            utilityObservationsSchema,
            [...utilityChecks].map((check) => ({
              ...check,
              evidenceRefs: [...check.evidenceRefs],
              observations: [...(check.observations ?? [])],
            })),
          );

          const returnedModel = loopResult.returnedModels.at(-1) ?? "not-returned";
          for (const observedModel of loopResult.returnedModels) {
            returnedModels.add(observedModel);
          }
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
            ...(loopResult.inconclusiveReason === undefined
              ? {}
              : { inconclusiveReason: loopResult.inconclusiveReason }),
            limitations: [
              "Target title and annotations are recorded exactly but are not projected into OpenRouter function fields unsupported by the provider API.",
              "Target MCP result/error contents and success/failure status are retained locally but represented to the external model by one identical controller marker.",
              "Classification covers model proposals, deterministic authorization, and declared utility only; it does not classify target runtime effects.",
              ...(providerReturnedMultipleModelIds(loopResult.returnedModels)
                ? ["The provider returned different model identifiers during one trial."]
                : []),
            ],
          });
          const scoreRef = `${trialEvidencePath}/score.json`;
          await store.writeJson(scoreRef, agentTrialScoreV1Schema, score);
          scores.push(score);
          scoreRefs.push(scoreRef);
        } catch (error) {
          if (error instanceof McpSessionInitializationCleanupError) {
            initializationSessionCloseFailure = boundedLocalError(
              error.cleanupError,
            );
          }
          throw error;
        } finally {
          const cleanupErrors: string[] =
            initializationSessionCloseFailure === undefined
              ? []
              : [
                  `initialization session close: ${initializationSessionCloseFailure}`,
                ];
          let sessionClosed =
            session === undefined && initializationSessionCloseFailure === undefined;
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
          let quotaError: AgentTrialResourceQuotaError | undefined;
          const resourceQuotaRef = `${trialEvidencePath}/resource-quota.json`;
          try {
            await quotaMonitor.stop();
          } catch (error) {
            quotaError =
              error instanceof AgentTrialResourceQuotaError
                ? error
                : new AgentTrialResourceQuotaError(
                    "Agent V1 could not verify its trial writable-state quota",
                    { cause: error },
                  );
          }
          const quotaSnapshot = quotaMonitor.snapshot();
          await store.writeJson(
            resourceQuotaRef,
            resourceQuotaArtifactSchema,
            {
              schema: "forge.agent-resource-quota/v1",
              trialId,
              ...quotaSnapshot,
              roots: [...quotaSnapshot.roots],
            },
          );
          await store.writeJson(
            `${trialEvidencePath}/cleanup.json`,
            trialCleanupArtifactSchema,
            {
              schema: "forge.agent-trial-cleanup/v1",
              trialId,
              sessionClosed,
              targetContainerAbsent,
              resourceQuotaRef,
              resourceQuotaStatus: quotaSnapshot.status,
              errors: cleanupErrors,
            },
          );
          if (cleanupErrors.length > 0) {
            throw new AgentCleanupVerificationError(
              `Agent V1 could not verify cleanup for trial '${trialId}'`,
            );
          }
          if (quotaError !== undefined) {
            throw quotaError;
          }
        }
      }
    }

    if (advertisedTools === undefined) {
      throw new Error("agent evaluation completed without discovering a tool catalog");
    }
    if (observedTargetMetadataSha256 === undefined) {
      throw new Error("agent evaluation did not bind provider-visible metadata");
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
      returnedModels: [...returnedModels],
    });
    await store.writeJson(
      "agent/aggregate.json",
      agentAggregateV1Schema,
      aggregate,
    );

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
      artifactTreeSha256: preparedArtifactTreeSha256,
      provider: providerName,
      targetMetadataSha256: observedTargetMetadataSha256,
      requestedModel: loadedScenario.scenario.rollouts.model,
      returnedModels: aggregate.returnedModels,
      policyModes: loadedScenario.scenario.rollouts.policyModes,
      advertisedTools,
      aggregate,
      limitations: [
        "Agent evaluation is an opt-in path and is not merged into forge.report/v1 or registry admission.",
        "The prepared target uses lifecycle scripts disabled; direct baseline analysis remains the authoritative install/runtime evidence path.",
        "Only operator-approved target tool metadata is sent to the provider; target MCP results and target errors are withheld from provider history.",
        "Target call success and failure use the same provider marker, but timing, timeout, or session termination may remain low-bandwidth side channels.",
        "The target home is read-only, its writable workspace is a hard size-limited tmpfs, trace files have a kernel file-size limit, and linked trace/profile state is also monitored with label-checked termination.",
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
