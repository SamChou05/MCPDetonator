import { createHash } from "node:crypto";

import {
  identifierV2Schema,
  outcomeContentAnalysisV2Schema,
  outcomeContentClassV2Schema,
  type OutcomeContentAnalysisV2,
  type OutcomeContentClassV2,
  type OutcomeHazardKindV2,
} from "../../contracts/v2/index.js";
import { exactByteArrayLength, exactByteArrayView } from "./bytes.js";
import { deepFreezeJson } from "./freeze.js";
import { parseStrictJson } from "./strict-json.js";

export const RESULT_CONTENT_ANALYZER_IDENTITY = Object.freeze({
  id: "forge-result-content-indicators",
  version: "1alpha1",
});

export const RESULT_CONTENT_ANALYSIS_LIMITS = Object.freeze({
  defaultMaxBytes: 65_536,
  hardMaxBytes: 262_144,
});

export interface AnalyzeResultContentInput {
  readonly content: string | Uint8Array;
  readonly evidenceReference: string;
  /** Whether the supplied bytes are the complete result or a retained prefix. */
  readonly sourceStatus: "complete" | "truncated";
  readonly maxBytes?: number;
}

interface MatchDescriptor {
  readonly kind: OutcomeHazardKindV2;
  readonly expression: RegExp;
  readonly classes: readonly OutcomeContentClassV2[];
}

