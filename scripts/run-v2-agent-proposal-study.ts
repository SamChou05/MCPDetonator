import { mkdir, writeFile } from "node:fs/promises";

import {
  assertNoProviderCredentialInValue,
  redactProviderCredentials,
} from "../src/agent/redaction.js";
import { OpenRouterAgentProvider } from "../src/agent/providers/openrouter.js";
import type {
  AgentProvider,
  ProviderCompletion,
  ProviderCompletionRequest,
} from "../src/agent/providers/provider.js";
import {
  AGENT_PROPOSAL_PROMPT_IDENTITY,
  prepareAgentProposalExperiment,
  runAgentProposalExperiment,
} from "../src/audit/v2/agent-proposal.js";
import {
  AGENT_PROPOSAL_STUDY_ID,
  AGENT_PROPOSAL_STUDY_OPPORTUNITIES,
  coveredAgentProposalStudyOpportunities,
  createAgentProposalStudyInput,
} from "../src/audit/v2/agent-proposal-study.js";
import { digestCanonicalJson } from "../src/audit/v2/canonical.js";
import { cloneStrictBoundedJson } from "../src/audit/v2/strict-clone.js";
import {
  rawAgentProposalSubmissionV2Schema,
  type AgentProposalComparisonV2,
  type RawAgentProposalSubmissionV2,
} from "../src/contracts/v2/index.js";

const DEFAULT_MODEL = "openai/gpt-5.6-luna";
const DEFAULT_TRIALS = 5;
const MAX_CANDIDATES = 6;
const MAX_TOTAL_STEPS = 12;
const OUTPUT_PREFIX =
  "experiments/evidence-first-v2/agent-proposal-live-gpt-5-6-luna-guided-contract-2026-08-30";
const PRICING = Object.freeze({
  source: "https://openrouter.ai/api/v1/models",
  observedAt: "2026-08-30",
  model: DEFAULT_MODEL,
  promptUsdPerToken: 0.0000002,
  completionUsdPerToken: 0.0000012,
});

interface CommandOptions {
  readonly model: string;
  readonly trials: number;
}

interface CompletedTrial {
  readonly trialId: string;
  readonly status: "completed";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly latencyMs: number;
  readonly submission: RawAgentProposalSubmissionV2;
  readonly comparison: AgentProposalComparisonV2;
  readonly coveredOpportunities: readonly string[];
  readonly estimatedCostUsd?: number;
}

interface FailedTrial {
  readonly trialId: string;
  readonly status: "failed";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly latencyMs: number;
  readonly error: {
    readonly name: string;
    readonly code?: string;
    readonly message: string;
  };
}

type TrialRecord = CompletedTrial | FailedTrial;

class CapturingProvider implements AgentProvider {
  public readonly name: string;
  public completion: ProviderCompletion | undefined;

  public constructor(private readonly delegate: AgentProvider) {
    this.name = delegate.name;
  }

  public async complete(
    request: ProviderCompletionRequest,
  ): Promise<ProviderCompletion> {
    const completion = await this.delegate.complete(request);
    this.completion = completion;
    return completion;
  }
}

