import { createHash } from "node:crypto";

import { z } from "zod";

import { reportV1Schema, type ReportV1 } from "../contracts/v1.js";
import { staticCapabilitySchema } from "../static/contracts.js";

const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_ADVERTISED_TOOLS = 64;
const MAX_EXPERIMENTS = 32;
const MAX_FINDINGS = 64;
const MAX_SCOPES = 32;
const MAX_LIMITATIONS = 8;
const MAX_PUBLIC_COUNT = 1_000_000;
const MAX_SOURCE_JSON_DEPTH = 64;
const MAX_SOURCE_JSON_NODES = 100_000;
const MAX_SOURCE_ARRAY_LENGTH = 10_000;
const MAX_SOURCE_OBJECT_KEYS = 1_000;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CONTROL_OR_BIDI_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const URL_PATTERN =
  /(?:\b(?:https?|ftp):\/\/|\bwww\.|(?:^|\s)mailto:)[^\s]*/iu;
const WINDOWS_ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s"'`([{=,:;])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`\])}>;,]*/u;
const POSIX_ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s"'`([{=,:;])(\/[^\s"'`\])}>;,]+)/gu;
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{30,}\b/u,
  /\bgh[pousr]_[0-9A-Za-z]{20,}\b/u,
  /\bglpat-[0-9A-Za-z_-]{20,}\b/u,
  /\bnpm_[0-9A-Za-z]{20,}\b/u,
  /\bsk-(?:proj-)?[0-9A-Za-z_-]{20,}\b/u,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/u,
  /\beyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\b/u,
  /\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret)\s*[:=]\s*[^\s,;]+/iu,
] as const;

const severitySchema = z.enum(["info", "low", "medium", "high"]);
const confidenceSchema = z.enum(["high", "medium", "low"]);
const comparedCapabilitySchema = z.enum([
  "filesystem_access",
  "network_access",
  "process_execution",
]);
const effectKindSchema = z.enum([
  "process.start",
  "process.exec",
  "process.exit",
  "file.open",
  "file.read",
  "file.write",
  "file.delete",
  "network.connect_attempt",
  "network.listen",
]);

const SEVERITY_ORDER = ["high", "medium", "low", "info"] as const;
const CAPABILITY_ORDER = staticCapabilitySchema.options;
const COMPARED_CAPABILITY_ORDER = comparedCapabilitySchema.options;
const EFFECT_KIND_ORDER = effectKindSchema.options;

export const DEMO_EXPORT_DISCLAIMER =
  "Zero findings means only that no deterministic findings were produced for the selected synthetic experiments and current rule coverage; it is not evidence of universal safety.";

export class DemoExportError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DemoExportError";
  }
}

function hasMalformedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (current >= 0xdc00 && current <= 0xdfff) return true;
    const codePoint = value.codePointAt(index);
    if (
      codePoint === undefined ||
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
      (codePoint & 0xffff) === 0xfffe ||
      (codePoint & 0xffff) === 0xffff
    ) {
      return true;
    }
  }
  return false;
}

function containsHostAbsolutePath(value: string): boolean {
  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(value)) return true;
  POSIX_ABSOLUTE_PATH_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(POSIX_ABSOLUTE_PATH_PATTERN)) {
    const path = match[1];
    if (path === undefined) continue;
    return true;
  }
  return false;
}

function unsafePublicStringReason(value: string): string | undefined {
  if (hasMalformedUnicode(value)) return "malformed Unicode";
  if (CONTROL_OR_BIDI_PATTERN.test(value)) return "control or bidi characters";
  if (URL_PATTERN.test(value)) return "a URL";
  if (containsHostAbsolutePath(value)) return "a host absolute path";
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))) {
    return "a credential-like value";
  }
  return undefined;
}

function publicTextSchema(maxLength: number): z.ZodString {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => value === value.trim(), "must not have outer whitespace")
    .refine(
      (value) => unsafePublicStringReason(value) === undefined,
      "must be safe for the public demo",
    );
}

const publicIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(IDENTIFIER_PATTERN)
  .refine(
    (value) => unsafePublicStringReason(value) === undefined,
    "must be safe for the public demo",
  );
