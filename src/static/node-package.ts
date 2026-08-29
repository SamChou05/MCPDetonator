import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

import { sha256, type EvidenceStore } from "../evidence-store.js";
import {
  nodePackageStaticInspectionV1Schema,
  staticFileEvidenceV1Schema,
  type NodePackageStaticInspectionV1,
  type StaticCapability,
  type StaticEvidenceReferenceV1,
} from "./contracts.js";

export interface StaticInspectionLimits {
  readonly maxSourceFiles: number;
  readonly maxSourceFileBytes: number;
  readonly maxTotalSourceBytes: number;
  readonly maxMetadataFileBytes: number;
  readonly maxDirectoryEntries: number;
}

export const defaultStaticInspectionLimits: StaticInspectionLimits = {
  maxSourceFiles: 250,
  maxSourceFileBytes: 512 * 1024,
  maxTotalSourceBytes: 10 * 1024 * 1024,
  maxMetadataFileBytes: 5 * 1024 * 1024,
  maxDirectoryEntries: 20_000,
};

export interface InspectNodePackageOptions {
  readonly store: EvidenceStore;
  readonly runId: string;
  readonly targetId: string;
  readonly packageRoot: string;
  readonly artifactPath?: string;
  readonly limits?: Partial<StaticInspectionLimits>;
}

export class StaticInspectionError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StaticInspectionError";
  }
}

type Manifest = NodePackageStaticInspectionV1["manifest"];
type ManifestClaims = Extract<Manifest, { status: "parsed" }>["claims"];
type Lockfile = NodePackageStaticInspectionV1["lockfiles"][number];
type ProvenanceHint = NodePackageStaticInspectionV1["provenanceHints"][number];
type SourceSignal = NodePackageStaticInspectionV1["source"]["signals"][number];
type ScannedSourceFile = NodePackageStaticInspectionV1["source"]["scannedFiles"][number];
type SkippedSourceFile = NodePackageStaticInspectionV1["source"]["skippedFiles"][number];

const sourceExtensions = new Set([
  ".js",
  ".jsx",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".cts",
  ".mts",
]);

const excludedDirectories = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  "coverage",
  "node_modules",
]);

const installationLifecycleScripts = new Set([
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
]);

const lockfileFormats = new Map<string, Lockfile["format"]>([
  ["package-lock.json", "npm-package-lock"],
  ["npm-shrinkwrap.json", "npm-shrinkwrap"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun-text"],
  ["bun.lockb", "bun-binary"],
]);

interface SuccessfulRead {
  readonly status: "ok";
  readonly buffer: Buffer;
  readonly sizeBytes: number;
}

interface FailedRead {
  readonly status: "missing" | "too_large" | "not_regular" | "error";
  readonly sizeBytes?: number;
  readonly error?: string;
}

type BoundedRead = SuccessfulRead | FailedRead;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeLimits(
  overrides: Partial<StaticInspectionLimits> | undefined,
): StaticInspectionLimits {
  const limits = { ...defaultStaticInspectionLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new StaticInspectionError(`${name} must be a positive safe integer`);
    }
  }
  return limits;
}

function targetPath(packageRoot: string, absolutePath: string): string {
  const result = relative(packageRoot, absolutePath).split(sep).join("/");
  if (result.length === 0 || result.startsWith("../") || result === "..") {
    throw new StaticInspectionError("inspected path escaped the package root");
  }
  return result;
}

async function readRegularFileBounded(
  path: string,
  maxBytes: number,
): Promise<BoundedRead> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { status: "not_regular" };
    }
    if (stat.size > maxBytes) {
      return { status: "too_large", sizeBytes: stat.size };
    }

    const buffer = await handle.readFile();
    if (buffer.byteLength > maxBytes) {
      return { status: "too_large", sizeBytes: buffer.byteLength };
    }
    return { status: "ok", buffer, sizeBytes: buffer.byteLength };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "error", error: errorMessage(error) };
  } finally {
    await handle?.close();
  }
}

function mediaType(path: string): string {
  if (path.endsWith(".json")) {
    return "application/json";
  }
  if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    return "application/yaml";
  }
  if (sourceExtensions.has(extname(path).toLowerCase()) || path.endsWith(".lock")) {
    return "text/plain";
  }
  return "application/octet-stream";
}

