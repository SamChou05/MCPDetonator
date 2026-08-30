import { createHash } from "node:crypto";

export const CANONICAL_JSON_ALGORITHM = "rfc8785-jcs" as const;

export type CanonicalJsonErrorReason =
  | "accessor_property"
  | "cyclic_value"
  | "invalid_unicode"
  | "non_enumerable_property"
  | "non_finite_number"
  | "non_json_value"
  | "non_plain_object"
  | "sparse_array"
  | "symbol_property";

export class CanonicalJsonError extends TypeError {
  public constructor(
    readonly reason: CanonicalJsonErrorReason,
    readonly pointer: string,
    detail: string,
  ) {
    super(`cannot canonicalize JSON at ${pointer || "/"}: ${detail}`);
    this.name = "CanonicalJsonError";
  }
}

function pointerChild(pointer: string, segment: string | number): string {
  const escaped = String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${pointer}/${escaped}`;
}

function firstLoneSurrogate(value: string): number | undefined {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        following < 0xdc00 ||
        following > 0xdfff
      ) {
        return index;
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return index;
  }
  return undefined;
}

function assertUnicodeScalarSequence(value: string, pointer: string): void {
  const invalidIndex = firstLoneSurrogate(value);
  if (invalidIndex !== undefined) {
    throw new CanonicalJsonError(
      "invalid_unicode",
      pointer,
      `string contains a lone UTF-16 surrogate at code-unit ${invalidIndex}`,
    );
  }
}

function compareUtf16CodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isArrayIndex(key: string, length: number): boolean {
  if (key === "0") return length > 0;
  if (!/^[1-9][0-9]*$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function stringifyString(value: string): string {
  // JSON.stringify follows the ECMAScript string escaping required by JCS.
  // Unicode scalar validation is performed before this helper is called.
  return JSON.stringify(value);
}

/**
 * Canonicalize an in-memory JSON value using RFC 8785/JCS semantics.
 *
 * Object names are sorted by their unescaped UTF-16 code units, array order is
 * preserved, and strings are not Unicode-normalized. Values that cannot have
 * originated in strict I-JSON are rejected instead of being silently omitted
 * or coerced by JSON.stringify.
 */
export function canonicalizeJson(value: unknown): string {
  const activeObjects = new WeakSet<object>();

  function render(item: unknown, pointer: string): string {
    if (item === null) return "null";

    switch (typeof item) {
      case "string":
        assertUnicodeScalarSequence(item, pointer || "/");
        return stringifyString(item);
      case "boolean":
        return item ? "true" : "false";
      case "number": {
        if (!Number.isFinite(item)) {
          throw new CanonicalJsonError(
            "non_finite_number",
            pointer,
            "numbers must be finite IEEE-754 values",
          );
        }
        const serialized = JSON.stringify(item);
        if (serialized === undefined) {
          throw new CanonicalJsonError(
            "non_json_value",
            pointer,
            "number did not serialize as JSON",
          );
        }
        return serialized;
      }
      case "undefined":
      case "bigint":
      case "function":
      case "symbol":
        throw new CanonicalJsonError(
          "non_json_value",
          pointer,
          `${typeof item} is not a JSON value`,
        );
      case "object":
        break;
    }

    if (activeObjects.has(item)) {
      throw new CanonicalJsonError(
        "cyclic_value",
        pointer,
        "cyclic references are not JSON",
      );
    }

    activeObjects.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype) {
          throw new CanonicalJsonError(
            "non_plain_object",
            pointer,
            "array subclasses and arrays with custom prototypes are not accepted",
          );
        }

        for (const key of Reflect.ownKeys(item)) {
          if (typeof key === "symbol") {
            throw new CanonicalJsonError(
              "symbol_property",
              pointer,
              "symbol properties are not JSON",
            );
          }
          if (key !== "length" && !isArrayIndex(key, item.length)) {
            throw new CanonicalJsonError(
              "non_json_value",
              pointerChild(pointer, key),
              "arrays may contain only indexed JSON elements",
            );
          }
        }

        const elements: string[] = [];
        for (let index = 0; index < item.length; index += 1) {
          const childPointer = pointerChild(pointer, index);
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (descriptor === undefined) {
            throw new CanonicalJsonError(
              "sparse_array",
              childPointer,
              "sparse array elements are not JSON values",
            );
          }
          if (!("value" in descriptor)) {
            throw new CanonicalJsonError(
              "accessor_property",
              childPointer,
              "accessor properties are not accepted",
            );
          }
          if (!descriptor.enumerable) {
            throw new CanonicalJsonError(
              "non_enumerable_property",
              childPointer,
              "non-enumerable array elements are not accepted",
            );
          }
          elements.push(render(descriptor.value, childPointer));
        }
        return `[${elements.join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new CanonicalJsonError(
          "non_plain_object",
          pointer,
          "only plain objects are accepted",
        );
      }

      const entries: Array<readonly [string, PropertyDescriptor]> = [];
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key === "symbol") {
          throw new CanonicalJsonError(
            "symbol_property",
            pointer,
            "symbol properties are not JSON",
          );
        }
        assertUnicodeScalarSequence(key, pointerChild(pointer, key));
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new CanonicalJsonError(
            "accessor_property",
            pointerChild(pointer, key),
            "accessor properties are not accepted",
          );
        }
        if (!descriptor.enumerable) {
          throw new CanonicalJsonError(
            "non_enumerable_property",
            pointerChild(pointer, key),
            "non-enumerable properties are not accepted",
          );
        }
        entries.push([key, descriptor]);
      }

      entries.sort(([left], [right]) => compareUtf16CodeUnits(left, right));
      return `{${entries
        .map(
          ([key, descriptor]) =>
            `${stringifyString(key)}:${render(
              descriptor.value,
              pointerChild(pointer, key),
            )}`,
        )
        .join(",")}}`;
    } finally {
      activeObjects.delete(item);
    }
  }

  return render(value, "");
}

export function canonicalJsonSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJson(value), "utf8")
    .digest("hex");
}

/**
 * Hash a canonical, versioned domain envelope. Using an object envelope keeps
 * component boundaries unambiguous and ensures that changing the domain or
 * projection version necessarily changes the digest.
 */
export function digestCanonicalJson(
  domain: string,
  version: string,
  payload: unknown,
): string {
  if (domain.length === 0) throw new TypeError("digest domain must not be empty");
  if (version.length === 0) {
    throw new TypeError("digest version must not be empty");
  }
  return canonicalJsonSha256({ domain, payload, version });
}
