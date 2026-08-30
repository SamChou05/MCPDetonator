import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  ControlledProposalReviewError,
  consumeControlledProposalReviewCapability,
  createControlledProposalReview,
  type ConsumeControlledProposalReviewInput,
  type ControlledProposalReviewCapability,
  type CreateControlledProposalReviewInput,
  type IssuedControlledProposalReview,
} from "../../src/audit/v2/controlled-proposal.js";
import {
  compareAgentProposalSubmission,
  prepareAgentProposalExperiment,
} from "../../src/audit/v2/agent-proposal.js";
import { digestCanonicalJson } from "../../src/audit/v2/canonical.js";
import type { CompileExperimentPlanInput } from "../../src/audit/v2/compile.js";
import { parseStrictJson } from "../../src/audit/v2/strict-json.js";
import {
  controlledProposalReviewRecordV2AlphaSchema,
  type ControlledProposalReviewRecordV2Alpha,
} from "../../src/contracts/v2/controlled-proposal.js";
import {
  AGENT_PROPOSAL_SUBMISSION_FORMAT,
  approvedPolicyV2Schema,
  auditSpecV2Schema,
  mandatoryCaseTemplateV2Schema,
  type ApprovedPolicyV2,
  type AuditSpecV2,
} from "../../src/contracts/v2/index.js";
import {
  jsonClone,
  loadManualFixtureInputs,
} from "../helpers/evidence-first-v2.js";

const PROPOSAL_METADATA = Object.freeze({
  adapter: "scripted",
  requestedModel: "scripted/proposer-v1",
  returnedModel: "scripted/proposer-v1",
});

async function proposalSubmission(): Promise<unknown> {
  return parseStrictJson(
    await readFile(
      new URL(
        "../../fixtures/evidence-first-v2/agent-proposals-scripted.json",
        import.meta.url,
      ),
    ),
  );
}

async function proposalReadyInput(): Promise<CompileExperimentPlanInput> {
  const fixture = await loadManualFixtureInputs();
  const mandatoryCases = [
    mandatoryCaseTemplateV2Schema.parse(jsonClone(fixture.mandatoryCases[0])),
  ];
  const policyDraft = jsonClone(fixture.policy);
  policyDraft.requiredMandatoryCaseIds = [mandatoryCases[0]!.caseId];
  for (const rule of policyDraft.experimentDispatchRules.rules) {
    for (const origin of ["manual", "agent_proposed"] as const) {
      if (!rule.allowedOrigins.includes(origin)) {
        rule.allowedOrigins.push(origin);
      }
    }
  }
  const policy: ApprovedPolicyV2 = approvedPolicyV2Schema.parse(policyDraft);
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
  const auditSpec: AuditSpecV2 = auditSpecV2Schema.parse(specDraft);
  return {
    ...fixture.compileInput,
    policy,
    auditSpec,
    mandatoryCases,
  };
}

function operatorAdoptedCase(): AuditSpecV2["manualCases"][number] {
  return {
    caseId: "operator-reviewed-sensitive-read",
    kind: "security_probe",
    description:
      "Operator-reviewed probe of the controller-owned synthetic credential.",
    steps: [
      {
        stepId: "operator-read-synthetic-credential",
        toolName: "read_document",
        arguments: {
          path: { $forgeResource: "profile.credential" },
        },
      },
    ],
    predictedEffects: [
      {
        predictionId: "operator-predict-synthetic-read",
        origin: "operator",
        action: "read",
        resourceClass: "synthetic_credential",
        phase: "invocation",
        confidence: "medium",
        evidenceBasis: [
          {
            kind: "operator_statement",
            reference: "operator-authored expectation for a synthetic canary",
          },
        ],
        limitations: [
          "This is an operator hypothesis and not an observed target effect.",
        ],
      },
    ],
    assertions: [
      {
        assertionId: "operator-assert-sensitive-read",
        kind: "effect_present",
        subject: "synthetic credential read",
        expected: {
          action: "read",
          resourceClass: "synthetic_credential",
        },
        required: true,
      },
    ],
    minimumApprovalClass: "security_review",
  };
}