const publicCountSchema = z.number().int().min(0).max(MAX_PUBLIC_COUNT);

const findingCountsSchema = z
  .object({
    info: publicCountSchema,
    low: publicCountSchema,
    medium: publicCountSchema,
    high: publicCountSchema,
  })
  .strict();

const findingCardSchema = z
  .object({
    ruleId: publicIdentifierSchema,
    title: publicTextSchema(160),
    severity: severitySchema,
    confidence: confidenceSchema,
  })
  .strict();

const semanticSchema = z
  .object({
    status: z.enum(["completed", "partial", "failed", "not_available"]),
    callsiteCount: publicCountSchema,
    capabilityCounts: z
      .array(
        z
          .object({
            capability: staticCapabilitySchema,
            count: publicCountSchema.positive(),
          })
          .strict(),
      )
      .max(CAPABILITY_ORDER.length),
  })
  .strict()
  .superRefine((semantic, context) => {
    const capabilities = semantic.capabilityCounts.map(
      (entry) => entry.capability,
    );
    const count = semantic.capabilityCounts.reduce(
      (total, entry) => total + entry.count,
      0,
    );
    if (new Set(capabilities).size !== capabilities.length) {
      context.addIssue({
        code: "custom",
        message: "semantic capabilities must be unique",
        path: ["capabilityCounts"],
      });
    }
    if (count !== semantic.callsiteCount) {
      context.addIssue({
        code: "custom",
        message: "semantic capability counts must equal the callsite count",
        path: ["callsiteCount"],
      });
    }
    if (
      semantic.status === "not_available" &&
      (semantic.callsiteCount !== 0 || semantic.capabilityCounts.length !== 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "unavailable semantic analysis cannot contain counts",
        path: ["status"],
      });
    }
  });

const behaviorRowSchema = z
  .object({
    capability: comparedCapabilitySchema,
    advertisedState: z.enum([
      "claimed",
      "not_claimed",
      "not_observed",
      "not_applicable",
    ]),
    staticState: z.enum(["found", "not_found"]),
    runtimeState: z.enum(["observed", "not_observed"]),
    operatorScope: z
      .object({
        state: z.enum(["configured", "not_configured"]),
        insideCount: publicCountSchema,
        outsideCount: publicCountSchema,
        unclassifiedCount: publicCountSchema,
      })
      .strict(),
  })
  .strict();

const behaviorScopeSchema = z
  .object({
    label: publicTextSchema(80),
    kind: z.enum(["initialization", "tool"]),
    rows: z.array(behaviorRowSchema).length(COMPARED_CAPABILITY_ORDER.length),
  })
  .strict()
  .superRefine((scope, context) => {
    const capabilities = scope.rows.map((row) => row.capability);
    if (
      new Set(capabilities).size !== COMPARED_CAPABILITY_ORDER.length ||
      COMPARED_CAPABILITY_ORDER.some(
        (capability) => !capabilities.includes(capability),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "behavior scope must contain every compared capability once",
        path: ["rows"],
      });
    }
  });

