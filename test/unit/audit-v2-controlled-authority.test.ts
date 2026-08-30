import { describe, expect, it } from "vitest";

import { computeCatalogIdentity } from "../../src/audit/v2/catalog.js";
import { compileExperimentPlan } from "../../src/audit/v2/compile.js";
import {
  ControlledExecutionAuthorityError,
  createControlledFixtureExecutionAuthority,
  type ControlledExecutionPermit,
} from "../../src/audit/v2/controlled-authority.js";
import { digestCanonicalJson } from "../../src/audit/v2/canonical.js";
import { computeOutputSchemaExpectation } from "../../src/audit/v2/outcome-comparison.js";
import {
  revalidateControlledDispatch,
  type ControlledBackendCapabilities,
  type RevalidateControlledDispatchInput,
} from "../../src/audit/v2/reference-monitor.js";
import {
  outcomeHypothesisV2Schema,
  type ControlledExecutionAuthorizationV2,
  type ExperimentPlanV2,
} from "../../src/contracts/v2/index.js";
import {
  jsonClone,
  loadManualFixtureInputs,
} from "../helpers/evidence-first-v2.js";

const PREPARED_TARGET_TREE_SHA256 = "b".repeat(64);
const OTHER_TARGET_TREE_SHA256 = "c".repeat(64);
const SANDBOX_IMAGE_ID = `sha256:${"d".repeat(64)}`;
const ISSUED_AT = "2026-08-30T07:05:00.000Z";
const CONSUMED_AT = "2026-08-30T07:06:00.000Z";
const CHECKED_AT = "2026-08-30T07:07:00.000Z";
const EXPIRES_AT = "2026-08-30T07:10:00.000Z";

async function buildControlledFixture() {
  const fixture = await loadManualFixtureInputs();
  const compiled = compileExperimentPlan(fixture.compileInput);
  const catalog = computeCatalogIdentity(fixture.catalogInput);
  const experimentCase = compiled.plan.cases.find(
    (candidate) => candidate.origin === "manual",
  );
  const step = experimentCase?.steps[0];
  const tool = catalog.catalog.tools.find(
    (candidate) => candidate.name === step?.toolName,
  );
  if (
    experimentCase === undefined ||
    step === undefined ||
    tool === undefined
  ) {
    throw new Error("manual controlled-fixture step is missing");
  }

  const hypothesis = outcomeHypothesisV2Schema.parse({
    format: "forge.outcome-hypothesis/v1alpha1",
    hypothesisId: "controlled-manual-read-hypothesis",
    createdAt: "2026-08-30T07:02:00.000Z",
    experimentPlanDigest: compiled.experimentPlanDigest,
    catalog: compiled.plan.catalog,
    caseId: experimentCase.caseId,
    stepId: step.stepId,
    toolName: step.toolName,
    source: {
      origin: "operator",
      component: { id: "controlled-test-author", version: "1.0.0" },
      confidence: "high",
      evidenceBasis: [
        {
          kind: "operator_statement",
          reference: "controlled fixture expected result",
        },
      ],
    },
    expected: {
      protocolOutcomes: ["success"],
      shapes: ["json_object"],
      contentClasses: ["structured_data"],
      maxReasonableBytes: 4_096,
      outputSchema: computeOutputSchemaExpectation(tool),
      predictedEffects: experimentCase.predictedEffects,
    },
    limitations: [
      "The controlled test hypothesis is not runtime authorization.",
    ],
    authority: {
      authorizesExecution: false,
      grantsApproval: false,
      declaresSafety: false,
    },
  });
  const targetIdentityDigest = digestCanonicalJson(
    "forge.target-identity",
    "v2",
    compiled.plan.target,
  );

  return {
    fixture,
    compiled,
    experimentCase,
    step,
    hypothesis,
    targetIdentityDigest,
  };
}

type ControlledFixture = Awaited<ReturnType<typeof buildControlledFixture>>;

let controlledFixturePromise: Promise<ControlledFixture> | undefined;

function controlledFixture(): Promise<ControlledFixture> {
  controlledFixturePromise ??= buildControlledFixture();
  return controlledFixturePromise;
}

function authorityFor(context: ControlledFixture) {
  return createControlledFixtureExecutionAuthority({
    controllerId: "controlled-test-controller",
    allowedFixtures: [
      {
        fixtureId: "repository-controlled-manual-fixture",
        targetIdentityDigest: context.targetIdentityDigest,
        preparedTargetTreeSha256: PREPARED_TARGET_TREE_SHA256,
        sandboxImageId: SANDBOX_IMAGE_ID,
        proposalReviewRequired: false,
      },
    ],
  });
}

