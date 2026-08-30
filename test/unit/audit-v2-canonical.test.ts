import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import {
  CanonicalJsonError,
  canonicalizeJson,
  canonicalJsonSha256,
  digestCanonicalJson,
} from "../../src/audit/v2/canonical.js";
import {
  parseStrictJson,
  StrictJsonError,
  type StrictJsonLimits,
} from "../../src/audit/v2/strict-json.js";

describe("V2 RFC 8785 canonical JSON", () => {
  it("matches the RFC 8785 serialization sample", () => {
    const value = {
      numbers: [
        333333333.33333329,
        1e30,
        4.5,
        2e-3,
        0.000000000000000000000000001,
      ],
      string: "€$\u000f\nA'B\"\\\\\"/",
      literals: [null, true, false],
    };

    expect(canonicalizeJson(value)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\\"\\\\\\\\\\\"/"}',
    );
  });

  it("sorts names by unescaped UTF-16 code units and preserves array order", () => {
    const value = {
      "\ufb33": 7,
      "😀": 6,
      "€": 5,
      "ö": 4,
      "\u0080": 3,
      "1": 2,
      "\r": 1,
      array: ["third", "first", "second"],
    };

    expect(canonicalizeJson(value)).toBe(
      '{"\\r":1,"1":2,"array":["third","first","second"],"":3,"ö":4,"€":5,"😀":6,"דּ":7}',
    );
  });

  it("does not normalize Unicode", () => {
    const decomposed = "e\u0301";
    const composed = "é";

    expect(canonicalizeJson({ [composed]: composed, [decomposed]: decomposed })).toBe(
      `{"${decomposed}":"${decomposed}","${composed}":"${composed}"}`,
    );
    expect(canonicalJsonSha256(composed)).not.toBe(
      canonicalJsonSha256(decomposed),
    );
  });

  it("is insensitive to object insertion order but sensitive to substitution", () => {
    const left = { z: [3, 2, 1], nested: { beta: true, alpha: null } };
    const reordered = { nested: { alpha: null, beta: true }, z: [3, 2, 1] };
    const substituted = { nested: { alpha: null, beta: false }, z: [3, 2, 1] };

    expect(canonicalJsonSha256(left)).toBe(canonicalJsonSha256(reordered));
    expect(canonicalJsonSha256(left)).not.toBe(
      canonicalJsonSha256(substituted),
    );
  });

  it("domain-separates projection name, version, and payload", () => {
    const digest = digestCanonicalJson("forge.test", "v1", { allowed: true });

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toBe(
      digestCanonicalJson("forge.other", "v1", { allowed: true }),
    );
    expect(digest).not.toBe(
      digestCanonicalJson("forge.test", "v2", { allowed: true }),
    );
    expect(digest).not.toBe(
      digestCanonicalJson("forge.test", "v1", { allowed: false }),
    );
  });

  it.each([NaN, Infinity, -Infinity])("rejects non-finite number %s", (value) => {
    expect(() => canonicalizeJson(value)).toThrowError(
      expect.objectContaining({ reason: "non_finite_number" }),
    );
  });

  it.each([undefined, 1n, () => undefined, Symbol("not-json")])(
    "rejects non-JSON scalar %s",
    (value) => {
      expect(() => canonicalizeJson(value)).toThrow(CanonicalJsonError);
    },
  );

  it("rejects sparse, accessor-backed, and decorated arrays", () => {
    const sparse = new Array(1);
    const accessor = ["safe"];
    let invoked = false;
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        invoked = true;
        return "unsafe";
      },
    });
    const decorated = ["safe"] as string[] & { note?: string };
    decorated.note = "hidden from JSON.stringify";

    expect(() => canonicalizeJson(sparse)).toThrowError(
      expect.objectContaining({ reason: "sparse_array" }),
    );
    expect(() => canonicalizeJson(accessor)).toThrowError(
      expect.objectContaining({ reason: "accessor_property" }),
    );
    expect(invoked).toBe(false);
    expect(() => canonicalizeJson(decorated)).toThrow(CanonicalJsonError);
  });

  it("rejects accessors, hidden fields, symbol fields, and non-plain objects", () => {
    let invoked = false;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        invoked = true;
        return "unsafe";
      },
    });
    const hidden = Object.defineProperty({}, "secret", { value: "ignored" });
    const symbol = { visible: true } as Record<PropertyKey, unknown>;
    symbol[Symbol("hidden")] = true;

    expect(() => canonicalizeJson(accessor)).toThrowError(
      expect.objectContaining({ reason: "accessor_property" }),
    );
    expect(invoked).toBe(false);
    expect(() => canonicalizeJson(hidden)).toThrowError(
      expect.objectContaining({ reason: "non_enumerable_property" }),
    );
    expect(() => canonicalizeJson(symbol)).toThrowError(
      expect.objectContaining({ reason: "symbol_property" }),
    );
    expect(() => canonicalizeJson(new Date(0))).toThrowError(
      expect.objectContaining({ reason: "non_plain_object" }),
    );
  });

  it("rejects cycles and lone surrogates", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => canonicalizeJson(cyclic)).toThrowError(
      expect.objectContaining({ reason: "cyclic_value" }),
    );
    expect(() => canonicalizeJson("\ud800")).toThrowError(
      expect.objectContaining({ reason: "invalid_unicode" }),
    );
    expect(() => canonicalizeJson({ ["\udc00"]: true })).toThrowError(
      expect.objectContaining({ reason: "invalid_unicode" }),
    );
  });
});

