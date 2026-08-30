import { Buffer } from "node:buffer";

import {
  exactByteArrayLength,
  snapshotExactByteArray,
} from "./bytes.js";

export interface StrictJsonLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxTotalStringCharacters: number;
  readonly maxKeyCharacters: number;
  readonly maxArrayItems: number;
  readonly maxObjectKeys: number;
}

export const DEFAULT_STRICT_JSON_LIMITS: StrictJsonLimits = Object.freeze({
  maxBytes: 1_048_576,
  maxDepth: 64,
  maxNodes: 50_000,
  maxTotalStringCharacters: 524_288,
  maxKeyCharacters: 1_024,
  maxArrayItems: 10_000,
  maxObjectKeys: 10_000,
});

export type StrictJsonErrorCode =
  | "array_item_limit"
  | "depth_limit"
  | "duplicate_key"
  | "input_byte_limit"
  | "invalid_json"
  | "invalid_unicode"
  | "key_character_limit"
  | "node_limit"
  | "non_finite_number"
  | "object_key_limit"
  | "string_character_limit"
  | "trailing_content";

export class StrictJsonError extends SyntaxError {
  public constructor(
    readonly code: StrictJsonErrorCode,
    readonly offset: number,
    detail: string,
  ) {
    super(`strict JSON ${code} at code-unit ${offset}: ${detail}`);
    this.name = "StrictJsonError";
  }
}

const limitNames = new Set<keyof StrictJsonLimits>(
  Object.keys(DEFAULT_STRICT_JSON_LIMITS) as Array<keyof StrictJsonLimits>,
);