const runtimeSchema = z
  .object({
    effectCounts: z
      .array(
        z
          .object({
            effectKind: effectKindSchema,
            count: publicCountSchema.positive(),
          })
          .strict(),
      )
      .max(EFFECT_KIND_ORDER.length),
    filesystemChangeCounts: z
      .object({
        created: publicCountSchema,
        modified: publicCountSchema,
        deleted: publicCountSchema,
        typeChanged: publicCountSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((runtime, context) => {
    const effects = runtime.effectCounts.map((entry) => entry.effectKind);
    if (new Set(effects).size !== effects.length) {
      context.addIssue({
        code: "custom",
        message: "runtime effect kinds must be unique",
        path: ["effectCounts"],
      });
    }
  });

const demoRunSchema = z
  .object({
    role: z.enum(["controlled", "reference"]),
    reportSha256: z.string().regex(SHA256_PATTERN),
    target: z
      .object({
        id: publicIdentifierSchema,
        displayName: publicTextSchema(80),
        description: publicTextSchema(320),
      })
      .strict(),
    generatedAt: z.iso.datetime({ offset: true }),
    summary: publicTextSchema(512),
    counts: z
      .object({
        advertisedTools: publicCountSchema,
        experiments: publicCountSchema,
        findings: publicCountSchema,
        findingsBySeverity: findingCountsSchema,
      })
      .strict(),
    findings: z.array(findingCardSchema).max(MAX_FINDINGS),
    semantic: semanticSchema,
    behaviorScopes: z.array(behaviorScopeSchema).max(MAX_SCOPES),
    runtime: runtimeSchema,
    limitations: z.array(publicTextSchema(400)).max(MAX_LIMITATIONS),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.counts.findings !== run.findings.length) {
      context.addIssue({
        code: "custom",
        message: "finding count must match finding cards",
        path: ["counts", "findings"],
      });
    }
    for (const severity of severitySchema.options) {
      const expected = run.findings.filter(
        (finding) => finding.severity === severity,
      ).length;
      if (run.counts.findingsBySeverity[severity] !== expected) {
        context.addIssue({
          code: "custom",
          message: "severity counts must match finding cards",
          path: ["counts", "findingsBySeverity", severity],
        });
      }
    }
    const labels = run.behaviorScopes.map((scope) => scope.label);
    if (new Set(labels).size !== labels.length) {
      context.addIssue({
        code: "custom",
        message: "behavior scope labels must be unique per run",
        path: ["behaviorScopes"],
      });
    }
  });

export const demoExportV1Schema = z
  .object({
    schema: z.literal("forge.demo-export/v1"),
    disclaimer: z.literal(DEMO_EXPORT_DISCLAIMER),
    runs: z.array(demoRunSchema).length(2),
  })
  .strict()
  .superRefine((value, context) => {
    const roles = value.runs.map((run) => run.role);
    if (
      roles[0] !== "controlled" ||
      roles[1] !== "reference" ||
      new Set(roles).size !== 2
    ) {
      context.addIssue({
        code: "custom",
        message: "runs must be ordered controlled then reference",
        path: ["runs"],
      });
    }
    if (
      new Set(value.runs.map((run) => run.target.id)).size !==
        value.runs.length ||
      new Set(value.runs.map((run) => run.reportSha256)).size !==
        value.runs.length
    ) {
      context.addIssue({
        code: "custom",
        message: "demo runs must identify distinct targets and reports",
        path: ["runs"],
      });
    }
  });

export type DemoExportV1 = z.infer<typeof demoExportV1Schema>;

export interface DemoScopeLabel {
  readonly experimentId: string;
  readonly label: string;
}

export interface DemoReportInput {
  readonly role: "controlled" | "reference";
  readonly reportBytes: Uint8Array;
  readonly expectedSha256: string;
  readonly expectedTargetId: string;
  readonly displayName: string;
  readonly description: string;
  readonly scopeLabels: readonly DemoScopeLabel[];
  readonly limitations: readonly string[];
}

export interface DemoExportBuildInput {
  readonly reports: readonly [DemoReportInput, DemoReportInput];
}

const scopeLabelInputSchema = z
  .object({
    experimentId: publicIdentifierSchema,
    label: publicTextSchema(80),
  })
  .strict();

const reportInputSchema = z
  .object({
    role: z.enum(["controlled", "reference"]),
    reportBytes: z.instanceof(Uint8Array),
    expectedSha256: z.string().regex(SHA256_PATTERN),
    expectedTargetId: publicIdentifierSchema,
    displayName: publicTextSchema(80),
    description: publicTextSchema(320),
    scopeLabels: z.array(scopeLabelInputSchema).max(MAX_SCOPES),
    limitations: z.array(publicTextSchema(400)).max(MAX_LIMITATIONS),
  })
  .strict();

const buildInputSchema = z
  .object({
    reports: z.array(reportInputSchema).length(2),
  })
  .strict();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertCardinality(label: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new DemoExportError(`${label} exceeds the public demo limit`);
  }
}

function addCount(label: string, left: number, right: number): number {
  assertCardinality(label, left, MAX_PUBLIC_COUNT);
  assertCardinality(label, right, MAX_PUBLIC_COUNT);
  const total = left + right;
  assertCardinality(label, total, MAX_PUBLIC_COUNT);
  return total;
}

function assertBoundedSourceJson(document: unknown): void {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: document, depth: 0 },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_SOURCE_JSON_NODES) {
      throw new DemoExportError("report JSON exceeds the public demo node limit");
    }
    if (current.depth > MAX_SOURCE_JSON_DEPTH) {
      throw new DemoExportError("report JSON exceeds the public demo depth limit");
    }
    if (Array.isArray(current.value)) {
      assertCardinality(
        "report JSON array length",
        current.value.length,
        MAX_SOURCE_ARRAY_LENGTH,
      );
      for (const entry of current.value) {
        stack.push({ value: entry, depth: current.depth + 1 });
      }
      continue;
    }
    if (current.value !== null && typeof current.value === "object") {
      const entries = Object.entries(current.value);
      assertCardinality(
        "report JSON object key count",
        entries.length,
        MAX_SOURCE_OBJECT_KEYS,
      );
      for (const [, entry] of entries) {
        stack.push({ value: entry, depth: current.depth + 1 });
      }
    }
  }
}

