import type { ValidateFunction } from "ajv";

import {
  type JsonTraversalLimits,
} from "../../mcp/json-bounds.js";
import {
  compileInputSchema,
  type InputSchemaDialect,
} from "../../mcp/input-schema.js";
import { cloneStrictBoundedJson } from "./strict-clone.js";

export const V2_SCHEMA_LIMITS: JsonTraversalLimits = Object.freeze({
  maxDepth: 24,
  maxNodes: 4_096,
  maxObjectKeys: 256,
  maxStringCharacters: 131_072,
  maxSerializedBytes: 262_144,
});

export const V2_ARGUMENT_LIMITS: JsonTraversalLimits = Object.freeze({
  maxDepth: 20,
  maxNodes: 4_096,
  maxObjectKeys: 256,
  maxStringCharacters: 131_072,
  maxSerializedBytes: 262_144,
});

const unsupportedSchemaKeywords = new Set([
  "$async",
  "$ref",
  "$dynamicRef",
  "$recursiveRef",
  "format",
  "pattern",
  "patternProperties",
  "uniqueItems",
]);

export const V2_SCHEMA_COMPLEXITY_LIMITS = Object.freeze({
  maxBranchesPerCombinator: 32,
  maxCombinatorBranches: 128,
  maxConditionalKeywords: 32,
  maxEnumValues: 256,
});

const combinatorKeywords = new Set(["allOf", "anyOf", "oneOf"]);
const conditionalKeywords = new Set(["if", "then", "else", "not"]);

export interface SafeInputValidation {
  readonly arguments: unknown;
  readonly dialect: InputSchemaDialect;
}

function assertPlainSchemaObject(schema: unknown): asserts schema is object {
  if (
    typeof schema !== "object" ||
    schema === null ||
    Array.isArray(schema)
  ) {
    throw new Error("V2 tool input schema must be a JSON object");
  }
}

/**
 * Phase 1A deliberately accepts a narrower JSON Schema subset than AJV.
 * References can create unexpectedly large or recursive compilation graphs,
 * while catalog-controlled regular expressions execute in the controller.
 * Unsupported features reduce coverage; they never silently become a pass.
 */
export function assertSafeInputSchema(schema: unknown): void {
  assertPlainSchemaObject(schema);
  const detached = cloneStrictBoundedJson(
    schema,
    V2_SCHEMA_LIMITS,
    "V2 tool input schema",
  ).clone;
  const stack: unknown[] = [detached];
  let combinatorBranches = 0;
  let conditionalKeywordCount = 0;

  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    if (typeof value !== "object" || value === null) continue;

    for (const [key, child] of Object.entries(value)) {
      if (unsupportedSchemaKeywords.has(key)) {
        throw new Error(
          `V2 Phase 1A does not support JSON Schema keyword '${key}'`,
        );
      }
      if (combinatorKeywords.has(key)) {
        if (!Array.isArray(child)) {
          throw new Error(`JSON Schema keyword '${key}' must be an array`);
        }
        if (
          child.length >
          V2_SCHEMA_COMPLEXITY_LIMITS.maxBranchesPerCombinator
        ) {
          throw new Error(
            `JSON Schema keyword '${key}' exceeds the Phase 1A branch limit`,
          );
        }
        combinatorBranches += child.length;
        if (
          combinatorBranches >
          V2_SCHEMA_COMPLEXITY_LIMITS.maxCombinatorBranches
        ) {
          throw new Error(
            "JSON Schema combinators exceed the Phase 1A aggregate branch limit",
          );
        }
      }
      if (conditionalKeywords.has(key)) {
        conditionalKeywordCount += 1;
        if (
          conditionalKeywordCount >
          V2_SCHEMA_COMPLEXITY_LIMITS.maxConditionalKeywords
        ) {
          throw new Error(
            "JSON Schema conditionals exceed the Phase 1A complexity limit",
          );
        }
      }
      if (
        key === "enum" &&
        Array.isArray(child) &&
        child.length > V2_SCHEMA_COMPLEXITY_LIMITS.maxEnumValues
      ) {
        throw new Error("JSON Schema enum exceeds the Phase 1A value limit");
      }
      stack.push(child);
    }
  }
}

function validateWithoutDiagnostics(
  validate: ValidateFunction<unknown>,
  argumentsValue: unknown,
): void {
  const valid = runSynchronousInputValidator(validate, argumentsValue);
  if (!valid) {
    throw new Error("V2 tool arguments do not satisfy the frozen input schema");
  }
}

export function runSynchronousInputValidator(
  validate: ValidateFunction<unknown>,
  argumentsValue: unknown,
): boolean {
  if ((validate as ValidateFunction<unknown> & { $async?: unknown }).$async === true) {
    throw new Error("V2 Phase 1A does not support asynchronous JSON Schema validation");
  }
  const result: unknown = validate(argumentsValue);
  if (typeof result !== "boolean") {
    if (
      typeof result === "object" &&
      result !== null &&
      "then" in result &&
      typeof result.then === "function"
    ) {
      void Promise.resolve(result).catch(() => undefined);
    }
    throw new Error("V2 JSON Schema validator returned a non-boolean result");
  }
  return result;
}

export function validateSafeToolArguments(
  inputSchema: unknown,
  argumentsValue: unknown,
  argumentLimits: JsonTraversalLimits = V2_ARGUMENT_LIMITS,
): SafeInputValidation {
  assertSafeInputSchema(inputSchema);
  const detachedArguments = cloneStrictBoundedJson(
    argumentsValue,
    argumentLimits,
    "V2 tool arguments",
  ).clone;
  const compiled = compileInputSchema(inputSchema, { strictSchema: true });
  validateWithoutDiagnostics(compiled.validate, detachedArguments);
  return {
    arguments: detachedArguments,
    dialect: compiled.dialect,
  };
}
