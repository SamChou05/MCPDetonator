export interface JsonTraversalLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxObjectKeys: number;
  readonly maxStringCharacters: number;
  readonly maxSerializedBytes: number;
}

export interface JsonTraversalMetrics {
  readonly nodes: number;
  readonly stringCharacters: number;
  readonly serializedBytes: number;
  readonly maximumDepth: number;
}

export type JsonLimitReason =
  | "tool_limit"
  | "json_depth_limit"
  | "json_node_limit"
  | "object_key_limit"
  | "string_character_limit"
  | "serialized_byte_limit"
  | "non_json_value"
  | "cyclic_value";

export class JsonLimitError extends Error {
  public constructor(
    readonly reason: JsonLimitReason,
    readonly pointer: string,
    readonly limit: number | undefined,
    label: string,
  ) {
    super(
      `${label} exceeds deterministic ${reason} at ${pointer}` +
        (limit === undefined ? "" : ` (limit ${limit})`),
    );
    this.name = "JsonLimitError";
  }
}

interface MutableMetrics {
  nodes: number;
  stringCharacters: number;
  serializedBytes: number;
  maximumDepth: number;
}

interface VisitFrame {
  readonly kind: "visit";
  readonly value: unknown;
  readonly pointer: string;
  readonly depth: number;
}

interface LeaveFrame {
  readonly kind: "leave";
  readonly value: object;
}

type TraversalFrame = VisitFrame | LeaveFrame;

const maximumDiagnosticSegmentCharacters = 128;

function pointerChild(pointer: string, segment: string | number): string {
  const source = String(segment);
  const bounded =
    source.length <= maximumDiagnosticSegmentCharacters
      ? source
      : `${source.slice(0, maximumDiagnosticSegmentCharacters)}…`;
  const escaped = bounded.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${pointer}/${escaped}`;
}

function addSerializedBytes(
  bytes: number,
  pointer: string,
  limits: JsonTraversalLimits,
  metrics: MutableMetrics,
  label: string,
): void {
  metrics.serializedBytes += bytes;
  if (metrics.serializedBytes > limits.maxSerializedBytes) {
    throw new JsonLimitError(
      "serialized_byte_limit",
      pointer,
      limits.maxSerializedBytes,
      label,
    );
  }
}

function addString(
  value: string,
  pointer: string,
  limits: JsonTraversalLimits,
  metrics: MutableMetrics,
  label: string,
): number {
  metrics.stringCharacters += value.length;
  if (metrics.stringCharacters > limits.maxStringCharacters) {
    throw new JsonLimitError(
      "string_character_limit",
      pointer,
      limits.maxStringCharacters,
      label,
    );
  }
  // JSON.stringify of one scalar string is non-recursive. The character limit
  // above bounds both this allocation and the UTF-8 byte scan.
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function validateLimits(limits: JsonTraversalLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative safe integer`);
    }
  }
}

function sortedBoundedObjectKeys(
  value: Record<string, unknown>,
  pointer: string,
  limits: JsonTraversalLimits,
  remainingNodes: number,
  metrics: MutableMetrics,
  label: string,
): string[] {
  const keys: string[] = [];
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (keys.length >= limits.maxObjectKeys) {
      throw new JsonLimitError(
        "object_key_limit",
        pointer,
        limits.maxObjectKeys,
        label,
      );
    }
    if (keys.length >= remainingNodes) {
      throw new JsonLimitError(
        "json_node_limit",
        pointer,
        limits.maxNodes,
        label,
      );
    }
    const keyBytes = addString(key, pointer, limits, metrics, label);
    addSerializedBytes(
      keyBytes + 1 + (keys.length === 0 ? 0 : 1),
      pointer,
      limits,
      metrics,
      label,
    );
    keys.push(key);
  }
  keys.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return keys;
}

/**
 * Iteratively validate and size a JSON value before any recursive stringify,
 * schema traversal, or persistence. Parsed wire messages are plain data, and
 * rejecting accessors/non-plain objects prevents preflight from invoking code.
 */
