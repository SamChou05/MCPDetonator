import {
  JsonLimitError,
  type JsonTraversalLimits,
  type JsonTraversalMetrics,
} from "../../mcp/json-bounds.js";
import { isProxy } from "node:util/types";
import { canonicalizeJson } from "./canonical.js";
import { parseStrictJson } from "./strict-json.js";

export const V2_ARTIFACT_CLONE_LIMITS: JsonTraversalLimits = Object.freeze({
  maxDepth: 64,
  maxNodes: 100_000,
  maxObjectKeys: 2_048,
  maxStringCharacters: 2_000_000,
  maxSerializedBytes: 4_000_000,
});

interface VisitFrame {
  readonly kind: "visit";
  readonly value: unknown;
  readonly pointer: string;
  readonly depth: number;
  readonly destination?: object;
  readonly destinationKey?: string | number;
}

interface LeaveFrame {
  readonly kind: "leave";
  readonly value: object;
}

type Frame = VisitFrame | LeaveFrame;

function assignDetachedValue(
  frame: VisitFrame,
  value: unknown,
  root: { value?: unknown },
): void {
  if (frame.destination === undefined) {
    root.value = value;
    return;
  }
  if (Array.isArray(frame.destination)) {
    frame.destination[frame.destinationKey as number] = value;
    return;
  }
  Object.defineProperty(frame.destination, frame.destinationKey as string, {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

function pointerChild(pointer: string, segment: string | number): string {
  const escaped = String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${pointer}/${escaped}`;
}

function validateLimits(limits: JsonTraversalLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
}

function rejectNonJson(pointer: string, label: string): never {
  throw new JsonLimitError(
    "non_json_value",
    pointer || "/",
    undefined,
    label,
  );
}

/**
 * Bound and detach decoded JSON without JSON.stringify, property enumeration,
 * or any user-defined conversion hook. Hidden fields, symbol fields,
 * accessors, decorated arrays, and custom prototypes are rejected rather than
 * erased. Only after this iterative pass is the small plain-data value
 * canonicalized and reparsed.
 */
export function cloneStrictBoundedJson<T>(
  value: T,
  limits: JsonTraversalLimits,
  label: string,
): { readonly clone: T; readonly metrics: JsonTraversalMetrics } {
  validateLimits(limits);
  let nodes = 0;
  let reservedNodes = 1;
  let stringCharacters = 0;
  let maximumDepth = 0;
  const active = new WeakSet<object>();
  const detachedRoot: { value?: unknown } = {};
  const stack: Frame[] = [
    { kind: "visit", value, pointer: "", depth: 0 },
  ];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.kind === "leave") {
      active.delete(frame.value);
      continue;
    }
    if (frame.depth > limits.maxDepth) {
      throw new JsonLimitError(
        "json_depth_limit",
        frame.pointer || "/",
        limits.maxDepth,
        label,
      );
    }
    maximumDepth = Math.max(maximumDepth, frame.depth);
    nodes += 1;
    if (nodes > limits.maxNodes) {
      throw new JsonLimitError(
        "json_node_limit",
        frame.pointer || "/",
        limits.maxNodes,
        label,
      );
    }

    const item = frame.value;
    if (item === null || typeof item === "boolean") {
      assignDetachedValue(frame, item, detachedRoot);
      continue;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) rejectNonJson(frame.pointer, label);
      assignDetachedValue(frame, item, detachedRoot);
      continue;
    }
    if (typeof item === "string") {
      stringCharacters += item.length;
      if (stringCharacters > limits.maxStringCharacters) {
        throw new JsonLimitError(
          "string_character_limit",
          frame.pointer || "/",
          limits.maxStringCharacters,
          label,
        );
      }
      assignDetachedValue(frame, item, detachedRoot);
      continue;
    }
    if (typeof item !== "object") rejectNonJson(frame.pointer, label);
    if (isProxy(item)) rejectNonJson(frame.pointer, label);
    if (active.has(item)) {
      throw new JsonLimitError(
        "cyclic_value",
        frame.pointer || "/",
        undefined,
        label,
      );
    }

    const prototype = Object.getPrototypeOf(item);
    if (
      Array.isArray(item)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    ) {
      rejectNonJson(frame.pointer, label);
    }
    active.add(item);
    stack.push({ kind: "leave", value: item });

    const ownKeys = Reflect.ownKeys(item);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      rejectNonJson(frame.pointer, label);
    }

    if (Array.isArray(item)) {
      const stringKeys = ownKeys as string[];
      if (
        stringKeys.length !== item.length + 1 ||
        !stringKeys.includes("length")
      ) {
        rejectNonJson(frame.pointer, label);
      }
      if (reservedNodes + item.length > limits.maxNodes) {
        throw new JsonLimitError(
          "json_node_limit",
          frame.pointer || "/",
          limits.maxNodes,
          label,
        );
      }
      reservedNodes += item.length;
      const detached: unknown[] = new Array(item.length);
      assignDetachedValue(frame, detached, detachedRoot);
      for (let index = item.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable
        ) {
          rejectNonJson(pointerChild(frame.pointer, index), label);
        }
        stack.push({
          kind: "visit",
          value: descriptor.value,
          pointer: pointerChild(frame.pointer, index),
          depth: frame.depth + 1,
          destination: detached,
          destinationKey: index,
        });
      }
      continue;
    }

    const detached: Record<string, unknown> = {};
    assignDetachedValue(frame, detached, detachedRoot);
    const keys = ownKeys as string[];
    if (keys.length > limits.maxObjectKeys) {
      throw new JsonLimitError(
        "object_key_limit",
        frame.pointer || "/",
        limits.maxObjectKeys,
        label,
      );
    }
    if (reservedNodes + keys.length > limits.maxNodes) {
      throw new JsonLimitError(
        "json_node_limit",
        frame.pointer || "/",
        limits.maxNodes,
        label,
      );
    }
    reservedNodes += keys.length;
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key === undefined) continue;
      stringCharacters += key.length;
      if (stringCharacters > limits.maxStringCharacters) {
        throw new JsonLimitError(
          "string_character_limit",
          pointerChild(frame.pointer, key),
          limits.maxStringCharacters,
          label,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        rejectNonJson(pointerChild(frame.pointer, key), label);
      }
      stack.push({
        kind: "visit",
        value: descriptor.value,
        pointer: pointerChild(frame.pointer, key),
        depth: frame.depth + 1,
        destination: detached,
        destinationKey: key,
      });
    }
  }

  const detached = detachedRoot.value;
  const canonical = canonicalizeJson(detached);
  const serializedBytes = Buffer.byteLength(canonical, "utf8");
  if (serializedBytes > limits.maxSerializedBytes) {
    throw new JsonLimitError(
      "serialized_byte_limit",
      "/",
      limits.maxSerializedBytes,
      label,
    );
  }
  const clone = parseStrictJson(canonical, {
    maxBytes: limits.maxSerializedBytes,
    maxDepth: limits.maxDepth,
    maxNodes: limits.maxNodes,
    maxTotalStringCharacters: limits.maxStringCharacters,
    maxKeyCharacters: limits.maxStringCharacters,
    maxArrayItems: limits.maxNodes,
    maxObjectKeys: limits.maxObjectKeys,
  }) as T;
  return {
    clone,
    metrics: { nodes, stringCharacters, serializedBytes, maximumDepth },
  };
}
