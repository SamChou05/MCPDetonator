import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = resolve(dirname(scriptPath), "..");
const defaultSampleRoot = join(defaultProjectRoot, "examples", "reports");

const DECEPTIVE_SAMPLE = "deceptive-control.report.json";
const FILESYSTEM_SAMPLE = "official-filesystem.report.json";
const SAMPLE_README = "README.md";

let schemaModulePromise;

async function loadCurrentSchemas() {
  schemaModulePromise ??= (async () => {
    let tsImport;
    try {
      // Prefer the TypeScript source so a stale ignored dist/ tree cannot validate
      // fixtures against an older contract. tsx is already a development
      // dependency used throughout this repository.
      ({ tsImport } = await import("tsx/esm/api"));
    } catch (sourceLoaderError) {
      try {
        // A production-style checkout may omit development dependencies. In
        // that case, accept the built contract, with an explicit error if
        // neither current source nor build output is loadable.
        return await import("../dist/contracts/v1.js");
      } catch (distError) {
        throw new AggregateError(
          [sourceLoaderError, distError],
          "could not load Forge report/run schemas; run npm install and npm run build",
        );
      }
    }
    // Once the source loader is available, a source-contract failure must not
    // silently fall back to potentially stale build output.
    return await tsImport("../src/contracts/v1.ts", import.meta.url);
  })();
  const schemas = await schemaModulePromise;
  if (
    schemas.reportV1Schema === undefined ||
    schemas.runManifestV1Schema === undefined
  ) {
    throw new Error("loaded Forge contracts do not export the required schemas");
  }
  return schemas;
}

function parseArguments(args) {
  const [deceptiveArgument, filesystemArgument, ...extraArguments] = args;
  if (
    deceptiveArgument === undefined ||
    filesystemArgument === undefined ||
    extraArguments.length > 0
  ) {
    throw new Error(
      "usage: node scripts/refresh-sample-reports.mjs <deceptive-run-directory> <filesystem-run-directory>",
    );
  }
  return { deceptiveArgument, filesystemArgument };
}

async function checkedRunDirectory(projectRoot, argument) {
  const directory = resolve(projectRoot, argument);
  const projectRelative = relative(projectRoot, directory);
  if (
    projectRelative.startsWith(`..${sep}`) ||
    projectRelative === ".." ||
    !/^runs[/\\]run-[a-zA-Z0-9-]+$/u.test(projectRelative)
  ) {
    throw new Error(`sample source is not an explicit Forge run: ${argument}`);
  }

  const [realRunsRoot, realDirectory] = await Promise.all([
    realpath(join(projectRoot, "runs")),
    realpath(directory),
  ]);
  const runsRelative = relative(realRunsRoot, realDirectory);
  if (
    runsRelative.startsWith(`..${sep}`) ||
    runsRelative === ".." ||
    runsRelative.includes(sep) ||
    basename(realDirectory) !== basename(directory)
  ) {
    throw new Error(`sample source resolves outside the Forge runs root: ${argument}`);
  }
  return { directory: realDirectory, runId: basename(directory) };
}

function sanitize(value, projectRoots) {
  if (typeof value === "string") {
    return projectRoots.reduce(
      (sanitized, projectRoot) =>
        sanitized.replaceAll(projectRoot, "<repository-root>"),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((child) => sanitize(child, projectRoots));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        sanitize(child, projectRoots),
      ]),
    );
  }
  return value;
}

const SAMPLE_GUARDS = [
  {
    label: "macOS host home path",
    pattern: /\/Users\/[^/\s]+\//u,
  },
  {
    label: "Windows host home path",
    pattern: /[A-Za-z]:\\Users\\[^\\\s]+\\/u,
  },
  {
    label: "macOS host temporary path",
    pattern: /\/private\/var\/folders\/[A-Za-z0-9_-]+\//u,
  },
  {
    label: "private key",
    pattern: /BEGIN (?:[A-Z0-9]+[ -])*PRIVATE KEY/iu,
  },
  {
    label: "OpenAI-style secret key",
    pattern: /sk-[A-Za-z0-9_-]{12,}/u,
  },
  {
    label: "GitHub token",
    pattern: /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u,
  },
  {
    label: "AWS access key",
    pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/u,
  },
  {
    label: "Slack token",
    pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/u,
  },
  {
    label: "Google API key",
    pattern: /AIza[A-Za-z0-9_-]{30,}/u,
  },
  {
    label: "npm access token",
    pattern: /npm_[A-Za-z0-9]{30,}/u,
  },
  {
    label: "bearer credential",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/iu,
  },
];

