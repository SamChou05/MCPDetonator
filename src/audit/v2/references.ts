import { V2CompileError } from "./errors.js";
import type { JsonTraversalLimits } from "../../mcp/json-bounds.js";
import { V2_ARGUMENT_LIMITS } from "./schema-safety.js";
import { cloneStrictBoundedJson } from "./strict-clone.js";

export interface ResolvedSyntheticResource {
  readonly alias: string;
  readonly containerPath: string;
}

export interface StaticResourceReferenceAnalysis {
  readonly aliases: ReadonlySet<string>;
  readonly hasUnclassifiedValues: boolean;
}

const markerKeys = new Set([
  "$forgeResource",
  "$forgeOutput",
  "$forgeBinding",
]);

const forbiddenExecutableKeys = new Set([
  "binary",
  "cmd",
  "code",
  "command",
  "env",
  "environment",
  "executable",
  "install",
  "package",
  "script",
  "shell",
]);

const pathFieldTokens = new Set([
  "cwd",
  "dir",
  "dirs",
  "directory",
  "directories",
  "file",
  "files",
  "filename",
  "filenames",
  "filepath",
  "filepaths",
  "path",
  "paths",
]);

const networkFieldTokens = new Set([
  "address",
  "addresses",
  "destination",
  "destinations",
  "endpoint",
  "endpoints",
  "host",
  "hosts",
  "hostname",
  "hostnames",
  "port",
  "ports",
  "socket",
  "sockets",
  "uri",
  "uris",
  "url",
  "urls",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safetyVariants(value: string): ReadonlySet<string> {
  const variants = new Set<string>();
  const addVariants = (candidate: string): void => {
    const normalized = candidate.normalize("NFKC");
    const slashNormalized = candidate.replace(/[\u2044\u2215]/gu, "/");
    variants.add(candidate);
    variants.add(normalized);
    variants.add(slashNormalized);
    variants.add(normalized.replace(/[\u2044\u2215]/gu, "/"));
    variants.add(slashNormalized.normalize("NFKC"));
  };
  addVariants(value);
  let encodedCandidate = value;
  for (let pass = 0; pass < 2; pass += 1) {
    if (!/%[0-9A-Fa-f]{2}/u.test(encodedCandidate)) break;
    let decoded: string;
    try {
      decoded = decodeURIComponent(encodedCandidate);
    } catch {
      decoded = encodedCandidate.replace(
        /%([0-9A-Fa-f]{2})/gu,
        (encoded, hex: string) => {
          const byte = Number.parseInt(hex, 16);
          return byte <= 0x7f ? String.fromCharCode(byte) : encoded;
        },
      );
    }
    addVariants(decoded);
    if (decoded === encodedCandidate) break;
    encodedCandidate = decoded;
  }

  return variants;
}

function assertSafeLiteralString(
  value: string,
  allowedSyntheticPaths?: ReadonlySet<string>,
): void {

  for (const candidate of safetyVariants(value)) {
    if (/[\u0000-\u001f\u007f]/u.test(candidate)) {
      throw new V2CompileError(
        "unsafe_reference",
        "control characters are forbidden in V2 arguments",
      );
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(candidate)) {
      throw new V2CompileError(
        "unsafe_reference",
        "arbitrary URI references are forbidden in V2 arguments",
      );
    }
    if (/^(?:[A-Za-z]:[\\/]|\\\\|~[\\/])/u.test(candidate)) {
      throw new V2CompileError(
        "unsafe_reference",
        "host filesystem paths are forbidden in V2 arguments",
      );
    }
    if (/(^|[\\/])\.\.([\\/]|$)/u.test(candidate)) {
      throw new V2CompileError(
        "unsafe_reference",
        "path traversal is forbidden in V2 arguments",
      );
    }
    if (candidate.startsWith("/")) {
      if (
        candidate === value &&
        allowedSyntheticPaths?.has(candidate) === true
      ) {
        continue;
      }
      throw new V2CompileError(
        "unsafe_reference",
        "literal absolute paths are forbidden; use a synthetic resource alias",
      );
    }
    if (
      candidate.includes("$(") ||
      candidate.includes("${") ||
      candidate.includes("`") ||
      /(?:process\.env|\$[A-Z_][A-Z0-9_]*|%[A-Z_][A-Z0-9_]*%)/u.test(
        candidate,
      )
    ) {
      throw new V2CompileError(
        "unsafe_reference",
        "executable interpolation or environment references are forbidden",
      );
    }
  }
}

function fieldToken(key: string): string {
  const separated = key
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((segment) => segment.length > 0);
  return separated.at(-1) ?? "";
}

function isExactResourceMarker(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value["$forgeResource"] === "string"
  );
}

function assertReferenceFieldBindings(
  value: Record<string, unknown>,
  allowedSyntheticPaths?: ReadonlySet<string>,
): void {
  for (const [key, child] of Object.entries(value)) {
    const token = fieldToken(key);
    if (networkFieldTokens.has(token)) {
      throw new V2CompileError(
        "binding_unsupported",
        `network-like argument field '${key}' is unsupported in Phase 1A`,
      );
    }
    if (!pathFieldTokens.has(token)) continue;
    if (
      isPlainRecord(child) &&
      Object.keys(child).some((childKey) => childKey.startsWith("$forge"))
    ) {
      continue;
    }
    if (isExactResourceMarker(child)) continue;
    if (
      typeof child === "string" &&
      allowedSyntheticPaths?.has(child) === true
    ) {
      continue;
    }
    throw new V2CompileError(
      "unsafe_reference",
      `path-like argument field '${key}' requires an exact synthetic resource alias`,
    );
  }
}

function assertSafeKeys(keys: readonly string[]): void {
  for (const key of keys) {
    assertSafeLiteralString(key);
    for (const candidate of safetyVariants(key)) {
      if (
        forbiddenExecutableKeys.has(candidate.toLowerCase()) ||
        forbiddenExecutableKeys.has(fieldToken(candidate))
      ) {
        throw new V2CompileError(
          "unsafe_reference",
          "raw executable, script, package, or environment fields are forbidden",
        );
      }
    }
  }
}

function resolveValue(
  value: unknown,
  resources: ReadonlyMap<string, ResolvedSyntheticResource>,
): unknown {
  if (typeof value === "string") {
    assertSafeLiteralString(value);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, resources));
  }
  if (!isPlainRecord(value)) return value;

  const keys = Object.keys(value);
  assertSafeKeys(keys);
  assertReferenceFieldBindings(value);
  const presentMarkers = keys.filter((key) => markerKeys.has(key));
  if (
    presentMarkers.length === 0 &&
    keys.some((key) => key.startsWith("$forge"))
  ) {
    throw new V2CompileError(
      "binding_unsupported",
      "unknown Forge argument bindings are forbidden",
    );
  }
  if (presentMarkers.length > 0) {
    if (
      keys.length !== 1 ||
      presentMarkers[0] !== "$forgeResource" ||
      typeof value["$forgeResource"] !== "string"
    ) {
      throw new V2CompileError(
        "binding_unsupported",
        "only a whole-value $forgeResource alias is supported in Phase 1A",
      );
    }
    const alias = value["$forgeResource"];
    const resource = resources.get(alias);
    if (resource === undefined) {
      throw new V2CompileError(
        "resource_unknown",
        `unknown synthetic resource alias '${alias}'`,
      );
    }
    return resource.containerPath;
  }

  return Object.fromEntries(
    keys.map((key) => [key, resolveValue(value[key], resources)]),
  );
}