const MATCH_DESCRIPTORS: readonly MatchDescriptor[] = [
  {
    kind: "instruction_override",
    expression:
      /\b(?:ignore|disregard|override|forget)\b[\s\S]{0,96}?\b(?:previous|prior|system|developer|instructions?|prompt)\b/iu,
    classes: ["instruction_like"],
  },
  {
    kind: "secret_request",
    expression:
      /\b(?:reveal|show|send|provide|return|expose|retrieve|read)\b[\s\S]{0,96}?\b(?:secret|credentials?|tokens?|api[ _-]?keys?|system prompt|passwords?)\b/iu,
    classes: ["instruction_like", "credential_like"],
  },
  {
    kind: "sensitive_data_claim",
    expression:
      /\b(?:leaked|exfiltrated|uploaded|sent|stolen)\b[\s\S]{0,96}?\b(?:customer|credential|private|secret|sensitive|data)\b/iu,
    classes: ["sensitive_data_claim"],
  },
  {
    kind: "credential_pattern",
    expression:
      /\b(?:sk-[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{12,}|(?:api[ _-]?key|token|password)\s*[:=]\s*[^\s,;]{4,})/u,
    classes: ["credential_like"],
  },
  {
    kind: "code_execution_payload",
    expression:
      /(?:\beval\s*\(|\bFunction\s*\(|\bchild_process\b|<script(?:\s|>))/iu,
    classes: ["code_like"],
  },
  {
    kind: "encoded_payload",
    expression: /(?:[A-Za-z0-9+/]{64,}={0,2}|[A-Za-z0-9_-]{80,})/u,
    classes: ["encoded_payload"],
  },
  {
    kind: "external_action_request",
    expression:
      /\b(?:visit|fetch|send|post|upload|open)\b[\s\S]{0,96}?https?:\/\/[^\s"'<>]+/iu,
    classes: ["instruction_like", "external_link"],
  },
] as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalClasses(
  values: Iterable<OutcomeContentClassV2>,
): OutcomeContentClassV2[] {
  const order = new Map(
    outcomeContentClassV2Schema.options.map((value, index) => [value, index]),
  );
  return [...new Set(values)].sort(
    (left, right) => order.get(left)! - order.get(right)!,
  );
}

function signal(
  kind: OutcomeHazardKindV2,
  matchBytes: Uint8Array,
  startByte: number,
  evidenceReference: string,
) {
  const digest = sha256(matchBytes);
  return {
    signalId: `signal-${kind}-${startByte}-${digest.slice(0, 12)}`,
    kind,
    detector: RESULT_CONTENT_ANALYZER_IDENTITY,
    startByte,
    endByteExclusive: startByte + matchBytes.byteLength,
    matchedBytesSha256: digest,
    evidenceReference,
  };
}

function firstControlByte(bytes: Uint8Array): number | undefined {
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index];
    if (
      byte !== undefined &&
      (byte <= 8 ||
        (byte >= 11 && byte <= 12) ||
        (byte >= 14 && byte <= 31) ||
        byte === 127)
    ) {
      return index;
    }
  }
  return undefined;
}

function isStructuredJson(text: string): boolean {
  try {
    const byteLength = Buffer.byteLength(text, "utf8");
    parseStrictJson(text, {
      maxBytes: RESULT_CONTENT_ANALYSIS_LIMITS.hardMaxBytes,
      maxDepth: 64,
      maxNodes: 20_000,
      maxTotalStringCharacters: byteLength,
      maxKeyCharacters: 1_024,
      maxArrayItems: 10_000,
      maxObjectKeys: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function assertNoLoneSurrogates(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (
        !Number.isInteger(following) ||
        following < 0xdc00 ||
        following > 0xdfff
      ) {
        throw new TypeError(
          "MCP result content contains an unpaired UTF-16 surrogate",
        );
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(
        "MCP result content contains an unpaired UTF-16 surrogate",
      );
    }
  }
}

/**
 * Extract bounded, hash-only lexical indicators from MCP result bytes. The
 * analyzer never retains matching text and never emits a maliciousness or
 * safety verdict. It is deliberately a partial evidence sensor.
 */
export function analyzeResultContent(
  input: AnalyzeResultContentInput,
): Readonly<OutcomeContentAnalysisV2> {
  if (input.sourceStatus !== "complete" && input.sourceStatus !== "truncated") {
    throw new TypeError("sourceStatus must be complete or truncated");
  }
  const evidenceReference = identifierV2Schema.parse(input.evidenceReference);
  const maxBytes =
    input.maxBytes ?? RESULT_CONTENT_ANALYSIS_LIMITS.defaultMaxBytes;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > RESULT_CONTENT_ANALYSIS_LIMITS.hardMaxBytes
  ) {
    throw new RangeError(
      `maxBytes must be a positive safe integer no greater than ${RESULT_CONTENT_ANALYSIS_LIMITS.hardMaxBytes}`,
    );
  }

  let totalByteLength: number;
  let prefix: Uint8Array;
  if (typeof input.content === "string") {
    // A JavaScript string whose code-unit length exceeds maxBytes cannot fit
    // in maxBytes of UTF-8. Slice before encoding so the analyzer's work and
    // allocation remain tied to its declared byte budget.
    let candidateEnd = Math.min(input.content.length, maxBytes);
    const lastCode = input.content.charCodeAt(candidateEnd - 1);
    const nextCode = input.content.charCodeAt(candidateEnd);
    if (
      candidateEnd < input.content.length &&
      lastCode >= 0xd800 &&
      lastCode <= 0xdbff &&
      nextCode >= 0xdc00 &&
      nextCode <= 0xdfff
    ) {
      candidateEnd += 1;
    }
    const candidate = input.content.slice(0, candidateEnd);
    assertNoLoneSurrogates(candidate);
    const candidateBytes = Buffer.from(candidate, "utf8");
    prefix = candidateBytes.subarray(0, maxBytes);
    totalByteLength =
      input.content.length > maxBytes
        ? maxBytes + 1
        : candidateBytes.byteLength;
  } else {
    const byteLength = exactByteArrayLength(input.content);
    if (byteLength === undefined) {
      throw new TypeError(
        "MCP result content must be an exact, unshared byte array",
      );
    }
    const view = exactByteArrayView(input.content, "MCP result content");
    prefix = new Uint8Array(Math.min(byteLength, maxBytes));
    Uint8Array.prototype.set.call(prefix, view.subarray(0, prefix.byteLength));
    totalByteLength = byteLength;
  }
  const coverage =
    input.sourceStatus === "complete" && totalByteLength <= maxBytes
      ? "complete"
      : "prefix";
  const classes = new Set<OutcomeContentClassV2>();
  const signals: ReturnType<typeof signal>[] = [];
  const limitations = [
    "Lexical content indicators do not establish malicious intent or semantic safety.",
    "Each detector retains only its first match in the analyzed projection.",
  ];

  const controlIndex = firstControlByte(prefix);
  if (controlIndex !== undefined) {
    signals.push(
      signal(
        "control_characters",
        prefix.subarray(controlIndex, controlIndex + 1),
        controlIndex,
        evidenceReference,
      ),
    );
    classes.add("control_characters");
  }

  let text: string | undefined;
  try {
    // Preserve an initial BOM as a decoded code point so UTF-8 byte offsets
    // remain relative to the exact analyzed projection.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      prefix,
    );
  } catch {
    classes.add("unknown");
    limitations.push(
      "The analyzed prefix was not valid UTF-8, so text-pattern coverage is unavailable.",
    );
  }

  if (text !== undefined && text.length > 0) {
    classes.add(isStructuredJson(text) ? "structured_data" : "plain_text");
    for (const descriptor of MATCH_DESCRIPTORS) {
      const match = descriptor.expression.exec(text);
      if (match?.index === undefined || match[0].length === 0) continue;
      const startByte = Buffer.byteLength(text.slice(0, match.index), "utf8");
      const matchedBytes = Buffer.from(match[0], "utf8");
      signals.push(
        signal(descriptor.kind, matchedBytes, startByte, evidenceReference),
      );
      descriptor.classes.forEach((contentClass) => classes.add(contentClass));
    }
    if (/https?:\/\/[^\s"'<>]+/iu.test(text)) classes.add("external_link");
  }

  if (coverage === "prefix") {
    limitations.push(
      input.sourceStatus === "truncated" && totalByteLength <= maxBytes
        ? "Content analysis covered only the retained result prefix."
        : `Content analysis was limited to the first ${maxBytes} bytes.`,
    );
  }
  const analysis = outcomeContentAnalysisV2Schema.parse({
    status: "assessed",
    analyzer: RESULT_CONTENT_ANALYZER_IDENTITY,
    analyzedBytes: prefix.byteLength,
    coverage,
    classes: canonicalClasses(classes),
    signals,
    limitations,
  });
  return deepFreezeJson(analysis);
}
