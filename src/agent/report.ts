import { lstat, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  agentReportV1Schema,
  type AgentAggregateV1,
  type AgentArtifactReferenceV1,
  type AgentPolicyModeV1,
  type AgentReportV1,
  type AgentToolDefinitionV1,
} from "./contracts.js";
import { sha256File, type EvidenceStore } from "../evidence-store.js";

function mediaType(path: string): string {
  if (path.endsWith(".jsonl")) {
    return "application/x-ndjson";
  }
  if (path.endsWith(".json")) {
    return "application/json";
  }
  return "text/plain";
}

async function listRegularFiles(directory: string): Promise<string[]> {
  const result: string[] = [];

  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        result.push(path);
      }
    }
  }

  await visit(directory);
  return result;
}

export async function collectAgentArtifacts(
  store: EvidenceStore,
): Promise<AgentArtifactReferenceV1[]> {
  const files = await listRegularFiles(store.runDirectory);
  const artifacts: AgentArtifactReferenceV1[] = [];

  for (const file of files) {
    const path = relative(store.runDirectory, file).split(sep).join("/");
    if (path === "agent/report.json") {
      continue;
    }
    const stat = await lstat(file);
    if (!stat.isFile()) {
      continue;
    }
    artifacts.push({
      path,
      sha256: await sha256File(file),
      mediaType: mediaType(path),
    });
  }

  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

function summary(aggregate: AgentAggregateV1): string {
  return aggregate.modes
    .map((mode) => {
      const rate = mode.unauthorizedProposalRate;
      return `${mode.policyMode}: ${rate.numerator}/${rate.denominator} conclusive trials contained an unauthorized proposal (${mode.inconclusiveTrials} inconclusive)`;
    })
    .join("; ");
}

export async function writeAgentReport(input: {
  readonly store: EvidenceStore;
  readonly reportId: string;
  readonly scenarioId: string;
  readonly scenarioSha256: string;
  readonly targetId: string;
  readonly targetConfig: string;
  readonly targetConfigSha256: string;
  readonly artifactTreeSha256: string;
  readonly provider: string;
  readonly requestedModel: string;
  readonly returnedModels: readonly string[];
  readonly policyModes: readonly AgentPolicyModeV1[];
  readonly advertisedTools: readonly AgentToolDefinitionV1[];
  readonly aggregate: AgentAggregateV1;
  readonly limitations: readonly string[];
}): Promise<AgentReportV1> {
  const report = agentReportV1Schema.parse({
    schema: "forge.agent-report/v1",
    reportId: input.reportId,
    scenarioId: input.scenarioId,
    scenarioSha256: input.scenarioSha256,
    generatedAt: new Date().toISOString(),
    target: {
      targetId: input.targetId,
      targetConfig: input.targetConfig,
      targetConfigSha256: input.targetConfigSha256,
      artifactTreeSha256: input.artifactTreeSha256,
    },
    scope: {
      provider: input.provider,
      requestedModel: input.requestedModel,
      returnedModels: [...input.returnedModels],
      policyModes: [...input.policyModes],
    },
    advertisedTools: [...input.advertisedTools],
    aggregate: input.aggregate,
    summary: summary(input.aggregate),
    artifacts: await collectAgentArtifacts(input.store),
    limitations: [...input.limitations],
  });
  await input.store.writeJson(
    "agent/report.json",
    agentReportV1Schema,
    report,
  );
  return report;
}
