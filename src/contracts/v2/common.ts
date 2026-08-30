import { z } from "zod";

export const V2_CONTRACT_LIMITS = {
  identifierCharacters: 128,
  shortTextCharacters: 512,
  descriptionCharacters: 4_096,
  longTextCharacters: 65_536,
  contentCharacters: 1_048_576,
  arrayItems: 1_024,
  jsonDepth: 64,
  jsonNodes: 20_000,
  jsonObjectKeys: 512,
  jsonArrayItems: 2_048,
  artifactBytes: 1_073_741_824,
} as const;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const toolNamePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const jsonPointerPattern = /^(?:|(?:\/(?:[^~/]|~[01])*)+)$/;

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function boundedString(maximum: number) {
  return z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => !containsLoneSurrogate(value), {
      message: "strings must not contain lone UTF-16 surrogate code units",
    });
}

export const identifierV2Schema = boundedString(
  V2_CONTRACT_LIMITS.identifierCharacters,
).regex(identifierPattern);

export const toolNameV2Schema = boundedString(
  V2_CONTRACT_LIMITS.identifierCharacters,
).regex(toolNamePattern);

export const shortTextV2Schema = boundedString(
  V2_CONTRACT_LIMITS.shortTextCharacters,
);

export const descriptionV2Schema = boundedString(
  V2_CONTRACT_LIMITS.descriptionCharacters,
);

export const longTextV2Schema = boundedString(V2_CONTRACT_LIMITS.longTextCharacters);

export const sha256V2Schema = z.string().regex(/^[a-f0-9]{64}$/);

const canonicalUtcMillisecondPattern =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

export const timestampV2Schema = z
  .string()
  .length(24)
  .regex(canonicalUtcMillisecondPattern)
  .refine((value) => {
    const epochMilliseconds = Date.parse(value);
    return (
      Number.isFinite(epochMilliseconds) &&
      new Date(epochMilliseconds).toISOString() === value
    );
  }, "timestamp must be a real canonical UTC instant at millisecond precision");

export const jsonPointerV2Schema = z
  .string()
  .max(V2_CONTRACT_LIMITS.shortTextCharacters)
  .regex(jsonPointerPattern);

export const nonnegativeSafeIntegerV2Schema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

export const positiveSafeIntegerV2Schema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

export const componentIdentityV2Schema = z
  .object({
    id: identifierV2Schema,
    version: shortTextV2Schema,
  })
  .strict();

export function addDuplicateIssues<T>(
  values: readonly T[],
  key: (value: T) => string,
  ctx: z.RefinementCtx,
  pathPrefix: PropertyKey[],
  label: string,
): void {
  const firstIndex = new Map<string, number>();
  values.forEach((value, index) => {
    const identity = key(value);
    const previous = firstIndex.get(identity);
    if (previous !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate ${label} ${JSON.stringify(identity)} (first at index ${previous})`,
        path: [...pathPrefix, index],
      });
      return;
    }
    firstIndex.set(identity, index);
  });
}

function validateBoundedJson(value: unknown, ctx: z.RefinementCtx): void {
  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number; path: PropertyKey[] }> = [
    { value, depth: 0, path: [] },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    nodes += 1;
    if (nodes > V2_CONTRACT_LIMITS.jsonNodes) {
      ctx.addIssue({
        code: "custom",
        message: `JSON values may contain at most ${V2_CONTRACT_LIMITS.jsonNodes} nodes`,
      });
      return;
    }
    if (current.depth > V2_CONTRACT_LIMITS.jsonDepth) {
      ctx.addIssue({
        code: "custom",
        message: `JSON values may be at most ${V2_CONTRACT_LIMITS.jsonDepth} levels deep`,
        path: current.path,
      });
      continue;
    }
    if (typeof current.value === "string") {
      if (current.value.length > V2_CONTRACT_LIMITS.longTextCharacters) {
        ctx.addIssue({
          code: "custom",
          message: `JSON strings may contain at most ${V2_CONTRACT_LIMITS.longTextCharacters} characters`,
          path: current.path,
        });
      } else if (containsLoneSurrogate(current.value)) {
        ctx.addIssue({
          code: "custom",
          message: "JSON strings must not contain lone UTF-16 surrogate code units",
          path: current.path,
        });
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > V2_CONTRACT_LIMITS.jsonArrayItems) {
        ctx.addIssue({
          code: "custom",
          message: `JSON arrays may contain at most ${V2_CONTRACT_LIMITS.jsonArrayItems} items`,
          path: current.path,
        });
        continue;
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: current.value[index],
          depth: current.depth + 1,
          path: [...current.path, index],
        });
      }
      continue;
    }
    if (current.value !== null && typeof current.value === "object") {
      const entries = Object.entries(current.value);
      if (entries.length > V2_CONTRACT_LIMITS.jsonObjectKeys) {
        ctx.addIssue({
          code: "custom",
          message: `JSON objects may contain at most ${V2_CONTRACT_LIMITS.jsonObjectKeys} keys`,
          path: current.path,
        });
        continue;
      }
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry === undefined) {
          continue;
        }
        const [key, child] = entry;
        if (key.length > V2_CONTRACT_LIMITS.shortTextCharacters) {
          ctx.addIssue({
            code: "custom",
            message: `JSON object keys may contain at most ${V2_CONTRACT_LIMITS.shortTextCharacters} characters`,
            path: [...current.path, key],
          });
        } else if (containsLoneSurrogate(key)) {
          ctx.addIssue({
            code: "custom",
            message: "JSON object keys must not contain lone UTF-16 surrogate code units",
            path: [...current.path, key],
          });
        }
        stack.push({
          value: child,
          depth: current.depth + 1,
          path: [...current.path, key],
        });
      }
    }
  }
}

export const boundedJsonValueV2Schema = z.json().superRefine(validateBoundedJson);

export type ComponentIdentityV2 = z.infer<typeof componentIdentityV2Schema>;
export type BoundedJsonValueV2 = z.infer<typeof boundedJsonValueV2Schema>;
