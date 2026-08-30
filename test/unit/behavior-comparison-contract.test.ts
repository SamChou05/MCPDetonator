import { describe, expect, it } from "vitest";

import {
  behaviorComparisonRowV1Schema,
  behaviorComparisonScopeV1Schema,
  behaviorComparisonV1Schema,
} from "../../src/contracts/v1.js";

const capabilities = [
  "filesystem_access",
  "network_access",
  "process_execution",
] as const;

function validRow(
  capability: (typeof capabilities)[number] = "filesystem_access",
) {
  return {
    capability,
    advertisedState: "not_claimed" as const,
    advertisedClaimReferences: [],
    staticState: "not_found" as const,
    staticSignalIds: [],
    runtimeState: "observed" as const,
    runtimeEventIds: ["event-1"],
    correlationBasis: "phase_timing_and_process_origin_inference" as const,
    temporalOverlapEventIds: ["event-1"],
    operatorScopeState: "configured" as const,
    withinOperatorScopeEventIds: ["event-1"],
    outsideOperatorScopeEventIds: [],
    unclassifiedRuntimeEventIds: [],
    interpretation: "Bounded comparison evidence.",
  };
}

function validToolScope(experimentId = "tool-experiment") {
  return {
    experimentId,
    kind: "tool" as const,
    toolName: "inspect_record",
    rows: capabilities.map((capability) => validRow(capability)),
  };
}

describe("behavior comparison contract invariants", () => {
  it.each([
    {
      label: "claim state without a reference",
      row: { ...validRow(), advertisedState: "claimed" },
    },
    {
      label: "static state without a signal",
      row: { ...validRow(), staticState: "found" },
    },
    {
      label: "runtime state without matching IDs",
      row: { ...validRow(), runtimeState: "not_observed" },
    },
    {
      label: "overlap ID outside selected runtime",
      row: { ...validRow(), temporalOverlapEventIds: ["event-other"] },
    },
    {
      label: "overlapping operator partitions",
      row: {
        ...validRow(),
        outsideOperatorScopeEventIds: ["event-1"],
      },
    },
    {
      label: "partition that omits selected runtime",
      row: { ...validRow(), withinOperatorScopeEventIds: [] },
    },
    {
      label: "unclassified event under configured scope",
      row: {
        ...validRow(),
        withinOperatorScopeEventIds: [],
        unclassifiedRuntimeEventIds: ["event-1"],
      },
    },
    {
      label: "classified event without configured scope",
      row: { ...validRow(), operatorScopeState: "not_configured" },
    },
  ])("rejects $label", ({ row }) => {
    expect(behaviorComparisonRowV1Schema.safeParse(row).success).toBe(false);
  });

  it("requires each capability exactly once", () => {
    const scope = validToolScope();
    expect(
      behaviorComparisonScopeV1Schema.safeParse({
        ...scope,
        rows: [scope.rows[0], scope.rows[0], scope.rows[1]],
      }).success,
    ).toBe(false);
  });

  it("keeps initialization and tool metadata mutually consistent", () => {
    const tool = validToolScope();
    expect(
      behaviorComparisonScopeV1Schema.safeParse({ ...tool, toolName: undefined })
        .success,
    ).toBe(false);
    expect(
      behaviorComparisonScopeV1Schema.safeParse({
        ...tool,
        kind: "initialization",
      }).success,
    ).toBe(false);

    const initialization = {
      experimentId: "baseline-initialization",
      kind: "initialization" as const,
      rows: capabilities.map((capability) => ({
        ...validRow(capability),
        advertisedState: "not_applicable" as const,
      })),
    };
    expect(behaviorComparisonScopeV1Schema.safeParse(initialization).success).toBe(
      true,
    );
    expect(
      behaviorComparisonScopeV1Schema.safeParse({
        ...initialization,
        toolName: "not-valid-for-initialization",
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate experiment scopes", () => {
    const scope = validToolScope();
    expect(
      behaviorComparisonV1Schema.safeParse({
        scopes: [scope, scope],
        limitations: [],
      }).success,
    ).toBe(false);
  });
});
