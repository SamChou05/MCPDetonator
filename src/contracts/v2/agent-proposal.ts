import { z } from "zod";

import { syntheticResourceMediaTypeV2Schema } from "./artifact-reference.js";
import { manualAuditCaseV2Schema } from "./audit-spec.js";
import { catalogIdentityV2Schema } from "./catalog.js";
import {
  addDuplicateIssues,
  boundedJsonValueV2Schema,
  componentIdentityV2Schema,
  descriptionV2Schema,
  identifierV2Schema,
  nonnegativeSafeIntegerV2Schema,
  positiveSafeIntegerV2Schema,
  sha256V2Schema,
  shortTextV2Schema,
  toolNameV2Schema,
} from "./common.js";
import {
  APPROVAL_CLASS_RANK,
  resourceClassV2Schema,
} from "./vocabulary.js";

/**
 * These are experimental, non-authoritative exchange formats. They are not
 * added to V2_TOP_LEVEL_SCHEMA_IDS and cannot substitute for AuditSpec,
 * ExperimentPlan, ApprovalReceipt, CoverageRecord, or AuditResult.
 */
export const AGENT_PROPOSAL_EXPERIMENT_LIMITS = Object.freeze({
  maxCandidates: 16,
  maxTotalSteps: 128,
  maxAmbiguitiesPerCandidate: 16,
  maxComparisonFeatures: 4_096,
});

export const AGENT_PROPOSAL_CONTEXT_FORMAT =
  "forge.agent-proposal-context/v1alpha1" as const;
export const AGENT_PROPOSAL_SUBMISSION_FORMAT =
  "forge.agent-proposal-submission/v1alpha1" as const;
export const AGENT_PROPOSAL_COMPARISON_FORMAT =
  "forge.agent-proposal-comparison/v1alpha1" as const;

const proposalJsonObjectV2Schema = boundedJsonValueV2Schema.refine(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  "value must be a JSON object",
);

export const agentProposalToolV2Schema = z
  .object({
    name: toolNameV2Schema,
    title: shortTextV2Schema.optional(),
    description: descriptionV2Schema.optional(),
    inputSchema: proposalJsonObjectV2Schema,
    outputSchema: proposalJsonObjectV2Schema.optional(),
    metadataTrust: z.literal("untrusted_mcp"),
  })
  .strict();

export const agentProposalResourceV2Schema = z
  .object({
    alias: identifierV2Schema,
    resourceClass: resourceClassV2Schema,
    mediaType: syntheticResourceMediaTypeV2Schema,
  })
  .strict();

export const agentProposalExistingStepV2Schema = z
  .object({
    toolName: toolNameV2Schema,
    arguments: boundedJsonValueV2Schema,
  })
  .strict();

export const agentProposalExistingCaseV2Schema = z
  .object({
    caseId: identifierV2Schema,
    kind: z.enum(["tool_call", "security_probe"]),
    description: descriptionV2Schema,
    steps: z.array(agentProposalExistingStepV2Schema).min(1).max(64),
    semanticDigest: sha256V2Schema,
    features: z
      .array(shortTextV2Schema)
      .max(AGENT_PROPOSAL_EXPERIMENT_LIMITS.maxComparisonFeatures),
  })
  .strict();

export const agentProposalBudgetV2Schema = z
  .object({
    maxCandidates: positiveSafeIntegerV2Schema.max(
      AGENT_PROPOSAL_EXPERIMENT_LIMITS.maxCandidates,
    ),
    maxAcceptedCases: nonnegativeSafeIntegerV2Schema.max(
      AGENT_PROPOSAL_EXPERIMENT_LIMITS.maxCandidates,
    ),
    maxAcceptedSteps: nonnegativeSafeIntegerV2Schema.max(
      AGENT_PROPOSAL_EXPERIMENT_LIMITS.maxTotalSteps,
    ),
    maxTotalSteps: positiveSafeIntegerV2Schema.max(
      AGENT_PROPOSAL_EXPERIMENT_LIMITS.maxTotalSteps,
    ),
    allowedCaseKinds: z
      .array(z.enum(["tool_call", "security_probe"]))
      .length(2),
  })
  .strict();