function parsePinnedReport(input: z.infer<typeof reportInputSchema>): {
  readonly report: ReportV1;
  readonly reportSha256: string;
} {
  assertCardinality(
    "report byte length",
    input.reportBytes.byteLength,
    MAX_REPORT_BYTES,
  );
  if (input.reportBytes.byteLength === 0) {
    throw new DemoExportError("report bytes must not be empty");
  }

  const bytes = Uint8Array.from(input.reportBytes);
  const digest = sha256(bytes);
  if (digest !== input.expectedSha256) {
    throw new DemoExportError(
      `report digest mismatch for expected target '${input.expectedTargetId}'`,
    );
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new DemoExportError("report bytes are not valid UTF-8", {
      cause: error,
    });
  }

  let document: unknown;
  try {
    document = JSON.parse(source) as unknown;
  } catch (error) {
    throw new DemoExportError("report bytes are not valid JSON", {
      cause: error,
    });
  }
  assertBoundedSourceJson(document);

  let report: ReportV1;
  try {
    report = reportV1Schema.parse(document);
  } catch (error) {
    throw new DemoExportError("report does not satisfy forge.report/v1", {
      cause: error,
    });
  }
  if (report.targetId !== input.expectedTargetId) {
    throw new DemoExportError(
      `report target mismatch: expected '${input.expectedTargetId}'`,
    );
  }

  return { report, reportSha256: digest };
}

function assertReportBounds(report: ReportV1): void {
  assertCardinality(
    "advertised tool count",
    report.advertisedTools.length,
    MAX_ADVERTISED_TOOLS,
  );
  assertCardinality(
    "experiment count",
    report.experiments.length,
    MAX_EXPERIMENTS,
  );
  assertCardinality("finding count", report.findings.length, MAX_FINDINGS);
  assertCardinality(
    "behavior scope count",
    report.behaviorComparison.scopes.length,
    MAX_SCOPES,
  );
  assertCardinality(
    "runtime observation count",
    report.runtimeObservations.length,
    MAX_SCOPES,
  );
  for (const scope of report.behaviorComparison.scopes) {
    for (const row of scope.rows) {
      assertCardinality(
        "inside operator-scope event count",
        row.withinOperatorScopeEventIds.length,
        MAX_PUBLIC_COUNT,
      );
      assertCardinality(
        "outside operator-scope event count",
        row.outsideOperatorScopeEventIds.length,
        MAX_PUBLIC_COUNT,
      );
      assertCardinality(
        "unclassified runtime event count",
        row.unclassifiedRuntimeEventIds.length,
        MAX_PUBLIC_COUNT,
      );
    }
  }
  if (report.semanticAnalysis !== undefined) {
    assertCardinality(
      "semantic callsite count",
      report.semanticAnalysis.callsiteCount,
      MAX_PUBLIC_COUNT,
    );
    assertCardinality(
      "semantic capability count",
      report.semanticAnalysis.capabilityCallsites.length,
      CAPABILITY_ORDER.length,
    );
  }
}

