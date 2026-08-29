import { z } from "zod";

const identifierSchema = z.string().min(1);
const timestampSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const relativeTargetPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/"), "must be relative")
  .refine(
    (value) => !value.split("/").includes(".."),
    "must not contain parent-directory segments",
  );

export const staticFileEvidenceV1Schema = z
  .object({
    schema: z.literal("forge.static-file/v1"),
    runId: identifierSchema,
    targetId: identifierSchema,
    evidenceId: identifierSchema,
    targetPath: relativeTargetPathSchema,
    sha256: sha256Schema,
    sizeBytes: z.number().int().nonnegative(),
    mediaType: z.string().min(1),
    encoding: z.enum(["utf8", "base64"]),
    content: z.string(),
  })
  .strict();

export const staticEvidenceReferenceV1Schema = z
  .object({
    artifactPath: relativeTargetPathSchema,
    targetPath: relativeTargetPathSchema,
    sha256: sha256Schema,
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  })
  .strict();

const packageScriptSchema = z
  .object({
    name: z.string().min(1),
    command: z.string(),
    installLifecycle: z.boolean(),
  })
  .strict();

const packageDependencySchema = z
  .object({
    name: z.string().min(1),
    specifier: z.string(),
    kind: z.enum([
      "runtime",
      "development",
      "optional",
      "peer",
    ]),
  })
  .strict();

const packageEntrypointSchema = z
  .object({
    kind: z.enum(["main", "module", "types", "bin"]),
    path: z.string().min(1),
    name: z.string().min(1).optional(),
  })
  .strict();

const manifestClaimsSchema = z
  .object({
    name: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    private: z.boolean().optional(),
    packageType: z.string().min(1).optional(),
    packageManager: z.string().min(1).optional(),
    repository: z.string().min(1).optional(),
    homepage: z.string().min(1).optional(),
    entrypoints: z.array(packageEntrypointSchema),
    scripts: z.array(packageScriptSchema),
    dependencies: z.array(packageDependencySchema),
    engines: z.record(z.string(), z.string()),
  })
  .strict();

const parsedManifestSchema = z
  .object({
    status: z.literal("parsed"),
    evidence: staticEvidenceReferenceV1Schema,
    claims: manifestClaimsSchema,
  })
  .strict();

const invalidManifestSchema = z
  .object({
    status: z.literal("invalid"),
    evidence: staticEvidenceReferenceV1Schema.optional(),
    error: z.string().min(1),
  })
  .strict();

const unreadableManifestSchema = z
  .object({
    status: z.literal("unreadable"),
    error: z.string().min(1),
  })
  .strict();

const missingManifestSchema = z.object({ status: z.literal("missing") }).strict();

const lockfileSchema = z
  .object({
    path: relativeTargetPathSchema,
    format: z.enum([
      "npm-package-lock",
      "npm-shrinkwrap",
      "pnpm",
      "yarn",
      "bun-text",
      "bun-binary",
    ]),
    sizeBytes: z.number().int().nonnegative(),
    sha256: sha256Schema.optional(),
    evidence: staticEvidenceReferenceV1Schema.optional(),
    metadata: z
      .object({
        parseStatus: z.enum(["parsed", "summarized", "not_parsed"]),
        lockfileVersion: z.union([z.string(), z.number()]).optional(),
        packageEntries: z.number().int().nonnegative().optional(),
        resolvedEntries: z.number().int().nonnegative().optional(),
        integrityEntries: z.number().int().nonnegative().optional(),
        parseError: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

export const staticCapabilitySchema = z.enum([
  "filesystem_access",
  "process_execution",
  "network_access",
  "environment_access",
  "dynamic_code_execution",
  "dynamic_module_loading",
  "native_code_loading",
]);

const sourceSignalSchema = z
  .object({
    signalId: identifierSchema,
    capability: staticCapabilitySchema,
    patternId: identifierSchema,
    summary: z.string().min(1),
    confidence: z.enum(["high", "medium", "low"]),
    evidence: staticEvidenceReferenceV1Schema,
    excerpt: z.string().min(1),
  })
  .strict();

const scannedSourceFileSchema = z
  .object({
    path: relativeTargetPathSchema,
    sizeBytes: z.number().int().nonnegative(),
    sha256: sha256Schema,
    evidence: staticEvidenceReferenceV1Schema,
  })
  .strict();

const skippedSourceFileSchema = z
  .object({
    path: relativeTargetPathSchema,
    reason: z.enum([
      "file_limit",
      "total_bytes_limit",
      "file_too_large",
      "invalid_utf8",
      "symlink",
      "read_error",
    ]),
  })
  .strict();

const provenanceHintSchema = z
  .object({
    kind: z.enum(["package_manager", "repository", "lockfile"]),
    value: z.string().min(1),
    basis: z.enum(["manifest_claim", "observed_file"]),
    evidence: staticEvidenceReferenceV1Schema,
  })
  .strict();

export const nodePackageStaticInspectionV1Schema = z
  .object({
    schema: z.literal("forge.node-package-static/v1"),
    runId: identifierSchema,
    targetId: identifierSchema,
    generatedAt: timestampSchema,
    manifest: z.discriminatedUnion("status", [
      parsedManifestSchema,
      invalidManifestSchema,
      unreadableManifestSchema,
      missingManifestSchema,
    ]),
    lockfiles: z.array(lockfileSchema),
    provenanceHints: z.array(provenanceHintSchema),
    source: z
      .object({
        candidateFiles: z.number().int().nonnegative(),
        scannedFiles: z.array(scannedSourceFileSchema),
        skippedFiles: z.array(skippedSourceFileSchema),
        signals: z.array(sourceSignalSchema),
      })
      .strict(),
    limitations: z.array(z.string().min(1)),
  })
  .strict();

export type StaticFileEvidenceV1 = z.infer<typeof staticFileEvidenceV1Schema>;
export type StaticEvidenceReferenceV1 = z.infer<
  typeof staticEvidenceReferenceV1Schema
>;
export type StaticCapability = z.infer<typeof staticCapabilitySchema>;
export type NodePackageStaticInspectionV1 = z.infer<
  typeof nodePackageStaticInspectionV1Schema
>;
