import { Buffer } from "node:buffer";
import { isProxy } from "node:util/types";

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)?.get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)?.get;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
)?.get;

if (
  typedArrayByteLength === undefined ||
  typedArrayBuffer === undefined ||
  typedArrayByteOffset === undefined
) {
  throw new Error("Uint8Array intrinsic accessors are unavailable");
}

/**
 * Read a byte-array length from the typed-array internal slot. Proxies,
 * subclasses, cross-realm values, and shared backing memory are rejected so a
 * caller cannot lie through an overridden accessor or mutate bytes while they
 * are being validated and hashed.
 */
export function exactByteArrayLength(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || isProxy(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) {
    return undefined;
  }
  const backing = Reflect.apply(typedArrayBuffer!, value, []) as ArrayBufferLike;
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    backing instanceof SharedArrayBuffer
  ) {
    return undefined;
  }
  return Reflect.apply(typedArrayByteLength!, value, []) as number;
}

export function snapshotExactByteArray(
  value: unknown,
  label: string,
): Uint8Array {
  const view = exactByteArrayView(value, label);
  const snapshot = new Uint8Array(view.byteLength);
  Uint8Array.prototype.set.call(snapshot, view);
  return snapshot;
}

/** Return a fresh, undecorated view over exact unshared storage without copying. */
export function exactByteArrayView(value: unknown, label: string): Uint8Array {
  const byteLength = exactByteArrayLength(value);
  if (byteLength === undefined) {
    throw new TypeError(`${label} must be an exact, unshared byte array`);
  }
  const backing = Reflect.apply(typedArrayBuffer!, value, []) as ArrayBuffer;
  const byteOffset = Reflect.apply(typedArrayByteOffset!, value, []) as number;
  return new Uint8Array(backing, byteOffset, byteLength);
}