function decodeUtf8(buffer: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

async function captureFile(options: {
  readonly store: EvidenceStore;
  readonly runId: string;
  readonly targetId: string;
  readonly path: string;
  readonly buffer: Buffer;
  readonly preferText: boolean;
}): Promise<StaticEvidenceReferenceV1> {
  const digest = sha256(options.buffer);
  const text = options.preferText ? decodeUtf8(options.buffer) : undefined;
  const evidenceId = `static-${sha256(`${options.path}\0${digest}`).slice(0, 24)}`;
  const artifactPath = `raw/static/${evidenceId}.json`;

  await options.store.writeJson(artifactPath, staticFileEvidenceV1Schema, {
    schema: "forge.static-file/v1",
    runId: options.runId,
    targetId: options.targetId,
    evidenceId,
    targetPath: options.path,
    sha256: digest,
    sizeBytes: options.buffer.byteLength,
    mediaType: mediaType(options.path),
    encoding: text === undefined ? "base64" : "utf8",
    content: text ?? options.buffer.toString("base64"),
  });

  return {
    artifactPath,
    targetPath: options.path,
    sha256: digest,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringProperty(
  record: Record<string, unknown>,
  name: string,
): string | undefined {
  return typeof record[name] === "string" && record[name].length > 0
    ? record[name]
    : undefined;
}

function booleanProperty(
  record: Record<string, unknown>,
  name: string,
): boolean | undefined {
  return typeof record[name] === "boolean" ? record[name] : undefined;
}

function stringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (record === undefined) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(record)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function repositoryClaim(manifest: Record<string, unknown>): string | undefined {
  const repository = manifest.repository;
  if (typeof repository === "string" && repository.length > 0) {
    return repository;
  }
  const record = asRecord(repository);
  return record === undefined ? undefined : stringProperty(record, "url");
}

function manifestEntrypoints(
  manifest: Record<string, unknown>,
): ManifestClaims["entrypoints"] {
  const result: ManifestClaims["entrypoints"] = [];
  const simple: ReadonlyArray<["main" | "module" | "types", string]> = [
    ["main", "main"],
    ["module", "module"],
    ["types", "types"],
  ];
  for (const [kind, property] of simple) {
    const path = stringProperty(manifest, property);
    if (path !== undefined) {
      result.push({ kind, path });
    }
  }
  if (!result.some((entrypoint) => entrypoint.kind === "types")) {
    const typings = stringProperty(manifest, "typings");
    if (typings !== undefined) {
      result.push({ kind: "types", path: typings });
    }
  }

  const bin = manifest.bin;
  if (typeof bin === "string" && bin.length > 0) {
    const declaredName = stringProperty(manifest, "name");
    result.push({
      kind: "bin",
      path: bin,
      ...(declaredName === undefined
        ? {}
        : { name: declaredName.split("/").at(-1) ?? declaredName }),
    });
  } else {
    for (const [name, path] of Object.entries(stringMap(bin))) {
      result.push({ kind: "bin", name, path });
    }
  }
  return result.sort((left, right) =>
    `${left.kind}:${left.name ?? ""}:${left.path}`.localeCompare(
      `${right.kind}:${right.name ?? ""}:${right.path}`,
    ),
  );
}

function manifestDependencies(
  manifest: Record<string, unknown>,
): ManifestClaims["dependencies"] {
  const groups: ReadonlyArray<[
    string,
    ManifestClaims["dependencies"][number]["kind"],
  ]> = [
    ["dependencies", "runtime"],
    ["devDependencies", "development"],
    ["optionalDependencies", "optional"],
    ["peerDependencies", "peer"],
  ];
  return groups
    .flatMap(([field, kind]) =>
      Object.entries(stringMap(manifest[field])).map(([name, specifier]) => ({
        name,
        specifier,
        kind,
      })),
    )
    .sort((left, right) =>
      `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`),
    );
}

function extractManifestClaims(manifest: Record<string, unknown>): ManifestClaims {
  const scripts = Object.entries(stringMap(manifest.scripts))
    .map(([name, command]) => ({
      name,
      command,
      installLifecycle: installationLifecycleScripts.has(name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const name = stringProperty(manifest, "name");
  const version = stringProperty(manifest, "version");
  const privateValue = booleanProperty(manifest, "private");
  const packageType = stringProperty(manifest, "type");
  const packageManager = stringProperty(manifest, "packageManager");
  const repository = repositoryClaim(manifest);
  const homepage = stringProperty(manifest, "homepage");

  return {
    ...(name === undefined ? {} : { name }),
    ...(version === undefined ? {} : { version }),
    ...(privateValue === undefined ? {} : { private: privateValue }),
    ...(packageType === undefined ? {} : { packageType }),
    ...(packageManager === undefined ? {} : { packageManager }),
    ...(repository === undefined ? {} : { repository }),
    ...(homepage === undefined ? {} : { homepage }),
    entrypoints: manifestEntrypoints(manifest),
    scripts,
    dependencies: manifestDependencies(manifest),
    engines: stringMap(manifest.engines),
  };
}

async function inspectManifest(options: {
  readonly packageRoot: string;
  readonly store: EvidenceStore;
  readonly runId: string;
  readonly targetId: string;
  readonly limits: StaticInspectionLimits;
}): Promise<Manifest> {
  const path = resolve(options.packageRoot, "package.json");
  const read = await readRegularFileBounded(path, options.limits.maxMetadataFileBytes);
  if (read.status === "missing") {
    return { status: "missing" };
  }
  if (read.status === "too_large") {
    return {
      status: "unreadable",
      error: `package.json exceeds the ${options.limits.maxMetadataFileBytes}-byte metadata limit`,
    };
  }
  if (read.status !== "ok") {
    return {
      status: "unreadable",
      error:
        read.status === "error"
          ? `package.json could not be read: ${read.error ?? "unknown error"}`
          : "package.json is not a regular file",
    };
  }

  const evidence = await captureFile({
    store: options.store,
    runId: options.runId,
    targetId: options.targetId,
    path: "package.json",
    buffer: read.buffer,
    preferText: true,
  });
  const content = decodeUtf8(read.buffer);
  if (content === undefined) {
    return { status: "invalid", evidence, error: "package.json is not valid UTF-8" };
  }

  try {
    const parsed: unknown = JSON.parse(content);
    const manifest = asRecord(parsed);
    if (manifest === undefined) {
      return {
        status: "invalid",
        evidence,
        error: "package.json must contain a JSON object",
      };
    }
    return { status: "parsed", evidence, claims: extractManifestClaims(manifest) };
  } catch (error) {
    return {
      status: "invalid",
      evidence,
      error: `package.json is not valid JSON: ${errorMessage(error)}`,
    };
  }
}

function countObjectKeys(value: unknown): {
  readonly resolvedEntries: number;
  readonly integrityEntries: number;
} {
  let resolvedEntries = 0;
  let integrityEntries = 0;
  const pending: unknown[] = [value];
  let visited = 0;

  while (pending.length > 0 && visited < 1_000_000) {
    visited += 1;
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const record = asRecord(current);
    if (record === undefined) {
      continue;
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === "resolved" && typeof child === "string") {
        resolvedEntries += 1;
      }
      if (key === "integrity" && typeof child === "string") {
        integrityEntries += 1;
      }
      if (typeof child === "object" && child !== null) {
        pending.push(child);
      }
    }
  }
  return { resolvedEntries, integrityEntries };
}

function npmLockMetadata(content: string): Lockfile["metadata"] {
  try {
    const parsed: unknown = JSON.parse(content);
    const record = asRecord(parsed);
    if (record === undefined) {
      return {
        parseStatus: "not_parsed",
        parseError: "lockfile root is not a JSON object",
      };
    }
    const packages = asRecord(record.packages);
    const counts = countObjectKeys(record);
    const version = record.lockfileVersion;
    return {
      parseStatus: "parsed",
      ...(typeof version === "string" || typeof version === "number"
        ? { lockfileVersion: version }
        : {}),
      ...(packages === undefined ? {} : { packageEntries: Object.keys(packages).length }),
      ...counts,
    };
  } catch (error) {
    return {
      parseStatus: "not_parsed",
      parseError: `lockfile is not valid JSON: ${errorMessage(error)}`,
    };
  }
}

function textLockMetadata(content: string): Lockfile["metadata"] {
  const explicitVersion = /^lockfileVersion:\s*["']?([^\s"']+)/m.exec(content)?.[1];
  const yarnV1 = /^# yarn lockfile v(\d+)/m.exec(content)?.[1];
  const resolvedEntries = (content.match(/^\s*resolved\s+|^\s*resolution:/gm) ?? [])
    .length;
  const integrityEntries = (content.match(/^\s*integrity\s+|^\s*integrity:/gm) ?? [])
    .length;
  return {
    parseStatus: "summarized",
    ...(explicitVersion === undefined && yarnV1 === undefined
      ? {}
      : { lockfileVersion: explicitVersion ?? yarnV1 ?? "unknown" }),
    resolvedEntries,
    integrityEntries,
  };
}

async function inspectLockfiles(options: {
  readonly packageRoot: string;
  readonly store: EvidenceStore;
  readonly runId: string;
  readonly targetId: string;
  readonly limits: StaticInspectionLimits;
}): Promise<Lockfile[]> {
  const lockfiles: Lockfile[] = [];
  for (const [name, format] of lockfileFormats) {
    const absolutePath = resolve(options.packageRoot, name);
    const read = await readRegularFileBounded(
      absolutePath,
      options.limits.maxMetadataFileBytes,
    );
    if (read.status === "missing" || read.status === "not_regular") {
      continue;
    }
    if (read.status !== "ok") {
      lockfiles.push({
        path: name,
        format,
        sizeBytes: read.sizeBytes ?? 0,
        metadata: {
          parseStatus: "not_parsed",
          parseError:
            read.status === "too_large"
              ? `lockfile exceeds the ${options.limits.maxMetadataFileBytes}-byte metadata limit`
              : `lockfile could not be read: ${read.error ?? "unknown error"}`,
        },
      });
      continue;
    }

    const evidence = await captureFile({
      store: options.store,
      runId: options.runId,
      targetId: options.targetId,
      path: name,
      buffer: read.buffer,
      preferText: format !== "bun-binary",
    });
    const content = decodeUtf8(read.buffer);
    const metadata =
      format === "npm-package-lock" || format === "npm-shrinkwrap"
        ? content === undefined
          ? { parseStatus: "not_parsed" as const, parseError: "lockfile is not UTF-8" }
          : npmLockMetadata(content)
        : content === undefined || format === "bun-binary"
          ? { parseStatus: "not_parsed" as const }
          : textLockMetadata(content);
    lockfiles.push({
      path: name,
      format,
      sizeBytes: read.sizeBytes,
      sha256: evidence.sha256,
      evidence,
      metadata,
    });
  }
  return lockfiles.sort((left, right) => left.path.localeCompare(right.path));
}

interface SourceCandidates {
  readonly paths: string[];
  readonly symlinks: string[];
  readonly traversalTruncated: boolean;
}

async function collectSourceCandidates(
  packageRoot: string,
  limits: StaticInspectionLimits,
): Promise<SourceCandidates> {
  const paths: string[] = [];
  const symlinks: string[] = [];
  const pending = [packageRoot];
  let entriesSeen = 0;
  let traversalTruncated = false;

  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {
      break;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > limits.maxDirectoryEntries) {
        traversalTruncated = true;
        pending.length = 0;
        break;
      }
      const absolutePath = resolve(directory, entry.name);
      const relativePath = targetPath(packageRoot, absolutePath);
      if (entry.isSymbolicLink()) {
        if (sourceExtensions.has(extname(entry.name).toLowerCase())) {
          symlinks.push(relativePath);
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) {
          pending.push(absolutePath);
        }
        continue;
      }
      if (entry.isFile() && sourceExtensions.has(extname(entry.name).toLowerCase())) {
        paths.push(absolutePath);
      }
    }
  }
  return {
    paths: paths.sort((left, right) => left.localeCompare(right)),
    symlinks: symlinks.sort((left, right) => left.localeCompare(right)),
    traversalTruncated,
  };
}

interface SourceViews {
  readonly commentsRemoved: string;
  readonly codeOnly: string;
}

function sourceViews(content: string): SourceViews {
  // split("") preserves UTF-16 indexes, which is what RegExp#index and string[index]
  // use. A code-point iterator would shift evidence columns after astral characters.
  const commentsRemoved = content.split("");
  const codeOnly = content.split("");
  let state: "code" | "single" | "double" | "template" | "line" | "block" =
    "code";

  function blank(index: number, comments: boolean, code: boolean): void {
    if (content[index] === "\n" || content[index] === "\r") {
      return;
    }
    if (comments) {
      commentsRemoved[index] = " ";
    }
    if (code) {
      codeOnly[index] = " ";
    }
  }

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (state === "line") {
      if (char === "\n") {
        state = "code";
      } else {
        blank(index, true, true);
      }
      continue;
    }
    if (state === "block") {
      blank(index, true, true);
      if (char === "*" && next === "/") {
        blank(index + 1, true, true);
        index += 1;
        state = "code";
      }
      continue;
    }
    if (state !== "code") {
      blank(index, false, true);
      if (char === "\\") {
        if (next !== undefined) {
          blank(index + 1, false, true);
          index += 1;
        }
        continue;
      }
      if (
        (state === "single" && char === "'") ||
        (state === "double" && char === '"') ||
        (state === "template" && char === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      blank(index, true, true);
      blank(index + 1, true, true);
      index += 1;
      state = "line";
    } else if (char === "/" && next === "*") {
      blank(index, true, true);
      blank(index + 1, true, true);
      index += 1;
      state = "block";
    } else if (char === "'") {
      blank(index, false, true);
      state = "single";
    } else if (char === '"') {
      blank(index, false, true);
      state = "double";
    } else if (char === "`") {
      blank(index, false, true);
      state = "template";
    }
  }
  return { commentsRemoved: commentsRemoved.join(""), codeOnly: codeOnly.join("") };
}

interface LocatedMatch {
  readonly column: number;
  readonly value?: string;
}

function regexMatches(line: string, pattern: RegExp): LocatedMatch[] {
  return [...line.matchAll(pattern)].map((match) => ({
    column: (match.index ?? 0) + 1,
    ...(match[1] === undefined ? {} : { value: match[1] }),
  }));
}

function moduleSpecifiers(line: string): LocatedMatch[] {
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ];
  return patterns.flatMap((pattern) => regexMatches(line, pattern));
}

function normalizedBuiltin(specifier: string): string {
  return specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
}

function excerpt(line: string): string {
  const compact = line.trim().replace(/\s+/g, " ");
  return compact.length <= 240 ? compact : `${compact.slice(0, 237)}...`;
}

function signalsForSource(options: {
  readonly content: string;
  readonly evidence: StaticEvidenceReferenceV1;
}): SourceSignal[] {
  const views = sourceViews(options.content);
  const originalLines = options.content.split(/\r?\n/);
  const commentsRemovedLines = views.commentsRemoved.split(/\r?\n/);
  const codeLines = views.codeOnly.split(/\r?\n/);
  const result: SourceSignal[] = [];
  const seen = new Set<string>();

  function add(
    lineIndex: number,
    column: number,
    capability: StaticCapability,
    patternId: string,
    summary: string,
    confidence: SourceSignal["confidence"],
  ): void {
    const line = lineIndex + 1;
    const key = `${line}:${column}:${capability}:${patternId}`;
    const sourceExcerpt = excerpt(originalLines[lineIndex] ?? "");
    if (seen.has(key) || sourceExcerpt.length === 0) {
      return;
    }
    seen.add(key);
    result.push({
      signalId: `signal-${sha256(
        `${options.evidence.targetPath}\0${line}\0${column}\0${patternId}`,
      ).slice(0, 24)}`,
      capability,
      patternId,
      summary,
      confidence,
      evidence: { ...options.evidence, line, column },
      excerpt: sourceExcerpt,
    });
  }

  for (let index = 0; index < commentsRemovedLines.length; index += 1) {
    const importLine = commentsRemovedLines[index] ?? "";
    const codeLine = codeLines[index] ?? "";
    for (const match of moduleSpecifiers(importLine)) {
      // The module matcher needs string literals, while codeOnly masks strings.
      // Requiring the keyword position to remain visible in codeOnly rejects
      // documentation strings such as `"try require('node:fs')"`.
      if (
        match.value === undefined ||
        (codeLine[match.column - 1] ?? " ").trim().length === 0
      ) {
        continue;
      }
      const module = normalizedBuiltin(match.value);
      if (module === "fs" || module.startsWith("fs/")) {
        add(
          index,
          match.column,
          "filesystem_access",
          "node-filesystem-module",
          "Imports the Node filesystem API.",
          "high",
        );
      } else if (module === "child_process") {
        add(
          index,
          match.column,
          "process_execution",
          "node-child-process-module",
          "Imports the Node process-execution API.",
          "high",
        );
      } else if (
        ["http", "https", "http2", "net", "tls", "dgram", "dns", "dns/promises"].includes(
          module,
        )
      ) {
        add(
          index,
          match.column,
          "network_access",
          "node-network-module",
          `Imports the Node ${module} network API.`,
          "high",
        );
      } else if (module === "vm") {
        add(
          index,
          match.column,
          "dynamic_code_execution",
          "node-vm-module",
          "Imports the Node dynamic-code execution API.",
          "high",
        );
      }
      if (module.endsWith(".node")) {
        add(
          index,
          match.column,
          "native_code_loading",
          "native-addon-import",
          "Loads a native Node addon.",
          "high",
        );
      }
    }

    for (const match of regexMatches(codeLine, /\bprocess\s*\.\s*env\b/g)) {
      add(
        index,
        match.column,
        "environment_access",
        "process-env-access",
        "Reads or enumerates process environment variables.",
        "high",
      );
    }
    for (const match of regexMatches(codeLine, /\bfetch\s*\(|\bWebSocket\s*\(/g)) {
      add(
        index,
        match.column,
        "network_access",
        "global-network-api",
        "Calls a global network API.",
        "medium",
      );
    }
    for (const match of regexMatches(codeLine, /\beval\s*\(|\bnew\s+Function\s*\(/g)) {
      add(
        index,
        match.column,
        "dynamic_code_execution",
        "dynamic-code-constructor",
        "Invokes a dynamic JavaScript code-execution primitive.",
        "high",
      );
    }
    for (const match of regexMatches(codeLine, /\bprocess\s*\.\s*dlopen\s*\(/g)) {
      add(
        index,
        match.column,
        "native_code_loading",
        "process-dlopen",
        "Loads native code through process.dlopen.",
        "high",
      );
    }

    for (const match of codeLine.matchAll(/\b(?:require|import)\s*\(\s*([^)]*)/g)) {
      const argument = (match[1] ?? "").trim();
      // Static string arguments are blank in codeOnly. Any remaining expression
      // is a runtime-selected module path.
      if (argument.length > 0) {
        add(
          index,
          (match.index ?? 0) + 1,
          "dynamic_module_loading",
          "nonliteral-module-loader",
          "Loads a module from a value determined at runtime.",
          "medium",
        );
      }
    }
  }
  return result.sort((left, right) =>
    `${left.evidence.targetPath}:${left.evidence.line ?? 0}:${left.evidence.column ?? 0}:${left.patternId}`.localeCompare(
      `${right.evidence.targetPath}:${right.evidence.line ?? 0}:${right.evidence.column ?? 0}:${right.patternId}`,
    ),
  );
}

async function inspectSources(options: {
  readonly packageRoot: string;
  readonly store: EvidenceStore;
  readonly runId: string;
  readonly targetId: string;
  readonly limits: StaticInspectionLimits;
}): Promise<{
  readonly candidateFiles: number;
  readonly scannedFiles: ScannedSourceFile[];
  readonly skippedFiles: SkippedSourceFile[];
  readonly signals: SourceSignal[];
  readonly traversalTruncated: boolean;
}> {
  const candidates = await collectSourceCandidates(options.packageRoot, options.limits);
  const scannedFiles: ScannedSourceFile[] = [];
  const skippedFiles: SkippedSourceFile[] = candidates.symlinks.map((path) => ({
    path,
    reason: "symlink",
  }));
  const signals: SourceSignal[] = [];
  let totalBytes = 0;

  for (let index = 0; index < candidates.paths.length; index += 1) {
    const absolutePath = candidates.paths[index];
    if (absolutePath === undefined) {
      continue;
    }
    const path = targetPath(options.packageRoot, absolutePath);
    if (index >= options.limits.maxSourceFiles) {
      skippedFiles.push({ path, reason: "file_limit" });
      continue;
    }
    const read = await readRegularFileBounded(
      absolutePath,
      options.limits.maxSourceFileBytes,
    );
    if (read.status !== "ok") {
      skippedFiles.push({
        path,
        reason: read.status === "too_large" ? "file_too_large" : "read_error",
      });
      continue;
    }
    if (totalBytes + read.sizeBytes > options.limits.maxTotalSourceBytes) {
      skippedFiles.push({ path, reason: "total_bytes_limit" });
      continue;
    }
    const content = decodeUtf8(read.buffer);
    if (content === undefined) {
      skippedFiles.push({ path, reason: "invalid_utf8" });
      continue;
    }
    totalBytes += read.sizeBytes;
    const evidence = await captureFile({
      store: options.store,
      runId: options.runId,
      targetId: options.targetId,
      path,
      buffer: read.buffer,
      preferText: true,
    });
    scannedFiles.push({
      path,
      sizeBytes: read.sizeBytes,
      sha256: evidence.sha256,
      evidence,
    });
    signals.push(...signalsForSource({ content, evidence }));
  }

  return {
    candidateFiles: candidates.paths.length + candidates.symlinks.length,
    scannedFiles: scannedFiles.sort((left, right) => left.path.localeCompare(right.path)),
    skippedFiles: skippedFiles.sort((left, right) => left.path.localeCompare(right.path)),
    signals: signals.sort((left, right) => left.signalId.localeCompare(right.signalId)),
    traversalTruncated: candidates.traversalTruncated,
  };
}

function provenanceHints(
  manifest: Manifest,
  lockfiles: readonly Lockfile[],
): ProvenanceHint[] {
  const result: ProvenanceHint[] = [];
  if (manifest.status === "parsed") {
    if (manifest.claims.packageManager !== undefined) {
      result.push({
        kind: "package_manager",
        value: manifest.claims.packageManager,
        basis: "manifest_claim",
        evidence: manifest.evidence,
      });
    }
    if (manifest.claims.repository !== undefined) {
      result.push({
        kind: "repository",
        value: manifest.claims.repository,
        basis: "manifest_claim",
        evidence: manifest.evidence,
      });
    }
  }
  for (const lockfile of lockfiles) {
    if (lockfile.evidence !== undefined) {
      result.push({
        kind: "lockfile",
        value: `${lockfile.format}:${lockfile.sha256 ?? "unhashed"}`,
        basis: "observed_file",
        evidence: lockfile.evidence,
      });
    }
  }
  return result.sort((left, right) =>
    `${left.kind}:${left.value}`.localeCompare(`${right.kind}:${right.value}`),
  );
}

export async function inspectNodePackage(
  options: InspectNodePackageOptions,
): Promise<NodePackageStaticInspectionV1> {
  const limits = normalizeLimits(options.limits);
  const packageRoot = resolve(options.packageRoot);
  let rootStat;
  try {
    rootStat = await lstat(packageRoot);
  } catch (error) {
    throw new StaticInspectionError(`cannot inspect package root: ${packageRoot}`, {
      cause: error,
    });
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new StaticInspectionError("package root must be a real directory, not a symlink");
  }

  const manifest = await inspectManifest({
    packageRoot,
    store: options.store,
    runId: options.runId,
    targetId: options.targetId,
    limits,
  });
  const lockfiles = await inspectLockfiles({
    packageRoot,
    store: options.store,
    runId: options.runId,
    targetId: options.targetId,
    limits,
  });
  const source = await inspectSources({
    packageRoot,
    store: options.store,
    runId: options.runId,
    targetId: options.targetId,
    limits,
  });
  const limitations = [
    "Package manifest fields and repository URLs are untrusted package-authored claims, not verified provenance.",
    "Source signals are bounded lexical capability indicators, not whole-program reachability or data-flow proof.",
    "Dependency source under node_modules is not scanned; dependencies are inventoried from the root manifest and available lock metadata.",
    ...(source.traversalTruncated
      ? ["Source discovery stopped at the configured directory-entry limit."]
      : []),
    ...(source.skippedFiles.length > 0
      ? [
          `${source.skippedFiles.length} source ${source.skippedFiles.length === 1 ? "file was" : "files were"} skipped by safety limits or file-type checks.`,
        ]
      : []),
  ];
  const inspection: NodePackageStaticInspectionV1 = {
    schema: "forge.node-package-static/v1",
    runId: options.runId,
    targetId: options.targetId,
    generatedAt: new Date().toISOString(),
    manifest,
    lockfiles,
    provenanceHints: provenanceHints(manifest, lockfiles),
    source: {
      candidateFiles: source.candidateFiles,
      scannedFiles: source.scannedFiles,
      skippedFiles: source.skippedFiles,
      signals: source.signals,
    },
    limitations,
  };
  await options.store.writeJson(
    options.artifactPath ?? "static/inspection.json",
    nodePackageStaticInspectionV1Schema,
    inspection,
  );
  return nodePackageStaticInspectionV1Schema.parse(inspection);
}
