import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { z } from "zod";

import type { ReportV1 } from "../contracts/v1.js";
import type { VerifiedRunBundle } from "../publish/bundle.js";
import type { DemoReportInput } from "./demo-export.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const POLICY_SOURCE_MAX_BYTES = 64 * 1_024;

const localSourceIdentitySchema = z
  .object({
    type: z.literal("local"),
    sourceTreeSha256: z.string().regex(SHA256_PATTERN),
    sourceFileCount: z.number().int().positive().max(100_000),
  })
  .strict();

const npmSourceIdentitySchema = z
  .object({
    type: z.literal("npm"),
    package: z.string().min(1).max(256),
    requestedVersion: z.string().min(1).max(128),
    resolvedVersion: z.string().min(1).max(128),
    packageTreeSha256: z.string().regex(SHA256_PATTERN),
    packageFileCount: z.number().int().positive().max(100_000),
    integrity: z.string().min(1).max(512),
  })
  .strict();

const eligibilitySchema = z
  .object({
    sandboxProfile: z.literal("developer-v1"),
    network: z.literal("blocked"),
    forgeVersion: z.literal("0.1.0"),
    reportSchema: z.literal("forge.report/v1"),
    installStrategy: z.literal("npm-install"),
    lifecycleScripts: z.literal("disabled"),
    packageManifestSha256: z.string().regex(SHA256_PATTERN),
    packageLockSha256: z.string().regex(SHA256_PATTERN),
    source: z.discriminatedUnion("type", [
      localSourceIdentitySchema,
      npmSourceIdentitySchema,
    ]),
  })
  .strict();

const scopeLabelSchema = z
  .object({
    experimentId: z.string().regex(IDENTIFIER_PATTERN),
    label: z.string().min(1).max(80),
  })
  .strict();

const targetPolicyDefinitionSchema = z
  .object({
    role: z.enum(["controlled", "reference"]),
    targetId: z.string().regex(IDENTIFIER_PATTERN),
    configSha256: z.string().regex(SHA256_PATTERN),
    displayName: z.string().min(1).max(80),
    description: z.string().min(1).max(320),
    scopeLabels: z.array(scopeLabelSchema).min(1).max(16),
    limitations: z.array(z.string().min(1).max(400)).length(1),
    experimentIds: z
      .array(z.string().regex(IDENTIFIER_PATTERN))
      .min(1)
      .max(32),
    sampleReportFile: z
      .string()
      .regex(/^[A-Za-z0-9._-]+\.report\.json$/u),
    sampleReportSha256: z.string().regex(SHA256_PATTERN),
    eligibility: eligibilitySchema,
  })
  .strict();

const policySourceSchema = z
  .object({
    schema: z.literal("forge.dashboard-policy-source/v1"),
    revision: z.string().regex(/^forge\.dashboard-policy\/v[1-9][0-9]*$/u),
    targets: z.tuple([
      targetPolicyDefinitionSchema,
      targetPolicyDefinitionSchema,
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.targets[0].role !== "controlled" ||
      value.targets[1].role !== "reference"
    ) {
      context.addIssue({
        code: "custom",
        message: "dashboard policy targets must be controlled then reference",
        path: ["targets"],
      });
    }
    if (value.targets[0].targetId === value.targets[1].targetId) {
      context.addIssue({
        code: "custom",
        message: "dashboard policy targets must be distinct",
        path: ["targets"],
      });
    }
  });

export type DemoTargetPolicyDefinition = z.infer<
  typeof targetPolicyDefinitionSchema
>;
export type DemoTargetPolicy = DemoTargetPolicyDefinition & {
  readonly policyId: string;
};

function readPolicySource(): z.infer<typeof policySourceSchema> {
  const bytes = readFileSync(
    new URL("../../dashboard/demo-policy-v1.json", import.meta.url),
  );
  if (bytes.byteLength === 0 || bytes.byteLength > POLICY_SOURCE_MAX_BYTES) {
    throw new Error("dashboard policy source exceeds its bounded size");
  }
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("dashboard policy source is not valid JSON", {
      cause: error,
    });
  }
  return policySourceSchema.parse(document);
}

const POLICY_SOURCE = readPolicySource();
const DEMO_DASHBOARD_POLICY_REVISION = POLICY_SOURCE.revision;
const DEMO_TARGET_POLICY_DEFINITIONS = POLICY_SOURCE.targets;

function canonicalPolicyJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalPolicyJson(entry)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new Error("dashboard policy contains a non-JSON value");
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalPolicyJson(record[key])}`,
    )
    .join(",")}}`;
}

export function demoDashboardPolicyIdFor(
  definitions: readonly DemoTargetPolicyDefinition[],
): string {
  const digest = createHash("sha256")
    .update(canonicalPolicyJson(definitions), "utf8")
    .digest("hex");
  return `${DEMO_DASHBOARD_POLICY_REVISION}:${digest}`;
}

