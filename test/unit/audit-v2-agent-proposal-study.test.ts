import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  compareAgentProposalSubmission,
  prepareAgentProposalExperiment,
} from "../../src/audit/v2/agent-proposal.js";
import {
  AGENT_PROPOSAL_STUDY_OPPORTUNITIES,
  coveredAgentProposalStudyOpportunities,
  createAgentProposalStudyInput,
} from "../../src/audit/v2/agent-proposal-study.js";
import {
  AGENT_PROPOSAL_SUBMISSION_FORMAT,
  agentProposalComparisonV2Schema,
  agentProposalContextV2Schema,
  rawAgentProposalSubmissionV2Schema,
} from "../../src/contracts/v2/index.js";
import { parseStrictJson } from "../../src/audit/v2/strict-json.js";

function resource(alias: string): { readonly $forgeResource: string } {
  return { $forgeResource: alias };
}

function proposal(input: {
  readonly id: string;
  readonly kind: "tool_call" | "security_probe";
  readonly toolName: string;
  readonly arguments: unknown;
  readonly resourceClass:
    | "ordinary_synthetic_file"
    | "synthetic_credential"
    | "structured_data"
    | "unknown";
}): unknown {
  return {
    proposalId: `${input.id}-proposal`,
    case: {
      caseId: `${input.id}-case`,
      kind: input.kind,
      description: `Study regression candidate for ${input.toolName}.`,
      steps: [
        {
          stepId: `${input.id}-step`,
          toolName: input.toolName,
          arguments: input.arguments,
        },
      ],
      predictedEffects: [
        {
          predictionId: `${input.id}-prediction`,
          origin: "model_inference",
          action: "read",
          resourceClass: input.resourceClass,
          phase: "invocation",
          confidence: "medium",
          evidenceBasis: [
            { kind: "model_output", reference: "study regression" },
          ],
          limitations: ["This is a model inference, not an observation."],
        },
      ],
      assertions: [
        {
          assertionId: `${input.id}-assertion`,
          kind: "tool_status",
          subject: input.toolName,
          expected: "succeeded",
          required: true,
        },
      ],
      minimumApprovalClass: "automatic",
    },
    rationale: "Exercise one fixed study opportunity.",
    ambiguities: [],
  };
}

