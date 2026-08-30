import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  buildDemoRunV1,
  buildDemoExportV1,
  DEMO_EXPORT_DISCLAIMER,
  demoExportV1Schema,
  type DemoExportBuildInput,
  type DemoExportV1,
  type DemoReportInput,
} from "../../src/dashboard/demo-export.js";

const CONTROLLED_SHA256 =
  "45fa8a54cb9b6bf5ede4da2a03bd36e4ada55e8ae9cfcb3cf332171a87ab5411";
const REFERENCE_SHA256 =
  "c1402b752d842d9717067ba4b17ed7aedfa2ba059c6c6eea4299a247ded0a34a";
const CONTROLLED_RUN_ID = "run-20260830181026-efaff1a4";
const REFERENCE_RUN_ID = "run-20260830181057-0a5ff552";
const CONTROLLED_TARGET_ID = "deceptive-document-summarizer";
const REFERENCE_TARGET_ID = "official-filesystem";

let controlledBytes: Uint8Array;
let referenceBytes: Uint8Array;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function controlledInput(
  overrides: Partial<DemoReportInput> = {},
): DemoReportInput {
  return {
    role: "controlled",
    reportBytes: controlledBytes,
    expectedSha256: CONTROLLED_SHA256,
    expectedTargetId: CONTROLLED_TARGET_ID,
    displayName: "Controlled deceptive target",
    description:
      "A synthetic negative control with deliberately unexpected behavior.",
    scopeLabels: [
      {
        experimentId: "baseline-initialization",
        label: "Baseline initialization",
      },
      {
        experimentId: "summarize-file",
        label: "Summarize synthetic document",
      },
    ],
    limitations: [
      "This controlled synthetic target intentionally exercises out-of-scope behavior.",
    ],
    ...overrides,
  };
}

function referenceInput(
  overrides: Partial<DemoReportInput> = {},
): DemoReportInput {
  return {
    role: "reference",
    reportBytes: referenceBytes,
    expectedSha256: REFERENCE_SHA256,
    expectedTargetId: REFERENCE_TARGET_ID,
    displayName: "Official filesystem target",
    description:
      "A pinned reference package exercised with selected synthetic file operations.",
    scopeLabels: [
      {
        experimentId: "baseline-initialization",
        label: "Baseline initialization",
      },
      {
        experimentId: "read-synthetic-report",
        label: "Read synthetic report",
      },
      {
        experimentId: "write-synthetic-output",
        label: "Write synthetic output",
      },
    ],
    limitations: [
      "Reference results cover only the selected synthetic read and write cases.",
    ],
    ...overrides,
  };
}

function buildInput(): DemoExportBuildInput {
  return { reports: [controlledInput(), referenceInput()] };
}

function replaceExactString(
  value: unknown,
  original: string,
  replacement: string,
): unknown {
  if (typeof value === "string") {
    return value === original ? replacement : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      replaceExactString(entry, original, replacement),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceExactString(entry, original, replacement),
      ]),
    );
  }
  return value;
}

function mutateReport(
  bytes: Uint8Array,
  mutation: (document: Record<string, unknown>) => void,
): Uint8Array {
  const document = JSON.parse(new TextDecoder().decode(bytes)) as Record<
    string,
    unknown
  >;
  mutation(document);
  return new TextEncoder().encode(JSON.stringify(document));
}

function everyObjectKey(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(everyObjectKey);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    key,
    ...everyObjectKey(entry),
  ]);
}

beforeAll(async () => {
  [controlledBytes, referenceBytes] = await Promise.all([
    readFile(
      join(
        process.cwd(),
        "examples",
        "reports",
        "deceptive-control.report.json",
      ),
    ),
    readFile(
      join(
        process.cwd(),
        "examples",
        "reports",
        "official-filesystem.report.json",
      ),
    ),
  ]);
  expect(sha256(controlledBytes)).toBe(CONTROLLED_SHA256);
  expect(sha256(referenceBytes)).toBe(REFERENCE_SHA256);
});