describe("V2 strict raw JSON parser", () => {
  it("parses ordinary data without prototype-key mutation", () => {
    const value = parseStrictJson(
      '{"safe":[null,true,false,-0,1.25e2],"__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;

    expect(value.safe).toEqual([null, true, false, -0, 125]);
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it.each([
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"😀":1,"\\ud83d\\ude00":2}',
  ])("rejects duplicate decoded keys in %s", (source) => {
    expect(() => parseStrictJson(source)).toThrowError(
      expect.objectContaining({ code: "duplicate_key" }),
    );
  });

  it("keeps canonically equivalent but distinct Unicode keys separate", () => {
    expect(parseStrictJson('{"é":1,"e\\u0301":2}')).toEqual({
      é: 1,
      "e\u0301": 2,
    });
  });

  it.each([
    ["maxBytes", '"four"', { maxBytes: 5 }, "input_byte_limit"],
    ["maxDepth", "[[0]]", { maxDepth: 1 }, "depth_limit"],
    ["maxNodes", "[0,1]", { maxNodes: 2 }, "node_limit"],
    [
      "maxTotalStringCharacters",
      '["ab","cd"]',
      { maxTotalStringCharacters: 3 },
      "string_character_limit",
    ],
    ["maxKeyCharacters", '{"long":1}', { maxKeyCharacters: 3 }, "key_character_limit"],
    ["maxArrayItems", "[0,1]", { maxArrayItems: 1 }, "array_item_limit"],
    ["maxObjectKeys", '{"a":1,"b":2}', { maxObjectKeys: 1 }, "object_key_limit"],
  ] as const)("enforces the %s limit", (_name, source, limits, code) => {
    expect(() =>
      parseStrictJson(source, limits as Partial<StrictJsonLimits>),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it.each([
    ["01", "invalid_json"],
    ["1.", "invalid_json"],
    ["[1,]", "invalid_json"],
    ['{"a":1} trailing', "trailing_content"],
    ['"\\ud800"', "invalid_unicode"],
    ["1e400", "non_finite_number"],
    ["\ufeffnull", "invalid_json"],
  ] as const)("rejects invalid input %j", (source, code) => {
    expect(() => parseStrictJson(source)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("rejects invalid UTF-8 before parsing", () => {
    expect(() => parseStrictJson(Uint8Array.from([0xc3, 0x28]))).toThrowError(
      expect.objectContaining({ code: "invalid_unicode" }),
    );
  });

  it("enforces byte limits from typed-array internal slots", () => {
    class MisreportedBytes extends Uint8Array {
      public override get byteLength(): number {
        return 0;
      }
    }
    expect(() =>
      parseStrictJson(new MisreportedBytes(Buffer.from("null", "utf8"))),
    ).toThrow("exact, unshared byte array");

    const exact = new Uint8Array(Buffer.from("null", "utf8"));
    let getterCalls = 0;
    Object.defineProperty(exact, "byteLength", {
      get() {
        getterCalls += 1;
        return 0;
      },
    });
    expect(() => parseStrictJson(exact, { maxBytes: 3 })).toThrowError(
      expect.objectContaining({ code: "input_byte_limit" }),
    );
    expect(getterCalls).toBe(0);
  });

  it("rejects malformed limit configuration", () => {
    expect(() => parseStrictJson("null", { maxNodes: -1 })).toThrow(RangeError);
    expect(() =>
      parseStrictJson("null", { unexpected: 1 } as Partial<StrictJsonLimits>),
    ).toThrow(TypeError);
    expect(() => parseStrictJson("null", Object.create({ maxNodes: 1 }))).toThrow(
      TypeError,
    );
  });

  it("surfaces structured parse errors", () => {
    try {
      parseStrictJson('{"a":1,"a":2}');
      throw new Error("expected parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(StrictJsonError);
      expect(error).toMatchObject({ code: "duplicate_key" });
    }
  });
});