export const agentProposalContextV2Schema = z
  .object({
    format: z.literal(AGENT_PROPOSAL_CONTEXT_FORMAT),
    targetIdentityDigest: sha256V2Schema,
    catalog: catalogIdentityV2Schema,
    policyDigest: sha256V2Schema,
    auditSpecDigest: sha256V2Schema,
    tools: z.array(agentProposalToolV2Schema).max(1_024),
    syntheticResources: z.array(agentProposalResourceV2Schema).max(1_024),
    existingCases: z
      .array(agentProposalExistingCaseV2Schema)
      .max(1_024),
    proposalBudget: agentProposalBudgetV2Schema,
    submissionTool: z.literal("submit_experiment_proposals"),
    authority: z
      .object({
        proposalsAuthorizeExecution: z.literal(false),
        proposalsGrantApproval: z.literal(false),
        requiredNextStep: z.literal("deterministic_validation_and_operator_review"),
      })
      .strict(),
  })
  .strict()
  .superRefine((context, ctx) => {
    addDuplicateIssues(
      context.tools,
      (tool) => tool.name,
      ctx,
      ["tools"],
      "proposal-context tool name",
    );
    addDuplicateIssues(
      context.syntheticResources,
      (resource) => resource.alias,
      ctx,
      ["syntheticResources"],
      "proposal-context resource alias",
    );
    addDuplicateIssues(
      context.existingCases,
      (auditCase) => auditCase.caseId,
      ctx,
      ["existingCases"],
      "proposal-context caseId",
    );
    if (
      context.proposalBudget.allowedCaseKinds[0] !== "tool_call" ||
      context.proposalBudget.allowedCaseKinds[1] !== "security_probe"
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "allowedCaseKinds must be the canonical tool_call, security_probe sequence",
        path: ["proposalBudget", "allowedCaseKinds"],
      });
    }
    if (context.tools.length !== context.catalog.toolCount) {
      ctx.addIssue({
        code: "custom",
        message: "proposal-context tools must exactly match catalog.toolCount",
        path: ["tools"],
      });
    }
    if (
      context.proposalBudget.maxAcceptedCases >
      context.proposalBudget.maxCandidates
    ) {
      ctx.addIssue({
        code: "custom",
        message: "maxAcceptedCases must not exceed maxCandidates",
        path: ["proposalBudget", "maxAcceptedCases"],
      });
    }
    if (
      context.proposalBudget.maxAcceptedSteps >
      context.proposalBudget.maxTotalSteps
    ) {
      ctx.addIssue({
        code: "custom",
        message: "maxAcceptedSteps must not exceed maxTotalSteps",
        path: ["proposalBudget", "maxAcceptedSteps"],
      });
    }
  });

export const agentExperimentProposalV2Schema = z
  .object({
    proposalId: identifierV2Schema,
    case: manualAuditCaseV2Schema,
    rationale: descriptionV2Schema,
    ambiguities: z
      .array(descriptionV2Schema)
      .max(AGENT_PROPOSAL_EXPERIMENT_LIMITS.maxAmbiguitiesPerCandidate),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    proposal.case.predictedEffects.forEach((effect, effectIndex) => {
      if (effect.origin !== "model_inference") {
        ctx.addIssue({
          code: "custom",
          message: "agent-proposed predicted effects must use model_inference origin",
          path: ["case", "predictedEffects", effectIndex, "origin"],
        });
      }
      effect.evidenceBasis.forEach((basis, basisIndex) => {
        if (basis.kind !== "model_output") {
          ctx.addIssue({
            code: "custom",
            message:
              "agent proposal evidence may cite only model_output in this metadata-only experiment",
            path: [
              "case",
              "predictedEffects",
              effectIndex,
              "evidenceBasis",
              basisIndex,
              "kind",
            ],
          });
        }
      });
    });
  });

/** Provider-facing typed contract used to generate the function schema. */
export const typedAgentProposalSubmissionV2Schema = z
  .object({
    format: z.literal(AGENT_PROPOSAL_SUBMISSION_FORMAT),
    proposals: z
      .array(agentExperimentProposalV2Schema)
      .max(AGENT_PROPOSAL_EXPERIMENT_LIMITS.maxCandidates),
  })
  .strict()
  .superRefine((submission, ctx) => {
    addDuplicateIssues(
      submission.proposals,
      (proposal) => proposal.proposalId,
      ctx,
      ["proposals"],
      "proposalId",
    );
    addDuplicateIssues(
      submission.proposals,
      (proposal) => proposal.case.caseId,
      ctx,
      ["proposals"],
      "agent caseId",
    );
  });

/**
 * Runtime envelope deliberately leaves individual entries untyped so one bad
 * candidate does not erase the evidence from its valid siblings. Each entry
 * is parsed separately with agentExperimentProposalV2Schema.
 */
export const rawAgentProposalSubmissionV2Schema = z
  .object({
    format: z.literal(AGENT_PROPOSAL_SUBMISSION_FORMAT),
    proposals: z
      .array(boundedJsonValueV2Schema)
      .max(AGENT_PROPOSAL_EXPERIMENT_LIMITS.maxCandidates),
  })
  .strict();

export const agentProposalDispositionV2Schema = z.enum([
  "rejected",
  "duplicate_baseline",
  "duplicate_agent",
  "accepted_novel",
]);