async function reviewInput(): Promise<CreateControlledProposalReviewInput> {
  const proposalCompileInput = await proposalReadyInput();
  const submission = await proposalSubmission();
  const prepared = prepareAgentProposalExperiment(proposalCompileInput, {
    maxCandidates: 4,
    maxTotalSteps: 8,
  });
  const comparison = compareAgentProposalSubmission({
    compileInput: proposalCompileInput,
    expectedContextDigest: prepared.contextDigest,
    submission,
    metadata: PROPOSAL_METADATA,
    maxCandidates: 4,
    maxTotalSteps: 8,
  });
  return {
    proposalCompileInput,
    expectedContextDigest: prepared.contextDigest,
    submission,
    comparison,
    proposalMetadata: PROPOSAL_METADATA,
    selectedProposalId: "proposal-novel-sensitive-probe",
    operatorAdoptedCase: operatorAdoptedCase(),
    maxCandidates: 4,
    maxTotalSteps: 8,
    finalCompilation: {
      auditSpecId: "controlled-proposal-final-spec",
      auditSpecCreatedAt: "2026-08-30T07:05:00.000Z",
      planId: "controlled-proposal-final-plan",
      manifestId: "controlled-proposal-final-resources",
      compiledAt: "2026-08-30T07:06:00.000Z",
    },
    review: {
      reviewId: "controlled-proposal-review-1",
      reviewerId: "security-operator-1",
      reviewedAt: "2026-08-30T07:07:00.000Z",
      approvalClass: "security_review",
      capabilityExpiresAt: "2026-08-30T07:10:00.000Z",
    },
  };
}

function consumeInput(
  issued: IssuedControlledProposalReview,
  changes: Partial<ConsumeControlledProposalReviewInput> = {},
): ConsumeControlledProposalReviewInput {
  return {
    capability: issued.capability,
    record: issued.record,
    recordDigest: issued.recordDigest,
    experimentPlanDigest: issued.experimentPlanDigest,
    finalPlan: issued.finalPlan,
    finalCompileInput: issued.finalCompileInput,
    consumedAt: "2026-08-30T07:08:00.000Z",
    ...changes,
  };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected controlled proposal review failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ControlledProposalReviewError);
    expect((error as ControlledProposalReviewError).code).toBe(code);
  }
}

