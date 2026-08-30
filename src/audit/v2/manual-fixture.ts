import { readFile } from "node:fs/promises";

import {
  approvedPolicyV2Schema,
  auditSpecV2Schema,
  claimProfileV2Schema,
  mandatoryCaseTemplateV2Schema,
  targetIdentityV2Schema,
  type ApprovedPolicyV2,
  type AuditSpecV2,
  type ClaimProfileV2,
  type TargetIdentityV2,
} from "../../contracts/v2/index.js";
import { artifactReferenceFromBytes } from "./artifacts.js";
import { computeCatalogIdentity } from "./catalog.js";
import { digestCanonicalJson } from "./canonical.js";
import type { CompileExperimentPlanInput } from "./compile.js";
import { parseStrictJson } from "./strict-json.js";
import {
  runtimeDescriptorV2Schema,
  type RuntimeDescriptorV2,
} from "./target.js";

interface FixtureArtifact {
  readonly artifactId: string;
  readonly kind: "source_bundle" | "runtime_snapshot";
  readonly mediaType:
    | "application/json"
    | "application/vnd.forge.runtime-tree+json";
  readonly content: string;
}

interface RawManualFixture {
  readonly fixtureFormat: "forge.manual-phase1-fixture/v1";
  readonly compile: {
    readonly planId: string;
    readonly manifestId: string;
    readonly compiledAt: string;
  };
  readonly approval: {
    readonly receiptId: string;
    readonly issuerId: string;
    readonly controllerId: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
  };
  readonly target: {
    readonly targetId: string;
    readonly sourceArtifact: FixtureArtifact;
    readonly runtimeSnapshot: FixtureArtifact;
    readonly runtimeDescriptor: unknown;
  };
  readonly catalog: unknown;
  readonly claimProfileFields: Record<string, unknown>;
  readonly policy: unknown;
  readonly auditSpecFields: Record<string, unknown>;
  readonly mandatoryCases: readonly unknown[];
}

export interface ManualFixtureInputs {
  readonly compileInput: CompileExperimentPlanInput;
  readonly approval: RawManualFixture["approval"];
  readonly target: TargetIdentityV2;
  readonly runtimeDescriptor: RuntimeDescriptorV2;
  readonly catalogInput: unknown;
  readonly claimProfile: ClaimProfileV2;
  readonly policy: ApprovedPolicyV2;
  readonly auditSpec: AuditSpecV2;
  readonly mandatoryCases: readonly unknown[];
}

function assertRawFixture(value: unknown): asserts value is RawManualFixture {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("manual V2 fixture must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record["fixtureFormat"] !== "forge.manual-phase1-fixture/v1") {
    throw new TypeError("manual V2 fixture format is invalid");
  }
}

function bytesFor(artifact: FixtureArtifact): Uint8Array {
  return Buffer.from(artifact.content, "utf8");
}

/** Load and fully bind the repository's human-authored Phase 1A example. */
export async function loadManualFixtureInputs(): Promise<ManualFixtureInputs> {
  const source = await readFile(
    new URL(
      "../../../fixtures/evidence-first-v2/manual-phase1.json",
      import.meta.url,
    ),
  );
  const raw = parseStrictJson(source);
  assertRawFixture(raw);

  const sourceArtifactBytes = bytesFor(raw.target.sourceArtifact);
  const runtimeSnapshotBytes = bytesFor(raw.target.runtimeSnapshot);
  const sourceArtifact = artifactReferenceFromBytes(
    raw.target.sourceArtifact,
    sourceArtifactBytes,
  );
  const runtimeSnapshot = artifactReferenceFromBytes(
    raw.target.runtimeSnapshot,
    runtimeSnapshotBytes,
  );
  const runtimeDescriptor = runtimeDescriptorV2Schema.parse(
    raw.target.runtimeDescriptor,
  );
  const target = targetIdentityV2Schema.parse({
    targetId: raw.target.targetId,
    sourceArtifact,
    runtimeSnapshot,
    runtimeTreeAlgorithm: "forge.runtime-tree/v2",
    runtimeDescriptorDigest: digestCanonicalJson(
      "forge.runtime-descriptor",
      "v2",
      runtimeDescriptor,
    ),
  });
  const targetIdentityDigest = digestCanonicalJson(
    "forge.target-identity",
    "v2",
    target,
  );

  const catalog = computeCatalogIdentity(raw.catalog);
  const claimProfile = claimProfileV2Schema.parse({
    ...raw.claimProfileFields,
    target,
    catalog: catalog.identity,
  });
  const rawPolicy = raw.policy as Record<string, unknown>;
  const policySubject = rawPolicy["subject"] as Record<string, unknown>;
  const policy = approvedPolicyV2Schema.parse({
    ...rawPolicy,
    subject: { ...policySubject, targetIdentityDigest },
  });
  const claimProfileDigest = digestCanonicalJson(
    "forge.claim-profile",
    "v2",
    claimProfile,
  );
  const policyDigest = digestCanonicalJson(
    "forge.audit-policy",
    "v2",
    policy,
  );
  const mandatoryCases = raw.mandatoryCases.map((item) =>
    mandatoryCaseTemplateV2Schema.parse(item),
  );
  const mandatorySuiteDigest = digestCanonicalJson(
    "forge.mandatory-case-suite",
    "v2",
    mandatoryCases,
  );
  const auditSpec = auditSpecV2Schema.parse({
    ...raw.auditSpecFields,
    targetSelector: {
      targetId: target.targetId,
      sourceArtifactSha256: target.sourceArtifact.sha256,
    },
    policyDigest,
    claimProfileDigest,
    mandatorySuiteDigest,
  });

  return {
    compileInput: {
      planId: raw.compile.planId,
      manifestId: raw.compile.manifestId,
      compiledAt: raw.compile.compiledAt,
      target: {
        identity: target,
        sourceArtifactBytes,
        runtimeSnapshotBytes,
        runtimeDescriptor,
      },
      catalog: raw.catalog,
      claimProfile,
      policy,
      auditSpec,
      mandatoryCases,
    },
    approval: raw.approval,
    target,
    runtimeDescriptor,
    catalogInput: raw.catalog,
    claimProfile,
    policy,
    auditSpec,
    mandatoryCases,
  };
}