export const agentProposalReasonCodeV2Schema = z.enum([
  "accepted",
  "contract_invalid",
  "duplicate_proposal_id",
  "duplicate_case_id",
  "reserved_case_id",
  "unsupported_case_kind",
  "bounds_exceeded",
  "tool_missing",
  "resource_unknown",
  "unsafe_reference",
  "binding_unsupported",
  "schema_unsupported",
  "schema_validation_failed",
  "policy_denied",
  "policy_missing",
  "duplicate_baseline",
  "duplicate_agent",
]);

export const agentProposalCandidateResultV2Schema = z
  .object({
    index: nonnegativeSafeIntegerV2Schema.max(
      AGENT_PROPOSAL_EXPERIMENT_LIMITS.maxCandidates - 1,
    ),
    proposalId: identifierV2Schema,
    caseId: identifierV2Schema.optional(),
    disposition: agentProposalDispositionV2Schema,
    reasonCode: agentProposalReasonCodeV2Schema,
    semanticDigest: sha256V2Schema.optional(),
    suggestedApprovalClass: z
      .enum(["automatic", "operator_review", "security_review"])
      .optional(),
    deterministicApprovalClass: z
      .enum(["automatic", "operator_review", "security_review"])
      .optional(),
    approvalUnderstated: z.boolean().optional(),
    features: z
      .array(shortTextV2Schema)
      .max(AGENT_PROPOSAL_EXPERIMENT_LIMITS.maxComparisonFeatures),
    warnings: z.array(shortTextV2Schema).max(32),
  })
  .strict()
  .superRefine((result, ctx) => {
    const expectedReason = {
      accepted_novel: "accepted",
      duplicate_baseline: "duplicate_baseline",
      duplicate_agent: "duplicate_agent",
    } as const;
    if (result.disposition !== "rejected") {
      if (result.reasonCode !== expectedReason[result.disposition]) {
        ctx.addIssue({
          code: "custom",
          message: "non-rejected proposal disposition and reasonCode disagree",
          path: ["reasonCode"],
        });
      }
      for (const field of [
        "caseId",
        "semanticDigest",
        "suggestedApprovalClass",
        "deterministicApprovalClass",
        "approvalUnderstated",
      ] as const) {
        if (result[field] === undefined) {
          ctx.addIssue({
            code: "custom",
            message: `${field} is required for a non-rejected proposal`,
            path: [field],
          });
        }
      }
    } else if (
      result.reasonCode === "accepted" ||
      result.reasonCode === "duplicate_baseline" ||
      result.reasonCode === "duplicate_agent"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "a rejected proposal must use a rejection reasonCode",
        path: ["reasonCode"],
      });
    }
    if (
      result.suggestedApprovalClass !== undefined &&
      result.deterministicApprovalClass !== undefined &&
      result.approvalUnderstated !== undefined &&
      result.approvalUnderstated !==
        (APPROVAL_CLASS_RANK[result.suggestedApprovalClass] <
          APPROVAL_CLASS_RANK[result.deterministicApprovalClass])
    ) {
      ctx.addIssue({
        code: "custom",
        message: "approvalUnderstated must reflect the two approval classes",
        path: ["approvalUnderstated"],
      });
    }
    addDuplicateIssues(
      result.features,
      (feature) => feature,
      ctx,
      ["features"],
      "candidate feature",
    );
    addDuplicateIssues(
      result.warnings,
      (warning) => warning,
      ctx,
      ["warnings"],
      "candidate warning",
    );
  });

const proposalFeatureSetV2Schema = z
  .array(shortTextV2Schema)
  .max(AGENT_PROPOSAL_EXPERIMENT_LIMITS.maxComparisonFeatures);