describe("public dashboard demo export", () => {
  it("builds the exact bounded two-fixture presentation contract", () => {
    const output = buildDemoExportV1(buildInput());

    expect(demoExportV1Schema.parse(output)).toEqual(output);
    expect(output.schema).toBe("forge.demo-export/v1");
    expect(output.disclaimer).toBe(DEMO_EXPORT_DISCLAIMER);
    expect(output.runs.map((run) => run.role)).toEqual([
      "controlled",
      "reference",
    ]);

    const [controlled, reference] = output.runs;
    expect(controlled).toMatchObject({
      role: "controlled",
      target: {
        displayName: "Controlled deceptive target",
      },
      presentation: { source: "sample" },
      counts: {
        advertisedTools: 1,
        experiments: 4,
        findings: 5,
        findingsBySeverity: { info: 0, low: 0, medium: 3, high: 2 },
      },
      semantic: {
        status: "completed",
        callsiteCount: 12,
      },
      runtime: {
        filesystemChangeCounts: {
          created: 0,
          modified: 0,
          deleted: 0,
          typeChanged: 0,
        },
      },
    });
    expect(controlled?.semantic.capabilityCounts).toEqual([
      { capability: "filesystem_access", count: 7 },
      { capability: "process_execution", count: 1 },
      { capability: "network_access", count: 1 },
      { capability: "environment_access", count: 3 },
    ]);
    expect(controlled?.runtime.effectCounts).toEqual([
      { effectKind: "process.start", count: 2 },
      { effectKind: "process.exec", count: 7 },
      { effectKind: "file.open", count: 447 },
      { effectKind: "file.read", count: 314 },
      { effectKind: "network.connect_attempt", count: 5 },
    ]);
    expect(controlled?.behaviorScopes.map((scope) => scope.label)).toEqual([
      "Baseline initialization",
      "Summarize synthetic document",
    ]);
    expect(controlled?.behaviorScopes[1]?.rows[0]).toEqual({
      capability: "filesystem_access",
      advertisedState: "claimed",
      staticState: "found",
      runtimeState: "observed",
      operatorScope: {
        state: "configured",
        insideCount: 2,
        outsideCount: 4,
        unclassifiedCount: 0,
      },
    });
    expect(controlled?.findings).toContainEqual({
      title: "Tool accessed data outside its configured scope",
      severity: "high",
      confidence: "medium",
    });

    expect(reference).toMatchObject({
      role: "reference",
      target: { displayName: "Official filesystem target" },
      counts: {
        advertisedTools: 14,
        experiments: 5,
        findings: 0,
        findingsBySeverity: { info: 0, low: 0, medium: 0, high: 0 },
      },
      findings: [],
      semantic: {
        status: "partial",
        callsiteCount: 25,
        capabilityCounts: [{ capability: "filesystem_access", count: 25 }],
      },
      runtime: {
        filesystemChangeCounts: {
          created: 1,
          modified: 0,
          deleted: 0,
          typeChanged: 0,
        },
      },
    });
  });

  it("builds and validates one publication-safe run projection", () => {
    const output = buildDemoRunV1(
      controlledInput({
        presentation: {
          source: "published",
          publishedAt: "2026-08-30T20:00:00.000Z",
        },
      }),
    );

    expect(output).toMatchObject({
      role: "controlled",
      analyzedAt: "2026-08-30T18:10:55.977Z",
      presentation: {
        source: "published",
        publishedAt: "2026-08-30T20:00:00.000Z",
      },
      summary:
        "5 deterministic findings were produced for the selected cases and current rule coverage.",
    });
    expect(JSON.stringify(output)).not.toContain(CONTROLLED_SHA256);
    expect(JSON.stringify(output)).not.toContain(CONTROLLED_TARGET_ID);
  });

  it("is deterministic across input and trusted label ordering", () => {
    const first = buildDemoExportV1(buildInput());
    const controlled = controlledInput({
      scopeLabels: [...controlledInput().scopeLabels].reverse(),
    });
    const reference = referenceInput({
      scopeLabels: [...referenceInput().scopeLabels].reverse(),
    });
    const second = buildDemoExportV1({ reports: [reference, controlled] });

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("keeps the output schema strict and count-bound", () => {
    const output = buildDemoExportV1(buildInput());
    const extraTop = { ...output, rawReport: {} };
    expect(demoExportV1Schema.safeParse(extraTop).success).toBe(false);

    const extraFinding = structuredClone(output) as DemoExportV1;
    Object.assign(extraFinding.runs[0]!.findings[0]!, {
      summary: "A field the public contract intentionally excludes.",
      eventIds: ["private-event"],
    });
    expect(demoExportV1Schema.safeParse(extraFinding).success).toBe(false);

    const extraScope = structuredClone(output) as DemoExportV1;
    Object.assign(extraScope.runs[0]!.behaviorScopes[0]!, {
      experimentId: "private-experiment",
      toolName: "private_tool",
    });
    expect(demoExportV1Schema.safeParse(extraScope).success).toBe(false);

    const wrongCounts = structuredClone(output);
    wrongCounts.runs[0]!.counts.findings = 4;
    expect(demoExportV1Schema.safeParse(wrongCounts).success).toBe(false);

    expect(() =>
      buildDemoExportV1({
        reports: [
          controlledInput({
            limitations: Array.from(
              { length: 9 },
              (_, index) => `Curated limitation ${index}.`,
            ),
          }),
          referenceInput(),
        ],
      }),
    ).toThrow("invalid public demo build input");
  });

  it("verifies digest and target identity before extraction", () => {
    expect(() =>
      buildDemoExportV1({
        reports: [
          controlledInput({ expectedSha256: "0".repeat(64) }),
          referenceInput(),
        ],
      }),
    ).toThrow("report digest mismatch");

    expect(() =>
      buildDemoExportV1({
        reports: [
          controlledInput({ expectedTargetId: REFERENCE_TARGET_ID }),
          referenceInput(),
        ],
      }),
    ).toThrow("report target mismatch");

    const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
    expect(() =>
      buildDemoExportV1({
        reports: [
          controlledInput({
            reportBytes: oversized,
            expectedSha256: sha256(oversized),
          }),
          referenceInput(),
        ],
      }),
    ).toThrow("report byte length exceeds");

    const invalidUtf8 = Uint8Array.from([0xc3, 0x28]);
    expect(() =>
      buildDemoExportV1({
        reports: [
          controlledInput({
            reportBytes: invalidUtf8,
            expectedSha256: sha256(invalidUtf8),
          }),
          referenceInput(),
        ],
      }),
    ).toThrow("report bytes are not valid UTF-8");
  });

  it("rejects duplicate source runs and duplicate target identities", () => {
    expect(() =>
      buildDemoExportV1({
        reports: [
          controlledInput(),
          controlledInput({ role: "reference" }),
        ],
      }),
    ).toThrow("duplicate run ID");

    const duplicateTargetBytes = mutateReport(referenceBytes, (document) => {
      const replaced = replaceExactString(
        document,
        REFERENCE_TARGET_ID,
        CONTROLLED_TARGET_ID,
      ) as Record<string, unknown>;
      for (const key of Object.keys(document)) delete document[key];
      Object.assign(document, replaced);
    });
    expect(() =>
      buildDemoExportV1({
        reports: [
          controlledInput(),
          referenceInput({
            reportBytes: duplicateTargetBytes,
            expectedSha256: sha256(duplicateTargetBytes),
            expectedTargetId: CONTROLLED_TARGET_ID,
          }),
        ],
      }),
    ).toThrow("duplicate target ID");
  });

  it("validates forge.report/v1 before selecting presentation fields", () => {
    const unknownFieldBytes = mutateReport(controlledBytes, (document) => {
      document.publicDemoShortcut = "must not bypass the source schema";
    });
    expect(() =>
      buildDemoExportV1({
        reports: [
          controlledInput({
            reportBytes: unknownFieldBytes,
            expectedSha256: sha256(unknownFieldBytes),
          }),
          referenceInput(),
        ],
      }),
    ).toThrow("report does not satisfy forge.report/v1");

    const tooDeepBytes = mutateReport(controlledBytes, (document) => {
      let nested: Record<string, unknown> = {};
      for (let depth = 0; depth < 70; depth += 1) {
        nested = { nested };
      }
      document.tooDeep = nested;
    });
    expect(() =>
      buildDemoExportV1({
        reports: [
          controlledInput({
            reportBytes: tooDeepBytes,
            expectedSha256: sha256(tooDeepBytes),
          }),
          referenceInput(),
        ],
      }),
    ).toThrow("report JSON exceeds the public demo depth limit");
  });

  it.each([
    "unsafe\u0000control",
    "unsafe\u202ebidi",
    "unsafe\ud800unicode",
    "See https://example.test for details.",
    "Read from /Users/alice/private-demo.txt.",
    "Read from C:\\Users\\alice\\private-demo.txt.",
    "api_key=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
    "AKIAIOSFODNN7EXAMPLE",
  ])("rejects unsafe curated output string %j", (unsafe) => {
    expect(() =>
      buildDemoExportV1({
        reports: [controlledInput({ description: unsafe }), referenceInput()],
      }),
    ).toThrow("invalid public demo build input");
  });

  it("does not let report-authored summaries or finding titles affect public output", () => {
    const baseline = buildDemoRunV1(controlledInput());
    const unsafeSummaryBytes = mutateReport(controlledBytes, (document) => {
      document.summary = "Review https://example.test/private before presenting.";
      const findings = document.findings as Array<Record<string, unknown>>;
      findings[0]!.title = "Private /Users/alice detail with api_key=secret-value";
    });
    const mutated = buildDemoRunV1(
      controlledInput({
        reportBytes: unsafeSummaryBytes,
        expectedSha256: sha256(unsafeSummaryBytes),
      }),
    );
    expect(mutated).toEqual(baseline);
  });

  it("rejects report-byte mutation against the pinned digest", () => {
    const mutated = Uint8Array.from(controlledBytes);
    mutated[mutated.length - 1] = 0x20;

    expect(() =>
      buildDemoExportV1({
        reports: [controlledInput({ reportBytes: mutated }), referenceInput()],
      }),
    ).toThrow("report digest mismatch");
    expect(sha256(controlledBytes)).toBe(CONTROLLED_SHA256);
  });

  it("requires exact trusted labels and emits no private field or path names", () => {
    expect(() =>
      buildDemoExportV1({
        reports: [
          controlledInput({
            scopeLabels: controlledInput().scopeLabels.slice(1),
          }),
          referenceInput(),
        ],
      }),
    ).toThrow("must exactly cover");

    const output = buildDemoExportV1(buildInput());
    const keys = everyObjectKey(output);
    for (const privateKey of [
      "runId",
      "experimentId",
      "toolName",
      "findingId",
      "eventId",
      "eventIds",
      "attributionId",
      "attributionIds",
      "rawRef",
      "path",
      "artifactPath",
      "input",
      "inputSchema",
      "annotations",
      "expected",
      "evidence",
      "reportSha256",
      "ruleId",
      "targetId",
    ]) {
      expect(keys).not.toContain(privateKey);
    }

    const serialized = JSON.stringify(output);
    for (const privateValue of [
      CONTROLLED_RUN_ID,
      REFERENCE_RUN_ID,
      "summarize-file",
      "summarize_file",
      "read-synthetic-report",
      "write-synthetic-output",
      "/sandbox/",
      "/Users/",
      "id_ed25519",
      "hosts.yml",
      "198.51.100.1",
      "static/semantic-inspection.json",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });
});
