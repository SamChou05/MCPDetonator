import { describe, expect, it } from "vitest";

import type { McpInterfaceV1 } from "../../src/contracts/v1.js";
import {
  extractMcpAdvertisedClaims,
  extractMcpInterfaceClaims,
  mcpAdvertisedClaimsV1Schema,
  noBoundedClaimInterpretation,
} from "../../src/mcp/interface-claims.js";

function mcpInterface(
  tools: McpInterfaceV1["tools"],
  overrides: Partial<Pick<McpInterfaceV1, "runId" | "experimentId">> = {},
): McpInterfaceV1 {
  return {
    schema: "forge.mcp-interface/v1",
    runId: overrides.runId ?? "run-claims",
    experimentId: overrides.experimentId ?? "tool-interface",
    server: { name: "claim-fixture", version: "1.0.0" },
    tools,
  };
}

function assessment(
  analysis: ReturnType<typeof extractMcpInterfaceClaims>,
  toolIndex: number,
  capability:
    | "filesystem_access"
    | "network_access"
    | "process_execution",
) {
  const found = analysis.capabilityAssessments.find(
    (candidate) =>
      candidate.toolIndex === toolIndex && candidate.capability === capability,
  );
  if (found === undefined) {
    throw new Error(`missing ${capability} assessment for tool ${toolIndex}`);
  }
  return found;
}

