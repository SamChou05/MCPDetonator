import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

export interface ParsedStraceRecord {
  readonly experimentId: string;
  readonly pid: number;
  readonly timestampSeconds: number;
  readonly syscall: string;
  readonly argumentsText: string;
  readonly resultText: string;
  readonly rawRef: string;
  readonly rawLine: string;
}

const syscallPattern = /^(\d+\.\d+)\s+([a-zA-Z0-9_]+)\((.*)\)\s+=\s+(.+)$/;

export function parseStraceLine(options: {
  readonly experimentId: string;
  readonly pid: number;
  readonly rawRef: string;
  readonly line: string;
}): ParsedStraceRecord | undefined {
  const match = syscallPattern.exec(options.line);
  if (!match) {
    return undefined;
  }

  const timestampSeconds = Number(match[1]);
  if (!Number.isFinite(timestampSeconds)) {
    return undefined;
  }

  return {
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

export async function readExperimentStrace(
  rawDirectory: string,
  experimentId: string,
): Promise<ParsedStraceRecord[]> {
  const entries = await readdir(rawDirectory, { withFileTypes: true });
  const traceFiles = entries
    .filter((entry) => entry.isFile() && /^strace\.\d+$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const records: ParsedStraceRecord[] = [];

  for (const entry of traceFiles) {
    const pid = Number(entry.name.slice("strace.".length));
    const contents = await readFile(resolve(rawDirectory, entry.name), "utf8");
    const lines = contents.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) {
        continue;
      }
      const rawRef = `raw/${experimentId}/${basename(entry.name)}:${index + 1}`;
      const parsed = parseStraceLine({
        experimentId,
        pid,
        rawRef,
        line,
      });
      if (parsed !== undefined) {
        records.push(parsed);
      }
    }
  }

  return records.sort(
    (left, right) =>
      left.timestampSeconds - right.timestampSeconds ||
      left.rawRef.localeCompare(right.rawRef),
  );
}

