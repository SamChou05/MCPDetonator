import { readFile } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve } from "node:path";

import { valid as validSemver } from "semver";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

const linuxAbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/"), "must be an absolute Linux path")
  .refine(
    (value) => !value.split("/").includes(".."),
    "must not contain parent-directory segments",
  );

const safeCommandPartSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "must not contain a null byte");

const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reservedEnvironmentNames = new Set([
  "HOME",
  "PATH",
  "FORGE_EVIDENCE_DIR",
  "FORGE_TARGET_HOME",
  "FORGE_TARGET_ROOT",
  "FORGE_TARGET_WORKSPACE",
]);

const runtimeEnvironmentSchema = z
  .record(
    z.string().regex(environmentNamePattern, "must be a valid environment variable name"),
    z
      .string()
      .max(16_384)
      .refine((value) => !value.includes("\0"), "must not contain a null byte"),
  )
  .refine(
    (environment) =>
      Object.keys(environment).every(
        (name) => !reservedEnvironmentNames.has(name) && !name.startsWith("FORGE_"),
      ),
    "must not override Forge, HOME, or PATH environment variables",
  );

const expectedNetworkDestinationSchema = z
  .object({
    address: z.string().min(1),
    port: z.number().int().min(1).max(65_535).optional(),
  })
  .strict();

export const expectedScopeV1Schema = z
  .object({
    fileReads: z.array(linuxAbsolutePathSchema),
    fileReadPrefixes: z.array(linuxAbsolutePathSchema).default([]),
    fileWrites: z.array(linuxAbsolutePathSchema),
    fileWritePrefixes: z.array(linuxAbsolutePathSchema).default([]),
    networkConnections: z.array(expectedNetworkDestinationSchema),
    childExecutables: z.array(linuxAbsolutePathSchema),
    childExecutablePrefixes: z.array(linuxAbsolutePathSchema).default([]),
  })
  .strict();

const toolExperimentV1Schema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    tool: z.string().min(1),
    input: z.record(z.string(), z.json()),
    expected: expectedScopeV1Schema,
  })
  .strict();

const workflowStepV1Schema = z
  .object({
    tool: z.string().min(1),
    input: z.record(z.string(), z.json()),
  })
  .strict();

const workflowExperimentV1Schema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    steps: z.array(workflowStepV1Schema).min(2),
    expected: expectedScopeV1Schema,
  })
  .strict();

const npmSourceV1Schema = z
  .object({
    type: z.literal("npm"),
    package: z
      .string()
      .regex(packageNamePattern, "must be an exact npm package name"),
    version: z
      .string()
      .refine(
        (value) => validSemver(value) !== null,
        "must be one exact semantic version, not a tag or range",
      ),
  })
  .strict();

const fixtureSourceV1Schema = z
  .object({
    type: z.literal("fixture"),
    path: z.string().min(1),
  })
  .strict();

const localSourceV1Schema = z
  .object({
    type: z.literal("local"),
    path: z.string().min(1),
    install: z.enum(["none", "npm-ignore-scripts"]).default("none"),
  })
  .strict();

export const targetConfigV1Schema = z
  .object({
    schema: z.literal("forge.target/v1"),
    target: z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9-]*$/),
        source: z.discriminatedUnion("type", [
          npmSourceV1Schema,
          localSourceV1Schema,
          fixtureSourceV1Schema,
        ]),
        runtime: z
          .object({
            transport: z.literal("stdio"),
            command: safeCommandPartSchema,
            args: z.array(safeCommandPartSchema),
            cwd: linuxAbsolutePathSchema.default("/opt/target"),
            env: runtimeEnvironmentSchema.default({}),
          })
          .strict(),
      })
      .strict(),
    sandbox: z
      .object({
        profile: z.literal("developer-v1"),
        network: z.literal("blocked"),
        limits: z
          .object({
            timeoutMs: z.number().int().min(100).max(120_000),
            installTimeoutMs: z
              .number()
              .int()
              .min(1_000)
              .max(300_000)
              .default(60_000),
            cooldownMs: z.number().int().min(0).max(10_000),
            memoryMb: z.number().int().min(64).max(4_096),
            cpus: z.number().positive().max(4),
            pids: z.number().int().min(8).max(512),
          })
          .strict(),
      })
      .strict(),
    experiments: z
      .object({
        initialization: z.boolean(),
        tools: z.array(toolExperimentV1Schema).min(1),
        workflows: z
          .array(workflowExperimentV1Schema)
          .max(
            0,
            "workflow experiments are not implemented; workflows must be empty",
          ),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = [
      ...config.experiments.tools.map((experiment) => experiment.id),
      ...config.experiments.workflows.map((experiment) => experiment.id),
    ];
    const seen = new Set<string>();

    for (const id of ids) {
      if (seen.has(id)) {
        context.addIssue({
          code: "custom",
          message: `experiment id '${id}' must be unique`,
          path: ["experiments"],
        });
      }
      seen.add(id);
    }
  });

export type ExpectedScopeV1 = z.infer<typeof expectedScopeV1Schema>;
export type TargetConfigV1 = z.infer<typeof targetConfigV1Schema>;

export interface LoadedTargetConfig {
  readonly config: TargetConfigV1;
  readonly configPath: string;
  readonly configDirectory: string;
}

export class TargetConfigError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TargetConfigError";
  }
}

function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "target";
      return `${location}: ${issue.message}`;
    })
    .join("\n");
}

export async function loadTargetConfig(configPath: string): Promise<LoadedTargetConfig> {
  const absoluteConfigPath = resolve(configPath);
  let source: string;

  try {
    source = await readFile(absoluteConfigPath, "utf8");
  } catch (error) {
    throw new TargetConfigError(`cannot read target config: ${absoluteConfigPath}`, {
      cause: error,
    });
  }

  let document: unknown;
  try {
    document = parseYaml(source, { maxAliasCount: 20, uniqueKeys: true });
  } catch (error) {
    throw new TargetConfigError(`target config is not valid YAML: ${absoluteConfigPath}`, {
      cause: error,
    });
  }

  const result = targetConfigV1Schema.safeParse(document);
  if (!result.success) {
    throw new TargetConfigError(
      `target config failed validation:\n${formatValidationError(result.error)}`,
    );
  }

  return {
    config: result.data,
    configPath: absoluteConfigPath,
    configDirectory: resolve(absoluteConfigPath, ".."),
  };
}

export function resolveFixturePath(loaded: LoadedTargetConfig): string | undefined {
  if (loaded.config.target.source.type !== "fixture") {
    return undefined;
  }

  const configuredPath = loaded.config.target.source.path;
  const resolvedPath = isAbsolute(configuredPath)
    ? normalize(configuredPath)
    : resolve(loaded.configDirectory, configuredPath);
  const relation = relative(loaded.configDirectory, resolvedPath);

  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new TargetConfigError(
      "fixture source must remain inside the target config directory",
    );
  }

  return resolvedPath;
}

/**
 * Resolve a host directory selected by the operator. The returned directory is
 * snapshotted before execution; it is never executed directly on the host.
 * `fixture` remains as a backwards-compatible source spelling for the controlled
 * test package, while new configurations should use `local`.
 */
export function resolveLocalSourcePath(
  loaded: LoadedTargetConfig,
): string | undefined {
  if (
    loaded.config.target.source.type !== "local" &&
    loaded.config.target.source.type !== "fixture"
  ) {
    return undefined;
  }

  const configuredPath = loaded.config.target.source.path;
  return isAbsolute(configuredPath)
    ? normalize(configuredPath)
    : resolve(loaded.configDirectory, configuredPath);
}