function buildScopeLabelMap(
  report: ReportV1,
  labels: readonly z.infer<typeof scopeLabelInputSchema>[],
): ReadonlyMap<string, string> {
  const labelMap = new Map<string, string>();
  for (const entry of labels) {
    if (labelMap.has(entry.experimentId)) {
      throw new DemoExportError(
        `duplicate curated scope label for '${entry.experimentId}'`,
      );
    }
    labelMap.set(entry.experimentId, entry.label);
  }
  const scopeIds = new Set(
    report.behaviorComparison.scopes.map((scope) => scope.experimentId),
  );
  if (
    scopeIds.size !== labelMap.size ||
    [...scopeIds].some((experimentId) => !labelMap.has(experimentId)) ||
    [...labelMap.keys()].some((experimentId) => !scopeIds.has(experimentId))
  ) {
    throw new DemoExportError(
      `curated scope labels must exactly cover target '${report.targetId}'`,
    );
  }
  if (new Set(labelMap.values()).size !== labelMap.size) {
    throw new DemoExportError(
      `curated scope labels must be unique for target '${report.targetId}'`,
    );
  }
  return labelMap;
}

function orderedIndex<T extends string>(values: readonly T[], value: T): number {
  return values.indexOf(value);
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function buildSemantic(report: ReportV1): DemoExportV1["runs"][number]["semantic"] {
  const semantic = report.semanticAnalysis;
  if (semantic === undefined) {
    return {
      status: "not_available",
      callsiteCount: 0,
      capabilityCounts: [],
    };
  }
  return {
    status: semantic.status,
    callsiteCount: semantic.callsiteCount,
    capabilityCounts: semantic.capabilityCallsites
      .map((entry) => ({
        capability: entry.capability,
        count: entry.count,
      }))
      .sort(
        (left, right) =>
          orderedIndex(CAPABILITY_ORDER, left.capability) -
          orderedIndex(CAPABILITY_ORDER, right.capability),
      ),
  };
}

function buildRuntime(report: ReportV1): DemoExportV1["runs"][number]["runtime"] {
  const effects = new Map<z.infer<typeof effectKindSchema>, number>();
  const filesystemChangeCounts = {
    created: 0,
    modified: 0,
    deleted: 0,
    typeChanged: 0,
  };
  for (const observation of report.runtimeObservations) {
    for (const entry of observation.effectCounts) {
      effects.set(
        entry.effectKind,
        addCount(
          `runtime '${entry.effectKind}' count`,
          effects.get(entry.effectKind) ?? 0,
          entry.count,
        ),
      );
    }
    const changes = observation.filesystemStateDelta?.changeCounts;
    if (changes !== undefined) {
      filesystemChangeCounts.created = addCount(
        "created filesystem change count",
        filesystemChangeCounts.created,
        changes.created,
      );
      filesystemChangeCounts.modified = addCount(
        "modified filesystem change count",
        filesystemChangeCounts.modified,
        changes.modified,
      );
      filesystemChangeCounts.deleted = addCount(
        "deleted filesystem change count",
        filesystemChangeCounts.deleted,
        changes.deleted,
      );
      filesystemChangeCounts.typeChanged = addCount(
        "type-changed filesystem change count",
        filesystemChangeCounts.typeChanged,
        changes.typeChanged,
      );
    }
  }
  return {
    effectCounts: EFFECT_KIND_ORDER.flatMap((effectKind) => {
      const count = effects.get(effectKind);
      return count === undefined ? [] : [{ effectKind, count }];
    }),
    filesystemChangeCounts,
  };
}

function buildRun(
  input: z.infer<typeof reportInputSchema>,
  report: ReportV1,
  reportSha256: string,
): DemoExportV1["runs"][number] {
  assertReportBounds(report);
  const labelMap = buildScopeLabelMap(report, input.scopeLabels);
  const findingsBySeverity = { info: 0, low: 0, medium: 0, high: 0 };
  for (const finding of report.findings) {
    findingsBySeverity[finding.severity] += 1;
  }

  return {
    role: input.role,
    reportSha256,
    target: {
      id: report.targetId,
      displayName: input.displayName,
      description: input.description,
    },
    generatedAt: report.generatedAt,
    summary: report.summary,
    counts: {
      advertisedTools: report.advertisedTools.length,
      experiments: report.experiments.length,
      findings: report.findings.length,
      findingsBySeverity,
    },
    findings: report.findings
      .map((finding) => ({
        ruleId: finding.ruleId,
        title: finding.title,
        severity: finding.severity,
        confidence: finding.confidence,
      }))
      .sort((left, right) => {
        const severityDifference =
          orderedIndex(SEVERITY_ORDER, left.severity) -
          orderedIndex(SEVERITY_ORDER, right.severity);
        return (
          severityDifference ||
          compareStrings(left.ruleId, right.ruleId) ||
          compareStrings(left.title, right.title)
        );
      }),
    semantic: buildSemantic(report),
    behaviorScopes: report.behaviorComparison.scopes.map((scope) => ({
      label: labelMap.get(scope.experimentId)!,
      kind: scope.kind,
      rows: scope.rows
        .map((row) => ({
          capability: row.capability,
          advertisedState: row.advertisedState,
          staticState: row.staticState,
          runtimeState: row.runtimeState,
          operatorScope: {
            state: row.operatorScopeState,
            insideCount: row.withinOperatorScopeEventIds.length,
            outsideCount: row.outsideOperatorScopeEventIds.length,
            unclassifiedCount: row.unclassifiedRuntimeEventIds.length,
          },
        }))
        .sort(
          (left, right) =>
            orderedIndex(COMPARED_CAPABILITY_ORDER, left.capability) -
            orderedIndex(COMPARED_CAPABILITY_ORDER, right.capability),
        ),
    })),
    runtime: buildRuntime(report),
    limitations: [...input.limitations],
  };
}

function assertEveryEmittedStringIsSafe(value: unknown, path = "$output"): void {
  if (typeof value === "string") {
    const reason = unsafePublicStringReason(value);
    if (reason !== undefined) {
      throw new DemoExportError(`${path} contains ${reason}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertEveryEmittedStringIsSafe(entry, `${path}[${index}]`),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assertEveryEmittedStringIsSafe(key, `${path}.<key>`);
      assertEveryEmittedStringIsSafe(entry, `${path}.${key}`);
    }
  }
}

export function buildDemoExportV1(input: DemoExportBuildInput): DemoExportV1 {
  let trustedInput: z.infer<typeof buildInputSchema>;
  try {
    trustedInput = buildInputSchema.parse(input);
  } catch (error) {
    throw new DemoExportError("invalid public demo build input", {
      cause: error,
    });
  }

  const roles = new Set(trustedInput.reports.map((report) => report.role));
  if (!roles.has("controlled") || !roles.has("reference") || roles.size !== 2) {
    throw new DemoExportError(
      "public demo requires exactly one controlled and one reference report",
    );
  }

  const parsed = trustedInput.reports.map((reportInput) => ({
    input: reportInput,
    ...parsePinnedReport(reportInput),
  }));
  if (new Set(parsed.map(({ report }) => report.runId)).size !== parsed.length) {
    throw new DemoExportError("public demo reports contain a duplicate run ID");
  }
  if (new Set(parsed.map(({ report }) => report.targetId)).size !== parsed.length) {
    throw new DemoExportError("public demo reports contain a duplicate target ID");
  }

  const runs = parsed
    .map(({ input: reportInput, report, reportSha256 }) =>
      buildRun(reportInput, report, reportSha256),
    )
    .sort((left, right) =>
      left.role === right.role ? 0 : left.role === "controlled" ? -1 : 1,
    );
  const candidate = {
    schema: "forge.demo-export/v1" as const,
    disclaimer: DEMO_EXPORT_DISCLAIMER,
    runs,
  };
  assertEveryEmittedStringIsSafe(candidate);
  try {
    return demoExportV1Schema.parse(candidate);
  } catch (error) {
    throw new DemoExportError("generated public demo export is invalid", {
      cause: error,
    });
  }
}
