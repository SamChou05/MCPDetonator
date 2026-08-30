import { describe, expect, it } from "vitest";

import {
  compileExperimentPlan,
  PHASE1_COMPILER_IDENTITY,
  PHASE1_COMPILER_WORK_LIMITS,
} from "../../src/audit/v2/compile.js";
import { computeCatalogIdentity } from "../../src/audit/v2/catalog.js";
import { digestCanonicalJson } from "../../src/audit/v2/canonical.js";
import { validateClaimEvidenceBindings } from "../../src/audit/v2/claim-evidence.js";
import { V2CompileError } from "../../src/audit/v2/errors.js";
import {
  createPolicyEvaluationWorkTracker,
  evaluateExperimentDispatch,
  evaluatePreparedExperimentDispatch,
  prepareExperimentDispatchPolicy,
} from "../../src/audit/v2/policy.js";
import type { ManualAuditCaseV2 } from "../../src/contracts/v2/index.js";
import {
  jsonClone,
  loadManualFixtureInputs,
} from "../helpers/evidence-first-v2.js";

describe("Evidence-First V2 provider-free compiler", () => {
  it("compiles mandatory cases first and preserves separated authority dimensions", async () => {
    const fixture = await loadManualFixtureInputs();
    const compiled = compileExperimentPlan(fixture.compileInput);

    expect(compiled.plan.cases.map((item) => item.origin)).toEqual([
      "mandatory",
      "mandatory",
      "manual",
    ]);
    expect(compiled.plan.caseBudgetReservation).toEqual({
      mandatory: 2,
      manual: 1,
      total: 3,
    });
    expect(compiled.plan.cases.every((item) => item.environmentVariant === "default")).toBe(
      true,
    );
    expect(compiled.plan.syntheticResourceManifest.instances).toHaveLength(3);
    expect(
      new Set(
        compiled.plan.syntheticResourceManifest.instances.map(
          (instance) => instance.caseId,
        ),
      ),
    ).toEqual(new Set(compiled.plan.cases.map((item) => item.caseId)));
    expect(compiled.plan.cases[1]?.requiredApprovalClass).toBe(
      "security_review",
    );
    expect(compiled.plan.cases[2]?.requiredApprovalClass).toBe(
      "operator_review",
    );
    expect(compiled.plan.requiredApprovalClass).toBe("security_review");

    // Subject behavior denies synthetic credential reads, while the separate
    // dispatch compartment deliberately authorizes this exact bounded probe.
    expect(
      fixture.policy.subjectBehaviorRules.rules.find(
        (rule) => rule.ruleId === "subject-deny-credential-read",
      )?.decision,
    ).toBe("deny");
    expect(compiled.plan.cases[1]?.steps[0]?.arguments).toEqual({
      path: expect.stringMatching(/^\/forge\/synthetic\/resource-/),
    });
    expect(JSON.stringify(compiled.plan)).not.toContain("$forgeResource");
    expect(compiled.plan).not.toHaveProperty("experimentPlanDigest");
    expect(compiled.plan).not.toHaveProperty("approval");
    expect(Object.isFrozen(compiled.plan)).toBe(true);
  });

  it("is byte-stable for the human-authored fixture", async () => {
    const first = compileExperimentPlan(
      (await loadManualFixtureInputs()).compileInput,
    );
    const second = compileExperimentPlan(
      (await loadManualFixtureInputs()).compileInput,
    );

    expect(second.plan).toEqual(first.plan);
    expect(second.experimentPlanDigest).toBe(first.experimentPlanDigest);
    expect(second.experimentPlanDigest).toBe(
      "656dc2d9eee5174c24deb71778088a8982ec122fdb496a7893efff9bd1cc1c9d",
    );
  });

  it("uses only the built-in Phase 1A compiler identity", async () => {
    const fixture = await loadManualFixtureInputs();
    const spoofedCompiler = { id: "untrusted-compiler", version: "999.0.0" };
    const callerSuppliedIdentity = {
      ...fixture.compileInput,
      compiler: spoofedCompiler,
    };

    const compiled = compileExperimentPlan(callerSuppliedIdentity);
    expect(compiled.plan.compiler).toEqual(PHASE1_COMPILER_IDENTITY);
    expect(compiled.plan.compiler).not.toEqual(spoofedCompiler);
  });

  it("bounds controller plan and manifest identifiers before expansion", async () => {
    const fixture = await loadManualFixtureInputs();
    for (const field of ["planId", "manifestId"] as const) {
      expect(() =>
        compileExperimentPlan({
          ...fixture.compileInput,
          [field]: `x${"a".repeat(128)}`,
        }),
      ).toThrow();
    }
  });

  it("rejects target artifact and runtime descriptor substitution", async () => {
    const fixture = await loadManualFixtureInputs();
    const changedBytes = Buffer.from("substituted source bytes", "utf8");
    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        target: {
          ...fixture.compileInput.target,
          sourceArtifactBytes: changedBytes,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "artifact_mismatch" }));

    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        target: {
          ...fixture.compileInput.target,
          runtimeDescriptor: {
            ...fixture.runtimeDescriptor,
            args: ["different.js"],
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "artifact_mismatch" }));
  });

  it("rejects unknown tools and default-denied dispatch", async () => {
    const fixture = await loadManualFixtureInputs();
    const unknownToolSpec = jsonClone(fixture.auditSpec);
    unknownToolSpec.manualCases[0]!.steps[0]!.toolName = "missing_tool";
    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        auditSpec: unknownToolSpec,
      }),
    ).toThrowError(expect.objectContaining({ code: "tool_missing" }));

    const deniedPolicy = jsonClone(fixture.policy);
    deniedPolicy.experimentDispatchRules.rules = [];
    const deniedSpec = jsonClone(fixture.auditSpec);
    deniedSpec.policyDigest = digestCanonicalJson(
      "forge.audit-policy",
      "v2",
      deniedPolicy,
    );
    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        policy: deniedPolicy,
        auditSpec: deniedSpec,
      }),
    ).toThrowError(expect.objectContaining({ code: "policy_denied" }));

    const unclassifiedSpec = jsonClone(fixture.auditSpec) as unknown as {
      manualCases: Array<{ steps: Array<{ arguments: { path: unknown } }> }>;
    };
    unclassifiedSpec.manualCases[0]!.steps[0]!.arguments.path = "relative.txt";
    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        auditSpec: unclassifiedSpec,
      }),
    ).toThrowError(expect.objectContaining({ code: "unsafe_reference" }));
  });

  it("does not hide unclassified values behind one approved resource alias", async () => {
    const fixture = await loadManualFixtureInputs();
    const catalogInput = jsonClone(fixture.catalogInput) as {
      tools: Array<{
        inputSchema: {
          properties: Record<string, unknown>;
        };
      }>;
    };
    catalogInput.tools[0]!.inputSchema.properties["label"] = {
      type: "string",
    };
    const catalog = computeCatalogIdentity(catalogInput);
    const claims = jsonClone(fixture.claimProfile);
    claims.catalog = catalog.identity;
    const spec = jsonClone(fixture.auditSpec);
    spec.claimProfileDigest = digestCanonicalJson(
      "forge.claim-profile",
      "v2",
      claims,
    );
    spec.manualCases[0]!.steps[0]!.arguments = {
      path: { $forgeResource: "profile.document" },
      label: "unclassified-extra-value",
    };

    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        catalog: catalogInput,
        claimProfile: claims,
        auditSpec: spec,
      }),
    ).toThrowError(expect.objectContaining({ code: "policy_denied" }));
  });

  it("rejects unresolved output bindings, literal paths, and URI references", async () => {
    const fixture = await loadManualFixtureInputs();
    for (const pathValue of [
      { $forgeOutput: { stepId: "producer", pointer: "/path" } },
      "../../etc/passwd",
      "/forge/synthetic/unbound-literal",
      "https://example.invalid/resource",
    ]) {
      const spec = jsonClone(fixture.auditSpec) as unknown as {
        manualCases: Array<{ steps: Array<{ arguments: { path: unknown } }> }>;
      };
      spec.manualCases[0]!.steps[0]!.arguments.path = pathValue;
      expect(() =>
        compileExperimentPlan({ ...fixture.compileInput, auditSpec: spec }),
      ).toThrow();
    }
  });

  it("normalizes dangerous argument keys and plural path or network fields", async () => {
    const fixture = await loadManualFixtureInputs();
    const dangerousArguments: Array<Record<string, string | string[]>> = [
      { paths: ["server.js"] },
      { filePaths: ["server.js"] },
      { files: ["server.js"] },
      { hosts: ["169.254.169.254"] },
      { urls: ["example.invalid"] },
      { path: "．．∕etc/passwd" },
      { "ｃｏｍｍａｎｄ": "echo unsafe" },
    ];
    for (const argumentsValue of dangerousArguments) {
      const spec = jsonClone(fixture.auditSpec);
      spec.manualCases[0]!.steps[0]!.arguments = argumentsValue;
      expect(() =>
        compileExperimentPlan({ ...fixture.compileInput, auditSpec: spec }),
      ).toThrowError(
        expect.objectContaining({
          code: expect.stringMatching(
            /^(?:binding_unsupported|unsafe_reference)$/u,
          ),
        }),
      );
    }
  });

  it("keeps later-phase and expected-invalid candidates out of Phase 1A plans", async () => {
    const fixture = await loadManualFixtureInputs();
    for (const kind of [
      "negative_tool_call",
      "workflow",
      "metamorphic_pair",
    ] as const) {
      const spec = jsonClone(fixture.auditSpec);
      spec.manualCases[0]!.kind = kind;
      if (kind === "negative_tool_call") {
        spec.manualCases[0]!.steps[0]!.arguments = {
          unexpected: "schema-invalid",
        };
      }

      expect(() =>
        compileExperimentPlan({ ...fixture.compileInput, auditSpec: spec }),
      ).toThrowError(
        expect.objectContaining({
          code: "binding_unsupported",
          message: expect.stringContaining("non-executable"),
        }),
      );
    }
  });

  it("rejects mandatory deletion, collision, and reservation bypass", async () => {
    const fixture = await loadManualFixtureInputs();
    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        mandatoryCases: fixture.mandatoryCases.slice(0, 1),
      }),
    ).toThrowError(expect.objectContaining({ code: "digest_mismatch" }));

    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        mandatoryCases: [
          ...fixture.mandatoryCases,
          fixture.mandatoryCases[0],
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "duplicate_id" }));

    const reservationBypass = jsonClone(fixture.auditSpec);
    reservationBypass.mandatoryCaseReservation = 1;
    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        auditSpec: reservationBypass,
      }),
    ).toThrowError(expect.objectContaining({ code: "bounds_exceeded" }));
  });

  it("rejects mandatory suite body substitution", async () => {
    const fixture = await loadManualFixtureInputs();
    const substituted = jsonClone(fixture.mandatoryCases) as Array<{
      description: string;
    }>;
    substituted[0]!.description =
      "Substituted mandatory behavior under an unchanged case identifier.";

    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        mandatoryCases: substituted,
      }),
    ).toThrowError(expect.objectContaining({ code: "digest_mismatch" }));
  });

  it("rejects AuditSpec resource-class relabeling of mandatory probes", async () => {
    const fixture = await loadManualFixtureInputs();
    const spec = jsonClone(fixture.auditSpec);
    const credential = spec.syntheticResources.find(
      (resource) => resource.alias === "profile.credential",
    )!;
    credential.resourceClass = "ordinary_synthetic_file";

    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        auditSpec: spec,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "mandatory_collision",
        message: expect.stringContaining("controller-owned case suite"),
      }),
    );
  });

  it("keeps every mandatory predicted class as a conservative policy selector", async () => {
    const fixture = await loadManualFixtureInputs();
    const mandatoryCases = jsonClone(
      fixture.mandatoryCases,
    ) as ManualAuditCaseV2[];
    const sensitive = mandatoryCases[1]!;
    sensitive.predictedEffects.push({
      ...sensitive.predictedEffects[0]!,
      predictionId: "predict-sensitive-ordinary-decoy",
      resourceClass: "ordinary_synthetic_file",
    });
    const spec = jsonClone(fixture.auditSpec);
    spec.mandatorySuiteDigest = digestCanonicalJson(
      "forge.mandatory-case-suite",
      "v2",
      mandatoryCases,
    );
    spec.syntheticResources.find(
      (resource) => resource.alias === "profile.credential",
    )!.resourceClass = "ordinary_synthetic_file";

    const compiled = compileExperimentPlan({
      ...fixture.compileInput,
      auditSpec: spec,
      mandatoryCases,
    });
    expect(
      compiled.plan.cases.find((item) =>
        item.caseId.startsWith("mandatory-sensitive-read"),
      )?.requiredApprovalClass,
    ).toBe("security_review");
  });

  it("rejects case expansion above the hard plan cardinality cap", async () => {
    const fixture = await loadManualFixtureInputs();
    const mandatoryCases = jsonClone(fixture.mandatoryCases) as Array<{
      caseId: string;
    }>;
    for (let index = 0; index < 15; index += 1) {
      const generated = jsonClone(fixture.mandatoryCases[0]) as {
        caseId: string;
      };
      generated.caseId = `mandatory-cap-${index}`;
      mandatoryCases.push(generated);
    }
    const spec = jsonClone(fixture.auditSpec);
    spec.repetitions = 64;
    spec.manualCases = [];
    spec.mandatoryCaseReservation = 1_024;
    spec.executionBounds.maxCases = 2_048;
    spec.mandatorySuiteDigest = digestCanonicalJson(
      "forge.mandatory-case-suite",
      "v2",
      mandatoryCases,
    );

    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        auditSpec: spec,
        mandatoryCases,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "bounds_exceeded",
        message: expect.stringContaining("cardinality"),
      }),
    );
  });

  it("expands and budget-binds every environment/repetition combination", async () => {
    const fixture = await loadManualFixtureInputs();
    const policy = jsonClone(fixture.policy);
    for (const rule of policy.experimentDispatchRules.rules) {
      rule.limits.maxCases = 12;
      rule.limits.maxSteps = 12;
      rule.limits.maxWritableFiles = 12;
      rule.limits.maxWritableBytes = 1_048_576;
    }
    const spec = jsonClone(fixture.auditSpec);
    spec.policyDigest = digestCanonicalJson(
      "forge.audit-policy",
      "v2",
      policy,
    );
    spec.environmentVariants = ["default", "alternate"];
    spec.repetitions = 2;
    spec.mandatoryCaseReservation = 8;
    spec.executionBounds.maxCases = 12;
    spec.executionBounds.maxTotalSteps = 12;
    spec.executionBounds.maxWritableFiles = 12;
    spec.executionBounds.maxWritableBytes = 1_048_576;

    const compiled = compileExperimentPlan({
      ...fixture.compileInput,
      policy,
      auditSpec: spec,
    });
    expect(compiled.plan.caseBudgetReservation).toEqual({
      mandatory: 8,
      manual: 4,
      total: 12,
    });
    expect(
      new Set(compiled.plan.cases.map((item) => item.environmentVariant)),
    ).toEqual(new Set(["default", "alternate"]));
    expect(new Set(compiled.plan.cases.map((item) => item.repetition))).toEqual(
      new Set([1, 2]),
    );
    expect(compiled.plan.syntheticResourceManifest.instances).toHaveLength(12);
  });

  it("rejects unsafe schemas before AJV and enforces case/step budgets", async () => {
    const fixture = await loadManualFixtureInputs();
    const unsafeCatalog = jsonClone(fixture.catalogInput) as {
      tools: Array<{ inputSchema: Record<string, unknown> }>;
    };
    unsafeCatalog.tools[0]!.inputSchema = {
      type: "object",
      patternProperties: { "^(a+)+$": { type: "string" } },
    };
    const unsafeClaims = jsonClone(fixture.claimProfile);
    unsafeClaims.catalog = computeCatalogIdentity(unsafeCatalog).identity;
    const unsafeSpec = jsonClone(fixture.auditSpec);
    unsafeSpec.claimProfileDigest = digestCanonicalJson(
      "forge.claim-profile",
      "v2",
      unsafeClaims,
    );
    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        catalog: unsafeCatalog,
        claimProfile: unsafeClaims,
        auditSpec: unsafeSpec,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema_unsupported" }));

    const boundedSpec = jsonClone(fixture.auditSpec);
    boundedSpec.executionBounds.maxTotalSteps = 2;
    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        auditSpec: boundedSpec,
      }),
    ).toThrowError(V2CompileError);
  });

  it("caps expanded validation work before compiling an unrepresentable plan", async () => {
    const fixture = await loadManualFixtureInputs();
    const policy = jsonClone(fixture.policy);
    for (const rule of policy.experimentDispatchRules.rules) {
      rule.limits.maxCases = 192;
      rule.limits.maxSteps = 5_000;
    }
    const spec = jsonClone(fixture.auditSpec);
    spec.policyDigest = digestCanonicalJson(
      "forge.audit-policy",
      "v2",
      policy,
    );
    spec.repetitions = 64;
    spec.mandatoryCaseReservation = 128;
    spec.executionBounds.maxCases = 192;
    spec.executionBounds.maxStepsPerCase = 64;
    spec.executionBounds.maxTotalSteps = 5_000;
    spec.executionBounds.maxWritableFiles = 192;
    spec.executionBounds.maxWritableBytes = 16 * 1_024 * 1_024;
    spec.manualCases[0]!.kind = "security_probe";
    spec.manualCases[0]!.steps = Array.from({ length: 64 }, (_, index) => ({
      ...spec.manualCases[0]!.steps[0]!,
      stepId: `large-step-${index}`,
    }));

    expect(
      spec.manualCases[0]!.steps.length * spec.repetitions +
        fixture.mandatoryCases.length * spec.repetitions,
    ).toBeGreaterThan(PHASE1_COMPILER_WORK_LIMITS.maxExpandedSteps);
    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        policy,
        auditSpec: spec,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "bounds_exceeded",
        message: expect.stringContaining("step bounds"),
      }),
    );
  });

  it("rejects excessive policy predicate work before step evaluation", async () => {
    const fixture = await loadManualFixtureInputs();
    const policy = jsonClone(fixture.policy);
    const template = policy.experimentDispatchRules.rules.find(
      (rule) => rule.ruleId === "dispatch-ordinary-read",
    )!;
    policy.experimentDispatchRules.rules = Array.from(
      { length: 130 },
      (_, ruleIndex) => ({
        ...template,
        ruleId: `bounded-policy-${ruleIndex}`,
        argumentRules: Array.from({ length: 64 }, () => ({
          jsonPointer: "/path",
          operator: "string_prefix" as const,
          prefix: "/forge/synthetic/",
        })),
        limits: {
          ...template.limits,
          maxCases: 12,
          maxSteps: 12,
        },
      }),
    );
    const spec = jsonClone(fixture.auditSpec);
    spec.policyDigest = digestCanonicalJson(
      "forge.audit-policy",
      "v2",
      policy,
    );
    spec.repetitions = 4;
    spec.mandatoryCaseReservation = 8;
    spec.executionBounds.maxCases = 12;
    spec.executionBounds.maxTotalSteps = 12;
    spec.executionBounds.maxWritableFiles = 12;
    spec.executionBounds.maxWritableBytes = 1_048_576;

    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        policy,
        auditSpec: spec,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "bounds_exceeded",
        message: expect.stringContaining("policy-evaluation work budget"),
      }),
    );
  });

  it("caps repeated near-limit argument bytes incrementally", async () => {
    const fixture = await loadManualFixtureInputs();
    const catalogInput = jsonClone(fixture.catalogInput) as {
      tools: Array<{
        inputSchema: {
          properties: Record<string, unknown>;
        };
      }>;
    };
    catalogInput.tools[0]!.inputSchema.properties["label"] = {
      type: "string",
    };
    const catalog = computeCatalogIdentity(catalogInput);
    const claims = jsonClone(fixture.claimProfile);
    claims.catalog = catalog.identity;
    const policy = jsonClone(fixture.policy);
    for (const rule of policy.experimentDispatchRules.rules) {
      rule.limits.maxCases = 192;
      rule.limits.maxSteps = 192;
      rule.limits.maxWritableFiles = 192;
      rule.limits.maxWritableBytes = 16 * 1_024 * 1_024;
      if (!rule.allowedResourceClasses.includes("unknown")) {
        rule.allowedResourceClasses.push("unknown");
      }
    }
    const spec = jsonClone(fixture.auditSpec);
    spec.claimProfileDigest = digestCanonicalJson(
      "forge.claim-profile",
      "v2",
      claims,
    );
    spec.policyDigest = digestCanonicalJson(
      "forge.audit-policy",
      "v2",
      policy,
    );
    spec.repetitions = 64;
    spec.mandatoryCaseReservation = 128;
    spec.executionBounds.maxCases = 192;
    spec.executionBounds.maxTotalSteps = 192;
    spec.executionBounds.maxWritableFiles = 192;
    spec.executionBounds.maxWritableBytes = 16 * 1_024 * 1_024;
    spec.manualCases[0]!.steps[0]!.arguments = {
      path: { $forgeResource: "profile.document" },
      label: "x".repeat(40_000),
    };

    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        catalog: catalogInput,
        claimProfile: claims,
        policy,
        auditSpec: spec,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "bounds_exceeded",
        message: expect.stringContaining("aggregate compiler work budget"),
      }),
    );
  });

  it("rejects post-binding policy or claim substitution", async () => {
    const fixture = await loadManualFixtureInputs();
    const policy = jsonClone(fixture.policy);
    policy.owner = "substituted-owner";
    expect(() =>
      compileExperimentPlan({ ...fixture.compileInput, policy }),
    ).toThrowError(expect.objectContaining({ code: "digest_mismatch" }));

    const claims = jsonClone(fixture.claimProfile);
    claims.limitations = ["mutated after AuditSpec binding"];
    expect(() =>
      compileExperimentPlan({ ...fixture.compileInput, claimProfile: claims }),
    ).toThrowError(expect.objectContaining({ code: "digest_mismatch" }));
  });

  it("verifies claim evidence source digests after top-level rebinding", async () => {
    const fixture = await loadManualFixtureInputs();
    const claims = jsonClone(fixture.claimProfile);
    claims.claims[0]!.evidence[0]!.sourceDigest = "0".repeat(64);
    const spec = jsonClone(fixture.auditSpec);
    spec.claimProfileDigest = digestCanonicalJson(
      "forge.claim-profile",
      "v2",
      claims,
    );

    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        claimProfile: claims,
        auditSpec: spec,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "digest_mismatch",
        message: expect.stringContaining("claim evidence digest"),
      }),
    );
  });

  it("hashes each exact catalog evidence source only once", async () => {
    const fixture = await loadManualFixtureInputs();
    const claims = jsonClone(fixture.claimProfile);
    claims.claims.push({
      ...jsonClone(claims.claims[0]!),
      claimId: "second-claim-same-source",
    });
    const metrics = validateClaimEvidenceBindings(
      claims,
      computeCatalogIdentity(fixture.catalogInput),
    );

    expect(metrics).toEqual({ evidenceRows: 2, digestComputations: 1 });
  });

  it("binds exact-target policy to runtime identity, not only targetId", async () => {
    const fixture = await loadManualFixtureInputs();
    const runtimeDescriptor = {
      ...fixture.runtimeDescriptor,
      args: ["alternate-server.js"],
    };
    const identity = {
      ...fixture.target,
      runtimeDescriptorDigest: digestCanonicalJson(
        "forge.runtime-descriptor",
        "v2",
        runtimeDescriptor,
      ),
    };

    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        target: {
          ...fixture.compileInput.target,
          identity,
          runtimeDescriptor,
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "policy_missing",
        message: expect.stringContaining("exact target identity"),
      }),
    );
  });

  it("applies maxArgumentBytes before resource aliases can shrink", async () => {
    const fixture = await loadManualFixtureInputs();
    const alias = `resource.${"a".repeat(100)}`;
    const spec = jsonClone(fixture.auditSpec);
    spec.executionBounds.maxArgumentBytes = 100;
    spec.syntheticResources.push({
      ...spec.syntheticResources[0]!,
      alias,
    });
    spec.manualCases[0]!.steps[0]!.arguments = {
      path: { $forgeResource: alias },
    };
    expect(
      JSON.stringify(spec.manualCases[0]!.steps[0]!.arguments).length,
    ).toBeGreaterThan(spec.executionBounds.maxArgumentBytes);

    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        auditSpec: spec,
      }),
    ).toThrow("serialized_byte_limit");
  });

  it("keeps matching deny rules dominant when their limits are exceeded", async () => {
    const fixture = await loadManualFixtureInputs();
    const policy = jsonClone(fixture.policy);
    const ordinaryAllow = policy.experimentDispatchRules.rules.find(
      (rule) => rule.ruleId === "dispatch-ordinary-read",
    )!;
    policy.experimentDispatchRules.rules.unshift({
      ...ordinaryAllow,
      ruleId: "deny-ordinary-even-over-limit",
      decision: "deny",
      limits: {
        ...ordinaryAllow.limits,
        maxCases: 1,
        maxStepsPerCase: 1,
        maxSteps: 1,
      },
      minimumApprovalClass: "automatic",
    });
    const spec = jsonClone(fixture.auditSpec);
    spec.policyDigest = digestCanonicalJson(
      "forge.audit-policy",
      "v2",
      policy,
    );

    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        policy,
        auditSpec: spec,
      }),
    ).toThrowError(expect.objectContaining({ code: "policy_denied" }));
  });

  it("does not let an unsatisfied approval gate fall through to allow", async () => {
    const fixture = await loadManualFixtureInputs();

    for (const unsupported of ["limits", "data_flow"] as const) {
      const policy = jsonClone(fixture.policy);
      const ordinaryAllow = policy.experimentDispatchRules.rules.find(
        (rule) => rule.ruleId === "dispatch-ordinary-read",
      )!;
      policy.experimentDispatchRules.rules.unshift({
        ...ordinaryAllow,
        ruleId: `review-ordinary-${unsupported}`,
        decision: "approval_required",
        allowedDataFlows:
          unsupported === "data_flow"
            ? [
                {
                  source: "ordinary_synthetic_file",
                  sinkAction: "send",
                  sink: "network_endpoint",
                },
              ]
            : [],
        limits: {
          ...ordinaryAllow.limits,
          maxCases:
            unsupported === "limits" ? 1 : ordinaryAllow.limits.maxCases,
        },
        minimumApprovalClass: "operator_review",
      });
      const spec = jsonClone(fixture.auditSpec);
      spec.policyDigest = digestCanonicalJson(
        "forge.audit-policy",
        "v2",
        policy,
      );

      expect(() =>
        compileExperimentPlan({
          ...fixture.compileInput,
          policy,
          auditSpec: spec,
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "policy_denied",
          message: expect.stringContaining("cannot be satisfied"),
        }),
      );
    }
  });

  it("requires dispatch policy to bound every receipt execution dimension", async () => {
    const fixture = await loadManualFixtureInputs();
    const fields = Object.keys(
      fixture.auditSpec.executionBounds,
    ) as Array<keyof typeof fixture.auditSpec.executionBounds>;

    for (const field of fields) {
      const spec = jsonClone(fixture.auditSpec);
      spec.executionBounds[field] += 1;
      expect(() =>
        compileExperimentPlan({
          ...fixture.compileInput,
          auditSpec: spec,
        }),
      ).toThrowError(expect.objectContaining({ code: "policy_denied" }));
    }
  });

  it("does not let extra resource classes pad around a deny or review gate", async () => {
    const fixture = await loadManualFixtureInputs();
    const baseInput = {
      toolName: "read_document",
      origin: "mandatory" as const,
      arguments: { path: "/forge/synthetic/resource-test" },
      resourceClasses: [
        "synthetic_credential",
        "ordinary_synthetic_file",
      ] as const,
      planCaseCount: 3,
      planStepCount: 3,
      argumentBytes: 48,
      requestedRuntimeMs: 5_000,
      executionBounds: fixture.auditSpec.executionBounds,
    };

    expect(evaluateExperimentDispatch(fixture.policy, baseInput)).toBe(
      "security_review",
    );

    expect(() =>
      evaluateExperimentDispatch(fixture.policy, {
        ...baseInput,
        resourceClasses: [
          "synthetic_credential",
          "network_endpoint",
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "policy_denied" }));

    const policy = jsonClone(fixture.policy);
    const sensitiveRule = policy.experimentDispatchRules.rules.find(
      (rule) => rule.ruleId === "dispatch-sensitive-probe",
    )!;
    policy.experimentDispatchRules.rules.unshift({
      ...sensitiveRule,
      ruleId: "deny-sensitive-overlap",
      decision: "deny",
      minimumApprovalClass: "automatic",
    });
    expect(() => evaluateExperimentDispatch(policy, baseInput)).toThrowError(
      expect.objectContaining({ code: "policy_denied" }),
    );
  });

  it("snapshots and freezes prepared dispatch authority", async () => {
    const fixture = await loadManualFixtureInputs();
    const mutablePolicy = jsonClone(fixture.policy);
    const prepared = prepareExperimentDispatchPolicy(mutablePolicy);
    const sensitiveRule = mutablePolicy.experimentDispatchRules.rules.find(
      (rule) => rule.ruleId === "dispatch-sensitive-probe",
    )!;
    sensitiveRule.allowedResourceClasses.push("network_endpoint");

    expect(Object.isFrozen(prepared.rules)).toBe(true);
    expect(
      Object.isFrozen(prepared.rules[0]!.rule.allowedResourceClasses),
    ).toBe(true);
    expect(() =>
      evaluatePreparedExperimentDispatch(
        prepared,
        {
          toolName: "read_document",
          origin: "mandatory",
          arguments: { path: "/forge/synthetic/resource-test" },
          resourceClasses: ["synthetic_credential", "network_endpoint"],
          planCaseCount: 3,
          planStepCount: 3,
          argumentBytes: 48,
          requestedRuntimeMs: 5_000,
          executionBounds: fixture.auditSpec.executionBounds,
        },
        createPolicyEvaluationWorkTracker(),
      ),
    ).toThrowError(expect.objectContaining({ code: "policy_denied" }));
  });

  it("enforces pre-plan catalog/artifact limits and policy-required sensors", async () => {
    const fixture = await loadManualFixtureInputs();
    const catalogBound = jsonClone(fixture.auditSpec);
    catalogBound.prePlanBounds.maxCatalogBytes = 1;
    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        auditSpec: catalogBound,
      }),
    ).toThrowError(expect.objectContaining({ code: "bounds_exceeded" }));

    const artifactBound = jsonClone(fixture.auditSpec);
    artifactBound.prePlanBounds.maxArtifactBytes = 1;
    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        auditSpec: artifactBound,
      }),
    ).toThrowError(expect.objectContaining({ code: "bounds_exceeded" }));

    const missingSensor = jsonClone(fixture.auditSpec);
    missingSensor.requiredSensors = ["filesystem", "mcp_transcript"];
    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        auditSpec: missingSensor,
      }),
    ).toThrowError(expect.objectContaining({ code: "policy_missing" }));
  });

  it("rejects ghost claims and compilation before trusted inputs exist", async () => {
    const fixture = await loadManualFixtureInputs();
    const claims = jsonClone(fixture.claimProfile);
    claims.claims[0]!.toolName = "ghost_tool";
    const spec = jsonClone(fixture.auditSpec);
    spec.claimProfileDigest = digestCanonicalJson(
      "forge.claim-profile",
      "v2",
      claims,
    );
    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        claimProfile: claims,
        auditSpec: spec,
      }),
    ).toThrow("references absent tool");

    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        compiledAt: "2026-08-30T06:40:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "policy_missing" }));
  });

  it("rejects impossible input chronology and non-reject unsupported handling", async () => {
    const fixture = await loadManualFixtureInputs();
    const predatingSpec = jsonClone(fixture.auditSpec);
    predatingSpec.createdAt = "2026-08-30T06:29:00.000Z";
    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        auditSpec: predatingSpec,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "digest_mismatch",
        message: expect.stringContaining("cannot predate"),
      }),
    );

    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        compiledAt: "2026-08-30T07:00:00.0001Z",
      }),
    ).toThrow();

    const inconclusiveSpec = jsonClone(fixture.auditSpec);
    inconclusiveSpec.unsupportedCaseHandling = "record_inconclusive";
    expect(() =>
      compileExperimentPlan({
        ...fixture.compileInput,
        auditSpec: inconclusiveSpec,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema_unsupported" }));
  });
});
