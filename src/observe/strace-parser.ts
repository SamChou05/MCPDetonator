import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

interface ParsedStraceRecordBase {
  readonly experimentId: string;
  readonly pid: number;
  readonly timestampSeconds: number;
  readonly rawRef: string;
  readonly rawLine: string;
}

export interface ParsedStraceSyscallRecord extends ParsedStraceRecordBase {
  readonly kind: "syscall";
  readonly syscall: string;
  readonly argumentsText: string;
  readonly resultText: string;
}

export interface ParsedStraceSignalTerminationRecord
  extends ParsedStraceRecordBase {
  readonly kind: "signal-termination";
  readonly signal: string;
}

export type ParsedStraceRecord =
  | ParsedStraceSyscallRecord
  | ParsedStraceSignalTerminationRecord;

export const straceHealthMaxExampleRawRefs = 5;
export const straceHealthMaxTraceFileDetails = 64;

/** A terminal marker is present only when it is the trace file's final line. */
export type StraceTerminalMarker =
  | {
      readonly status: "present";
      readonly kind: "exit" | "signal-termination";
      readonly rawRef: string;
    }
  | { readonly status: "missing" };

export interface StraceTraceFileHealth {
  readonly rawRef: string;
  readonly pid: number;
  readonly nonemptyLineCount: number;
  readonly terminalMarker: StraceTerminalMarker;
}

export interface StraceParseHealth {
  readonly traceDirectoryPresent: boolean;
  readonly traceFileCount: number;
  readonly nonemptyLineCount: number;
  readonly parsedRecordCount: number;
  readonly parsedSyscallRecordCount: number;
  readonly parsedSignalTerminationRecordCount: number;
  readonly recognizedControlLineCount: number;
  readonly recognizedExitControlLineCount: number;
  readonly recognizedSignalDeliveryControlLineCount: number;
  readonly unfinishedLineCount: number;
  readonly resumedLineCount: number;
  readonly malformedLineCount: number;
  readonly stringTruncationIndicatorCount: number;
  readonly stringTruncationLineCount: number;
  readonly unfinishedRawRefs: readonly string[];
  readonly resumedRawRefs: readonly string[];
  readonly malformedRawRefs: readonly string[];
  readonly stringTruncationRawRefs: readonly string[];
  readonly terminalMarkerPresentTraceFileCount: number;
  readonly missingTerminalMarkerTraceFileCount: number;
  readonly missingTerminalMarkerTraceFileRawRefs: readonly string[];
  readonly traceFileDetails: readonly StraceTraceFileHealth[];
  readonly traceFileDetailOmittedCount: number;
  /**
   * Structural parse integrity. Bounded detail omission and strace's rendered
   * string abbreviation are reported separately and do not change this value.
   */
  readonly integrityComplete: boolean;
}

export interface ExperimentStraceParseResult {
  readonly records: readonly ParsedStraceRecord[];
  readonly health: StraceParseHealth;
}

const syscallPattern = /^(\d+\.\d+)\s+([a-zA-Z0-9_]+)\((.*)\)\s+=\s+(.+)$/;
const signalTerminationPattern =
  /^(\d+\.\d+)\s+\+\+\+\s+killed by\s+(SIG[A-Z0-9_+-]+)(?:\s+\(core dumped\))?\s+\+\+\+$/;
const exitControlLinePattern =
  /^\d+\.\d+\s+\+\+\+\s+exited with\s+-?\d+\s+\+\+\+$/;
const signalDeliveryControlLinePattern =
  /^\d+\.\d+\s+---\s+SIG[A-Z0-9_+-]+(?:\s+\{.*\})?\s+---$/;
