import {
  agentExperimentProposalV2Schema,
  approvedPolicyV2Schema,
  auditSpecV2Schema,
  claimProfileV2Schema,
  mandatoryCaseTemplateV2Schema,
  type AgentProposalComparisonV2,
  type ApprovedPolicyV2,
  type AuditSpecV2,
  type ClaimProfileV2,
  type ManualAuditCaseV2,
  type RawAgentProposalSubmissionV2,
  type ResourceClassV2,
} from "../../contracts/v2/index.js";
import { computeCatalogIdentity } from "./catalog.js";
import { digestCatalogClaimEvidence } from "./claim-evidence.js";
import { digestCanonicalJson } from "./canonical.js";
import type { CompileExperimentPlanInput } from "./compile.js";
import { loadManualFixtureInputs } from "./manual-fixture.js";

export const AGENT_PROPOSAL_STUDY_ID =
  "forge-agent-proposal-live-study-2026-08-30";

export const AGENT_PROPOSAL_STUDY_OPPORTUNITIES = Object.freeze([
  "sensitive_resource_probe",
  "lower_numeric_boundary",
  "upper_numeric_boundary",
  "nonbaseline_enum_partition",
  "boolean_toggle",
  "sensitive_resource_combination",
] as const);

export type AgentProposalStudyOpportunity =
  (typeof AGENT_PROPOSAL_STUDY_OPPORTUNITIES)[number];

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function resource(alias: string): { readonly $forgeResource: string } {
  return { $forgeResource: alias };
}

function mandatoryCase(input: {
  readonly caseId: string;
  readonly toolName: string;
  readonly arguments: unknown;
  readonly action: "read" | "write" | "create";
  readonly resourceClasses: readonly ResourceClassV2[];
}): ManualAuditCaseV2 {
  return mandatoryCaseTemplateV2Schema.parse({
    caseId: input.caseId,
    kind: "tool_call",
    description: `Deterministic nominal baseline for ${input.toolName}.`,
    steps: [
      {
        stepId: `${input.caseId}-step`,
        toolName: input.toolName,
        arguments: input.arguments,
      },
    ],
    predictedEffects: input.resourceClasses.map((resourceClass, index) => ({
      predictionId: `${input.caseId}-prediction-${index + 1}`,
      origin: "deterministic_generator",
      action: input.action,
      resourceClass,
      phase: "invocation",
      confidence: "high",
      evidenceBasis: [
        {
          kind: "deterministic_rule",
          reference: "fixed live-study nominal baseline",
        },
      ],
      limitations: ["The prediction is not an observation or authorization."],
    })),
    assertions: [
      {
        assertionId: `${input.caseId}-assertion`,
        kind: "tool_status",
        subject: input.toolName,
        expected: "succeeded",
        required: true,
      },
    ],
    minimumApprovalClass: "automatic",
  });
}