function issuePermit(
  context: ControlledFixture,
  authority = authorityFor(context),
  overrides: {
    authorizationId?: string;
    approvalClass?: "automatic" | "operator_review" | "security_review";
    fixtureId?: string;
    issuedAt?: string;
    expiresAt?: string;
    preparedTargetTreeSha256?: string;
    sandboxImageId?: string;
  } = {},
) {
  return authority.issueSingleStepPermit({
    authorizationId:
      overrides.authorizationId ?? "controlled-manual-read-authorization",
    issuedAt: overrides.issuedAt ?? ISSUED_AT,
    expiresAt: overrides.expiresAt ?? EXPIRES_AT,
    reviewerId: "controlled-test-reviewer",
    approvalClass: overrides.approvalClass ?? "operator_review",
    compileInput: context.fixture.compileInput,
    envelope: context.compiled,
    hypothesis: context.hypothesis,
    caseId: context.experimentCase.caseId,
    stepId: context.step.stepId,
    fixtureId: overrides.fixtureId ?? "repository-controlled-manual-fixture",
    preparedTargetTreeSha256:
      overrides.preparedTargetTreeSha256 ?? PREPARED_TARGET_TREE_SHA256,
    sandboxImageId: overrides.sandboxImageId ?? SANDBOX_IMAGE_ID,
  });
}

function backendFor(context: ControlledFixture): ControlledBackendCapabilities {
  return {
    executionClass: "controlled_fixture_only",
    network: "none",
    maxCalls: 1,
    maxRetries: 0,
    resultExposure: "local_quarantine_only",
    sandboxImageId: SANDBOX_IMAGE_ID,
    imageHasDeclaredVolumes: false,
    hardMcpMessageBytes: context.compiled.plan.bounds.maxOutputBytesPerStep,
    hardRuntimeMs: context.compiled.plan.bounds.maxCaseRuntimeMs,
    hardWritableBytes: context.compiled.plan.bounds.maxWritableBytes,
    hardWritableFiles: context.compiled.plan.bounds.maxWritableFiles,
    hardFileBytes: context.compiled.plan.bounds.maxFileBytes,
    hardProcesses: context.compiled.plan.bounds.maxProcesses,
    hardMemoryMb: context.compiled.plan.bounds.maxMemoryMb,
    hardCpuMs: context.compiled.plan.bounds.maxCpuMs,
    hardOpenFiles: context.compiled.plan.bounds.maxOpenFiles,
    readonlyTargetMount: true,
    readonlySyntheticResourceMount: true,
    readonlyMessageQueueMount: true,
    writableRootFilesystem: false,
    writableHostBinds: false,
    providerAvailable: false,
    cleanupVerification: true,
  };
}

function expectAuthorityError(
  action: () => unknown,
  code:
    | "invalid_authorization"
    | "sandbox_prerequisites_unmet"
    | "binding_mismatch"
    | "review_insufficient"
    | "expired"
    | "replay",
): ControlledExecutionAuthorityError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ControlledExecutionAuthorityError);
    const authorityError = error as ControlledExecutionAuthorityError;
    expect(authorityError.code).toBe(code);
    return authorityError;
  }
  throw new Error(`expected ControlledExecutionAuthorityError '${code}'`);
}

function issueAndConsume(context: ControlledFixture) {
  const authority = authorityFor(context);
  const issued = issuePermit(context, authority);
  const consumed = authority.consumeSingleStepPermit({
    permit: issued.permit,
    authorization: issued.authorization,
    authorizationDigest: issued.authorizationDigest,
    now: CONSUMED_AT,
  });
  return { authority, issued, consumed };
}

function dispatchInput(
  context: ControlledFixture,
  consumed: ReturnType<typeof issueAndConsume>["consumed"],
): RevalidateControlledDispatchInput {
  return {
    compileInput: context.fixture.compileInput,
    envelope: context.compiled,
    authorization: consumed.authorization,
    consumed,
    liveCatalog: context.fixture.catalogInput,
    currentTargetTreeSha256: PREPARED_TARGET_TREE_SHA256,
    currentSyntheticResourceManifestDigest:
      context.compiled.plan.syntheticResourceManifestDigest,
    toolName: context.step.toolName,
    arguments: context.step.arguments,
    now: CHECKED_AT,
    backend: backendFor(context),
  };
}

