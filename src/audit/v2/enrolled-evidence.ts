import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256File } from "../../evidence-store.js";
import { canonicalizeJson, digestCanonicalJson } from "./canonical.js";
import type { RetainedEnrolledResources } from "./enrolled-authority.js";
import { parseStrictJson } from "./strict-json.js";

const MAX_TRANSCRIPT_INSPECTION_BYTES = 2_000_000;
const MAX_RESULT_TAINT_STRINGS = 1_024;
const MIN_RESULT_TAINT_CHARACTERS = 16;

export interface EnrolledTranscriptMetrics {
  readonly sha256: string;
  readonly byteLength: number;
  readonly messageCount: number;
  readonly toolsListRequests: number;
  readonly toolsCallRequests: number;
  readonly toolsListChangedNotifications: number;
  readonly followupCalls: number;
  readonly initializeRequests: number;
  readonly initializedNotifications: number;
  readonly unexpectedServerRequests: number;
  readonly unexpectedClientMethods: number;
  readonly sequenceContiguous: true;
}

/** Create the exact empty resource manifest used by the first enrollment alpha. */
export async function materializeEmptyEnrolledResources(
  manifestId: string,
): Promise<RetainedEnrolledResources> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "forge-enrolled-resources-"));
  const hostRoot = join(temporaryRoot, "resources");
  try {
    await chmod(temporaryRoot, 0o755);
    await mkdir(hostRoot, { mode: 0o555 });
    const manifest = {
      format: "forge.synthetic-resource-manifest/v2" as const,
      manifestId,
      instances: [] as const,
    };
    const manifestDigest = digestCanonicalJson(
      "forge.synthetic-resource-manifest",
      "v2",
      manifest,
    );

    const verify = async (): Promise<string> => {
      const metadata = await stat(hostRoot);
      if (!metadata.isDirectory()) {
        throw new Error("enrolled resource root is no longer a directory");
      }
      const entries = await readdir(hostRoot);
      if (entries.length !== 0) {
        throw new Error("empty enrolled resource manifest gained an entry");
      }
      return manifestDigest;
    };
    const dispose = async (): Promise<void> => {
      await chmod(hostRoot, 0o755).catch(() => undefined);
      await rm(temporaryRoot, { recursive: true, force: true });
    };
    await verify();
    return Object.freeze({ hostRoot, manifestDigest, verify, dispose });
  } catch (error) {
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "enrolled resource setup and cleanup both failed",
      );
    }
    throw error;
  }
}

export async function inspectEnrolledTranscript(
  path: string,
): Promise<Readonly<EnrolledTranscriptMetrics>> {
  const metadata = await stat(path);
  if (
    !metadata.isFile() ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 1 ||
    metadata.size > MAX_TRANSCRIPT_INSPECTION_BYTES
  ) {
    throw new Error("enrolled transcript is absent or outside its byte ceiling");
  }
  const source = await readFile(path, "utf8");
  let messageCount = 0;
  let toolsListRequests = 0;
  let toolsCallRequests = 0;
  let toolsListChangedNotifications = 0;
  let initializeRequests = 0;
  let initializedNotifications = 0;
  let unexpectedServerRequests = 0;
  let unexpectedClientMethods = 0;
  let expectedSequence = 0;
  const allowedClientMethods = new Set([
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/call",
  ]);
  for (const line of source.split("\n")) {
    if (line.length === 0) continue;
    messageCount += 1;
    const entry = parseStrictJson(line, {
      maxBytes: 1_100_000,
      maxDepth: 160,
      maxNodes: 100_000,
      maxTotalStringCharacters: 1_000_000,
      maxKeyCharacters: 1_024,
      maxArrayItems: 20_000,
      maxObjectKeys: 20_000,
    }) as Record<string, unknown>;
    const message = entry["message"] as Record<string, unknown> | undefined;
    if (entry["sequence"] !== expectedSequence) {
      throw new Error("enrolled transcript sequence is not contiguous");
    }
    expectedSequence += 1;
    if (entry["direction"] === "client_to_server") {
      if (message?.["method"] === "initialize") initializeRequests += 1;
      if (message?.["method"] === "notifications/initialized") {
        initializedNotifications += 1;
      }
      if (message?.["method"] === "tools/list") toolsListRequests += 1;
      if (message?.["method"] === "tools/call") toolsCallRequests += 1;
      if (
        typeof message?.["method"] === "string" &&
        !allowedClientMethods.has(message["method"])
      ) {
        unexpectedClientMethods += 1;
      }
    }
    if (
      entry["direction"] === "server_to_client" &&
      message?.["method"] === "notifications/tools/list_changed"
    ) {
      toolsListChangedNotifications += 1;
    }
    if (
      entry["direction"] === "server_to_client" &&
      typeof message?.["method"] === "string" &&
      Object.hasOwn(message, "id")
    ) {
      unexpectedServerRequests += 1;
    }
  }
  return Object.freeze({
    sha256: await sha256File(path),
    byteLength: metadata.size,
    messageCount,
    toolsListRequests,
    toolsCallRequests,
    toolsListChangedNotifications,
    followupCalls: Math.max(0, toolsCallRequests - 1),
    initializeRequests,
    initializedNotifications,
    unexpectedServerRequests,
    unexpectedClientMethods,
    sequenceContiguous: true,
  });
}

function collectStrings(value: unknown): Set<string> {
  const found = new Set<string>();
  const stack = [value];
  while (stack.length > 0 && found.size < MAX_RESULT_TAINT_STRINGS) {
    const current = stack.pop();
    if (typeof current === "string") {
      if (current.length >= MIN_RESULT_TAINT_CHARACTERS) found.add(current);
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (current !== null && typeof current === "object") {
      for (const child of Object.values(current as Record<string, unknown>)) {
        stack.push(child);
      }
    }
  }
  return found;
}

/**
 * Supplemental structural quarantine assertion. It extracts output-only long
 * strings and verifies that none entered a non-raw artifact. Hashes and bounded
 * lexical classes remain allowed; this function never returns matched text.
 */
export function assertOutputOnlyStringsQuarantined(input: {
  readonly result: unknown;
  readonly preCallValues: readonly unknown[];
  readonly safeArtifacts: readonly unknown[];
}): void {
  const resultStrings = collectStrings(input.result);
  const preCall = input.preCallValues
    .map((value) => canonicalizeJson(value))
    .join("\n");
  const safe = input.safeArtifacts
    .map((value) => canonicalizeJson(value))
    .join("\n");
  for (const value of resultStrings) {
    if (!preCall.includes(value) && safe.includes(value)) {
      throw new Error("an output-only result string escaped local quarantine");
    }
  }
}
