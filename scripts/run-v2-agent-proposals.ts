import { readFile } from "node:fs/promises";

import { ScriptedAgentProvider } from "../src/agent/providers/scripted.js";
import { OpenRouterAgentProvider } from "../src/agent/providers/openrouter.js";
import type {
  AgentProvider,
  ProviderCompletion,
  ProviderJsonObject,
} from "../src/agent/providers/provider.js";
import { redactProviderCredentials } from "../src/agent/redaction.js";
import { runAgentProposalExperiment } from "../src/audit/v2/agent-proposal.js";
import { digestCanonicalJson } from "../src/audit/v2/canonical.js";
import type { CompileExperimentPlanInput } from "../src/audit/v2/compile.js";
import { loadManualFixtureInputs } from "../src/audit/v2/manual-fixture.js";
import { parseStrictJson } from "../src/audit/v2/strict-json.js";
import {
  approvedPolicyV2Schema,
  auditSpecV2Schema,
  mandatoryCaseTemplateV2Schema,
} from "../src/contracts/v2/index.js";

interface CommandOptions {
  readonly live: boolean;
  readonly model: string;
}

function usage(): string {
  return [
    "Usage:",
    "  npm run experiment:v2-proposals",
    "  npm run experiment:v2-proposals -- --live --model <provider/model>",
    "",
    "The default run is provider-free and replays a scripted proposal batch.",
    "The live run requires OPENROUTER_API_KEY and sends only the bounded proposal context.",
    "Neither mode executes a target or creates an ApprovalReceipt/ExperimentPlan.",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): CommandOptions {
  let live = false;
  let model = "scripted/proposer-v1";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === "--live") {
      live = true;
      continue;
    }
    if (argument === "--model") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--model requires a value");
      }
      model = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument '${argument}'`);
  }
  if (live && model === "scripted/proposer-v1") {
    throw new Error("--live requires an explicit --model <provider/model>");
  }
  if (!live && model !== "scripted/proposer-v1") {
    throw new Error("--model is meaningful only with --live");
  }
  return { live, model };
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function proposalReadyInput(): Promise<CompileExperimentPlanInput> {
  const fixture = await loadManualFixtureInputs();
  const mandatoryCases = [
    mandatoryCaseTemplateV2Schema.parse(jsonClone(fixture.mandatoryCases[0])),
  ];
  const policyDraft = jsonClone(fixture.policy);
  policyDraft.requiredMandatoryCaseIds = [mandatoryCases[0]!.caseId];
  for (const rule of policyDraft.experimentDispatchRules.rules) {
    if (!rule.allowedOrigins.includes("agent_proposed")) {
      rule.allowedOrigins.push("agent_proposed");
    }
  }
  const policy = approvedPolicyV2Schema.parse(policyDraft);
  const specDraft = jsonClone(fixture.auditSpec);
  specDraft.manualCases = [];
  specDraft.mandatoryCaseReservation = 1;
  specDraft.policyDigest = digestCanonicalJson(
    "forge.audit-policy",
    "v2",
    policy,
  );
  specDraft.mandatorySuiteDigest = digestCanonicalJson(
    "forge.mandatory-case-suite",
    "v2",
    mandatoryCases,
  );
  const auditSpec = auditSpecV2Schema.parse(specDraft);
  return {
    ...fixture.compileInput,
    policy,
    auditSpec,
    mandatoryCases,
  };
}

async function scriptedCompletion(): Promise<ProviderCompletion> {
  const bytes = await readFile(
    new URL(
      "../fixtures/evidence-first-v2/agent-proposals-scripted.json",
      import.meta.url,
    ),
  );
  const submission = parseStrictJson(bytes);
  if (
    typeof submission !== "object" ||
    submission === null ||
    Array.isArray(submission)
  ) {
    throw new TypeError("scripted proposal fixture must be a JSON object");
  }
  return {
    returnedModel: "scripted/proposer-v1",
    content: null,
    toolCalls: [
      {
        id: "scripted-proposal-call",
        name: "submit_experiment_proposals",
        arguments: submission as ProviderJsonObject,
      },
    ],
    finishReason: "tool_calls",
    usage: { promptTokens: 900, completionTokens: 600, totalTokens: 1_500 },
  };
}

async function providerFor(options: CommandOptions): Promise<{
  readonly provider: AgentProvider;
  readonly credentialSecrets: readonly string[];
}> {
  if (!options.live) {
    return {
      provider: new ScriptedAgentProvider([await scriptedCompletion()]),
      credentialSecrets: [],
    };
  }
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("OPENROUTER_API_KEY is required for --live");
  }
  return {
    provider: new OpenRouterAgentProvider({ apiKey }),
    credentialSecrets: [apiKey],
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const { provider, credentialSecrets } = await providerFor(options);
  const report = await runAgentProposalExperiment({
    compileInput: await proposalReadyInput(),
    provider,
    model: options.model,
    maxCandidates: 4,
    maxTotalSteps: 8,
    credentialSecrets,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const rawMessage = error instanceof Error ? error.message : "unknown failure";
  const message = redactProviderCredentials(rawMessage, [
    process.env["OPENROUTER_API_KEY"] ?? "",
  ]);
  process.stderr.write(`V2 agent proposal experiment failed: ${message}\n`);
  process.exitCode = 1;
});