export function analyzeStaticResourceReferences(
  value: unknown,
  limits: JsonTraversalLimits = V2_ARGUMENT_LIMITS,
): StaticResourceReferenceAnalysis {
  const bounded = cloneStrictBoundedJson(
    value,
    limits,
    "unresolved V2 tool arguments",
  ).clone;
  const aliases = new Set<string>();
  let hasUnclassifiedValues = false;
  const stack: unknown[] = [bounded];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === null || typeof item !== "object") {
      hasUnclassifiedValues = true;
      continue;
    }
    if (Array.isArray(item)) {
      for (const child of item) stack.push(child);
      continue;
    }
    if (!isPlainRecord(item)) continue;
    const keys = Object.keys(item);
    assertSafeKeys(keys);
    assertReferenceFieldBindings(item);
    const presentMarkers = keys.filter((key) => markerKeys.has(key));
    if (
      presentMarkers.length === 0 &&
      keys.some((key) => key.startsWith("$forge"))
    ) {
      throw new V2CompileError(
        "binding_unsupported",
        "unknown Forge argument bindings are forbidden",
      );
    }
    if (presentMarkers.length > 0) {
      if (
        keys.length !== 1 ||
        presentMarkers[0] !== "$forgeResource" ||
        typeof item["$forgeResource"] !== "string"
      ) {
        throw new V2CompileError(
          "binding_unsupported",
          "only a whole-value $forgeResource alias is supported in Phase 1A",
        );
      }
      aliases.add(item["$forgeResource"]);
      continue;
    }
    for (const child of Object.values(item)) stack.push(child);
  }
  return Object.freeze({ aliases, hasUnclassifiedValues });
}

export function collectStaticResourceAliases(
  value: unknown,
  limits: JsonTraversalLimits = V2_ARGUMENT_LIMITS,
): ReadonlySet<string> {
  return analyzeStaticResourceReferences(value, limits).aliases;
}

export function assertResolvedPlanArguments(
  value: unknown,
  allowedSyntheticPaths: ReadonlySet<string>,
  limits: JsonTraversalLimits = V2_ARGUMENT_LIMITS,
): void {
  const bounded = cloneStrictBoundedJson(
    value,
    limits,
    "resolved ExperimentPlan arguments",
  ).clone;
  const stack: unknown[] = [bounded];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === "string") {
      assertSafeLiteralString(item, allowedSyntheticPaths);
      continue;
    }
    if (Array.isArray(item)) {
      for (const child of item) stack.push(child);
      continue;
    }
    if (!isPlainRecord(item)) continue;
    const keys = Object.keys(item);
    assertSafeKeys(keys);
    assertReferenceFieldBindings(item, allowedSyntheticPaths);
    if (keys.some((key) => markerKeys.has(key) || key.startsWith("$forge"))) {
      throw new V2CompileError(
        "binding_unsupported",
        "ExperimentPlan arguments must not contain unresolved Forge bindings",
      );
    }
    for (const child of Object.values(item)) stack.push(child);
  }
}

export function resolveStaticResourceReferences(
  value: unknown,
  resources: ReadonlyMap<string, ResolvedSyntheticResource>,
  limits: JsonTraversalLimits = V2_ARGUMENT_LIMITS,
): unknown {
  const bounded = cloneStrictBoundedJson(
    value,
    limits,
    "unresolved V2 tool arguments",
  ).clone;
  return cloneStrictBoundedJson(
    resolveValue(bounded, resources),
    limits,
    "resolved V2 tool arguments",
  ).clone;
}