export function preflightBoundedJson(
  value: unknown,
  limits: JsonTraversalLimits,
  label: string,
): JsonTraversalMetrics {
  validateLimits(limits);
  const metrics: MutableMetrics = {
    nodes: 0,
    stringCharacters: 0,
    serializedBytes: 0,
    maximumDepth: 0,
  };
  const activeObjects = new WeakSet<object>();
  let reservedNodes = 1;
  const stack: TraversalFrame[] = [
    { kind: "visit", value, pointer: "", depth: 0 },
  ];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.kind === "leave") {
      activeObjects.delete(frame.value);
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
    metrics.maximumDepth = Math.max(metrics.maximumDepth, frame.depth);
    metrics.nodes += 1;
    if (metrics.nodes > limits.maxNodes) {
      throw new JsonLimitError(
        "json_node_limit",
        frame.pointer || "/",
        limits.maxNodes,
        label,
      );
    }

    const item = frame.value;
    if (item === null) {
      addSerializedBytes(4, frame.pointer || "/", limits, metrics, label);
      continue;
    }
    if (typeof item === "string") {
      addSerializedBytes(
        addString(item, frame.pointer || "/", limits, metrics, label),
        frame.pointer || "/",
        limits,
        metrics,
        label,
      );
      continue;
    }
    if (typeof item === "boolean") {
      addSerializedBytes(
        item ? 4 : 5,
        frame.pointer || "/",
        limits,
        metrics,
        label,
      );
      continue;
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      addSerializedBytes(
        JSON.stringify(item).length,
        frame.pointer || "/",
        limits,
        metrics,
        label,
      );
      continue;
    }
    if (typeof item !== "object") {
      throw new JsonLimitError(
        "non_json_value",
        frame.pointer || "/",
        undefined,
        label,
      );
    }
    if (activeObjects.has(item)) {
      throw new JsonLimitError(
        "cyclic_value",
        frame.pointer || "/",
        undefined,
        label,
      );
    }

    const prototype = Object.getPrototypeOf(item);
    if (
      !Array.isArray(item) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new JsonLimitError(
        "non_json_value",
        frame.pointer || "/",
        undefined,
        label,
      );
    }

    activeObjects.add(item);
    stack.push({ kind: "leave", value: item });
    if (Array.isArray(item)) {
      const remainingNodes = limits.maxNodes - reservedNodes;
      if (item.length > remainingNodes) {
        throw new JsonLimitError(
          "json_node_limit",
          frame.pointer || "/",
          limits.maxNodes,
          label,
        );
      }
      reservedNodes += item.length;
      addSerializedBytes(
        2 + Math.max(0, item.length - 1),
        frame.pointer || "/",
        limits,
        metrics,
        label,
      );
      for (let index = item.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new JsonLimitError(
            "non_json_value",
            pointerChild(frame.pointer, index),
            undefined,
            label,
          );
        }
        stack.push({
          kind: "visit",
          value: descriptor.value,
          pointer: pointerChild(frame.pointer, index),
          depth: frame.depth + 1,
        });
      }
      continue;
    }

    addSerializedBytes(2, frame.pointer || "/", limits, metrics, label);
    const record = item as Record<string, unknown>;
    const keys = sortedBoundedObjectKeys(
      record,
      frame.pointer || "/",
      limits,
      limits.maxNodes - reservedNodes,
      metrics,
      label,
    );
    reservedNodes += keys.length;
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key === undefined) continue;
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new JsonLimitError(
          "non_json_value",
          pointerChild(frame.pointer, key),
          undefined,
          label,
        );
      }
      stack.push({
        kind: "visit",
        value: descriptor.value,
        pointer: pointerChild(frame.pointer, key),
        depth: frame.depth + 1,
      });
    }
  }

  return metrics;
}

export function cloneBoundedJson<T>(
  value: T,
  limits: JsonTraversalLimits,
  label: string,
): { readonly clone: T; readonly metrics: JsonTraversalMetrics } {
  const metrics = preflightBoundedJson(value, limits, label);
  // The iterative preflight has already bounded depth, nodes, strings, and
  // bytes and rejected accessors/cycles, so these recursive built-ins now have
  // a small, deterministic input envelope.
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new JsonLimitError("non_json_value", "/", undefined, label);
  }
  const actualBytes = Buffer.byteLength(serialized, "utf8");
  if (actualBytes !== metrics.serializedBytes) {
    throw new Error(`${label} changed while it was being bounded`);
  }
  return {
    clone: JSON.parse(serialized) as T,
    metrics,
  };
}