export const DEMO_DASHBOARD_POLICY_ID = demoDashboardPolicyIdFor(
  DEMO_TARGET_POLICY_DEFINITIONS,
);

export const DEMO_TARGET_POLICIES: readonly [
  DemoTargetPolicy,
  DemoTargetPolicy,
] = [
  {
    ...DEMO_TARGET_POLICY_DEFINITIONS[0],
    policyId: DEMO_DASHBOARD_POLICY_ID,
  },
  {
    ...DEMO_TARGET_POLICY_DEFINITIONS[1],
    policyId: DEMO_DASHBOARD_POLICY_ID,
  },
];

function sameOrderedValues(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function hasExpectedSourceIdentity(
  policy: DemoTargetPolicy,
  report: ReportV1,
): boolean {
  const provenance = report.artifactProvenance;
  const expected = policy.eligibility;
  if (
    provenance.install.strategy !== expected.installStrategy ||
    provenance.install.lifecycleScripts !== expected.lifecycleScripts ||
    provenance.packageManifestSha256 !== expected.packageManifestSha256 ||
    provenance.packageLockSha256 !== expected.packageLockSha256
  ) {
    return false;
  }

  if (expected.source.type === "local") {
    return (
      provenance.source.type === "local" &&
      provenance.source.sourceTreeSha256 ===
        expected.source.sourceTreeSha256 &&
      provenance.source.sourceFileCount === expected.source.sourceFileCount
    );
  }

  const source = provenance.source;
  return (
    source.type === "npm" &&
    source.package === expected.source.package &&
    source.requestedVersion === expected.source.requestedVersion &&
    source.resolvedVersion === expected.source.resolvedVersion &&
    source.packageTreeSha256 === expected.source.packageTreeSha256 &&
    source.packageFileCount === expected.source.packageFileCount &&
    source.integrity === expected.source.integrity
  );
}

export function policyForTarget(
  targetId: string,
): DemoTargetPolicy | undefined {
  return DEMO_TARGET_POLICIES.find((policy) => policy.targetId === targetId);
}

export function eligibleDemoPolicy(
  bundle: VerifiedRunBundle,
): DemoTargetPolicy | undefined {
  const policy = policyForTarget(bundle.manifest.targetId);
  if (policy === undefined) return undefined;

  const scopeIds = bundle.report.behaviorComparison.scopes.map(
    (scope) => scope.experimentId,
  );
  const scopeKinds = bundle.report.behaviorComparison.scopes.map(
    (scope) => scope.kind,
  );
  const expectedScopeIds = policy.scopeLabels.map(
    (scope) => scope.experimentId,
  );
  const experimentIds = bundle.report.experiments.map(
    (experiment) => experiment.experimentId,
  );
  if (
    bundle.manifest.status !== "completed" ||
    bundle.manifest.completedAt === undefined ||
    bundle.report.runId !== bundle.manifest.runId ||
    bundle.report.targetId !== policy.targetId ||
    bundle.report.artifactProvenance.runId !== bundle.manifest.runId ||
    bundle.report.artifactProvenance.targetId !== policy.targetId ||
    bundle.manifest.configSha256 !== policy.configSha256 ||
    bundle.manifest.sandboxPolicy.profile !== policy.eligibility.sandboxProfile ||
    bundle.manifest.sandboxPolicy.network !== policy.eligibility.network ||
    bundle.manifest.toolchain.forgeVersion !== policy.eligibility.forgeVersion ||
    bundle.report.schema !== policy.eligibility.reportSchema ||
    bundle.report.sandboxPolicy.profile !== policy.eligibility.sandboxProfile ||
    bundle.report.sandboxPolicy.network !== policy.eligibility.network ||
    !sameOrderedValues(experimentIds, policy.experimentIds) ||
    !sameOrderedValues(scopeIds, expectedScopeIds) ||
    !sameOrderedValues(
      scopeKinds,
      expectedScopeIds.map((_scopeId, index) =>
        index === 0 ? "initialization" : "tool",
      ),
    ) ||
    !hasExpectedSourceIdentity(policy, bundle.report)
  ) {
    return undefined;
  }
  return policy;
}

export function publishedDemoReportInput(
  bundle: VerifiedRunBundle,
  publishedAt: string,
): DemoReportInput | undefined {
  const policy = eligibleDemoPolicy(bundle);
  if (policy === undefined) return undefined;
  return {
    role: policy.role,
    reportBytes: bundle.reportBytes,
    expectedSha256: bundle.reportArtifact.verifiedSha256,
    expectedTargetId: policy.targetId,
    displayName: policy.displayName,
    description: policy.description,
    scopeLabels: policy.scopeLabels,
    limitations: policy.limitations,
    presentation: { source: "published", publishedAt },
  };
}