describe("controlled V2 proposal adoption", () => {
  it("recomputes, operator-adopts, freshly compiles, and consumes once", async () => {
    const input = await reviewInput();
    const issued = createControlledProposalReview(input);

    expect(issued.record).toMatchObject({
      proposalEvidence: {
        selectedProposalId: "proposal-novel-sensitive-probe",
        selectedCaseId: "agent-sensitive-resource-read",
        selectedCandidateIndex: 1,
      },
      adoption: {
        adoptedCaseId: "operator-reviewed-sensitive-read",
        adoptedPredictionOrigin: "operator",
        independentOperatorPredictionsConfirmed: true,
        proposalPredictionsImported: false,
        proposalRationaleImported: false,
      },
      review: {
        reviewerId: "security-operator-1",
        approvalClass: "security_review",
        requiredApprovalClass: "security_review",
      },
      authority: {
        recordAuthorizesExecution: false,
        recordGrantsApproval: false,
        serializedRecordIsBearerAuthority: false,
        serializedCapabilityExists: false,
        proposalPredictionsAreAuthority: false,
        proposalRationaleIsAuthority: false,
      },
    });
    expect(issued.record.proposalEvidence.selectedCaseSemanticDigest).toBe(
      issued.record.adoption.adoptedCaseSemanticDigest,
    );
    expect(issued.record.finalCompilation.experimentPlanDigest).toBe(
      issued.experimentPlanDigest,
    );
    expect(issued.finalPlan.plan.auditSpecDigest).toBe(
      issued.record.finalCompilation.auditSpecDigest,
    );
    const adoptedPlanCase = issued.finalPlan.plan.cases.find(
      (auditCase) =>
        auditCase.description === operatorAdoptedCase().description,
    );
    expect(adoptedPlanCase).toMatchObject({
      origin: "manual",
      predictedEffects: [
        expect.objectContaining({
          origin: "operator",
          predictionId: "operator-predict-synthetic-read",
        }),
      ],
    });
    expect(JSON.stringify(adoptedPlanCase)).not.toContain("model_inference");
    expect(Object.isFrozen(issued.record)).toBe(true);
    expect(Object.isFrozen(issued.record.proposalEvidence)).toBe(true);
    expect(JSON.stringify(issued.capability)).toBe("{}");

    const consumed = consumeControlledProposalReviewCapability(
      consumeInput(issued),
    );
    expect(consumed.record).toBe(issued.record);
    expect(consumed.finalPlan).toBe(issued.finalPlan);
    expect(consumed.experimentPlanDigest).toBe(issued.experimentPlanDigest);
  });

  it("rejects duplicate or rejected comparison candidates", async () => {
    for (const selectedProposalId of [
      "proposal-duplicate-nominal",
      "proposal-unsafe-host-path",
    ]) {
      const input = await reviewInput();
      expectCode(
        () =>
          createControlledProposalReview({
            ...input,
            selectedProposalId,
          }),
        "proposal_not_accepted",
      );
    }
  });

  it("rejects a structurally valid but tampered comparison", async () => {
    const input = await reviewInput();
    const comparison = jsonClone(input.comparison) as {
      proposer: { adapter: string };
    };
    comparison.proposer.adapter = "tampered-adapter";
    expectCode(
      () =>
        createControlledProposalReview({
          ...input,
          comparison,
        }),
      "comparison_mismatch",
    );
  });

  it("rejects changes to tool-and-symbolic-argument semantics", async () => {
    const input = await reviewInput();
    const adopted = jsonClone(input.operatorAdoptedCase) as ReturnType<
      typeof operatorAdoptedCase
    >;
    adopted.steps[0]!.arguments = {
      path: { $forgeResource: "profile.document" },
    };
    expectCode(
      () =>
        createControlledProposalReview({
          ...input,
          operatorAdoptedCase: adopted,
        }),
      "semantic_mismatch",
    );
  });

  it("rejects changing the selected executable case kind", async () => {
    const input = await reviewInput();
    const adopted = jsonClone(input.operatorAdoptedCase) as ReturnType<
      typeof operatorAdoptedCase
    >;
    adopted.kind = "tool_call";
    expectCode(
      () =>
        createControlledProposalReview({
          ...input,
          operatorAdoptedCase: adopted,
        }),
      "semantic_mismatch",
    );
  });

  it("never promotes model predictions into the adopted template", async () => {
    const input = await reviewInput();
    const adopted = jsonClone(input.operatorAdoptedCase) as ReturnType<
      typeof operatorAdoptedCase
    >;
    adopted.predictedEffects[0]!.origin = "model_inference";
    adopted.predictedEffects[0]!.evidenceBasis = [
      { kind: "model_output", reference: "untrusted proposal" },
    ];
    expectCode(
      () =>
        createControlledProposalReview({
          ...input,
          operatorAdoptedCase: adopted,
        }),
      "operator_case_invalid",
    );
  });

  it("rejects forged and copied capability objects without burning the real one", async () => {
    const issued = createControlledProposalReview(await reviewInput());
    const forged = Object.freeze(
      {},
    ) as unknown as ControlledProposalReviewCapability;
    const copied = {
      ...(issued.capability as unknown as Record<string, never>),
    } as unknown as ControlledProposalReviewCapability;

    expectCode(
      () =>
        consumeControlledProposalReviewCapability(
          consumeInput(issued, { capability: forged }),
        ),
      "capability_invalid",
    );
    expectCode(
      () =>
        consumeControlledProposalReviewCapability(
          consumeInput(issued, { capability: copied }),
        ),
      "capability_invalid",
    );
    expect(() =>
      consumeControlledProposalReviewCapability(consumeInput(issued)),
    ).not.toThrow();
  });

  it("burns the capability on first successful consumption", async () => {
    const issued = createControlledProposalReview(await reviewInput());
    consumeControlledProposalReviewCapability(consumeInput(issued));
    expectCode(
      () => consumeControlledProposalReviewCapability(consumeInput(issued)),
      "capability_replayed",
    );
  });

  it("atomically rejects record, digest, and final-plan substitutions", async () => {
    const other = createControlledProposalReview(await reviewInput());

    const recordVictim = createControlledProposalReview(await reviewInput());
    expectCode(
      () =>
        consumeControlledProposalReviewCapability(
          consumeInput(recordVictim, { record: other.record }),
        ),
      "binding_mismatch",
    );
    expectCode(
      () =>
        consumeControlledProposalReviewCapability(consumeInput(recordVictim)),
      "capability_replayed",
    );

    const digestVictim = createControlledProposalReview(await reviewInput());
    expectCode(
      () =>
        consumeControlledProposalReviewCapability(
          consumeInput(digestVictim, { recordDigest: "0".repeat(64) }),
        ),
      "binding_mismatch",
    );

    const planDigestVictim = createControlledProposalReview(
      await reviewInput(),
    );
    expectCode(
      () =>
        consumeControlledProposalReviewCapability(
          consumeInput(planDigestVictim, {
            experimentPlanDigest: "f".repeat(64),
          }),
        ),
      "binding_mismatch",
    );

    const planVictim = createControlledProposalReview(await reviewInput());
    expectCode(
      () =>
        consumeControlledProposalReviewCapability(
          consumeInput(planVictim, { finalPlan: other.finalPlan }),
        ),
      "binding_mismatch",
    );
  });

  it("rejects insufficient review class and invalid review lifetimes", async () => {
    const understatedCase = await reviewInput();
    const adopted = jsonClone(
      understatedCase.operatorAdoptedCase,
    ) as ReturnType<typeof operatorAdoptedCase>;
    adopted.minimumApprovalClass = "operator_review";
    expectCode(
      () =>
        createControlledProposalReview({
          ...understatedCase,
          operatorAdoptedCase: adopted,
        }),
      "operator_case_invalid",
    );

    const insufficient = await reviewInput();
    expectCode(
      () =>
        createControlledProposalReview({
          ...insufficient,
          review: {
            ...insufficient.review,
            approvalClass: "operator_review",
          },
        }),
      "insufficient_review",
    );

    const predating = await reviewInput();
    expectCode(
      () =>
        createControlledProposalReview({
          ...predating,
          review: {
            ...predating.review,
            reviewedAt: "2026-08-30T07:05:59.000Z",
          },
        }),
      "timestamp_invalid",
    );

    const excessive = await reviewInput();
    expectCode(
      () =>
        createControlledProposalReview({
          ...excessive,
          review: {
            ...excessive.review,
            capabilityExpiresAt: "2026-08-30T07:12:00.001Z",
          },
        }),
      "timestamp_invalid",
    );
  });

  it("fails closed on expiration and rejects authoritative record mutations", async () => {
    const issued = createControlledProposalReview(await reviewInput());
    expectCode(
      () =>
        consumeControlledProposalReviewCapability(
          consumeInput(issued, { consumedAt: "2026-08-30T07:10:00.000Z" }),
        ),
      "capability_expired",
    );

    const record = jsonClone(
      issued.record,
    ) as ControlledProposalReviewRecordV2Alpha;
    record.authority.recordAuthorizesExecution = true as false;
    expect(() =>
      controlledProposalReviewRecordV2AlphaSchema.parse(record),
    ).toThrow();
  });

  it("does not accept an empty or substitute submission envelope", async () => {
    const input = await reviewInput();
    expectCode(
      () =>
        createControlledProposalReview({
          ...input,
          submission: {
            format: AGENT_PROPOSAL_SUBMISSION_FORMAT,
            proposals: [],
          },
        }),
      "comparison_mismatch",
    );
  });
});