function resolveLimits(overrides: Partial<StrictJsonLimits>): StrictJsonLimits {
  const prototype = Object.getPrototypeOf(overrides);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("strict JSON limit overrides must be a plain object");
  }
  for (const key of Reflect.ownKeys(overrides)) {
    if (typeof key !== "string" || !limitNames.has(key as keyof StrictJsonLimits)) {
      throw new TypeError(`unknown strict JSON limit: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(overrides, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`strict JSON limit ${key} must be a data property`);
    }
  }

  const limits = { ...DEFAULT_STRICT_JSON_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
  return limits;
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

class Parser {
  private index = 0;
  private nodes = 0;
  private stringCharacters = 0;

  public constructor(
    private readonly source: string,
    private readonly limits: StrictJsonLimits,
  ) {}

  public parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      this.fail("trailing_content", "unexpected content after the JSON value");
    }
    return value;
  }

  private fail(code: StrictJsonErrorCode, detail: string, offset = this.index): never {
    throw new StrictJsonError(code, offset, detail);
  }

  private registerNode(depth: number): void {
    if (depth > this.limits.maxDepth) {
      this.fail("depth_limit", `maximum depth is ${this.limits.maxDepth}`);
    }
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) {
      this.fail("node_limit", `maximum node count is ${this.limits.maxNodes}`);
    }
  }

  private parseValue(depth: number): unknown {
    this.registerNode(depth);
    const character = this.source[this.index];
    switch (character) {
      case '"':
        return this.parseString(false);
      case "{":
        return this.parseObject(depth);
      case "[":
        return this.parseArray(depth);
      case "t":
        return this.parseLiteral("true", true);
      case "f":
        return this.parseLiteral("false", false);
      case "n":
        return this.parseLiteral("null", null);
      default:
        if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) {
          return this.parseNumber();
        }
        this.fail("invalid_json", "expected a JSON value");
    }
  }

  private parseLiteral<T>(token: string, value: T): T {
    if (this.source.slice(this.index, this.index + token.length) !== token) {
      this.fail("invalid_json", `expected ${token}`);
    }
    this.index += token.length;
    return value;
  }

  private parseNumber(): number {
    const start = this.index;
    if (this.source[this.index] === "-") this.index += 1;

    if (this.source[this.index] === "0") {
      this.index += 1;
      const following = this.source[this.index];
      if (following !== undefined && following >= "0" && following <= "9") {
        this.fail("invalid_json", "numbers may not contain a leading zero");
      }
    } else {
      const first = this.source[this.index];
      if (first === undefined || first < "1" || first > "9") {
        this.fail("invalid_json", "expected a digit");
      }
      do {
        this.index += 1;
      } while (
        this.source[this.index] !== undefined &&
        this.source[this.index]! >= "0" &&
        this.source[this.index]! <= "9"
      );
    }

    if (this.source[this.index] === ".") {
      this.index += 1;
      const firstFraction = this.source[this.index];
      if (
        firstFraction === undefined ||
        firstFraction < "0" ||
        firstFraction > "9"
      ) {
        this.fail("invalid_json", "fractional part requires a digit");
      }
      do {
        this.index += 1;
      } while (
        this.source[this.index] !== undefined &&
        this.source[this.index]! >= "0" &&
        this.source[this.index]! <= "9"
      );
    }

    if (this.source[this.index] === "e" || this.source[this.index] === "E") {
      this.index += 1;
      if (this.source[this.index] === "+" || this.source[this.index] === "-") {
        this.index += 1;
      }
      const firstExponent = this.source[this.index];
      if (
        firstExponent === undefined ||
        firstExponent < "0" ||
        firstExponent > "9"
      ) {
        this.fail("invalid_json", "exponent requires a digit");
      }
      do {
        this.index += 1;
      } while (
        this.source[this.index] !== undefined &&
        this.source[this.index]! >= "0" &&
        this.source[this.index]! <= "9"
      );
    }

    const value = Number(this.source.slice(start, this.index));
    if (!Number.isFinite(value)) {
      this.fail(
        "non_finite_number",
        "number is outside the finite IEEE-754 range",
        start,
      );
    }
    return value;
  }

  private parseString(isKey: boolean): string {
    const start = this.index;
    this.index += 1;
    const characters: string[] = [];
    let characterCount = 0;

    const append = (value: string): void => {
      characterCount += value.length;
      this.stringCharacters += value.length;
      if (isKey && characterCount > this.limits.maxKeyCharacters) {
        this.fail(
          "key_character_limit",
          `maximum decoded key length is ${this.limits.maxKeyCharacters}`,
          start,
        );
      }
      if (this.stringCharacters > this.limits.maxTotalStringCharacters) {
        this.fail(
          "string_character_limit",
          `maximum aggregate decoded string length is ${this.limits.maxTotalStringCharacters}`,
          start,
        );
      }
      characters.push(value);
    };

    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        const result = characters.join("");
        const invalidIndex = firstLoneSurrogate(result);
        if (invalidIndex !== undefined) {
          this.fail(
            "invalid_unicode",
            `decoded string contains a lone UTF-16 surrogate at code-unit ${invalidIndex}`,
            start,
          );
        }
        return result;
      }
      if (character === "\\") {
        this.index += 1;
        const escape = this.source[this.index];
        this.index += 1;
        switch (escape) {
          case '"':
          case "\\":
          case "/":
            append(escape);
            break;
          case "b":
            append("\b");
            break;
          case "f":
            append("\f");
            break;
          case "n":
            append("\n");
            break;
          case "r":
            append("\r");
            break;
          case "t":
            append("\t");
            break;
          case "u": {
            const hexadecimal = this.source.slice(this.index, this.index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hexadecimal)) {
              this.fail("invalid_json", "Unicode escape requires four hexadecimal digits");
            }
            append(String.fromCharCode(Number.parseInt(hexadecimal, 16)));
            this.index += 4;
            break;
          }
          default:
            this.fail("invalid_json", "invalid string escape");
        }
        continue;
      }
      if (character === undefined || character.charCodeAt(0) <= 0x1f) {
        this.fail("invalid_json", "unescaped control character in string");
      }
      append(character);
      this.index += 1;
    }
    this.fail("invalid_json", "unterminated string", start);
  }

  private parseArray(depth: number): unknown[] {
    this.index += 1;
    this.skipWhitespace();
    const result: unknown[] = [];
    if (this.source[this.index] === "]") {
      this.index += 1;
      return result;
    }

    while (true) {
      if (result.length >= this.limits.maxArrayItems) {
        this.fail(
          "array_item_limit",
          `maximum array length is ${this.limits.maxArrayItems}`,
        );
      }
      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const separator = this.source[this.index];
      if (separator === "]") {
        this.index += 1;
        return result;
      }
      if (separator !== ",") {
        this.fail("invalid_json", "expected ',' or ']' in array");
      }
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.index += 1;
    this.skipWhitespace();
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return result;
    }

    while (true) {
      if (keys.size >= this.limits.maxObjectKeys) {
        this.fail(
          "object_key_limit",
          `maximum object property count is ${this.limits.maxObjectKeys}`,
        );
      }
      if (this.source[this.index] !== '"') {
        this.fail("invalid_json", "object property name must be a string");
      }
      const keyOffset = this.index;
      const key = this.parseString(true);
      if (keys.has(key)) {
        this.fail("duplicate_key", `duplicate decoded object key ${JSON.stringify(key)}`, keyOffset);
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ":") {
        this.fail("invalid_json", "expected ':' after object property name");
      }
      this.index += 1;
      this.skipWhitespace();
      const value = this.parseValue(depth + 1);
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
      this.skipWhitespace();
      const separator = this.source[this.index];
      if (separator === "}") {
        this.index += 1;
        return result;
      }
      if (separator !== ",") {
        this.fail("invalid_json", "expected ',' or '}' in object");
      }
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private skipWhitespace(): void {
    while (
      this.source[this.index] === " " ||
      this.source[this.index] === "\t" ||
      this.source[this.index] === "\n" ||
      this.source[this.index] === "\r"
    ) {
      this.index += 1;
    }
  }
}

/**
 * Parse bounded JSON without first passing through JSON.parse, so duplicate
 * decoded names (for example `"a"` and `"\\u0061"`) cannot be erased before
 * contract validation.
 */
export function parseStrictJson(
  input: string | Uint8Array,
  limitOverrides: Partial<StrictJsonLimits> = {},
): unknown {
  const limits = resolveLimits(limitOverrides);
  const byteLength =
    typeof input === "string"
      ? Buffer.byteLength(input, "utf8")
      : exactByteArrayLength(input);
  if (byteLength === undefined) {
    throw new TypeError("strict JSON input must be a string or exact, unshared byte array");
  }
  if (byteLength > limits.maxBytes) {
    throw new StrictJsonError(
      "input_byte_limit",
      0,
      `input is ${byteLength} bytes; maximum is ${limits.maxBytes}`,
    );
  }

  let source: string;
  if (typeof input === "string") {
    source = input;
  } else {
    const snapshot = snapshotExactByteArray(input, "strict JSON input");
    try {
      source = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(snapshot);
    } catch {
      throw new StrictJsonError(
        "invalid_unicode",
        0,
        "input is not valid UTF-8",
      );
    }
  }

  const invalidSourceIndex = firstLoneSurrogate(source);
  if (invalidSourceIndex !== undefined) {
    throw new StrictJsonError(
      "invalid_unicode",
      invalidSourceIndex,
      "input contains a lone UTF-16 surrogate",
    );
  }
  return new Parser(source, limits).parse();
}