describe("controlled V2 execution authority", () => {
  it("requires the exact live capability and rejects copied or forged permits before dispatch", async () => {
    const context = await controlledFixture();
    const authority = authorityFor(context);
    const issued = issuePermit(context, authority);
    const copiedPermit = {
      ...(issued.permit as object),
    } as unknown as ControlledExecutionPermit;
    const forgedPermit = Object.freeze(
      {},
    ) as unknown as ControlledExecutionPermit;
    let simulatedDispatches = 0;

    for (const permit of [copiedPermit, forgedPermit]) {
      expectAuthorityError(() => {
        authority.consumeSingleStepPermit({
          permit,
          authorization: issued.authorization,
          authorizationDigest: issued.authorizationDigest,
          now: CONSUMED_AT,
        });
        simulatedDispatches += 1;
      }, "invalid_authorization");
      expect(simulatedDispatches).toBe(0);
    }

    const mutatedAuthorization = jsonClone(issued.authorization);
    mutatedAuthorization.review.reviewerId = "substituted-reviewer";
    expectAuthorityError(() => {
      authority.consumeSingleStepPermit({
        permit: issued.permit,
        authorization: mutatedAuthorization,
        authorizationDigest: issued.authorizationDigest,
        now: CONSUMED_AT,
      });
      simulatedDispatches += 1;
    }, "binding_mismatch");
    expect(simulatedDispatches).toBe(0);

    const consumed = authority.consumeSingleStepPermit({
      permit: issued.permit,
      authorization: jsonClone(issued.authorization),
      authorizationDigest: issued.authorizationDigest,
      now: CONSUMED_AT,
    });
    simulatedDispatches += 1;
    expect(consumed.authorizationDigest).toBe(issued.authorizationDigest);
    expect(simulatedDispatches).toBe(1);

    expectAuthorityError(() => {
      authority.consumeSingleStepPermit({
        permit: issued.permit,
        authorization: issued.authorization,
        authorizationDigest: issued.authorizationDigest,
        now: CHECKED_AT,
      });
      simulatedDispatches += 1;
    }, "replay");
    expect(simulatedDispatches).toBe(1);
  });

  it("rejects expired permits both at consumption and immediately before dispatch", async () => {
    const context = await controlledFixture();
    const authority = authorityFor(context);
    const expiredBeforeConsumption = issuePermit(context, authority, {
      authorizationId: "expired-before-consumption",
      expiresAt: "2026-08-30T07:06:00.000Z",
    });
    let simulatedDispatches = 0;

    expectAuthorityError(() => {
      authority.consumeSingleStepPermit({
        permit: expiredBeforeConsumption.permit,
        authorization: expiredBeforeConsumption.authorization,
        authorizationDigest: expiredBeforeConsumption.authorizationDigest,
        now: "2026-08-30T07:06:00.000Z",
      });
      simulatedDispatches += 1;
    }, "expired");
    expect(simulatedDispatches).toBe(0);

    const expiresAfterConsumption = issuePermit(context, authority, {
      authorizationId: "expired-before-reference-monitor",
      expiresAt: "2026-08-30T07:07:00.000Z",
    });
    const consumed = authority.consumeSingleStepPermit({
      permit: expiresAfterConsumption.permit,
      authorization: expiresAfterConsumption.authorization,
      authorizationDigest: expiresAfterConsumption.authorizationDigest,
      now: CONSUMED_AT,
    });
    expectAuthorityError(() => {
      revalidateControlledDispatch({
        ...dispatchInput(context, consumed),
        now: "2026-08-30T07:07:00.000Z",
      });
      simulatedDispatches += 1;
    }, "expired");
    expect(simulatedDispatches).toBe(0);
  });

  it("rejects review below the compiled case requirement before dispatch", async () => {
    const context = await controlledFixture();
    let simulatedDispatches = 0;
    expectAuthorityError(() => {
      issuePermit(context, authorityFor(context), {
        approvalClass: "automatic",
      });
      simulatedDispatches += 1;
    }, "review_insufficient");
    expect(simulatedDispatches).toBe(0);
  });

  it("rejects capabilities beyond five minutes and images outside the fixture allowlist", async () => {
    const context = await controlledFixture();
    expectAuthorityError(
      () =>
        issuePermit(context, authorityFor(context), {
          expiresAt: "2026-08-30T07:10:00.001Z",
        }),
      "invalid_authorization",
    );
    expectAuthorityError(
      () =>
        issuePermit(context, authorityFor(context), {
          sandboxImageId: `sha256:${"e".repeat(64)}`,
        }),
      "sandbox_prerequisites_unmet",
    );
  });

  it("rejects a fixture that is absent from the controller-owned allowlist", async () => {
    const context = await controlledFixture();
    const authority = createControlledFixtureExecutionAuthority({
      controllerId: "controlled-test-controller",
      allowedFixtures: [],
    });
    let simulatedDispatches = 0;
    expectAuthorityError(() => {
      issuePermit(context, authority, {
        fixtureId: "unlisted-controlled-fixture",
      });
      simulatedDispatches += 1;
    }, "sandbox_prerequisites_unmet");
    expect(simulatedDispatches).toBe(0);
  });

  it("does not treat a serialized proposal-review record as execution authority", async () => {
    const context = await controlledFixture();
    const authority = createControlledFixtureExecutionAuthority({
      controllerId: "controlled-test-controller",
      allowedFixtures: [
        {
          fixtureId: "repository-controlled-manual-fixture",
          targetIdentityDigest: context.targetIdentityDigest,
          preparedTargetTreeSha256: PREPARED_TARGET_TREE_SHA256,
          sandboxImageId: SANDBOX_IMAGE_ID,
          proposalReviewRequired: true,
        },
      ],
    });
    expectAuthorityError(
      () => issuePermit(context, authority),
      "review_insufficient",
    );
  });
});

