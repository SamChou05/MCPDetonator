import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import semanticTypeScript from "typescript-semantic";

import { sha256, sha256File, type EvidenceStore } from "../evidence-store.js";
import {
  nodePackageStaticInspectionV1Schema,
  staticFileEvidenceV1Schema,
  type NodePackageStaticInspectionV1,
} from "./contracts.js";
import {
  type NodeSemanticEngineInput,
  type NodeSemanticSourceInput,
} from "./node-semantic-engine.js";
import { NODE_SEMANTIC_CATALOG_VERSION } from "./node-semantic-catalog.js";
import {
  nodeSemanticLimitsV1Schema,
  nodeSemanticStaticV1Schema,
  type NodeSemanticLimitsV1,
  type NodeSemanticStaticV1,
} from "./semantic-contracts.js";

export const defaultNodeSemanticLimits: NodeSemanticLimitsV1 = {
  maxInputFiles: 250,
  maxInputBytes: 10 * 1024 * 1024,
  maxAstNodes: 500_000,
  maxCallsites: 10_000,
  maxDiagnostics: 500,
  maxCallGraphEdges: 10_000,
  maxModuleResolutions: 5_000,
  maxAliasPasses: 12,
  maxAliasDepth: 12,
  maxReachabilityDepth: 12,
  timeoutMs: 15_000,
  workerMemoryMb: 192,
};

export interface RunNodeSemanticAnalysisOptions {
  readonly store: EvidenceStore;
  readonly runId: string;
  readonly targetId: string;
  readonly lexicalInspectionArtifact?: string;
  readonly artifactPath?: string;
  readonly limits?: Partial<NodeSemanticLimitsV1>;
  readonly workerRunner?: NodeSemanticWorkerRunner;
}

export interface NodeSemanticAnalysisResult {
  readonly analysis: NodeSemanticStaticV1;
  readonly artifactPath: string;
  readonly artifactSha256: string;
}

export type NodeSemanticWorkerRunner = (
  input: NodeSemanticEngineInput,
) => Promise<NodeSemanticStaticV1>;

class SemanticInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SemanticInputError";
  }
}

class SemanticWorkerError extends Error {
  public constructor(
    public readonly kind: "timeout" | "resource_limit" | "worker_error",
    message: string,
  ) {
    super(message);
    this.name = "SemanticWorkerError";
  }
}

function normalizeLimits(
  overrides: Partial<NodeSemanticLimitsV1> | undefined,
): NodeSemanticLimitsV1 {
  return nodeSemanticLimitsV1Schema.parse({
    ...defaultNodeSemanticLimits,
    ...overrides,
  });
}

