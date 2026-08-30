import { describe, expect, it } from "vitest";

import {
  issuePhase1Approval,
  verifyPhase1Approval,
  type Phase1CaseDecision,
} from "../../src/audit/v2/approval.js";
import { digestCanonicalJson } from "../../src/audit/v2/canonical.js";
import { compileExperimentPlan } from "../../src/audit/v2/compile.js";
import {
  createExperimentPlanEnvelope,
  verifyExperimentPlanEnvelope,
} from "../../src/audit/v2/envelope.js";
import { V2CompileError } from "../../src/audit/v2/errors.js";
import {
  jsonClone,
  loadManualFixtureInputs,
} from "../helpers/evidence-first-v2.js";

async function approvedFixture() {
  const fixture = await loadManualFixtureInputs();
  const compiled = compileExperimentPlan(fixture.compileInput);
  const decisions: Phase1CaseDecision[] = compiled.plan.cases.map((item) => ({
    caseId: item.caseId,
    decision: "approved",
    approvalClass: item.requiredApprovalClass,
  }));
  const receipt = issuePhase1Approval({
    ...fixture.approval,
    envelope: compiled,
    compilationInput: fixture.compileInput,
    caseDecisions: decisions,
  });
  return { fixture, compiled, decisions, receipt };
}

describe("Evidence-First V2 Phase 1A approval binding", () => {
  it("issues an unsigned, non-dispatchable structural receipt after plan hashing", async () => {
    const { fixture, compiled, receipt } = await approvedFixture();

    expect(receipt.authority).toEqual({
      issuerId: "local-security-reviewer",
      authentication: "unsigned",
      authenticated: false,
    });
    expect(receipt.purpose).toBe("audit_execution");
    expect(receipt.reusePolicy).toBe("prohibited");
    expect(receipt.scope.maxUses).toBe(1);
    expect(receipt.dispatchEligibility).toBe("non_dispatchable_phase1");
    expect(receipt.experimentPlanDigest).toBe(compiled.experimentPlanDigest);

    const verified = verifyPhase1Approval(receipt, {
      envelope: compiled,
      controllerId: fixture.approval.controllerId,
      now: "2026-08-30T07:30:00.000Z",
    });
    expect(verified).toMatchObject({
      structurallyBound: true,
      dispatchAuthorized: false,
    });
  });

  it("refuses missing decisions and approval-class downgrades", async () => {
    const { fixture, compiled, decisions } = await approvedFixture();
    expect(() =>
      issuePhase1Approval({
        ...fixture.approval,
        envelope: compiled,
        compilationInput: fixture.compileInput,
        caseDecisions: decisions.slice(0, -1),
      }),
    ).toThrowError(expect.objectContaining({ code: "receipt_invalid" }));

    const downgraded = decisions.map((decision) =>
      decision.approvalClass === "security_review"
        ? { ...decision, approvalClass: "operator_review" as const }
        : decision,
    );
    expect(() =>
      issuePhase1Approval({
        ...fixture.approval,
        envelope: compiled,
        compilationInput: fixture.compileInput,
        caseDecisions: downgraded,
      }),
    ).toThrowError(expect.objectContaining({ code: "receipt_invalid" }));
  });

  it("detects any post-hash plan mutation", async () => {
    const { fixture, compiled, receipt } = await approvedFixture();
    const mutatedPlan = jsonClone(compiled.plan);
    mutatedPlan.cases[0]!.description = "mutated after receipt issuance";
    const mutatedEnvelope = createExperimentPlanEnvelope(mutatedPlan);

    expect(mutatedEnvelope.experimentPlanDigest).not.toBe(
      compiled.experimentPlanDigest,
    );
    expect(() =>
      verifyPhase1Approval(receipt, {
        envelope: mutatedEnvelope,
        controllerId: fixture.approval.controllerId,
        now: "2026-08-30T07:30:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "receipt_invalid" }));
  });

  it("rejects internally stale embedded manifest and argument digests", async () => {
    const { compiled } = await approvedFixture();
    const staleManifest = jsonClone(compiled.plan);
    staleManifest.syntheticResourceManifest.instances[0]!.alias =
      "changed.alias";
    expect(() => createExperimentPlanEnvelope(staleManifest)).toThrowError(
      expect.objectContaining({ code: "digest_mismatch" }),
    );

    const staleArguments = jsonClone(compiled.plan);
    const originalArguments = staleArguments.cases[0]!.steps[0]!
      .arguments as Record<string, unknown>;
    staleArguments.cases[0]!.steps[0]!.arguments = {
      ...originalArguments,
      label: "changed-after-hash",
    };
    expect(() => createExperimentPlanEnvelope(staleArguments)).toThrowError(
      expect.objectContaining({ code: "digest_mismatch" }),
    );
  });

  it("rejects ExperimentPlan accessors without invoking them", async () => {
    const { compiled } = await approvedFixture();
    const accessorPlan = jsonClone(compiled.plan);
    let getterCalls = 0;
    Object.defineProperty(accessorPlan, "planId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return compiled.plan.planId;
      },
    });

    expect(() => createExperimentPlanEnvelope(accessorPlan)).toThrow();
    expect(getterCalls).toBe(0);
  });

  it("rejects proxy or decorated controller envelopes before traps execute", async () => {
    const { compiled } = await approvedFixture();
    let descriptorCalls = 0;
    const proxied = new Proxy(compiled, {
      getOwnPropertyDescriptor(target, property) {
        descriptorCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(() => verifyExperimentPlanEnvelope(proxied)).toThrow("non-proxy");
    expect(descriptorCalls).toBe(0);
    expect(() =>
      verifyExperimentPlanEnvelope({ ...compiled, extra: true } as never),
    ).toThrow("exactly");
  });

  it("rejects receipt accessors without invoking them", async () => {
    const { fixture, compiled, receipt } = await approvedFixture();
    const accessorReceipt = { ...receipt };
    let getterCalls = 0;
    Object.defineProperty(accessorReceipt, "receiptId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return receipt.receiptId;
      },
    });

    expect(() =>
      verifyPhase1Approval(accessorReceipt, {
        envelope: compiled,
        controllerId: fixture.approval.controllerId,
        now: "2026-08-30T07:30:00.000Z",
      }),
    ).toThrow();
    expect(getterCalls).toBe(0);
  });

  it("recompiles trusted inputs before issuing a receipt", async () => {
    const { fixture, compiled, decisions } = await approvedFixture();
    const changedPlan = jsonClone(compiled.plan);
    changedPlan.cases[0]!.description = "valid but not the recompiled plan";
    const changedEnvelope = createExperimentPlanEnvelope(changedPlan);
    const forgedEnvelope = { ...compiled, ...changedEnvelope };

    expect(() =>
      issuePhase1Approval({
        ...fixture.approval,
        envelope: forgedEnvelope,
        compilationInput: fixture.compileInput,
        caseDecisions: decisions,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "receipt_invalid",
        message: "submitted plan does not match deterministic recompilation",
      }),
    );
  });

  it("rejects unresolved Forge resource markers even with a fresh argument digest", async () => {
    const { compiled } = await approvedFixture();
    const unresolvedPlan = jsonClone(compiled.plan);
    const step = unresolvedPlan.cases[0]!.steps[0]!;
    step.arguments = {
      path: { $forgeResource: "profile.document" },
    };
    step.argumentSha256 = digestCanonicalJson(
      "forge.tool-arguments",
      "v2",
      step.arguments,
    );

    expect(() => createExperimentPlanEnvelope(unresolvedPlan)).toThrow(
      "ExperimentPlan arguments must not contain unresolved Forge bindings",
    );
  });

  it("requires canonical UTC timestamps at millisecond precision", async () => {
    const { fixture, compiled, decisions } = await approvedFixture();
    const canonical = issuePhase1Approval({
      ...fixture.approval,
      envelope: compiled,
      compilationInput: fixture.compileInput,
      caseDecisions: decisions,
    });
    expect(canonical.issuedAt).toBe("2026-08-30T07:01:00.000Z");

    for (const issuedAt of [
      "August 30, 2026",
      "2026-08-30T07:00:00.000",
      "2026-08-30T00:01:00.000-07:00",
      "2026-08-30T07:01:00.0001Z",
      "2026-02-30T07:01:00.000Z",
    ]) {
      expect(() =>
        issuePhase1Approval({
          ...fixture.approval,
          issuedAt,
          envelope: compiled,
          compilationInput: fixture.compileInput,
          caseDecisions: decisions,
        }),
      ).toThrow();
    }
  });

  it("caps receipt validity at the ApprovedPolicy expiry", async () => {
    const { fixture, compiled, decisions } = await approvedFixture();
    expect(compiled.plan.policyExpiresAt).toBe(
      "2026-08-31T06:30:00.000Z",
    );

    const capped = issuePhase1Approval({
      ...fixture.approval,
      expiresAt: compiled.plan.policyExpiresAt!,
      envelope: compiled,
      compilationInput: fixture.compileInput,
      caseDecisions: decisions,
    });
    expect(capped.expiresAt).toBe(compiled.plan.policyExpiresAt);

    expect(() =>
      issuePhase1Approval({
        ...fixture.approval,
        expiresAt: "2026-08-31T06:30:00.001Z",
        envelope: compiled,
        compilationInput: fixture.compileInput,
        caseDecisions: decisions,
      }),
    ).toThrowError(expect.objectContaining({ code: "receipt_invalid" }));
  });

  it("cannot poison compiler-owned bytes through a read before approval", async () => {
    const fixture = await loadManualFixtureInputs();
    const compiled = compileExperimentPlan(fixture.compileInput);
    const resourceId =
      compiled.plan.syntheticResourceManifest.instances[0]!.resourceId;
    const exposedBytes = compiled.resources.bytesByResourceId.get(resourceId)!;
    exposedBytes.fill(0);
    const decisions: Phase1CaseDecision[] = compiled.plan.cases.map((item) => ({
      caseId: item.caseId,
      decision: "approved",
      approvalClass: item.requiredApprovalClass,
    }));

    expect(() =>
      issuePhase1Approval({
        ...fixture.approval,
        envelope: compiled,
        compilationInput: fixture.compileInput,
        caseDecisions: decisions,
      }),
    ).not.toThrow();
  });

  it("cannot issue a receipt whose timestamp predates plan compilation", async () => {
    const { fixture, compiled, decisions } = await approvedFixture();
    expect(() =>
      issuePhase1Approval({
        ...fixture.approval,
        issuedAt: "2026-08-30T06:59:59.999Z",
        envelope: compiled,
        compilationInput: fixture.compileInput,
        caseDecisions: decisions,
      }),
    ).toThrowError(expect.objectContaining({ code: "receipt_invalid" }));
  });

  it("detects receipt catalog, manifest, bounds, and audience substitution", async () => {
    const { fixture, compiled, receipt } = await approvedFixture();
    const mutations = [
      {
        ...receipt,
        catalog: {
          ...receipt.catalog,
          rawDiscoveryDigest: "0".repeat(64),
        },
      },
      {
        ...receipt,
        syntheticResourceManifestDigest: "0".repeat(64),
      },
      {
        ...receipt,
        executionBounds: {
          ...receipt.executionBounds,
          maxCases: receipt.executionBounds.maxCases + 1,
        },
      },
      {
        ...receipt,
        audience: { ...receipt.audience, controllerId: "other-controller" },
      },
    ];

    for (const mutation of mutations) {
      expect(() =>
        verifyPhase1Approval(mutation, {
          envelope: compiled,
          controllerId: fixture.approval.controllerId,
          now: "2026-08-30T07:30:00.000Z",
        }),
      ).toThrowError(V2CompileError);
    }
  });

  it("rejects expired or not-yet-valid receipts", async () => {
    const { fixture, compiled, receipt } = await approvedFixture();
    for (const now of [
      "2026-08-30T06:59:59.999Z",
      "2026-08-30T08:01:00.000Z",
    ]) {
      expect(() =>
        verifyPhase1Approval(receipt, {
          envelope: compiled,
          controllerId: fixture.approval.controllerId,
          now,
        }),
      ).toThrowError(expect.objectContaining({ code: "receipt_invalid" }));
    }
  });

  it("rejects malformed authority, dispatch, reuse, and unknown fields", async () => {
    const { compiled, receipt } = await approvedFixture();
    const malformed: unknown[] = [
      {
        ...receipt,
        authority: { ...receipt.authority, authenticated: true },
      },
      { ...receipt, dispatchEligibility: "dispatchable" },
      { ...receipt, reusePolicy: "unbounded" },
      { ...receipt, unexpectedAuthority: "self-approved" },
    ];
    for (const value of malformed) {
      expect(() =>
        verifyPhase1Approval(value, {
          envelope: compiled,
          controllerId: "forge-test-controller",
          now: "2026-08-30T07:30:00.000Z",
        }),
      ).toThrow();
    }
  });
});