describe("controlled V2 reference monitor", () => {
  it("requires the exact live consumed capability and burns it after one check", async () => {
    const context = await controlledFixture();
    const { consumed } = issueAndConsume(context);
    const forged = {
      authorization: consumed.authorization,
      authorizationDigest: consumed.authorizationDigest,
      consumedAt: consumed.consumedAt,
    } as unknown as typeof consumed;

    expectAuthorityError(
      () => revalidateControlledDispatch(dispatchInput(context, forged)),
      "invalid_authorization",
    );
    expect(() =>
      revalidateControlledDispatch(dispatchInput(context, consumed)),
    ).not.toThrow();
    expectAuthorityError(
      () => revalidateControlledDispatch(dispatchInput(context, consumed)),
      "replay",
    );
  });

  it("prepares the exact frozen step before the simulated dispatch", async () => {
    const context = await controlledFixture();
    const { consumed } = issueAndConsume(context);
    let simulatedDispatches = 0;

    const prepared = revalidateControlledDispatch(
      dispatchInput(context, consumed),
    );
    simulatedDispatches += 1;

    expect(prepared).toEqual({
      toolName: context.step.toolName,
      arguments: context.step.arguments,
      argumentSha256: context.step.argumentSha256,
      liveCatalogDigest: context.compiled.plan.catalog.planCatalogDigest,
      checkedAt: CHECKED_AT,
      sequence: 0,
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.arguments)).toBe(true);
    expect(simulatedDispatches).toBe(1);
  });

  it("blocks authorization, plan, policy, catalog, target-tree, tool, and argument drift before dispatch", async () => {
    const context = await controlledFixture();
    const attempts: Array<{
      label: string;
      mutate: (
        input: RevalidateControlledDispatchInput,
      ) => RevalidateControlledDispatchInput;
    }> = [
      {
        label: "authorization",
        mutate: (base) => {
          const authorization = jsonClone(
            base.authorization,
          ) as ControlledExecutionAuthorizationV2;
          authorization.review.reviewerId = "mutated-reviewer";
          return { ...base, authorization };
        },
      },
      {
        label: "plan",
        mutate: (base) => {
          const plan = jsonClone(base.envelope.plan) as ExperimentPlanV2;
          plan.planId = "mutated-controlled-plan";
          return {
            ...base,
            envelope: {
              plan,
              experimentPlanDigest: base.envelope.experimentPlanDigest,
            },
          };
        },
      },
      {
        label: "policy",
        mutate: (base) => {
          const policy = jsonClone(context.fixture.policy);
          policy.owner = "mutated-policy-owner";
          return {
            ...base,
            compileInput: { ...base.compileInput, policy },
          };
        },
      },
      {
        label: "catalog",
        mutate: (base) => {
          const catalog = jsonClone(context.fixture.catalogInput) as {
            tools: Array<{ description?: string }>;
          };
          catalog.tools[0]!.description = "Mutated live tool description.";
          return { ...base, liveCatalog: catalog };
        },
      },
      {
        label: "target tree",
        mutate: (base) => ({
          ...base,
          currentTargetTreeSha256: OTHER_TARGET_TREE_SHA256,
        }),
      },
      {
        label: "synthetic resources",
        mutate: (base) => ({
          ...base,
          currentSyntheticResourceManifestDigest: "e".repeat(64),
        }),
      },
      {
        label: "tool",
        mutate: (base) => ({ ...base, toolName: "substituted_tool" }),
      },
      {
        label: "arguments",
        mutate: (base) => ({
          ...base,
          arguments: { path: "/forge/synthetic/substituted-document" },
        }),
      },
    ];

    for (const attempt of attempts) {
      const { consumed } = issueAndConsume(context);
      const input = attempt.mutate(dispatchInput(context, consumed));
      let simulatedDispatches = 0;
      expect(() => {
        revalidateControlledDispatch(input);
        simulatedDispatches += 1;
      }, attempt.label).toThrow();
      expect(simulatedDispatches, attempt.label).toBe(0);
    }
  });

  it("fails closed when any declared backend capability is insufficient", async () => {
    const context = await controlledFixture();
    const backend = backendFor(context);
    const insufficientBackends: Array<{
      label: string;
      backend: ControlledBackendCapabilities;
    }> = [
      {
        label: "execution class",
        backend: {
          ...backend,
          executionClass: "arbitrary_target",
        } as unknown as ControlledBackendCapabilities,
      },
      {
        label: "network",
        backend: {
          ...backend,
          network: "external",
        } as unknown as ControlledBackendCapabilities,
      },
      {
        label: "call count",
        backend: {
          ...backend,
          maxCalls: 2,
        } as unknown as ControlledBackendCapabilities,
      },
      {
        label: "retry count",
        backend: {
          ...backend,
          maxRetries: 1,
        } as unknown as ControlledBackendCapabilities,
      },
      {
        label: "result exposure",
        backend: {
          ...backend,
          resultExposure: "planner_visible",
        } as unknown as ControlledBackendCapabilities,
      },
      {
        label: "cleanup verification",
        backend: {
          ...backend,
          cleanupVerification: false,
        } as unknown as ControlledBackendCapabilities,
      },
      {
        label: "image identity",
        backend: { ...backend, sandboxImageId: `sha256:${"e".repeat(64)}` },
      },
      {
        label: "declared image volume",
        backend: {
          ...backend,
          imageHasDeclaredVolumes: true,
        } as unknown as ControlledBackendCapabilities,
      },
      {
        label: "target mount",
        backend: {
          ...backend,
          readonlyTargetMount: false,
        } as unknown as ControlledBackendCapabilities,
      },
      {
        label: "resource mount",
        backend: {
          ...backend,
          readonlySyntheticResourceMount: false,
        } as unknown as ControlledBackendCapabilities,
      },
      {
        label: "message-queue mount",
        backend: {
          ...backend,
          readonlyMessageQueueMount: false,
        } as unknown as ControlledBackendCapabilities,
      },
      {
        label: "root filesystem",
        backend: {
          ...backend,
          writableRootFilesystem: true,
        } as unknown as ControlledBackendCapabilities,
      },
      {
        label: "host bind",
        backend: {
          ...backend,
          writableHostBinds: true,
        } as unknown as ControlledBackendCapabilities,
      },
      {
        label: "provider",
        backend: {
          ...backend,
          providerAvailable: true,
        } as unknown as ControlledBackendCapabilities,
      },
      {
        label: "MCP message bound",
        backend: {
          ...backend,
          hardMcpMessageBytes:
            context.compiled.plan.bounds.maxOutputBytesPerStep - 1,
        },
      },
      ...(
        [
          [
            "runtime",
            "hardRuntimeMs",
            context.compiled.plan.bounds.maxCaseRuntimeMs + 1,
          ],
          [
            "writable bytes",
            "hardWritableBytes",
            context.compiled.plan.bounds.maxWritableBytes + 1,
          ],
          [
            "writable files",
            "hardWritableFiles",
            context.compiled.plan.bounds.maxWritableFiles + 1,
          ],
          [
            "file bytes",
            "hardFileBytes",
            context.compiled.plan.bounds.maxFileBytes + 1,
          ],
          [
            "processes",
            "hardProcesses",
            context.compiled.plan.bounds.maxProcesses + 1,
          ],
          [
            "memory",
            "hardMemoryMb",
            context.compiled.plan.bounds.maxMemoryMb + 1,
          ],
          ["CPU", "hardCpuMs", context.compiled.plan.bounds.maxCpuMs + 1],
          [
            "open files",
            "hardOpenFiles",
            context.compiled.plan.bounds.maxOpenFiles + 1,
          ],
        ] as const
      ).map(([label, field, value]) => ({
        label,
        backend: { ...backend, [field]: value },
      })),
    ];

    for (const candidate of insufficientBackends) {
      const { consumed } = issueAndConsume(context);
      const base = dispatchInput(context, consumed);
      let simulatedDispatches = 0;
      expectAuthorityError(() => {
        revalidateControlledDispatch({
          ...base,
          backend: candidate.backend,
        });
        simulatedDispatches += 1;
      }, "sandbox_prerequisites_unmet");
      expect(simulatedDispatches, candidate.label).toBe(0);
    }
  });
});