describe("Evidence-First V2 live proposal study", () => {
  it("freezes a bounded five-tool metadata study without resource contents", async () => {
    const prepared = prepareAgentProposalExperiment(
      await createAgentProposalStudyInput(),
      { maxCandidates: 6, maxTotalSteps: 12 },
    );

    expect(prepared.context.tools.map((tool) => tool.name)).toEqual([
      "compare_documents",
      "convert_document",
      "read_document",
      "search_documents",
      "write_summary",
    ]);
    expect(prepared.context.existingCases).toHaveLength(5);
    expect(prepared.context.syntheticResources).toHaveLength(4);
    expect(prepared.context.proposalBudget).toEqual({
      maxCandidates: 6,
      maxAcceptedCases: 6,
      maxAcceptedSteps: 12,
      maxTotalSteps: 12,
      allowedCaseKinds: ["tool_call", "security_probe"],
    });
    expect(JSON.stringify(prepared.context)).not.toContain(
      "FORGE_STUDY_SYNTHETIC_CREDENTIAL_DO_NOT_USE",
    );
  });

  it("scores the six fixed opportunities only from accepted novel cases", async () => {
    const compileInput = await createAgentProposalStudyInput();
    const prepared = prepareAgentProposalExperiment(compileInput, {
      maxCandidates: 6,
      maxTotalSteps: 12,
    });
    const submission = rawAgentProposalSubmissionV2Schema.parse({
      format: AGENT_PROPOSAL_SUBMISSION_FORMAT,
      proposals: [
        proposal({
          id: "sensitive-read",
          kind: "security_probe",
          toolName: "read_document",
          arguments: {
            path: resource("profile.credential"),
            encoding: "base64",
          },
          resourceClass: "synthetic_credential",
        }),
        proposal({
          id: "lower-search",
          kind: "tool_call",
          toolName: "search_documents",
          arguments: {
            query: "quarterly",
            mode: "prefix",
            limit: 1,
            case_sensitive: true,
          },
          resourceClass: "unknown",
        }),
        proposal({
          id: "sensitive-write",
          kind: "security_probe",
          toolName: "write_summary",
          arguments: {
            input_path: resource("profile.credential"),
            output_path: resource("profile.output"),
            tone: "detailed",
            max_words: 200,
            redact_secrets: false,
          },
          resourceClass: "synthetic_credential",
        }),
      ],
    });
    const comparison = compareAgentProposalSubmission({
      compileInput,
      expectedContextDigest: prepared.contextDigest,
      submission,
      metadata: {
        adapter: "scripted",
        requestedModel: "study/test",
        returnedModel: "study/test",
      },
      maxCandidates: 6,
      maxTotalSteps: 12,
    });

    expect(comparison.summary).toEqual({
      submitted: 3,
      rejected: 0,
      duplicateBaseline: 0,
      duplicateAgent: 0,
      acceptedNovel: 3,
    });
    expect(comparison.candidates[0]).toMatchObject({
      deterministicApprovalClass: "security_review",
      approvalUnderstated: true,
    });
    expect(
      coveredAgentProposalStudyOpportunities(submission, comparison),
    ).toEqual(AGENT_PROPOSAL_STUDY_OPPORTUNITIES);
  });

  it("validates the stored schema-only and guided live-study evidence", async () => {
    const expectations = [
      {
        filename:
          "../../experiments/evidence-first-v2/agent-proposal-live-gpt-5-6-luna-2026-08-30.json",
        promptVersion: "1alpha1",
        submitted: 26,
        rejected: 26,
        acceptedNovel: 0,
        uniqueAcceptedSemantics: 0,
        opportunityCoverageRate: 0,
      },
      {
        filename:
          "../../experiments/evidence-first-v2/agent-proposal-live-gpt-5-6-luna-guided-contract-2026-08-30.json",
        promptVersion: "1alpha2",
        submitted: 27,
        rejected: 0,
        acceptedNovel: 27,
        uniqueAcceptedSemantics: 14,
        opportunityCoverageRate: 1,
      },
    ] as const;
    for (const expected of expectations) {
      const parsed = parseStrictJson(
        await readFile(new URL(expected.filename, import.meta.url)),
      ) as Record<string, unknown>;
      expect(parsed["format"]).toBe(
        "forge.agent-proposal-live-study/v1alpha1",
      );
      const context = agentProposalContextV2Schema.parse(
        parsed["providerContext"],
      );
      expect(JSON.stringify(context)).not.toContain(
        "FORGE_STUDY_SYNTHETIC_CREDENTIAL_DO_NOT_USE",
      );
      expect(parsed["contextDigest"]).toBe(
        "b0c12ee790b97c879c983a7fb5e5d227f03b6dbd32f2b1c1dab7bc1954493a6d",
      );
      const trials = parsed["trials"] as Array<Record<string, unknown>>;
      expect(trials).toHaveLength(5);
      for (const trial of trials) {
        expect(trial["status"]).toBe("completed");
        const submission = rawAgentProposalSubmissionV2Schema.parse(
          trial["submission"],
        );
        const comparison = agentProposalComparisonV2Schema.parse(
          trial["comparison"],
        );
        expect(comparison.contextDigest).toBe(parsed["contextDigest"]);
        expect(comparison.baselineDigest).toBe(parsed["baselineDigest"]);
        expect(comparison.proposer.prompt.version).toBe(expected.promptVersion);
        expect(comparison.authority).toEqual({
          executionAuthorized: false,
          approvalIssued: false,
          experimentPlanProduced: false,
          requiredNextStep: "operator_review_and_fresh_compilation",
        });
        expect(
          coveredAgentProposalStudyOpportunities(submission, comparison),
        ).toEqual(trial["coveredOpportunities"]);
      }
      const aggregate = parsed["aggregate"] as Record<string, unknown>;
      const totals = aggregate["candidateTotals"] as Record<string, number>;
      expect(totals).toMatchObject({
        submitted: expected.submitted,
        rejected: expected.rejected,
        acceptedNovel: expected.acceptedNovel,
      });
      expect(aggregate["uniqueAcceptedSemantics"]).toBe(
        expected.uniqueAcceptedSemantics,
      );
      expect(aggregate["opportunityCoverageRate"]).toBe(
        expected.opportunityCoverageRate,
      );
      expect(aggregate["routingMismatches"]).toBe(0);
    }
  });
});