function usage(): string {
  return [
    "Usage:",
    "  node --env-file-if-exists=.env --import tsx scripts/run-v2-agent-proposal-study.ts",
    "  node --env-file-if-exists=.env --import tsx scripts/run-v2-agent-proposal-study.ts --trials 5 --model openai/gpt-5.6-luna",
    "",
    "Runs sequential live proposal trials and writes tracked JSON plus Markdown results.",
    "It never executes a target or creates an ApprovalReceipt/ExperimentPlan.",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): CommandOptions {
  let model = DEFAULT_MODEL;
  let trials = DEFAULT_TRIALS;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    const value = argv[index + 1];
    if (argument === "--model") {
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--model requires a value");
      }
      model = value;
      index += 1;
      continue;
    }
    if (argument === "--trials") {
      if (value === undefined || !/^[0-9]+$/u.test(value)) {
        throw new Error("--trials requires an integer between 1 and 10");
      }
      trials = Number(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument '${argument}'`);
  }
  if (model.length === 0 || model.length > 512) {
    throw new Error("model must contain between 1 and 512 characters");
  }
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 10) {
    throw new Error("--trials must be between 1 and 10");
  }
  return { model, trials };
}

function capturedSubmission(
  completion: ProviderCompletion | undefined,
): RawAgentProposalSubmissionV2 {
  if (completion === undefined || completion.toolCalls.length !== 1) {
    throw new Error("completed trial did not retain exactly one proposal call");
  }
  const toolCall = completion.toolCalls[0];
  if (
    toolCall === undefined ||
    toolCall.name !== "submit_experiment_proposals"
  ) {
    throw new Error("completed trial did not retain the proposal submission call");
  }
  const detached = cloneStrictBoundedJson(
    toolCall.arguments,
    {
      maxDepth: 32,
      maxNodes: 50_000,
      maxObjectKeys: 512,
      maxStringCharacters: 524_288,
      maxSerializedBytes: 1_000_000,
    },
    "live study proposal submission",
  ).clone;
  return rawAgentProposalSubmissionV2Schema.parse(detached);
}

function estimatedCost(
  comparison: AgentProposalComparisonV2,
  model: string,
): number | undefined {
  if (model !== PRICING.model || comparison.proposer.usage === undefined) {
    return undefined;
  }
  return (
    comparison.proposer.usage.promptTokens * PRICING.promptUsdPerToken +
    comparison.proposer.usage.completionTokens * PRICING.completionUsdPerToken
  );
}

function safeError(error: unknown, credential: string): FailedTrial["error"] {
  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : undefined;
  const rawMessage = error instanceof Error ? error.message : "unknown failure";
  const code = record?.["code"];
  return {
    name: error instanceof Error ? error.name : "Error",
    ...(typeof code === "string" ? { code } : {}),
    message: redactProviderCredentials(rawMessage, [credential]),
  };
}

function aggregate(trials: readonly TrialRecord[]): Record<string, unknown> {
  const completed = trials.filter(
    (trial): trial is CompletedTrial => trial.status === "completed",
  );
  const candidateTotals = {
    submitted: 0,
    rejected: 0,
    duplicateBaseline: 0,
    duplicateAgent: 0,
    acceptedNovel: 0,
  };
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let approvalUnderstatements = 0;
  let routingMismatches = 0;
  let estimatedCostUsd = 0;
  let pricedTrials = 0;
  const acceptedSemanticDigests: string[] = [];
  const acceptedFeatures = new Set<string>();
  const opportunityFrequency = Object.fromEntries(
    AGENT_PROPOSAL_STUDY_OPPORTUNITIES.map((opportunity) => [opportunity, 0]),
  ) as Record<string, number>;
  for (const trial of completed) {
    const summary = trial.comparison.summary;
    candidateTotals.submitted += summary.submitted;
    candidateTotals.rejected += summary.rejected;
    candidateTotals.duplicateBaseline += summary.duplicateBaseline;
    candidateTotals.duplicateAgent += summary.duplicateAgent;
    candidateTotals.acceptedNovel += summary.acceptedNovel;
    for (const candidate of trial.comparison.candidates) {
      if (candidate.approvalUnderstated === true) approvalUnderstatements += 1;
      if (
        candidate.disposition === "accepted_novel" &&
        candidate.semanticDigest !== undefined
      ) {
        acceptedSemanticDigests.push(candidate.semanticDigest);
      }
    }
    for (const feature of trial.comparison.coverageComparison.agentOnlyFeatures) {
      acceptedFeatures.add(feature);
    }
    for (const opportunity of trial.coveredOpportunities) {
      opportunityFrequency[opportunity] =
        (opportunityFrequency[opportunity] ?? 0) + 1;
    }
    if (!trial.comparison.proposer.routingMatch) routingMismatches += 1;
    const usage = trial.comparison.proposer.usage;
    if (usage !== undefined) {
      promptTokens += usage.promptTokens;
      completionTokens += usage.completionTokens;
      totalTokens += usage.totalTokens;
    }
    if (trial.estimatedCostUsd !== undefined) {
      pricedTrials += 1;
      estimatedCostUsd += trial.estimatedCostUsd;
    }
  }
  const uniqueAccepted = new Set(acceptedSemanticDigests);
  const opportunityUnion = AGENT_PROPOSAL_STUDY_OPPORTUNITIES.filter(
    (opportunity) => opportunityFrequency[opportunity]! > 0,
  );
  return {
    requestedTrials: trials.length,
    completedTrials: completed.length,
    failedTrials: trials.length - completed.length,
    candidateTotals,
    deterministicPassRate:
      candidateTotals.submitted === 0
        ? 0
        : (candidateTotals.submitted - candidateTotals.rejected) /
          candidateTotals.submitted,
    acceptedNovelRate:
      candidateTotals.submitted === 0
        ? 0
        : candidateTotals.acceptedNovel / candidateTotals.submitted,
    acceptedSemanticOccurrences: acceptedSemanticDigests.length,
    uniqueAcceptedSemantics: uniqueAccepted.size,
    crossTrialRepeatedSemantics:
      acceptedSemanticDigests.length - uniqueAccepted.size,
    approvalUnderstatements,
    routingMismatches,
    acceptedAgentFeatures: [...acceptedFeatures].sort(),
    opportunityUnion,
    opportunityCoverageRate:
      opportunityUnion.length / AGENT_PROPOSAL_STUDY_OPPORTUNITIES.length,
    opportunityFrequency,
    usage: { promptTokens, completionTokens, totalTokens },
    pricing: {
      ...PRICING,
      pricedTrials,
      estimatedCostUsd,
    },
  };
}

function percent(value: unknown): string {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function markdown(record: Record<string, unknown>): string {
  const trials = record["trials"] as readonly TrialRecord[];
  const summary = record["aggregate"] as Record<string, unknown>;
  const candidateTotals = summary["candidateTotals"] as Record<string, number>;
  const pricing = summary["pricing"] as Record<string, unknown>;
  const completed = trials.filter(
    (trial): trial is CompletedTrial => trial.status === "completed",
  );
  const lines = [
    "# Live Evidence-First V2 agent-proposal study",
    "",
    `- Study: \`${AGENT_PROPOSAL_STUDY_ID}\``,
    `- Model requested: \`${String(record["requestedModel"])}\``,
    `- Context digest: \`${String(record["contextDigest"])}\``,
    `- Baseline digest: \`${String(record["baselineDigest"])}\``,
    `- Trials: ${String(summary["completedTrials"])} completed, ${String(summary["failedTrials"])} failed`,
    `- Estimated provider cost: $${Number(pricing["estimatedCostUsd"]).toFixed(6)} (${String(pricing["pricedTrials"])} priced trials)`,
    "",
    "The tool metadata and model submissions are untrusted experimental data.",
    "No target was executed, no approval was issued, and no ExperimentPlan was produced.",
    "",
    "## Aggregate result",
    "",
    `- ${candidateTotals["submitted"]} candidates submitted; ${candidateTotals["acceptedNovel"]} accepted as novel, ${candidateTotals["duplicateBaseline"]} baseline duplicates, ${candidateTotals["duplicateAgent"]} within-trial duplicates, and ${candidateTotals["rejected"]} rejected.`,
    `- Deterministic pass rate: ${percent(summary["deterministicPassRate"])}.`,
    `- Accepted-novel rate: ${percent(summary["acceptedNovelRate"])}.`,
    `- Cross-trial semantic diversity: ${String(summary["uniqueAcceptedSemantics"])} unique accepted semantics from ${String(summary["acceptedSemanticOccurrences"])} accepted occurrences.`,
    `- Fixed opportunity coverage: ${String((summary["opportunityUnion"] as unknown[]).length)}/${AGENT_PROPOSAL_STUDY_OPPORTUNITIES.length} (${percent(summary["opportunityCoverageRate"])}).`,
    `- Approval understatements corrected deterministically: ${String(summary["approvalUnderstatements"])}.`,
    `- Model-routing mismatches: ${String(summary["routingMismatches"])}.`,
    "",
    "## Per-trial result",
    "",
    "| Trial | Status | Submitted | Rejected | Baseline duplicates | Accepted novel | Opportunities | Tokens | Latency | Est. cost |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |",
  ];
  for (const trial of trials) {
    if (trial.status === "failed") {
      lines.push(
        `| ${trial.trialId} | failed: ${trial.error.code ?? trial.error.name} | – | – | – | – | – | – | ${trial.latencyMs} ms | – |`,
      );
      continue;
    }
    const trialSummary = trial.comparison.summary;
    lines.push(
      `| ${trial.trialId} | completed | ${trialSummary.submitted} | ${trialSummary.rejected} | ${trialSummary.duplicateBaseline} | ${trialSummary.acceptedNovel} | ${trial.coveredOpportunities.join(", ") || "none"} | ${trial.comparison.proposer.usage?.totalTokens ?? "unknown"} | ${trial.latencyMs} ms | $${(trial.estimatedCostUsd ?? 0).toFixed(6)} |`,
    );
  }
  lines.push(
    "",
    "## Opportunity frequency",
    "",
  );
  const frequency = summary["opportunityFrequency"] as Record<string, number>;
  for (const opportunity of AGENT_PROPOSAL_STUDY_OPPORTUNITIES) {
    lines.push(`- \`${opportunity}\`: ${frequency[opportunity] ?? 0}/${completed.length} completed trials`);
  }
  lines.push(
    "",
    "## Interpretation limits",
    "",
    "- `accepted_novel` means contract-valid, policy-eligible, and absent from the five-case baseline by exact tool-and-argument semantics. It is not a vulnerability finding.",
    "- The six opportunities are operator-authored metadata-coverage probes frozen before the live calls; they are not a complete ground truth.",
    "- Repeated temperature-zero calls estimate consistency for this provider route, not broad model quality.",
    "- No candidate was freshly compiled into an ExperimentPlan or executed. Runtime usefulness and finding recall remain unmeasured.",
    "",
    `The complete bounded submissions and deterministic comparison reports are in [the JSON record](./${OUTPUT_PREFIX.split("/").at(-1)}.json).`,
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const credential = process.env["OPENROUTER_API_KEY"];
  if (credential === undefined || credential.length === 0) {
    throw new Error(
      "OPENROUTER_API_KEY is required; load the ignored .env with node --env-file-if-exists=.env",
    );
  }
  const compileInput = await createAgentProposalStudyInput();
  const prepared = prepareAgentProposalExperiment(compileInput, {
    maxCandidates: MAX_CANDIDATES,
    maxTotalSteps: MAX_TOTAL_STEPS,
  });
  const startedAt = new Date().toISOString();
  const trials: TrialRecord[] = [];
  for (let index = 0; index < options.trials; index += 1) {
    const trialId = `live-trial-${String(index + 1).padStart(2, "0")}`;
    const trialStartedAt = new Date().toISOString();
    const start = Date.now();
    const provider = new CapturingProvider(
      new OpenRouterAgentProvider({ apiKey: credential, timeoutMs: 120_000 }),
    );
    try {
      const comparison = await runAgentProposalExperiment({
        compileInput,
        provider,
        model: options.model,
        maxCandidates: MAX_CANDIDATES,
        maxTotalSteps: MAX_TOTAL_STEPS,
        maxTokens: 4_096,
        timeoutMs: 120_000,
        credentialSecrets: [credential],
      });
      const submission = capturedSubmission(provider.completion);
      const trialCost = estimatedCost(comparison, options.model);
      const completed: CompletedTrial = {
        trialId,
        status: "completed",
        startedAt: trialStartedAt,
        completedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        submission,
        comparison,
        coveredOpportunities: coveredAgentProposalStudyOpportunities(
          submission,
          comparison,
        ),
        ...(trialCost === undefined ? {} : { estimatedCostUsd: trialCost }),
      };
      trials.push(completed);
      process.stdout.write(
        `${trialId}: completed (${comparison.summary.acceptedNovel} novel, ${comparison.summary.rejected} rejected)\n`,
      );
    } catch (error) {
      const failed: FailedTrial = {
        trialId,
        status: "failed",
        startedAt: trialStartedAt,
        completedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        error: safeError(error, credential),
      };
      trials.push(failed);
      process.stdout.write(
        `${trialId}: failed (${failed.error.code ?? failed.error.name})\n`,
      );
    }
  }
  const aggregateResult = aggregate(trials);
  const record: Record<string, unknown> = {
    format: "forge.agent-proposal-live-study/v1alpha1",
    studyId: AGENT_PROPOSAL_STUDY_ID,
    startedAt,
    completedAt: new Date().toISOString(),
    requestedModel: options.model,
    trialConfiguration: {
      trials: options.trials,
      temperature: 0,
      maxCandidates: MAX_CANDIDATES,
      maxTotalSteps: MAX_TOTAL_STEPS,
      maxTokens: 4_096,
      sequential: true,
    },
    providerContext: prepared.context,
    contextDigest: prepared.contextDigest,
    baselineDigest: prepared.baselineDigest,
    studyDefinitionDigest: digestCanonicalJson(
      "forge.agent-proposal-live-study-definition",
      "v1alpha1",
      {
        contextDigest: prepared.contextDigest,
        baselineDigest: prepared.baselineDigest,
        opportunities: AGENT_PROPOSAL_STUDY_OPPORTUNITIES,
        prompt: AGENT_PROPOSAL_PROMPT_IDENTITY,
        model: options.model,
        trials: options.trials,
      },
    ),
    fixedOpportunities: AGENT_PROPOSAL_STUDY_OPPORTUNITIES,
    prompt: AGENT_PROPOSAL_PROMPT_IDENTITY,
    authority: {
      executionAuthorized: false,
      approvalIssued: false,
      experimentPlanProduced: false,
    },
    trials,
    aggregate: aggregateResult,
    limitations: [
      "Tool metadata and submissions are untrusted experimental data.",
      "Accepted novelty is exact semantic absence from this baseline, not usefulness or a finding.",
      "The fixed opportunity set is an operator-authored metadata-coverage probe, not complete ground truth.",
      "No target execution, fresh ExperimentPlan compilation, or runtime finding evaluation occurred.",
    ],
  };
  assertNoProviderCredentialInValue(
    record,
    [credential],
    "live study record contains the provider credential",
  );
  const markdownRecord = markdown(record);
  assertNoProviderCredentialInValue(
    markdownRecord,
    [credential],
    "live study Markdown contains the provider credential",
  );
  await mkdir("experiments/evidence-first-v2", { recursive: true });
  await writeFile(`${OUTPUT_PREFIX}.json`, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(`${OUTPUT_PREFIX}.md`, markdownRecord, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(`Wrote ${OUTPUT_PREFIX}.json and ${OUTPUT_PREFIX}.md\n`);
}

main().catch((error: unknown) => {
  const credential = process.env["OPENROUTER_API_KEY"] ?? "";
  const rawMessage = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(
    `Live V2 proposal study failed: ${redactProviderCredentials(rawMessage, [credential])}\n`,
  );
  process.exitCode = 1;
});