export const agentProposalComparisonV2Schema = z
  .object({
    format: z.literal(AGENT_PROPOSAL_COMPARISON_FORMAT),
    contextDigest: sha256V2Schema,
    submissionDigest: sha256V2Schema,
    baselineDigest: sha256V2Schema,
    proposer: z
      .object({
        adapter: identifierV2Schema,
        requestedModel: shortTextV2Schema,
        returnedModel: shortTextV2Schema,
        routingMatch: z.boolean(),
        prompt: componentIdentityV2Schema,
        usage: z
          .object({
            promptTokens: nonnegativeSafeIntegerV2Schema,
            completionTokens: nonnegativeSafeIntegerV2Schema,
            totalTokens: nonnegativeSafeIntegerV2Schema,
          })
          .strict()
          .optional(),
      })
      .strict(),
    summary: z
      .object({
        submitted: nonnegativeSafeIntegerV2Schema,
        rejected: nonnegativeSafeIntegerV2Schema,
        duplicateBaseline: nonnegativeSafeIntegerV2Schema,
        duplicateAgent: nonnegativeSafeIntegerV2Schema,
        acceptedNovel: nonnegativeSafeIntegerV2Schema,
      })
      .strict(),
    candidates: z
      .array(agentProposalCandidateResultV2Schema)
      .max(AGENT_PROPOSAL_EXPERIMENT_LIMITS.maxCandidates),
    coverageComparison: z
      .object({
        baselineFeatures: proposalFeatureSetV2Schema,
        acceptedAgentFeatures: proposalFeatureSetV2Schema,
        combinedFeatures: proposalFeatureSetV2Schema,
        agentOnlyFeatures: proposalFeatureSetV2Schema,
      })
      .strict(),
    authority: z
      .object({
        executionAuthorized: z.literal(false),
        approvalIssued: z.literal(false),
        experimentPlanProduced: z.literal(false),
        requiredNextStep: z.literal("operator_review_and_fresh_compilation"),
      })
      .strict(),
    limitations: z.array(descriptionV2Schema).min(1).max(16),
  })
  .strict()
  .superRefine((report, ctx) => {
    const expectedSummary = {
      submitted: report.candidates.length,
      rejected: report.candidates.filter(
        (candidate) => candidate.disposition === "rejected",
      ).length,
      duplicateBaseline: report.candidates.filter(
        (candidate) => candidate.disposition === "duplicate_baseline",
      ).length,
      duplicateAgent: report.candidates.filter(
        (candidate) => candidate.disposition === "duplicate_agent",
      ).length,
      acceptedNovel: report.candidates.filter(
        (candidate) => candidate.disposition === "accepted_novel",
      ).length,
    };
    if (
      Object.entries(expectedSummary).some(
        ([key, value]) =>
          report.summary[key as keyof typeof expectedSummary] !== value,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "proposal summary must exactly account for every candidate",
        path: ["summary"],
      });
    }
    report.candidates.forEach((candidate, index) => {
      if (candidate.index !== index) {
        ctx.addIssue({
          code: "custom",
          message: "candidate index must equal its array position",
          path: ["candidates", index, "index"],
        });
      }
    });
    if (
      report.proposer.routingMatch !==
      (report.proposer.requestedModel === report.proposer.returnedModel)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "routingMatch must reflect exact requested/returned model identity",
        path: ["proposer", "routingMatch"],
      });
    }
    if (
      report.proposer.usage !== undefined &&
      report.proposer.usage.totalTokens !==
        report.proposer.usage.promptTokens +
          report.proposer.usage.completionTokens
    ) {
      ctx.addIssue({
        code: "custom",
        message: "totalTokens must equal promptTokens plus completionTokens",
        path: ["proposer", "usage", "totalTokens"],
      });
    }
    const featureGroups = report.coverageComparison;
    for (const [name, values] of Object.entries(featureGroups)) {
      addDuplicateIssues(
        values,
        (feature) => feature,
        ctx,
        ["coverageComparison", name],
        `${name} feature`,
      );
      const sorted = values.slice().sort();
      if (sorted.some((feature, index) => feature !== values[index])) {
        ctx.addIssue({
          code: "custom",
          message: `${name} must use canonical feature ordering`,
          path: ["coverageComparison", name],
        });
      }
    }
    const baseline = new Set(featureGroups.baselineFeatures);
    const accepted = new Set(featureGroups.acceptedAgentFeatures);
    const expectedCombined = [...new Set([...baseline, ...accepted])].sort();
    const expectedAgentOnly = [...accepted]
      .filter((feature) => !baseline.has(feature))
      .sort();
    const candidateAccepted = [
      ...new Set(
        report.candidates
          .filter((candidate) => candidate.disposition === "accepted_novel")
          .flatMap((candidate) => candidate.features),
      ),
    ].sort();
    if (
      JSON.stringify(featureGroups.combinedFeatures) !==
        JSON.stringify(expectedCombined) ||
      JSON.stringify(featureGroups.agentOnlyFeatures) !==
        JSON.stringify(expectedAgentOnly) ||
      JSON.stringify(featureGroups.acceptedAgentFeatures) !==
        JSON.stringify(candidateAccepted)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "coverageComparison must be the exact candidate feature union/difference",
        path: ["coverageComparison"],
      });
    }
  });

export type AgentProposalToolV2 = z.infer<typeof agentProposalToolV2Schema>;
export type AgentProposalContextV2 = z.infer<typeof agentProposalContextV2Schema>;
export type AgentExperimentProposalV2 = z.infer<
  typeof agentExperimentProposalV2Schema
>;
export type RawAgentProposalSubmissionV2 = z.infer<
  typeof rawAgentProposalSubmissionV2Schema
>;
export type AgentProposalCandidateResultV2 = z.infer<
  typeof agentProposalCandidateResultV2Schema
>;
export type AgentProposalComparisonV2 = z.infer<
  typeof agentProposalComparisonV2Schema
>;