export function assertSampleContentSafe(serialized, label) {
  for (const guard of SAMPLE_GUARDS) {
    if (guard.pattern.test(serialized)) {
      throw new Error(
        `${label} retains a credential-like or local value (${guard.label})`,
      );
    }
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function containedArtifactPath(runDirectory, artifactPath) {
  const resolvedPath = resolve(runDirectory, artifactPath);
  const runRelative = relative(runDirectory, resolvedPath);
  if (
    runRelative.length === 0 ||
    runRelative === ".." ||
    runRelative.startsWith(`..${sep}`)
  ) {
    throw new Error(
      `semantic artifact path resolves outside its Forge run: ${artifactPath}`,
    );
  }
  return resolvedPath;
}

async function loadSemanticArtifact(options) {
  const matchingArtifacts = options.manifest.artifacts.filter(
    (artifact) => artifact.path === options.artifactPath,
  );
  if (matchingArtifacts.length !== 1) {
    throw new Error(
      `run ${options.runId} must bind exactly one ${options.stage} semantic artifact`,
    );
  }
  const [artifact] = matchingArtifacts;
  if (artifact.mediaType !== "application/json") {
    throw new Error(
      `run ${options.runId} ${options.stage} semantic artifact is not JSON`,
    );
  }

  const unresolvedPath = containedArtifactPath(
    options.directory,
    options.artifactPath,
  );
  const realArtifactPath = await realpath(unresolvedPath);
  containedArtifactPath(options.directory, realArtifactPath);
  const source = await readFile(realArtifactPath);
  const digest = sha256(source);
  if (artifact.sha256 !== digest) {
    throw new Error(
      `run ${options.runId} does not bind its ${options.stage} semantic artifact to the manifest`,
    );
  }
  if (options.expectedReportSha256 !== undefined && digest !== options.expectedReportSha256) {
    throw new Error(
      `run ${options.runId} selected semantic artifact does not match the report summary`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(source.toString("utf8"));
  } catch {
    throw new Error(
      `run ${options.runId} ${options.stage} semantic artifact is not valid JSON`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    parsed.schema !== "forge.node-semantic-static/v1" ||
    parsed.runId !== options.runId ||
    parsed.targetId !== options.targetId ||
    parsed.input === null ||
    typeof parsed.input !== "object" ||
    parsed.input.lexicalInspectionArtifact !== options.lexicalInspectionArtifact
  ) {
    throw new Error(
      `run ${options.runId} ${options.stage} semantic artifact identity is inconsistent`,
    );
  }
}

async function verifySemanticArtifacts(options) {
  if (options.report.semanticAnalysis === undefined) return;
  const selectedPath = options.report.evidence.semanticInspection;
  const preInstallPath = options.report.evidence.preInstallSemanticInspection;
  if (
    selectedPath === undefined ||
    preInstallPath === undefined ||
    selectedPath === preInstallPath
  ) {
    throw new Error(
      `run ${options.runId} requires distinct selected and pre-install semantic artifacts`,
    );
  }
  await Promise.all([
    loadSemanticArtifact({
      ...options,
      artifactPath: selectedPath,
      stage: "selected",
      lexicalInspectionArtifact: "static/inspection.json",
      expectedReportSha256: options.report.semanticAnalysis.artifactSha256,
    }),
    loadSemanticArtifact({
      ...options,
      artifactPath: preInstallPath,
      stage: "pre-install",
      lexicalInspectionArtifact: "static/pre-install-inspection.json",
    }),
  ]);
}

async function loadRun(
  projectRoot,
  argument,
  expectedTargetId,
  reportV1Schema,
  runManifestV1Schema,
) {
  const { directory, runId } = await checkedRunDirectory(projectRoot, argument);
  const [reportSource, manifestSource] = await Promise.all([
    readFile(join(directory, "report.json"), "utf8"),
    readFile(join(directory, "run.json"), "utf8"),
  ]);
  const report = reportV1Schema.parse(JSON.parse(reportSource));
  const manifest = runManifestV1Schema.parse(JSON.parse(manifestSource));

  if (
    report.runId !== runId ||
    manifest.runId !== runId ||
    report.targetId !== expectedTargetId ||
    manifest.targetId !== expectedTargetId
  ) {
    throw new Error(
      `run ${runId} does not consistently identify the expected ${expectedTargetId} report`,
    );
  }
  if (manifest.status !== "completed" || manifest.completedAt === undefined) {
    throw new Error(`run ${runId} is not a completed Forge analysis`);
  }

  const reportArtifact = manifest.artifacts.find(
    (artifact) => artifact.path === "report.json",
  );
  if (
    reportArtifact?.mediaType !== "application/json" ||
    reportArtifact.sha256 !== sha256(reportSource)
  ) {
    throw new Error(`run ${runId} does not bind report.json to its manifest`);
  }

  await verifySemanticArtifacts({
    directory,
    runId,
    targetId: expectedTargetId,
    manifest,
    report,
  });

  const realProjectRoot = await realpath(projectRoot);
  const sanitized = sanitize(report, [...new Set([projectRoot, realProjectRoot])]);
  if (
    (sanitized.artifactProvenance.source.type === "local" ||
      sanitized.artifactProvenance.source.type === "fixture") &&
    !sanitized.artifactProvenance.source.configuredPath.startsWith(
      "<repository-root>/",
    )
  ) {
    throw new Error(
      `sanitized ${expectedTargetId} report retains a local source path outside the repository`,
    );
  }
  const serialized = `${JSON.stringify(sanitized, null, 2)}\n`;
  assertSampleContentSafe(serialized, `sanitized ${expectedTargetId} report`);
  return { manifest, report: sanitized, serialized };
}

function refreshedReadme(readme, deceptiveRunId, filesystemRunId) {
  const deceptivePattern =
    /(`deceptive-control\.report\.json` is the report from `)run-[^`]+(`\.)/u;
  const filesystemPattern =
    /(`official-filesystem\.report\.json` is the report from `)run-[^`]+(`\.)/u;
  if (!deceptivePattern.test(readme) || !filesystemPattern.test(readme)) {
    throw new Error("sample report README run identifier lines are missing");
  }
  return readme
    .replace(deceptivePattern, `$1${deceptiveRunId}$2`)
    .replace(filesystemPattern, `$1${filesystemRunId}$2`);
}

async function writeAtomically(path, contents, transactionId) {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.forge-refresh-${transactionId}.tmp`,
  );
  await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
  return {
    temporary,
    commit: () => rename(temporary, path),
  };
}

export async function refreshSampleReports(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? defaultProjectRoot);
  const sampleRoot = resolve(options.sampleRoot ?? defaultSampleRoot);
  const { deceptiveArgument, filesystemArgument } = parseArguments(
    options.args ?? process.argv.slice(2),
  );
  const schemas = options.schemas ?? (await loadCurrentSchemas());

  const [deceptive, filesystem, readme] = await Promise.all([
    loadRun(
      projectRoot,
      deceptiveArgument,
      "deceptive-document-summarizer",
      schemas.reportV1Schema,
      schemas.runManifestV1Schema,
    ),
    loadRun(
      projectRoot,
      filesystemArgument,
      "official-filesystem",
      schemas.reportV1Schema,
      schemas.runManifestV1Schema,
    ),
    readFile(join(sampleRoot, SAMPLE_README), "utf8"),
  ]);

  if (
    deceptive.manifest.toolchain.observerImageId !==
      filesystem.manifest.toolchain.observerImageId ||
    deceptive.manifest.toolchain.observerImageReference !==
      filesystem.manifest.toolchain.observerImageReference
  ) {
    throw new Error(
      "sample runs do not use the same immutable observer image and reference",
    );
  }

  // Validate and render all three final documents before creating any temporary
  // file. Each final rename is atomic; cleanup removes every uncommitted temp.
  const renderedReadme = refreshedReadme(
    readme,
    deceptive.report.runId,
    filesystem.report.runId,
  );
  assertSampleContentSafe(renderedReadme, "sample report README");

  const transactionId = `${process.pid}-${randomUUID()}`;
  const writes = [];
  try {
    writes.push(
      await writeAtomically(
        join(sampleRoot, DECEPTIVE_SAMPLE),
        deceptive.serialized,
        transactionId,
      ),
    );
    writes.push(
      await writeAtomically(
        join(sampleRoot, FILESYSTEM_SAMPLE),
        filesystem.serialized,
        transactionId,
      ),
    );
    writes.push(
      await writeAtomically(
        join(sampleRoot, SAMPLE_README),
        renderedReadme,
        transactionId,
      ),
    );
    for (const write of writes) {
      await write.commit();
    }
  } finally {
    await Promise.all(
      writes.map((write) => rm(write.temporary, { force: true })),
    );
  }

  return {
    deceptiveRunId: deceptive.report.runId,
    filesystemRunId: filesystem.report.runId,
    observerImageId: deceptive.manifest.toolchain.observerImageId,
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  await refreshSampleReports();
}