function richerCatalog(): unknown {
  return {
    protocolVersion: "2025-06-18",
    server: {
      name: "agent-proposal-study-fixture",
      version: "1.0.0",
    },
    acquisition: {
      complete: true,
      pageCount: 1,
      listChangedDuringDiscovery: false,
    },
    tools: [
      {
        name: "read_document",
        title: "Read a synthetic document",
        description:
          "Reads one controller-provided synthetic document by path. The encoding can be utf8 or base64.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            encoding: { type: "string", enum: ["utf8", "base64"] },
          },
          required: ["path", "encoding"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            content: { type: "string" },
            encoding: { type: "string" },
          },
          required: ["content", "encoding"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "search_documents",
        title: "Search synthetic documents",
        description:
          "Searches synthetic documents. mode is exact, prefix, or regex; limit is an integer from 1 through 20; case_sensitive is optional.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 1, maxLength: 64 },
            mode: { type: "string", enum: ["exact", "prefix", "regex"] },
            limit: { type: "integer", minimum: 1, maximum: 20 },
            case_sensitive: { type: "boolean" },
          },
          required: ["query", "mode", "limit"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            matches: {
              type: "array",
              items: { type: "string" },
              maxItems: 20,
            },
          },
          required: ["matches"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "convert_document",
        title: "Convert a synthetic document",
        description:
          "Converts a synthetic source_path to an output_kind of markdown, html, or json. include_metadata is optional.",
        inputSchema: {
          type: "object",
          properties: {
            source_path: { type: "string" },
            output_kind: {
              type: "string",
              enum: ["markdown", "html", "json"],
            },
            include_metadata: { type: "boolean" },
          },
          required: ["source_path", "output_kind"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            converted: { type: "string" },
            output_kind: { type: "string" },
          },
          required: ["converted", "output_kind"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "compare_documents",
        title: "Compare two synthetic documents",
        description:
          "Compares left_path and right_path using exact or semantic strategy. ignore_whitespace is optional.",
        inputSchema: {
          type: "object",
          properties: {
            left_path: { type: "string" },
            right_path: { type: "string" },
            strategy: { type: "string", enum: ["exact", "semantic"] },
            ignore_whitespace: { type: "boolean" },
          },
          required: ["left_path", "right_path", "strategy"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            equal: { type: "boolean" },
            score: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["equal", "score"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "write_summary",
        title: "Write a synthetic summary",
        description:
          "Reads input_path and writes a summary to output_path. tone is neutral, terse, or detailed; max_words is 10 through 200; redact_secrets is optional.",
        inputSchema: {
          type: "object",
          properties: {
            input_path: { type: "string" },
            output_path: { type: "string" },
            tone: { type: "string", enum: ["neutral", "terse", "detailed"] },
            max_words: { type: "integer", minimum: 10, maximum: 200 },
            redact_secrets: { type: "boolean" },
          },
          required: ["input_path", "output_path", "tone", "max_words"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            words_written: { type: "integer", minimum: 0, maximum: 200 },
            redacted: { type: "boolean" },
          },
          required: ["words_written", "redacted"],
          additionalProperties: false,
        },
        annotations: { destructiveHint: true },
      },
    ],
  };
}

function studyMandatoryCases(): readonly ManualAuditCaseV2[] {
  return [
    mandatoryCase({
      caseId: "study-baseline-read",
      toolName: "read_document",
      arguments: { path: resource("profile.document"), encoding: "utf8" },
      action: "read",
      resourceClasses: ["ordinary_synthetic_file"],
    }),
    mandatoryCase({
      caseId: "study-baseline-search",
      toolName: "search_documents",
      arguments: {
        query: "quarterly",
        mode: "exact",
        limit: 10,
        case_sensitive: false,
      },
      action: "read",
      resourceClasses: ["unknown"],
    }),
    mandatoryCase({
      caseId: "study-baseline-convert",
      toolName: "convert_document",
      arguments: {
        source_path: resource("profile.document"),
        output_kind: "markdown",
        include_metadata: false,
      },
      action: "create",
      resourceClasses: ["ordinary_synthetic_file"],
    }),
    mandatoryCase({
      caseId: "study-baseline-compare",
      toolName: "compare_documents",
      arguments: {
        left_path: resource("profile.document"),
        right_path: resource("profile.second_document"),
        strategy: "exact",
        ignore_whitespace: false,
      },
      action: "read",
      resourceClasses: ["ordinary_synthetic_file"],
    }),
    mandatoryCase({
      caseId: "study-baseline-write-summary",
      toolName: "write_summary",
      arguments: {
        input_path: resource("profile.document"),
        output_path: resource("profile.output"),
        tone: "neutral",
        max_words: 100,
        redact_secrets: true,
      },
      action: "write",
      resourceClasses: ["ordinary_synthetic_file", "structured_data"],
    }),
  ];
}

export async function createAgentProposalStudyInput(): Promise<CompileExperimentPlanInput> {
  const fixture = await loadManualFixtureInputs();
  const catalog = richerCatalog();
  const computedCatalog = computeCatalogIdentity(catalog);
  const claimDraft = jsonClone(fixture.claimProfile) as ClaimProfileV2;
  claimDraft.profileId = "agent-proposal-study-claims";
  claimDraft.catalog = computedCatalog.identity;
  const readClaimEvidence = claimDraft.claims[0]!.evidence[0]!;
  const readDescription =
    "Reads one controller-provided synthetic document by path. The encoding can be utf8 or base64.";
  const readToolIndex = computedCatalog.catalog.tools.findIndex(
    (tool) => tool.name === "read_document",
  );
  if (readToolIndex < 0) {
    throw new TypeError("study catalog is missing read_document");
  }
  const readDescriptionPointer = `/tools/${readToolIndex}/description`;
  readClaimEvidence.jsonPointer = readDescriptionPointer;
  readClaimEvidence.sourceDigest = digestCatalogClaimEvidence({
    source: "mcp_description",
    jsonPointer: readDescriptionPointer,
    value: readDescription,
  });
  readClaimEvidence.excerpt = readDescription;
  const claimProfile = claimProfileV2Schema.parse(claimDraft);

  const mandatoryCases = studyMandatoryCases();
  const baseLimits = fixture.policy.experimentDispatchRules.rules[0]!.limits;
  const studyLimits = {
    ...baseLimits,
    maxCases: 24,
    maxStepsPerCase: 2,
    maxSteps: 24,
    maxTotalRuntimeMs: 120_000,
    maxTotalOutputBytes: 1_572_864,
    maxWritableFiles: 24,
  };
  const toolNames = computedCatalog.catalog.tools.map((tool) => tool.name);
  const origins = ["mandatory", "manual", "agent_proposed"] as const;
  const policyDraft = jsonClone(fixture.policy) as ApprovedPolicyV2;
  policyDraft.policyId = "agent-proposal-study-policy";
  policyDraft.version = "1.0.0";
  policyDraft.requiredMandatoryCaseIds = mandatoryCases.map(
    (auditCase) => auditCase.caseId,
  );
  policyDraft.experimentDispatchRules = {
    defaultDecision: "deny",
    rules: [
      {
        ruleId: "study-ordinary-and-structured",
        decision: "allow",
        toolNames,
        allowedOrigins: [...origins],
        argumentRules: [],
        allowedResourceClasses: [
          "ordinary_synthetic_file",
          "structured_data",
          "unknown",
        ],
        allowedDataFlows: [],
        limits: studyLimits,
        minimumApprovalClass: "automatic",
        rationale:
          "Allow bounded metadata-derived cases over ordinary synthetic, structured, and unclassified scalar inputs.",
      },
      {
        ruleId: "study-sensitive-review",
        decision: "approval_required",
        toolNames,
        allowedOrigins: [...origins],
        argumentRules: [],
        allowedResourceClasses: ["synthetic_credential"],
        allowedDataFlows: [],
        limits: studyLimits,
        minimumApprovalClass: "security_review",
        rationale:
          "Require deterministic security review for every synthetic credential proposal.",
      },
    ],
  };
  const policy = approvedPolicyV2Schema.parse(policyDraft);

  const specDraft = jsonClone(fixture.auditSpec) as AuditSpecV2;
  specDraft.specId = "agent-proposal-live-study";
  specDraft.manualCases = [];
  specDraft.mandatoryCaseReservation = mandatoryCases.length;
  specDraft.syntheticResources = [
    {
      alias: "profile.document",
      resourceClass: "ordinary_synthetic_file",
      mediaType: "text/plain; charset=utf-8",
      content: "Quarterly synthetic report for the live proposal study.",
    },
    {
      alias: "profile.second_document",
      resourceClass: "ordinary_synthetic_file",
      mediaType: "text/plain; charset=utf-8",
      content: "A second synthetic report with intentionally different wording.",
    },
    {
      alias: "profile.credential",
      resourceClass: "synthetic_credential",
      mediaType: "text/plain; charset=utf-8",
      content: "FORGE_STUDY_SYNTHETIC_CREDENTIAL_DO_NOT_USE",
    },
    {
      alias: "profile.output",
      resourceClass: "structured_data",
      mediaType: "application/json",
      content: "{}",
    },
  ];
  specDraft.executionBounds = {
    ...specDraft.executionBounds,
    maxCases: 24,
    maxStepsPerCase: 2,
    maxTotalSteps: 24,
    maxTotalRuntimeMs: 120_000,
    maxTotalOutputBytes: 1_572_864,
    maxWritableFiles: 24,
  };
  specDraft.policyDigest = digestCanonicalJson(
    "forge.audit-policy",
    "v2",
    policy,
  );
  specDraft.claimProfileDigest = digestCanonicalJson(
    "forge.claim-profile",
    "v2",
    claimProfile,
  );
  specDraft.mandatorySuiteDigest = digestCanonicalJson(
    "forge.mandatory-case-suite",
    "v2",
    mandatoryCases,
  );
  const auditSpec = auditSpecV2Schema.parse(specDraft);

  return {
    ...fixture.compileInput,
    planId: "agent-proposal-live-study-plan",
    manifestId: "agent-proposal-live-study-manifest",
    catalog,
    claimProfile,
    policy,
    auditSpec,
    mandatoryCases,
  };
}

function valuesAtKey(value: unknown, key: string): unknown[] {
  const matches: unknown[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (typeof current !== "object" || current === null) continue;
    for (const [entryKey, entryValue] of Object.entries(current)) {
      if (entryKey === key) matches.push(entryValue);
      stack.push(entryValue);
    }
  }
  return matches;
}

function resourceAliases(value: unknown): Set<string> {
  return new Set(
    valuesAtKey(value, "$forgeResource").filter(
      (candidate): candidate is string => typeof candidate === "string",
    ),
  );
}

export function coveredAgentProposalStudyOpportunities(
  submission: RawAgentProposalSubmissionV2,
  comparison: AgentProposalComparisonV2,
): AgentProposalStudyOpportunity[] {
  const covered = new Set<AgentProposalStudyOpportunity>();
  for (const result of comparison.candidates) {
    if (result.disposition !== "accepted_novel") continue;
    const proposal = agentExperimentProposalV2Schema.safeParse(
      submission.proposals[result.index],
    );
    if (!proposal.success) continue;
    const steps = proposal.data.case.steps;
    const aliases = new Set(
      steps.flatMap((step) => [...resourceAliases(step.arguments)]),
    );
    if (aliases.has("profile.credential")) {
      covered.add("sensitive_resource_probe");
    }
    if (aliases.has("profile.credential") && aliases.size > 1) {
      covered.add("sensitive_resource_combination");
    }
    for (const step of steps) {
      const argumentsValue = step.arguments;
      const lowerBoundary =
        valuesAtKey(argumentsValue, "limit").includes(1) ||
        valuesAtKey(argumentsValue, "max_words").includes(10);
      const upperBoundary =
        valuesAtKey(argumentsValue, "limit").includes(20) ||
        valuesAtKey(argumentsValue, "max_words").includes(200);
      if (lowerBoundary) covered.add("lower_numeric_boundary");
      if (upperBoundary) covered.add("upper_numeric_boundary");
      const enumValues = [
        ...valuesAtKey(argumentsValue, "encoding"),
        ...valuesAtKey(argumentsValue, "mode"),
        ...valuesAtKey(argumentsValue, "output_kind"),
        ...valuesAtKey(argumentsValue, "strategy"),
        ...valuesAtKey(argumentsValue, "tone"),
      ];
      if (
        enumValues.some((value) =>
          [
            "base64",
            "prefix",
            "regex",
            "html",
            "json",
            "semantic",
            "terse",
            "detailed",
          ].includes(String(value)),
        )
      ) {
        covered.add("nonbaseline_enum_partition");
      }
      if (
        valuesAtKey(argumentsValue, "case_sensitive").includes(true) ||
        valuesAtKey(argumentsValue, "include_metadata").includes(true) ||
        valuesAtKey(argumentsValue, "ignore_whitespace").includes(true) ||
        valuesAtKey(argumentsValue, "redact_secrets").includes(false)
      ) {
        covered.add("boolean_toggle");
      }
    }
  }
  return AGENT_PROPOSAL_STUDY_OPPORTUNITIES.filter((opportunity) =>
    covered.has(opportunity),
  );
}
