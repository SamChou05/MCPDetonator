import { describe, expect, it } from "vitest";

import { createEnrolledSingleCallExperiment } from "../../src/audit/v2/enrolled-experiment.js";

function catalog(toolName = "transform_value") {
  return {
    protocolVersion: "2025-06-18",
    server: { name: "unfamiliar-test-server", version: "7.4.2" },
    acquisition: {
      complete: true,
      pageCount: 1 as const,
      listChangedDuringDiscovery: false,
    },
    tools: [
      {
        name: toolName,
        description: "Return a deterministic transformation of one value.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string", maxLength: 128 } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    ],
  };
}

function build(overrides: Partial<Parameters<typeof createEnrolledSingleCallExperiment>[0]> = {}) {
  return createEnrolledSingleCallExperiment({
    identityPrefix: "blind-alpha",
    targetId: "unfamiliar-target",
    sourceEvidence: {
      format: "test-source/v1",
      requested: { package: "example-mcp", version: "1.2.3" },
    },
    runtimeSnapshotEvidence: {
      format: "forge.prepared-runtime-tree/v1alpha1",
      sha256: "a".repeat(64),
      fileCount: 8,
    },
    runtimeDescriptor: {
      transport: "stdio",
      protocol: "mcp",
      command: "node",
      args: ["/opt/target/node_modules/example-mcp/dist/index.js"],
      cwd: "/opt/target",
      environment: {},
    },
    catalog: catalog(),
    toolName: "transform_value",
    arguments: { value: "synthetic probe" },
    createdAt: "2026-08-30T20:00:00.000Z",
    reviewedAt: "2026-08-30T20:01:00.000Z",
    expiresAt: "2026-08-30T20:06:00.000Z",
    ...overrides,
  });
}

describe("enrolled single-call experiment compiler", () => {
  it("compiles an arbitrary discovered tool without package or tool allowlists", () => {
    const result = build();
    const experimentCase = result.compiled.plan.cases[0];

    expect(experimentCase).toMatchObject({
      origin: "mandatory",
      requiredApprovalClass: "operator_review",
      steps: [
        {
          toolName: "transform_value",
          arguments: { value: "synthetic probe" },
        },
      ],
    });
    expect(result.compiled.plan.requiredSensors).toEqual([
      "process",
      "filesystem",
      "network",
      "mcp_transcript",
      "cleanup",
    ]);
    expect(result.claimProfile.unsupportedDimensions).toContain(
      "Filesystem, process, and network behavior are not assessed by the result-channel-only alpha.",
    );
  });

  it("binds target, runtime, catalog, policy, and exact argument semantics", () => {
    const first = build();
    const changedArguments = build({ arguments: { value: "different" } });
    const changedRuntime = build({
      runtimeDescriptor: {
        transport: "stdio",
        protocol: "mcp",
        command: "node",
        args: ["/opt/target/node_modules/example-mcp/other.js"],
        cwd: "/opt/target",
        environment: {},
      },
    });

    expect(changedArguments.compiled.experimentPlanDigest).not.toBe(
      first.compiled.experimentPlanDigest,
    );
    expect(changedRuntime.compiled.experimentPlanDigest).not.toBe(
      first.compiled.experimentPlanDigest,
    );
  });

  it("fails closed for a missing tool, invalid arguments, or incomplete catalog", () => {
    expect(() => build({ toolName: "absent" })).toThrow(/unknown tool/u);
    expect(() => build({ arguments: { value: 3 } })).toThrow(
      /arguments do not satisfy/u,
    );
    expect(() =>
      build({
        catalog: {
          ...catalog(),
          acquisition: {
            complete: false,
            pageCount: 1,
            listChangedDuringDiscovery: false,
          },
        },
      }),
    ).toThrow(/catalog/u);
  });
});