const unfinishedLinePattern =
  /^\d+\.\d+\s+[a-zA-Z0-9_]+\(.*<unfinished \.\.\.>$/;
const resumedLinePattern =
  /^\d+\.\d+\s+<\.\.\.\s+[a-zA-Z0-9_]+\s+resumed>.*$/;

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function pushExample(examples: string[], rawRef: string): void {
  if (examples.length < straceHealthMaxExampleRawRefs) {
    examples.push(rawRef);
  }
}

function countStringTruncationIndicators(line: string): number {
  let inString = false;
  let escaped = false;
  let count = 0;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (!inString) {
      if (character === '"') {
        inString = true;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== '"') {
      continue;
    }

    inString = false;
    if (line.slice(index + 1, index + 4) === "...") {
      count += 1;
    }
  }

  return count;
}

export function parseStraceLine(options: {
  readonly experimentId: string;
  readonly pid: number;
  readonly rawRef: string;
  readonly line: string;
}): ParsedStraceRecord | undefined {
  const match = syscallPattern.exec(options.line);
  if (match !== null) {
    const timestampSeconds = Number(match[1]);
    if (!Number.isFinite(timestampSeconds)) {
      return undefined;
    }

    return {
      kind: "syscall",
      experimentId: options.experimentId,
      pid: options.pid,
      timestampSeconds,
      syscall: match[2] ?? "",
      argumentsText: match[3] ?? "",
      resultText: match[4] ?? "",
      rawRef: options.rawRef,
      rawLine: options.line,
    };
  }

  const terminationMatch = signalTerminationPattern.exec(options.line);
  if (terminationMatch === null) {
    return undefined;
  }
  const timestampSeconds = Number(terminationMatch[1]);
  const signal = terminationMatch[2];
  if (!Number.isFinite(timestampSeconds) || signal === undefined) {
    return undefined;
  }
  return {
    kind: "signal-termination",
    experimentId: options.experimentId,
    pid: options.pid,
    timestampSeconds,
    signal,
    rawRef: options.rawRef,
    rawLine: options.line,
  };
}

async function readExperimentStraceInternal(
  rawDirectory: string,
  experimentId: string,
  tolerateMissingDirectory: boolean,
): Promise<ExperimentStraceParseResult> {
  let traceDirectoryPresent = true;
  let entries: Dirent[];
  try {
    entries = await readdir(rawDirectory, { withFileTypes: true });
  } catch (error) {
    if (!tolerateMissingDirectory || !isMissingPathError(error)) {
      throw error;
    }
    traceDirectoryPresent = false;
    entries = [];
  }
  const traceFiles = entries
    .filter((entry) => entry.isFile() && /^strace\.\d+$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const records: ParsedStraceRecord[] = [];
  const unfinishedRawRefs: string[] = [];
  const resumedRawRefs: string[] = [];
  const malformedRawRefs: string[] = [];
  const stringTruncationRawRefs: string[] = [];
  const missingTerminalMarkerTraceFileRawRefs: string[] = [];
  const traceFileDetails: StraceTraceFileHealth[] = [];
  let nonemptyLineCount = 0;
  let parsedSyscallRecordCount = 0;
  let parsedSignalTerminationRecordCount = 0;
  let recognizedExitControlLineCount = 0;
  let recognizedSignalDeliveryControlLineCount = 0;
  let unfinishedLineCount = 0;
  let resumedLineCount = 0;
  let malformedLineCount = 0;
  let stringTruncationIndicatorCount = 0;
  let stringTruncationLineCount = 0;
  let terminalMarkerPresentTraceFileCount = 0;
  let missingTerminalMarkerTraceFileCount = 0;

  for (const entry of traceFiles) {
    const pid = Number(entry.name.slice("strace.".length));
    const contents = await readFile(resolve(rawDirectory, entry.name), "utf8");
    const lines = contents.split("\n");
    let traceNonemptyLineCount = 0;
    let finalNonemptyLine: string | undefined;
    let finalNonemptyRawRef: string | undefined;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.trim().length === 0) {
        continue;
      }
      nonemptyLineCount += 1;
      traceNonemptyLineCount += 1;
      const rawRef = `raw/${experimentId}/${basename(entry.name)}:${index + 1}`;
      finalNonemptyLine = line;
      finalNonemptyRawRef = rawRef;

      const stringTruncations = countStringTruncationIndicators(line);
      if (stringTruncations > 0) {
        stringTruncationIndicatorCount += stringTruncations;
        stringTruncationLineCount += 1;
        pushExample(stringTruncationRawRefs, rawRef);
      }

      const parsed = parseStraceLine({
        experimentId,
        pid,
        rawRef,
        line,
      });
      if (parsed !== undefined) {
        records.push(parsed);
        if (parsed.kind === "syscall") {
          parsedSyscallRecordCount += 1;
        } else {
          parsedSignalTerminationRecordCount += 1;
        }
      } else if (exitControlLinePattern.test(line)) {
        recognizedExitControlLineCount += 1;
      } else if (signalDeliveryControlLinePattern.test(line)) {
        recognizedSignalDeliveryControlLineCount += 1;
      } else if (unfinishedLinePattern.test(line)) {
        unfinishedLineCount += 1;
        pushExample(unfinishedRawRefs, rawRef);
      } else if (resumedLinePattern.test(line)) {
        resumedLineCount += 1;
        pushExample(resumedRawRefs, rawRef);
      } else {
        malformedLineCount += 1;
        pushExample(malformedRawRefs, rawRef);
      }
    }

    const traceFileRawRef = `raw/${experimentId}/${basename(entry.name)}`;
    let terminalMarker: StraceTerminalMarker = { status: "missing" };
    if (
      finalNonemptyLine !== undefined &&
      finalNonemptyRawRef !== undefined &&
      exitControlLinePattern.test(finalNonemptyLine)
    ) {
      terminalMarker = {
        status: "present",
        kind: "exit",
        rawRef: finalNonemptyRawRef,
      };
    } else if (
      finalNonemptyLine !== undefined &&
      finalNonemptyRawRef !== undefined &&
      signalTerminationPattern.test(finalNonemptyLine)
    ) {
      terminalMarker = {
        status: "present",
        kind: "signal-termination",
        rawRef: finalNonemptyRawRef,
      };
    }

    if (terminalMarker.status === "present") {
      terminalMarkerPresentTraceFileCount += 1;
    } else {
      missingTerminalMarkerTraceFileCount += 1;
      pushExample(missingTerminalMarkerTraceFileRawRefs, traceFileRawRef);
    }
    if (traceFileDetails.length < straceHealthMaxTraceFileDetails) {
      traceFileDetails.push({
        rawRef: traceFileRawRef,
        pid,
        nonemptyLineCount: traceNonemptyLineCount,
        terminalMarker,
      });
    }
  }

  records.sort(
    (left, right) =>
      left.timestampSeconds - right.timestampSeconds ||
      left.rawRef.localeCompare(right.rawRef),
  );

  const traceFileDetailOmittedCount =
    traceFiles.length - traceFileDetails.length;
  const recognizedControlLineCount =
    recognizedExitControlLineCount +
    recognizedSignalDeliveryControlLineCount;
  const health = {
    traceDirectoryPresent,
    traceFileCount: traceFiles.length,
    nonemptyLineCount,
    parsedRecordCount: records.length,
    parsedSyscallRecordCount,
    parsedSignalTerminationRecordCount,
    recognizedControlLineCount,
    recognizedExitControlLineCount,
    recognizedSignalDeliveryControlLineCount,
    unfinishedLineCount,
    resumedLineCount,
    malformedLineCount,
    stringTruncationIndicatorCount,
    stringTruncationLineCount,
    unfinishedRawRefs,
    resumedRawRefs,
    malformedRawRefs,
    stringTruncationRawRefs,
    terminalMarkerPresentTraceFileCount,
    missingTerminalMarkerTraceFileCount,
    missingTerminalMarkerTraceFileRawRefs,
    traceFileDetails,
    traceFileDetailOmittedCount,
    integrityComplete:
      traceDirectoryPresent &&
      traceFiles.length > 0 &&
      parsedSyscallRecordCount > 0 &&
      unfinishedLineCount === 0 &&
      resumedLineCount === 0 &&
      malformedLineCount === 0 &&
      missingTerminalMarkerTraceFileCount === 0,
  } satisfies StraceParseHealth;

  return { records, health };
}

export async function readExperimentStraceDetailed(
  rawDirectory: string,
  experimentId: string,
): Promise<ExperimentStraceParseResult> {
  return readExperimentStraceInternal(rawDirectory, experimentId, true);
}

export async function readExperimentStrace(
  rawDirectory: string,
  experimentId: string,
): Promise<ParsedStraceRecord[]> {
  const result = await readExperimentStraceInternal(
    rawDirectory,
    experimentId,
    false,
  );
  return [...result.records];
}