function sourceSetSha256(
  sources: readonly Pick<
    NodeSemanticSourceInput,
    "targetPath" | "sizeBytes" | "sha256" | "evidence"
  >[],
): string {
  const rows = [...sources]
    .sort((left, right) =>
      left.targetPath < right.targetPath
        ? -1
        : left.targetPath > right.targetPath
          ? 1
          : 0,
    )
    .map((source) =>
      [
        source.targetPath,
        String(source.sizeBytes),
        source.sha256,
        source.evidence.artifactPath,
      ].join("\0"),
    );
  return sha256(["forge.node-semantic-source-set/v1", ...rows].join("\n"));
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new SemanticInputError(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertInspectionIdentity(
  inspection: NodePackageStaticInspectionV1,
  runId: string,
  targetId: string,
): void {
  if (inspection.runId !== runId || inspection.targetId !== targetId) {
    throw new SemanticInputError(
      "the lexical inspection does not belong to the requested run and target",
    );
  }
}

async function loadCapturedSource(options: {
  readonly store: EvidenceStore;
  readonly runId: string;
  readonly targetId: string;
  readonly source: NodePackageStaticInspectionV1["source"]["scannedFiles"][number];
}): Promise<NodeSemanticSourceInput> {
  const bytes = await readFile(
    options.store.pathFor(options.source.evidence.artifactPath),
  );
  const evidence = staticFileEvidenceV1Schema.parse(
    parseJson(bytes, options.source.evidence.artifactPath),
  );
  const expectedArtifactPath = `raw/static/${evidence.evidenceId}.json`;
  if (
    evidence.runId !== options.runId ||
    evidence.targetId !== options.targetId ||
    expectedArtifactPath !== options.source.evidence.artifactPath ||
    evidence.targetPath !== options.source.path ||
    evidence.targetPath !== options.source.evidence.targetPath ||
    evidence.sha256 !== options.source.sha256 ||
    evidence.sha256 !== options.source.evidence.sha256 ||
    evidence.sizeBytes !== options.source.sizeBytes
  ) {
    throw new SemanticInputError(
      `captured source identity mismatch for '${options.source.path}'`,
    );
  }
  if (evidence.encoding !== "utf8") {
    throw new SemanticInputError(
      `captured source '${options.source.path}' is not valid UTF-8 text`,
    );
  }
  const contentBytes = Buffer.from(evidence.content, "utf8");
  if (
    contentBytes.byteLength !== evidence.sizeBytes ||
    sha256(contentBytes) !== evidence.sha256
  ) {
    throw new SemanticInputError(
      `captured source bytes do not match their size and digest for '${options.source.path}'`,
    );
  }
  return {
    targetPath: options.source.path,
    sizeBytes: evidence.sizeBytes,
    sha256: evidence.sha256,
    evidence: options.source.evidence,
    content: evidence.content,
  };
}

function semanticWorkerModuleUrl(): URL {
  return new URL(
    import.meta.url.endsWith(".ts")
      ? "./node-semantic-worker.ts"
      : "./node-semantic-worker.js",
    import.meta.url,
  );
}

function workerEntryUrl(): URL {
  const moduleUrl = semanticWorkerModuleUrl();
  if (!import.meta.url.endsWith(".ts")) return moduleUrl;
  const tsxApiUrl = pathToFileURL(
    createRequire(import.meta.url).resolve("tsx/esm/api"),
  ).href;
  const bootstrap = [
    `import { tsImport } from ${JSON.stringify(tsxApiUrl)};`,
    `await tsImport(${JSON.stringify(moduleUrl.href)}, ${JSON.stringify(import.meta.url)});`,
  ].join("\n");
  return new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`);
}

export async function runNodeSemanticWorker(
  input: NodeSemanticEngineInput,
): Promise<NodeSemanticStaticV1> {
  return await new Promise<NodeSemanticStaticV1>((resolve, reject) => {
    const worker = new Worker(workerEntryUrl(), {
      workerData: input,
      // Do not inherit parent preload hooks, loaders, or inspector flags into
      // the evidence-producing compiler boundary.
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: input.limits.workerMemoryMb,
        maxYoungGenerationSizeMb: Math.min(32, input.limits.workerMemoryMb),
        stackSizeMb: 4,
      },
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Settlement follows confirmed worker termination so the caller cannot
      // advance while timed-out compiler work is still executing.
      void worker.terminate().then(
        () => {
          reject(
            new SemanticWorkerError(
              "timeout",
              `semantic worker exceeded ${input.limits.timeoutMs} ms`,
            ),
          );
        },
        (error: unknown) => {
          reject(
            new SemanticWorkerError(
              "worker_error",
              `semantic worker timed out and termination failed: ${
                error instanceof Error ? error.message : String(error)
              }`.slice(0, 512),
            ),
          );
        },
      );
    }, input.limits.timeoutMs);
    timer.unref();

    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    }

    worker.once("message", (message: unknown) => {
      finish(() => {
        if (
          typeof message === "object" &&
          message !== null &&
          "status" in message &&
          message.status === "completed" &&
          "analysis" in message
        ) {
          try {
            resolve(nodeSemanticStaticV1Schema.parse(message.analysis));
          } catch (error) {
            reject(
              new SemanticWorkerError(
                "worker_error",
                `semantic worker returned invalid evidence: ${
                  error instanceof Error ? error.message : String(error)
                }`.slice(0, 512),
              ),
            );
          }
          return;
        }
        const detail =
          typeof message === "object" &&
          message !== null &&
          "message" in message &&
          typeof message.message === "string"
            ? message.message
            : "semantic worker failed without a bounded error message";
        reject(new SemanticWorkerError("worker_error", detail.slice(0, 512)));
      });
    });
    worker.once("error", (error) => {
      finish(() => {
        const kind =
          "code" in error && error.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? "resource_limit"
            : "worker_error";
        reject(new SemanticWorkerError(kind, error.message.slice(0, 512)));
      });
    });
    worker.once("exit", (code) => {
      finish(() => {
        reject(
          new SemanticWorkerError(
            "worker_error",
            code === 0
              ? "semantic worker exited without returning evidence"
              : `semantic worker exited with code ${code}`,
          ),
        );
      });
    });
  });
}

function failedAnalysis(options: {
  readonly runId: string;
  readonly targetId: string;
  readonly generatedAt: string;
  readonly lexicalInspectionArtifact: string;
  readonly lexicalInspectionSha256: string;
  readonly sourceSetSha256: string;
  readonly limits: NodeSemanticLimitsV1;
  readonly declaredSources: readonly NodePackageStaticInspectionV1["source"]["scannedFiles"][number][];
  readonly kind: "invalid_input" | "timeout" | "resource_limit" | "worker_error";
  readonly message: string;
}): NodeSemanticStaticV1 {
  const files = options.declaredSources
    .map((source) => ({
      targetPath: source.path,
      sizeBytes: source.sizeBytes,
      sha256: source.sha256,
      evidence: source.evidence,
      parseStatus: "not_analyzed" as const,
      syntaxDiagnosticCount: 0,
      diagnostics: [],
      diagnosticsTruncated: false,
    }))
    .sort((left, right) =>
      left.targetPath < right.targetPath
        ? -1
        : left.targetPath > right.targetPath
          ? 1
          : 0,
    );
  return nodeSemanticStaticV1Schema.parse({
    schema: "forge.node-semantic-static/v1",
    runId: options.runId,
    targetId: options.targetId,
    generatedAt: options.generatedAt,
    status: "failed",
    analyzer: {
      engine: "typescript-compiler-api",
      package: "typescript-semantic",
      version: semanticTypeScript.version,
      catalogVersion: NODE_SEMANTIC_CATALOG_VERSION,
    },
    input: {
      lexicalInspectionArtifact: options.lexicalInspectionArtifact,
      lexicalInspectionSha256: options.lexicalInspectionSha256,
      sourceSetSha256: options.sourceSetSha256,
    },
    limits: options.limits,
    coverage: {
      inputFiles: files.length,
      inputBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
      parsedFiles: 0,
      filesWithSyntaxErrors: 0,
      astNodesVisited: 0,
      callExpressionsVisited: 0,
      handlerRootsIdentified: 0,
      localCallGraphEdges: 0,
      moduleResolutionsAttempted: 0,
      moduleResolutionsUnresolved: 0,
      resolutionIncomplete: true,
    },
    files,
    callsites: [],
    issues: [
      {
        kind:
          options.kind === "invalid_input"
            ? "input_failure"
            : "worker_failure",
        summary: options.message.slice(0, 512) || "semantic analysis failed",
      },
    ],
    truncations: [],
    failure: {
      kind: options.kind,
      message: options.message.slice(0, 512) || "semantic analysis failed",
    },
    limitations: [
      "The semantic sidecar failed; absence of callsites is not evidence that sensitive callsites are absent.",
      "The lexical inspection remains available as independent bounded evidence.",
      "Worker resource limits bound V8 heap generations and stack only; they are not a total-RSS or OS-permission sandbox.",
    ],
  });
}

export function verifyNodeSemanticAnalysis(options: {
  readonly analysis: NodeSemanticStaticV1;
  readonly inspection: NodePackageStaticInspectionV1;
  readonly lexicalInspectionArtifact: string;
  readonly lexicalInspectionSha256: string;
}): void {
  const analysis = nodeSemanticStaticV1Schema.parse(options.analysis);
  if (
    analysis.runId !== options.inspection.runId ||
    analysis.targetId !== options.inspection.targetId ||
    analysis.input.lexicalInspectionArtifact !==
      options.lexicalInspectionArtifact ||
    analysis.input.lexicalInspectionSha256 !== options.lexicalInspectionSha256
  ) {
    throw new SemanticInputError(
      "semantic evidence identity does not match its lexical source inspection",
    );
  }
  const declared = new Map(
    options.inspection.source.scannedFiles.map((source) => [source.path, source]),
  );
  if (analysis.files.length !== declared.size) {
    throw new SemanticInputError(
      "semantic file coverage does not exactly cover the lexical source set",
    );
  }
  for (const file of analysis.files) {
    const source = declared.get(file.targetPath);
    if (
      source === undefined ||
      source.sha256 !== file.sha256 ||
      source.sizeBytes !== file.sizeBytes ||
      source.evidence.artifactPath !== file.evidence.artifactPath
    ) {
      throw new SemanticInputError(
        `semantic file coverage mismatch for '${file.targetPath}'`,
      );
    }
  }
  if (
    analysis.input.sourceSetSha256 !==
    sourceSetSha256(options.inspection.source.scannedFiles.map((source) => ({
      targetPath: source.path,
      sizeBytes: source.sizeBytes,
      sha256: source.sha256,
      evidence: source.evidence,
    })))
  ) {
    throw new SemanticInputError(
      "semantic source-set digest does not match the lexical source set",
    );
  }
}

export async function runNodeSemanticAnalysis(
  options: RunNodeSemanticAnalysisOptions,
): Promise<NodeSemanticAnalysisResult> {
  const lexicalInspectionArtifact =
    options.lexicalInspectionArtifact ?? "static/inspection.json";
  const artifactPath = options.artifactPath ?? "static/semantic-inspection.json";
  const generatedAt = new Date().toISOString();
  const limits = normalizeLimits(options.limits);
  const lexicalBytes = await readFile(
    options.store.pathFor(lexicalInspectionArtifact),
  );
  const lexicalInspectionSha256 = sha256(lexicalBytes);
  let inspection: NodePackageStaticInspectionV1 | undefined;
  let declaredSources: NodePackageStaticInspectionV1["source"]["scannedFiles"] = [];
  let declaredSourceSetSha256 = sourceSetSha256([]);
  let analysis: NodeSemanticStaticV1;

  try {
    inspection = nodePackageStaticInspectionV1Schema.parse(
      parseJson(lexicalBytes, lexicalInspectionArtifact),
    );
    assertInspectionIdentity(inspection, options.runId, options.targetId);
    declaredSources = inspection.source.scannedFiles;
    declaredSourceSetSha256 = sourceSetSha256(
      declaredSources.map((source) => ({
        targetPath: source.path,
        sizeBytes: source.sizeBytes,
        sha256: source.sha256,
        evidence: source.evidence,
      })),
    );
    const inputBytes = declaredSources.reduce(
      (total, source) => total + source.sizeBytes,
      0,
    );
    if (
      declaredSources.length > limits.maxInputFiles ||
      inputBytes > limits.maxInputBytes
    ) {
      throw new SemanticInputError(
        "the lexical source set exceeds the semantic worker input limits",
      );
    }
    const sources = await Promise.all(
      declaredSources.map(async (source) =>
        await loadCapturedSource({
          store: options.store,
          runId: options.runId,
          targetId: options.targetId,
          source,
        }),
      ),
    );
    const input: NodeSemanticEngineInput = {
      runId: options.runId,
      targetId: options.targetId,
      generatedAt,
      lexicalInspectionArtifact,
      lexicalInspectionSha256,
      sourceSetSha256: declaredSourceSetSha256,
      limits,
      sources,
    };
    analysis = await (options.workerRunner ?? runNodeSemanticWorker)(input);
    verifyNodeSemanticAnalysis({
      analysis,
      inspection,
      lexicalInspectionArtifact,
      lexicalInspectionSha256,
    });
  } catch (error) {
    const kind =
      error instanceof SemanticInputError
        ? "invalid_input"
        : error instanceof SemanticWorkerError
          ? error.kind
          : "worker_error";
    analysis = failedAnalysis({
      runId: options.runId,
      targetId: options.targetId,
      generatedAt,
      lexicalInspectionArtifact,
      lexicalInspectionSha256,
      sourceSetSha256: declaredSourceSetSha256,
      limits,
      declaredSources,
      kind,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const destination = await options.store.writeJson(
    artifactPath,
    nodeSemanticStaticV1Schema,
    analysis,
  );
  return {
    analysis,
    artifactPath,
    artifactSha256: await sha256File(destination),
  };
}