describe("MCP interface claim extraction", () => {
  it("keeps the deceptive fixture's positive file claim without reversing explicit denials", () => {
    const analysis = extractMcpInterfaceClaims(
      mcpInterface([
        {
          name: "summarize_file",
          title: "Summarize a workspace document",
          description:
            "Reads and summarizes only the workspace document supplied in path. It does not access credentials, launch programs, or use the network.",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Absolute path to one document in the workspace",
              },
            },
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          },
        },
      ]),
    );

    const filesystem = assessment(analysis, 0, "filesystem_access");
    expect(filesystem.status).toBe("claim_identified");
    expect(filesystem.evidence.map((item) => item.basis)).toEqual([
      "name",
      "title",
      "description",
      "schema",
      "schema",
    ]);
    expect(filesystem.evidence.map((item) => item.pointer)).toContain(
      "/tools/0/inputSchema/properties/path",
    );
    expect(assessment(analysis, 0, "network_access")).toMatchObject({
      status: "no_bounded_claim_identified",
      evidence: [],
    });
    expect(assessment(analysis, 0, "process_execution")).toMatchObject({
      status: "no_bounded_claim_identified",
      evidence: [],
    });
    expect(analysis.annotations).toEqual([
      {
        evidenceId:
          "mcp-annotation:run-claims:tool-interface:0:readOnlyHint",
        experimentId: "tool-interface",
        toolIndex: 0,
        toolName: "summarize_file",
        annotation: "readOnlyHint",
        value: true,
        basis: "annotation",
        pointer: "/tools/0/annotations/readOnlyHint",
      },
      {
        evidenceId:
          "mcp-annotation:run-claims:tool-interface:0:destructiveHint",
        experimentId: "tool-interface",
        toolIndex: 0,
        toolName: "summarize_file",
        annotation: "destructiveHint",
        value: false,
        basis: "annotation",
        pointer: "/tools/0/annotations/destructiveHint",
      },
      {
        evidenceId:
          "mcp-annotation:run-claims:tool-interface:0:openWorldHint",
        experimentId: "tool-interface",
        toolIndex: 0,
        toolName: "summarize_file",
        annotation: "openWorldHint",
        value: false,
        basis: "annotation",
        pointer: "/tools/0/annotations/openWorldHint",
      },
    ]);
  });

  it("finds mixed positive signals with exact field and schema pointers", () => {
    const analysis = extractMcpInterfaceClaims(
      mcpInterface([
        {
          name: "sync_endpoint",
          title: "Run a shell command",
          description: "Writes results into a local directory.",
          inputSchema: {
            type: "object",
            properties: {
              target: { type: "string", format: "uri" },
            },
          },
        },
      ]),
    );

    expect(assessment(analysis, 0, "filesystem_access")).toMatchObject({
      status: "claim_identified",
      evidence: [
        {
          basis: "description",
          pointer: "/tools/0/description",
          source: "field_value",
        },
      ],
    });
    expect(assessment(analysis, 0, "network_access")).toMatchObject({
      status: "claim_identified",
      evidence: [
        {
          basis: "name",
          pointer: "/tools/0/name",
        },
        {
          basis: "schema",
          pointer: "/tools/0/inputSchema/properties/target/format",
          matchedTerms: ["uri"],
        },
      ],
    });
    expect(assessment(analysis, 0, "process_execution")).toMatchObject({
      status: "claim_identified",
      evidence: [
        {
          basis: "title",
          pointer: "/tools/0/title",
        },
      ],
    });
  });

  it("does not infer capabilities from misleading substrings, denials, dialect metadata, or openWorldHint", () => {
    const analysis = extractMcpInterfaceClaims(
      mcpInterface([
        {
          name: "profile_commandment",
          title: "Summarize a record",
          description:
            "Never runs shell commands and cannot use the internet or any file path.",
          inputSchema: {
            $schema: "http://json-schema.org/draft-07/schema#",
            $id: "https://example.invalid/schemas/profile.json",
            type: "object",
            properties: {
              profile: { type: "string" },
              networklessMode: { type: "boolean" },
            },
          },
          annotations: { openWorldHint: true },
        },
      ]),
    );

    expect(
      analysis.capabilityAssessments.map(({ capability, status, evidence }) => ({
        capability,
        status,
        evidence,
      })),
    ).toEqual([
      {
        capability: "filesystem_access",
        status: "no_bounded_claim_identified",
        evidence: [],
      },
      {
        capability: "network_access",
        status: "no_bounded_claim_identified",
        evidence: [],
      },
      {
        capability: "process_execution",
        status: "no_bounded_claim_identified",
        evidence: [],
      },
    ]);
    expect(analysis.annotations).toMatchObject([
      {
        annotation: "openWorldHint",
        value: true,
        basis: "annotation",
      },
    ]);
  });

  it("normalizes straight and curly negative contractions before classifying claims", () => {
    const analysis = extractMcpInterfaceClaims(
      mcpInterface([
        {
          name: "inspect_record",
          description:
            "It can't call a webhook. It can’t use the network. It won't launch programs. It won’t access a file path.",
          inputSchema: { type: "object" },
        },
      ]),
    );

    expect(
      analysis.capabilityAssessments.map(({ capability, status, evidence }) => ({
        capability,
        status,
        evidence,
      })),
    ).toEqual([
      {
        capability: "filesystem_access",
        status: "no_bounded_claim_identified",
        evidence: [],
      },
      {
        capability: "network_access",
        status: "no_bounded_claim_identified",
        evidence: [],
      },
      {
        capability: "process_execution",
        status: "no_bounded_claim_identified",
        evidence: [],
      },
    ]);
  });

  it("preserves only valid standard booleans and reports malformed standard annotations separately", () => {
    const analysis = extractMcpInterfaceClaims(
      mcpInterface([
        {
          name: "inspect_record",
          inputSchema: { type: "object" },
          annotations: {
            readOnlyHint: "true",
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: null,
            customHint: "preserved only in the raw interface",
          },
        },
        {
          name: "inspect_other_record",
          inputSchema: { type: "object" },
          annotations: ["readOnlyHint"],
        },
      ]),
    );

    expect(
      analysis.annotations.map(({ toolIndex, annotation, value }) => ({
        toolIndex,
        annotation,
        value,
      })),
    ).toEqual([
      { toolIndex: 0, annotation: "destructiveHint", value: true },
      { toolIndex: 0, annotation: "idempotentHint", value: false },
    ]);
    expect(analysis.annotationIssues).toMatchObject([
      {
        toolIndex: 0,
        annotation: "readOnlyHint",
        pointer: "/tools/0/annotations/readOnlyHint",
        reason: "annotation_not_boolean",
      },
      {
        toolIndex: 0,
        annotation: "openWorldHint",
        pointer: "/tools/0/annotations/openWorldHint",
        reason: "annotation_not_boolean",
      },
      {
        toolIndex: 1,
        pointer: "/tools/1/annotations",
        reason: "annotations_not_object",
      },
    ]);
  });

  it("bounds huge and deep schemas without promoting content outside the examined window", () => {
    let deep: McpInterfaceV1["tools"][number]["inputSchema"] = {
      description: "Runs a shell command",
    };
    for (let index = 0; index < 12; index += 1) {
      deep = { nested: deep };
    }
    const wide = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `field${String(index).padStart(2, "0")}`,
        { type: "string" },
      ]),
    );

    const analysis = extractMcpInterfaceClaims(
      mcpInterface([
        {
          name: "deep_schema",
          description: `${"x".repeat(80)} network`,
          inputSchema: {
            nested: deep,
            [`${"oversized".repeat(8)}File`]: "file",
          },
        },
        {
          name: "wide_schema",
          inputSchema: { properties: wide },
        },
      ]),
      {
        maxFieldCharacters: 32,
        maxSchemaDepth: 2,
        maxSchemaNodesPerTool: 12,
        maxSchemaTextCharactersPerTool: 1_024,
        maxSchemaKeyCharacters: 16,
        maxExcerptCharacters: 24,
        maxTruncationsPerInterface: 20,
      },
    );

    expect(
      analysis.capabilityAssessments.every(
        (item) => item.status === "no_bounded_claim_identified",
      ),
    ).toBe(true);
    expect(new Set(analysis.coverage.truncations.map((item) => item.reason))).toEqual(
      new Set([
        "field_character_limit",
        "schema_depth_limit",
        "schema_key_character_limit",
        "schema_node_limit",
      ]),
    );
    expect(analysis.coverage.schemaNodesVisited).toBeLessThanOrEqual(24);
    expect(analysis.coverage.schemaTextCharactersExamined).toBeLessThanOrEqual(
      2_048,
    );
    expect(
      analysis.capabilityAssessments
        .flatMap((item) => item.evidence)
        .every((item) => item.excerpt.length <= 24),
    ).toBe(true);
  });

  it("keeps complete prefix tokens without manufacturing a trailing partial-token claim", () => {
    const analysis = extractMcpInterfaceClaims(
      mcpInterface([
        {
          name: "inspect",
          description: "File commandment",
          inputSchema: { type: "object" },
        },
      ]),
      { maxFieldCharacters: 12 },
    );

    expect(assessment(analysis, 0, "filesystem_access")).toMatchObject({
      status: "claim_identified",
      evidence: [
        {
          basis: "description",
          pointer: "/tools/0/description",
          matchedTerms: ["file"],
        },
      ],
    });
    expect(assessment(analysis, 0, "process_execution")).toMatchObject({
      status: "no_bounded_claim_identified",
      evidence: [],
    });
    expect(analysis.coverage.truncations).toContainEqual(
      expect.objectContaining({
        pointer: "/tools/0/description",
        reason: "field_character_limit",
        limit: 12,
      }),
    );
  });

  it("omits an over-wide schema object before selection so key order cannot change evidence", () => {
    const entries: [string, McpInterfaceV1["tools"][number]["inputSchema"]][] = [
      [
        "filePath",
        {
          description:
            "A file path that also launches a shell command for a network URL",
        },
      ],
      ...Array.from({ length: 12 }, (_, index) => [
        `field${String(index).padStart(2, "0")}`,
        { type: "string" },
      ] as [string, McpInterfaceV1["tools"][number]["inputSchema"]]),
    ];
    const analyze = (
      orderedEntries: typeof entries,
    ): ReturnType<typeof extractMcpInterfaceClaims> =>
      extractMcpInterfaceClaims(
        mcpInterface([
          {
            name: "inspect_record",
            inputSchema: {
              properties: Object.fromEntries(orderedEntries),
            },
          },
        ]),
        { maxSchemaNodesPerTool: 4 },
      );

    const forward = analyze(entries);
    const reverse = analyze([...entries].reverse());

    expect(reverse).toEqual(forward);
    expect(
      forward.capabilityAssessments.every(
        (item) => item.status === "no_bounded_claim_identified",
      ),
    ).toBe(true);
    expect(forward.coverage).toMatchObject({
      schemaNodesVisited: 2,
      schemaTextCharactersExamined: 0,
      truncations: [
        {
          experimentId: "tool-interface",
          toolIndex: 0,
          toolName: "inspect_record",
          pointer: "/tools/0/inputSchema/properties",
          reason: "schema_node_limit",
          limit: 4,
        },
      ],
      truncationsOmitted: 0,
    });
  });

  it("keeps every declared matched term inside its bounded evidence excerpt", () => {
    const analysis = extractMcpInterfaceClaims(
      mcpInterface([
        {
          name: "inspect_record",
          description: `Profiles come before a file ${"x".repeat(80)} path. Then inspect a directory.`,
          inputSchema: { type: "object" },
        },
      ]),
      { maxExcerptCharacters: 24 },
    );
    const evidence = assessment(
      analysis,
      0,
      "filesystem_access",
    ).evidence.filter((item) => item.basis === "description");

    expect(evidence).toHaveLength(3);
    expect(
      [...new Set(evidence.flatMap((item) => item.matchedTerms))].sort(),
    ).toEqual(["directory", "file", "path"]);
    for (const item of evidence) {
      expect(item.excerpt.length).toBeLessThanOrEqual(24);
      for (const term of item.matchedTerms) {
        expect(item.excerpt.toLowerCase()).toContain(term);
      }
    }
  });

  it("keeps ordering and deduplication stable and describes empty results without treating them as denials", () => {
    const source = mcpInterface([
      {
        name: "inspect_record",
        description: "File file FILE path path.",
        inputSchema: {
          type: "object",
          properties: {
            zUrl: { type: "string" },
            aFile: { type: "string" },
            "file/path~name": { type: "string" },
          },
        },
      },
      {
        name: "summarize_record",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const first = extractMcpAdvertisedClaims("run-claims", [source]);
    const second = extractMcpAdvertisedClaims("run-claims", [source]);
    expect(second).toEqual(first);
    expect(mcpAdvertisedClaimsV1Schema.parse(first)).toEqual(first);
    expect(first.absenceInterpretation).toBe(noBoundedClaimInterpretation);

    const firstAnalysis = first.interfaces[0];
    if (firstAnalysis === undefined) {
      throw new Error("missing claim analysis");
    }
    const fileAssessment = assessment(firstAnalysis, 0, "filesystem_access");
    expect(fileAssessment.evidence[0]).toMatchObject({
      basis: "description",
      matchedTerms: ["file", "path"],
    });
    expect(fileAssessment.evidence.map((item) => item.pointer)).toContain(
      "/tools/0/inputSchema/properties/file~1path~0name",
    );
    expect(
      firstAnalysis.capabilityAssessments.map(
        ({ toolIndex, capability, status }) => ({
          toolIndex,
          capability,
          status,
        }),
      ),
    ).toEqual([
      { toolIndex: 0, capability: "filesystem_access", status: "claim_identified" },
      { toolIndex: 0, capability: "network_access", status: "claim_identified" },
      {
        toolIndex: 0,
        capability: "process_execution",
        status: "no_bounded_claim_identified",
      },
      {
        toolIndex: 1,
        capability: "filesystem_access",
        status: "no_bounded_claim_identified",
      },
      {
        toolIndex: 1,
        capability: "network_access",
        status: "no_bounded_claim_identified",
      },
      {
        toolIndex: 1,
        capability: "process_execution",
        status: "no_bounded_claim_identified",
      },
    ]);
  });

  it("records a tool-catalog coverage boundary and rejects cross-run aggregation", () => {
    const source = mcpInterface([
      { name: "first_record", inputSchema: { type: "object" } },
      { name: "second_record", inputSchema: { type: "object" } },
    ]);
    const analysis = extractMcpInterfaceClaims(source, { maxTools: 1 });

    expect(analysis).toMatchObject({
      advertisedToolCount: 2,
      analyzedToolCount: 1,
      coverage: {
        truncations: [
          {
            experimentId: "tool-interface",
            pointer: "/tools/1",
            reason: "tool_limit",
            limit: 1,
          },
        ],
      },
    });
    expect(() =>
      extractMcpAdvertisedClaims("different-run", [source]),
    ).toThrow("does not match advertised-claims run");
  });

  it("rejects cross-bound advertised-claim envelope and nested identities", () => {
    const createArtifact = () =>
      extractMcpAdvertisedClaims(
        "run-claims",
        [
          mcpInterface([
            {
              name: "first_tool",
              description: "Reads a file.",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
            {
              name: "second_tool",
              inputSchema: { type: "object" },
            },
            {
              name: "omitted_tool",
              inputSchema: { type: "object" },
            },
          ]),
        ],
        { maxTools: 2 },
      );
    type Artifact = ReturnType<typeof createArtifact>;
    const firstInterface = (artifact: Artifact) => {
      const analysis = artifact.interfaces[0];
      if (analysis === undefined) {
        throw new Error("missing interface claim analysis");
      }
      return analysis;
    };
    const mutations: readonly {
      readonly label: string;
      readonly mutate: (artifact: Artifact) => void;
    }[] = [
      {
        label: "envelope run",
        mutate: (artifact) => {
          artifact.runId = "cross-run";
        },
      },
      {
        label: "interface extraction limits",
        mutate: (artifact) => {
          firstInterface(artifact).limits.maxExcerptCharacters += 1;
        },
      },
      {
        label: "duplicate interface experiment",
        mutate: (artifact) => {
          artifact.interfaces.push(structuredClone(firstInterface(artifact)));
        },
      },
      {
        label: "assessment experiment",
        mutate: (artifact) => {
          firstInterface(artifact).capabilityAssessments[0]!.experimentId =
            "other-experiment";
        },
      },
      {
        label: "assessment tool identity",
        mutate: (artifact) => {
          firstInterface(artifact).capabilityAssessments[0]!.toolName =
            "second_tool";
        },
      },
      {
        label: "assessment capability coverage",
        mutate: (artifact) => {
          firstInterface(artifact).capabilityAssessments.pop();
        },
      },
      {
        label: "claim evidence tool pointer",
        mutate: (artifact) => {
          firstInterface(artifact).capabilityAssessments[0]!.evidence[0]!.pointer =
            "/tools/1/description";
        },
      },
      {
        label: "claim evidence identity",
        mutate: (artifact) => {
          firstInterface(artifact).capabilityAssessments[0]!.evidence[0]!.evidenceId =
            "mcp-claim:cross-run:other:0:filesystem_access:1";
        },
      },
      {
        label: "claim evidence over declared limit",
        mutate: (artifact) => {
          const analysis = firstInterface(artifact);
          const assessment = analysis.capabilityAssessments.find(
            (candidate) => candidate.evidence.length > 0,
          );
          const template = assessment?.evidence[0];
          if (assessment === undefined || template === undefined) {
            throw new Error("fixture lacks claim evidence");
          }
          while (
            assessment.evidence.length <=
            analysis.limits.maxEvidencePerCapability
          ) {
            const position = assessment.evidence.length + 1;
            assessment.evidence.push({
              ...structuredClone(template),
              evidenceId:
                `mcp-claim:${analysis.runId}:${analysis.experimentId}:` +
                `${assessment.toolIndex}:${assessment.capability}:${position}`,
            });
          }
        },
      },
      {
        label: "claim excerpt over declared limit",
        mutate: (artifact) => {
          const analysis = firstInterface(artifact);
          const evidence = analysis.capabilityAssessments.find(
            (candidate) => candidate.evidence.length > 0,
          )?.evidence[0];
          if (evidence === undefined) {
            throw new Error("fixture lacks claim evidence");
          }
          evidence.excerpt = "x".repeat(
            analysis.limits.maxExcerptCharacters + 1,
          );
        },
      },
      {
        label: "annotation tool identity",
        mutate: (artifact) => {
          firstInterface(artifact).annotations[0]!.toolName = "second_tool";
        },
      },
      {
        label: "truncation experiment",
        mutate: (artifact) => {
          firstInterface(artifact).coverage.truncations[0]!.experimentId =
            "other-experiment";
        },
      },
    ];

    expect(mcpAdvertisedClaimsV1Schema.safeParse(createArtifact()).success).toBe(
      true,
    );
    for (const mutation of mutations) {
      const artifact = createArtifact();
      mutation.mutate(artifact);
      expect(
        mcpAdvertisedClaimsV1Schema.safeParse(artifact).success,
        mutation.label,
      ).toBe(false);
    }
  });
});
