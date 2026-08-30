import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runForge(target, rebuildImage) {
  const args = [resolve(projectRoot, "dist", "cli.js"), "analyze", target];
  if (rebuildImage) {
    args.push("--rebuild-image");
  }
  const output = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (code === 0) {
        resolveRun(text);
      } else {
        rejectRun(
          new Error(
            `Forge exited with ${code ?? `signal ${signal ?? "unknown"}`}:\n${text.slice(-4_000)}`,
          ),
        );
      }
    });
  });
  const marker = output.lastIndexOf('{\n  "status": "completed"');
  invariant(marker >= 0, `Forge did not emit a completion object:\n${output.slice(-2_000)}`);
  return JSON.parse(output.slice(marker));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonl(path) {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function assertSemanticEvidence(runDirectory, report, manifest, label) {
  const selectedPath = report.evidence.semanticInspection;
  const preInstallPath = report.evidence.preInstallSemanticInspection;
  invariant(
    report.semanticAnalysis !== undefined &&
      typeof selectedPath === "string" &&
      typeof preInstallPath === "string",
    `${label} is missing the semantic summary or retained artifacts`,
  );
  const selectedBytes = await readFile(join(runDirectory, selectedPath));
  const selected = JSON.parse(selectedBytes.toString("utf8"));
  const preInstallBytes = await readFile(join(runDirectory, preInstallPath));
  const preInstall = JSON.parse(preInstallBytes.toString("utf8"));
  const lexicalBytes = await readFile(
    join(runDirectory, report.evidence.staticInspection),
  );
  const lexical = JSON.parse(lexicalBytes.toString("utf8"));
  const preInstallLexicalBytes = await readFile(
    join(runDirectory, report.evidence.preInstallStaticInspection),
  );
  const retainedArtifact = manifest.artifacts.find(
    (artifact) => artifact.path === selectedPath,
  );
  const retainedPreInstallArtifact = manifest.artifacts.find(
    (artifact) => artifact.path === preInstallPath,
  );
  invariant(
    selected.schema === "forge.node-semantic-static/v1" &&
      preInstall.schema === "forge.node-semantic-static/v1" &&
      selected.runId === report.runId &&
      selected.targetId === report.targetId &&
      preInstall.runId === report.runId &&
      preInstall.targetId === report.targetId &&
      selected.input.lexicalInspectionArtifact ===
        report.evidence.staticInspection &&
      preInstall.input.lexicalInspectionArtifact ===
        report.evidence.preInstallStaticInspection &&
      selected.input.lexicalInspectionSha256 === sha256(lexicalBytes) &&
      preInstall.input.lexicalInspectionSha256 ===
        sha256(preInstallLexicalBytes) &&
      report.semanticAnalysis.artifactPath === selectedPath &&
      report.semanticAnalysis.artifactSha256 === sha256(selectedBytes) &&
      retainedArtifact?.mediaType === "application/json" &&
      retainedArtifact.sha256 === sha256(selectedBytes) &&
      retainedPreInstallArtifact?.mediaType === "application/json" &&
      retainedPreInstallArtifact.sha256 === sha256(preInstallBytes),
    `${label} semantic identity or artifact digest is inconsistent`,
  );

  invariant(
    report.semanticAnalysis.status === selected.status &&
      isDeepStrictEqual(report.semanticAnalysis.analyzer, selected.analyzer) &&
      report.semanticAnalysis.sourceSetSha256 ===
        selected.input.sourceSetSha256 &&
      isDeepStrictEqual(report.semanticAnalysis.coverage, selected.coverage) &&
      isDeepStrictEqual(
        report.semanticAnalysis.truncations,
        selected.truncations,
      ) &&
      isDeepStrictEqual(report.semanticAnalysis.failure, selected.failure) &&
      isDeepStrictEqual(
        report.semanticAnalysis.limitations,
        selected.limitations,
      ),
    `${label} semantic report summary diverges from the retained artifact`,
  );

  const lexicalSources = new Map(
    lexical.source.scannedFiles.map((source) => [source.path, source]),
  );
  invariant(
    selected.files.length === lexicalSources.size &&
      selected.coverage.inputFiles === selected.files.length &&
      selected.coverage.inputBytes ===
        selected.files.reduce((total, file) => total + file.sizeBytes, 0),
    `${label} semantic file coverage does not match its lexical source set`,
  );
  for (const file of selected.files) {
    const lexicalSource = lexicalSources.get(file.targetPath);
    invariant(
      lexicalSource?.sha256 === file.sha256 &&
        lexicalSource.sizeBytes === file.sizeBytes &&
        lexicalSource.evidence.artifactPath === file.evidence.artifactPath,
      `${label} semantic coverage contains an unbound source file`,
    );
  }

  const callsiteIds = selected.callsites.map((callsite) => callsite.callsiteId);
  invariant(
    selected.callsites.length === report.semanticAnalysis.callsiteCount &&
      sortedUnique(callsiteIds).length === callsiteIds.length,
    `${label} semantic callsite counts or identifiers are inconsistent`,
  );
  const expectedCapabilities = new Map();
  const expectedReachability = {
    directHandler: 0,
    boundedCallPath: 0,
    notIdentified: 0,
    notAssessed: 0,
  };
  const reachabilityField = {
    direct_handler: "directHandler",
    bounded_call_path: "boundedCallPath",
    not_identified: "notIdentified",
    not_assessed: "notAssessed",
  };
  for (const callsite of selected.callsites) {
    const file = lexicalSources.get(callsite.evidence.targetPath);
    invariant(
      callsite.callsiteId.startsWith("semantic-callsite-") &&
        callsite.sinkId.startsWith("node.") &&
        file?.sha256 === callsite.evidence.sha256,
      `${label} semantic callsite is not bound to admitted source evidence`,
    );
    expectedCapabilities.set(
      callsite.capability,
      (expectedCapabilities.get(callsite.capability) ?? 0) + 1,
    );
    expectedReachability[reachabilityField[callsite.handlerReachability]] += 1;
  }
  invariant(
    JSON.stringify(
      [...expectedCapabilities.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([capability, count]) => ({ capability, count })),
    ) === JSON.stringify(report.semanticAnalysis.capabilityCallsites) &&
      JSON.stringify(expectedReachability) ===
        JSON.stringify(report.semanticAnalysis.handlerReachability),
    `${label} semantic report partitions diverge from the retained artifact`,
  );
}

function claimReferenceKeys(claims) {
  return new Set(
    claims.interfaces.flatMap((mcpInterface) =>
      mcpInterface.capabilityAssessments.flatMap((assessment) =>
        assessment.evidence.map(
          (evidence) => `${evidence.evidenceId}\0${evidence.pointer}`,
        ),
      ),
    ),
  );
}

function assertBehaviorClaimReferences(report, label) {
  const available = claimReferenceKeys(report.advertisedClaims);
  for (const scope of report.behaviorComparison.scopes) {
    for (const row of scope.rows) {
      for (const reference of row.advertisedClaimReferences) {
        invariant(
          available.has(`${reference.evidenceId}\0${reference.fieldReference}`),
          `${label} behavior comparison contains an unresolved advertised-claim reference`,
        );
      }
    }
  }
}

const COMPARED_CAPABILITIES = [
  "filesystem_access",
  "network_access",
  "process_execution",
];

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function assertBehaviorComparisonCompleteness(report, label) {
  const observations = new Map(
    report.runtimeObservations.map((observation) => [
      observation.experimentId,
      observation,
    ]),
  );
  invariant(
    observations.size === report.runtimeObservations.length,
    `${label} contains duplicate runtime-observation experiment IDs`,
  );
  const scopes = new Map(
    report.behaviorComparison.scopes.map((scope) => [scope.experimentId, scope]),
  );
  invariant(
    scopes.size === report.behaviorComparison.scopes.length &&
      scopes.size === observations.size,
    `${label} behavior comparison does not cover each runtime experiment exactly once`,
  );

  for (const [experimentId, observation] of observations) {
    const scope = scopes.get(experimentId);
    invariant(
      scope?.kind === observation.kind && scope.toolName === observation.toolName,
      `${label} behavior scope '${experimentId}' has the wrong kind or tool identity`,
    );
    invariant(
      scope.rows.length === COMPARED_CAPABILITIES.length &&
        JSON.stringify(sortedUnique(scope.rows.map((row) => row.capability))) ===
        JSON.stringify(COMPARED_CAPABILITIES),
      `${label} behavior scope '${experimentId}' does not contain each compared capability exactly once`,
    );

    for (const row of scope.rows) {
      const claimKeys = row.advertisedClaimReferences.map(
        (reference) => `${reference.evidenceId}\0${reference.fieldReference}`,
      );
      invariant(
        (row.staticState === "found") === (row.staticSignalIds.length > 0) &&
          sortedUnique(row.staticSignalIds).length === row.staticSignalIds.length,
        `${label} ${experimentId}/${row.capability} has inconsistent static evidence`,
      );
      invariant(
        (row.runtimeState === "observed") === (row.runtimeEventIds.length > 0),
        `${label} ${experimentId}/${row.capability} has inconsistent runtime evidence`,
      );
      invariant(
        sortedUnique(row.runtimeEventIds).length === row.runtimeEventIds.length &&
          sortedUnique(row.temporalOverlapEventIds).length ===
            row.temporalOverlapEventIds.length &&
          sortedUnique(claimKeys).length === claimKeys.length,
        `${label} ${experimentId}/${row.capability} repeats a behavior-evidence identifier`,
      );

      const partition = [
        ...row.withinOperatorScopeEventIds,
        ...row.outsideOperatorScopeEventIds,
        ...row.unclassifiedRuntimeEventIds,
      ];
      invariant(
        partition.length === sortedUnique(partition).length &&
          JSON.stringify([...partition].sort()) ===
            JSON.stringify([...row.runtimeEventIds].sort()),
        `${label} ${experimentId}/${row.capability} does not exactly partition runtime events by operator scope`,
      );
      invariant(
        row.temporalOverlapEventIds.every((eventId) =>
          row.runtimeEventIds.includes(eventId),
        ),
        `${label} ${experimentId}/${row.capability} has a temporal-overlap ID outside its runtime evidence`,
      );
      invariant(
        (row.operatorScopeState === "configured" &&
          row.unclassifiedRuntimeEventIds.length === 0) ||
          (row.operatorScopeState === "not_configured" &&
            row.withinOperatorScopeEventIds.length === 0 &&
            row.outsideOperatorScopeEventIds.length === 0),
        `${label} ${experimentId}/${row.capability} contradicts its operator-scope state`,
      );

      if (scope.kind === "initialization") {
        invariant(
          row.advertisedState === "not_applicable" &&
            row.advertisedClaimReferences.length === 0,
          `${label} ${experimentId}/${row.capability} assigns tool claims to initialization`,
        );
      } else {
        invariant(
          row.advertisedState !== "not_applicable" &&
            (row.advertisedState === "claimed") ===
              (row.advertisedClaimReferences.length > 0),
          `${label} ${experimentId}/${row.capability} has inconsistent advertised-claim evidence`,
        );
      }
    }
  }
}

async function readFilesystemStateEvidence(
  runDirectory,
  expectedRunId,
  observation,
) {
  const state = observation?.filesystemStateDelta;
  invariant(
    state?.scope === "isolated_experiment_window" &&
      state.attribution === "experiment_only",
    `experiment '${observation?.experimentId ?? "unknown"}' lacks explicit filesystem-state scope`,
  );
  const before = await readJson(join(runDirectory, state.artifactRefs.before));
  const after = await readJson(join(runDirectory, state.artifactRefs.after));
  const delta = await readJson(join(runDirectory, state.artifactRefs.delta));
  invariant(
    before.schema === "forge.filesystem-state/v1" &&
      before.runId === expectedRunId &&
      before.label === "before" &&
      before.experimentId === observation.experimentId &&
      after.schema === "forge.filesystem-state/v1" &&
      after.runId === expectedRunId &&
      after.label === "after" &&
      after.experimentId === observation.experimentId &&
      delta.schema === "forge.filesystem-delta/v1" &&
      delta.runId === expectedRunId &&
      delta.experimentId === observation.experimentId &&
      JSON.stringify(delta.artifactRefs) === JSON.stringify(state.artifactRefs) &&
      delta.snapshotsComplete.before === before.complete &&
      delta.snapshotsComplete.after === after.complete &&
      state.snapshotsComplete.before === before.complete &&
      state.snapshotsComplete.after === after.complete &&
      state.changeCounts.created === delta.changes.created.length &&
      state.changeCounts.modified === delta.changes.modified.length &&
      state.changeCounts.deleted === delta.changes.deleted.length &&
      state.changeCounts.typeChanged === delta.changes.typeChanged.length,
    `experiment '${observation.experimentId}' has inconsistent filesystem-state artifacts`,
  );
  return { before, after, delta };
}

async function readAllFilesystemStateEvidence(runDirectory, report) {
  return new Map(
    await Promise.all(
      report.runtimeObservations.map(async (observation) => [
        observation.experimentId,
        await readFilesystemStateEvidence(
          runDirectory,
          report.runId,
          observation,
        ),
      ]),
    ),
  );
}

async function imageId() {
  const { stdout } = await execFileAsync(
    "docker",
    ["image", "inspect", "forge-sandbox:dev", "--format", "{{.Id}}"],
    { cwd: projectRoot, encoding: "utf8" },
  );
  return stdout.trim();
}

async function assertCoreHasNoCaseBranches() {
  const forbidden = [
    "@modelcontextprotocol/server-filesystem",
    "secure-filesystem-server",
    "read_text_file",
    "summarize_file",
  ];
  for (const directory of ["src", "container"]) {
    const pending = [resolve(projectRoot, directory)];
    while (pending.length > 0) {
      const current = pending.pop();
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(path);
        } else if (entry.isFile()) {
          const source = await readFile(path, "utf8");
          for (const token of forbidden) {
            invariant(!source.includes(token), `${path} contains case-specific token '${token}'`);
          }
        }
      }
    }
  }
}

await assertCoreHasNoCaseBranches();

const deceptive = await runForge("fixtures/deceptive-mcp/target.yaml", true);
const observerImage = await imageId();
const filesystem = await runForge("case-studies/filesystem/target.yaml", false);
invariant(
  (await imageId()) === observerImage,
  "observer image changed between the two targets",
);

const deceptiveReport = await readJson(join(deceptive.runDirectory, "report.json"));
const deceptiveRunManifest = await readJson(join(deceptive.runDirectory, "run.json"));
await assertSemanticEvidence(
  deceptive.runDirectory,
  deceptiveReport,
  deceptiveRunManifest,
  "deceptive control",
);
assertBehaviorComparisonCompleteness(deceptiveReport, "deceptive control");
await readAllFilesystemStateEvidence(deceptive.runDirectory, deceptiveReport);
invariant(
  deceptiveReport.advertisedInterfaceSummary.catalogConsistency === "consistent" &&
    deceptiveReport.advertisedInterfaceSummary.comparedExperimentIds.length === 2 &&
    deceptiveReport.advertisedInterfaceSummary.differingExperimentIds.length === 0 &&
    deceptiveReport.advertisedInterfaceSummary.duplicateToolNames.length === 0,
  "deceptive run did not establish a stable per-experiment MCP catalog",
);
invariant(
  deceptiveRunManifest.toolchain.observerImageReference === "forge-sandbox:dev" &&
    deceptiveRunManifest.toolchain.observerImageId === observerImage,
  "deceptive run did not record the immutable observer image identity",
);
const deceptiveRules = deceptiveReport.findings.map((finding) => finding.ruleId).sort();
invariant(
  JSON.stringify(deceptiveRules) ===
    JSON.stringify([
      "runtime.file_scope_exceeded",
      "runtime.initialization_sensitive_access",
      "runtime.unexpected_network_attempt",
      "runtime.unexpected_process_exec",
      "runtime.post_return_activity",
    ].sort()),
  `deceptive control produced unexpected rules: ${deceptiveRules.join(", ")}`,
);
invariant(
  deceptiveReport.artifactProvenance.source.type === "local" &&
    deceptiveReport.staticAnalysis.manifest.status === "parsed",
  "deceptive control is missing local provenance or static inspection",
);
invariant(
  deceptiveReport.installLifecycle.status === "observed" &&
    deceptiveReport.installLifecycle.comparisonStatus === "complete" &&
    deceptiveReport.artifactProvenance.runtimeSnapshot.lifecycleScripts === "enabled",
  "deceptive control did not complete the install A/B comparison or use its enabled snapshot",
);
invariant(
  deceptiveReport.staticAnalysis.snapshot.treeSha256 ===
      deceptiveReport.artifactProvenance.runtimeSnapshot.treeSha256 &&
    deceptiveReport.staticAnalysis.snapshot.sourceExperimentId ===
      deceptiveReport.artifactProvenance.runtimeSnapshot.sourceExperimentId,
  "deceptive static analysis is not tied to the selected runtime snapshot",
);
await readJson(
  join(
    deceptive.runDirectory,
    deceptiveReport.evidence.preInstallStaticInspection,
  ),
);
const deceptiveEvents = await readJsonl(join(deceptive.runDirectory, "events.jsonl"));
const deceptiveAttributions = new Map(
  (await readJsonl(join(deceptive.runDirectory, "attributions.jsonl"))).map(
    (value) => [value.eventId, value],
  ),
);
const initializationFinding = deceptiveReport.findings.find(
  (finding) => finding.ruleId === "runtime.initialization_sensitive_access",
);
invariant(
  initializationFinding?.confidence === "high" &&
    initializationFinding.eventIds.some((eventId) => {
      const event = deceptiveEvents.find((candidate) => candidate.eventId === eventId);
      return (
        event?.effect.kind === "file.read" &&
        event.effect.path.endsWith("/.config/gh/hosts.yml") &&
        deceptiveAttributions
          .get(eventId)
          ?.activePhaseId?.includes("baseline-initialization-initialization")
      );
    }),
  "deceptive control did not surface its initialization credential read",
);
const postReturnFinding = deceptiveReport.findings.find(
  (finding) => finding.ruleId === "runtime.post_return_activity",
);
invariant(
  postReturnFinding?.confidence === "medium" &&
    postReturnFinding.eventIds.some((eventId) => {
      const event = deceptiveEvents.find((candidate) => candidate.eventId === eventId);
      const attribution = deceptiveAttributions.get(eventId);
      return (
        event?.effect.kind === "file.read" &&
        event.effect.path.endsWith("/.ssh/id_ed25519") &&
        attribution?.activePhaseId?.includes("cooldown") &&
        attribution?.processOriginPhaseId?.includes("tool")
      );
    }),
  "deceptive control did not link delayed credential access to a tool-originated cooldown process",
);
const deceptiveComparison = new Map(
  deceptiveReport.staticRuntimeComparison.rows.map((row) => [row.capability, row]),
);
for (const capability of [
  "filesystem_access",
  "process_execution",
  "network_access",
]) {
  invariant(
    deceptiveComparison.get(capability)?.staticSignal === "found" &&
      deceptiveComparison.get(capability)?.runtimeObservation === "observed",
    `deceptive control static/runtime comparison is incomplete for ${capability}`,
  );
}
const deceptiveToolComparison = deceptiveReport.behaviorComparison.scopes.find(
  (scope) => scope.experimentId === "summarize-file",
);
const deceptiveBehaviorRows = new Map(
  deceptiveToolComparison?.rows.map((row) => [row.capability, row]) ?? [],
);
invariant(
  deceptiveBehaviorRows.get("filesystem_access")?.advertisedState === "claimed" &&
    deceptiveBehaviorRows.get("filesystem_access")?.staticState === "found" &&
    deceptiveBehaviorRows.get("filesystem_access")?.runtimeState === "observed" &&
    deceptiveBehaviorRows.get("filesystem_access")?.withinOperatorScopeEventIds
      .length > 0 &&
    deceptiveBehaviorRows.get("filesystem_access")?.outsideOperatorScopeEventIds
      .length > 0,
  "deceptive control did not retain its advertised filesystem claim",
);
for (const capability of ["process_execution", "network_access"]) {
  const row = deceptiveBehaviorRows.get(capability);
  invariant(
    row?.advertisedState === "not_claimed" &&
      row.staticState === "found" &&
      row.runtimeState === "observed" &&
      row.outsideOperatorScopeEventIds.length > 0,
    `deceptive control did not expose unclaimed, out-of-scope ${capability}`,
  );
}
const deceptiveClaims = await readJson(
  join(deceptive.runDirectory, deceptiveReport.evidence.advertisedClaims),
);
invariant(
  JSON.stringify(deceptiveClaims) === JSON.stringify(deceptiveReport.advertisedClaims),
  "deceptive advertised-claim artifact and report summary diverged",
);
assertBehaviorClaimReferences(deceptiveReport, "deceptive control");
const treatmentEventIds = new Set(
  Object.values(deceptiveReport.installLifecycle.delta.treatmentOnly).flat(),
);
const treatmentEvents = deceptiveEvents.filter((event) =>
  treatmentEventIds.has(event.eventId),
);
invariant(
  treatmentEvents.some(
    (event) =>
      event.effect.kind === "process.exec" &&
      event.effect.args.some((argument) => argument.includes("postinstall.js")),
  ),
  "scripts-enabled install did not expose the controlled postinstall process",
);
invariant(
  treatmentEvents.some(
    (event) =>
      event.effect.kind === "file.read" &&
      event.effect.path.endsWith("/.forge/install-canary.txt"),
  ) &&
    treatmentEvents.some(
      (event) =>
        event.effect.kind === "file.write" &&
        event.effect.path === "/opt/target/.forge-install-marker.json",
    ),
  "scripts-enabled install did not expose the controlled canary read and marker write",
);

const filesystemReport = await readJson(join(filesystem.runDirectory, "report.json"));
const filesystemRunManifest = await readJson(join(filesystem.runDirectory, "run.json"));
await assertSemanticEvidence(
  filesystem.runDirectory,
  filesystemReport,
  filesystemRunManifest,
  "Filesystem",
);
assertBehaviorComparisonCompleteness(filesystemReport, "Filesystem case study");
const filesystemStateEvidence = await readAllFilesystemStateEvidence(
  filesystem.runDirectory,
  filesystemReport,
);
invariant(
  filesystemReport.advertisedInterfaceSummary.catalogConsistency === "consistent" &&
    filesystemReport.advertisedInterfaceSummary.comparedExperimentIds.length === 3 &&
    filesystemReport.advertisedInterfaceSummary.differingExperimentIds.length === 0 &&
    filesystemReport.advertisedInterfaceSummary.duplicateToolNames.length === 0,
  "Filesystem run did not establish a stable per-experiment MCP catalog",
);
invariant(
  filesystemRunManifest.toolchain.observerImageReference === "forge-sandbox:dev" &&
    filesystemRunManifest.toolchain.observerImageId === observerImage,
  "Filesystem run did not record the immutable observer image identity",
);
invariant(
  filesystemReport.artifactProvenance.source.type === "npm" &&
    filesystemReport.artifactProvenance.source.package ===
      "@modelcontextprotocol/server-filesystem" &&
    filesystemReport.artifactProvenance.source.requestedVersion === "2026.7.10" &&
    filesystemReport.artifactProvenance.source.resolvedVersion === "2026.7.10",
  "Filesystem report is missing exact npm provenance",
);
invariant(
  filesystemReport.findings.length === 0,
  `Filesystem report unexpectedly produced ${filesystemReport.findings.length} findings`,
);
invariant(
  filesystemReport.staticAnalysis.manifest.name ===
    "@modelcontextprotocol/server-filesystem",
  "Filesystem report did not statically inspect the actual published package",
);
invariant(
  filesystemReport.installLifecycle.status === "observed" &&
    filesystemReport.installLifecycle.comparisonStatus === "complete",
  "Filesystem install A/B comparison did not complete",
);
invariant(
  filesystemReport.staticAnalysis.snapshot.treeSha256 ===
      filesystemReport.artifactProvenance.runtimeSnapshot.treeSha256 &&
    filesystemReport.staticAnalysis.snapshot.sourceExperimentId ===
      filesystemReport.artifactProvenance.runtimeSnapshot.sourceExperimentId,
  "Filesystem static analysis is not tied to the selected runtime snapshot",
);
await readJson(
  join(
    filesystem.runDirectory,
    filesystemReport.evidence.preInstallStaticInspection,
  ),
);
const advertisedTools = new Set(filesystemReport.advertisedTools.map((tool) => tool.name));
invariant(
  advertisedTools.has("read_text_file") && advertisedTools.has("write_file"),
  "Filesystem MCP did not advertise the configured case-study tools",
);

const filesystemEvents = await readJsonl(join(filesystem.runDirectory, "events.jsonl"));
const expectedEvents = filesystemEvents.filter(
  (event) =>
    (event.experimentId === "read-synthetic-report" &&
      event.effect.kind === "file.read" &&
      event.effect.path === "/sandbox/workspace/report.txt") ||
    (event.experimentId === "write-synthetic-output" &&
      event.effect.kind === "file.write" &&
      event.effect.path === "/sandbox/workspace/forge-output.txt"),
);
invariant(expectedEvents.length === 2, "Filesystem positive read/write evidence is incomplete");
const reportPositiveExamples = filesystemReport.runtimeObservations.flatMap(
  (observation) => observation.expectedScopeMatches?.examples ?? [],
);
const reportPositiveEventIds = new Set(
  reportPositiveExamples.map((example) => example.eventId),
);
invariant(
  expectedEvents.every((event) => reportPositiveEventIds.has(event.eventId)),
  "Filesystem report does not summarize its positive read/write evidence",
);
const readObservation = filesystemReport.runtimeObservations.find(
  (observation) => observation.experimentId === "read-synthetic-report",
);
const writeObservation = filesystemReport.runtimeObservations.find(
  (observation) => observation.experimentId === "write-synthetic-output",
);
invariant(
  JSON.stringify(readObservation?.effectCounts) ===
    JSON.stringify([
      { effectKind: "file.open", count: 1 },
      { effectKind: "file.read", count: 1 },
    ]) &&
    JSON.stringify(writeObservation?.effectCounts) ===
      JSON.stringify([
        { effectKind: "file.open", count: 1 },
        { effectKind: "file.write", count: 1 },
      ]),
  "Filesystem report effect counts are not scoped to the active tool phases",
);
invariant(
  readObservation?.filesystemStateDelta?.snapshotsComplete.before === true &&
    readObservation.filesystemStateDelta.snapshotsComplete.after === true &&
    Object.values(readObservation.filesystemStateDelta.changeCounts).every(
      (count) => count === 0,
    ),
  "Filesystem read experiment changed durable synthetic profile state",
);
invariant(
  writeObservation?.filesystemStateDelta?.snapshotsComplete.before === true &&
    writeObservation.filesystemStateDelta.snapshotsComplete.after === true &&
    writeObservation.filesystemStateDelta.examples.some(
      (change) =>
        change.change === "created" &&
        change.path === "/sandbox/workspace/forge-output.txt" &&
        change.afterKind === "file",
    ),
  "Filesystem write experiment lacks a durable created-file state delta",
);
const readStateEvidence = filesystemStateEvidence.get("read-synthetic-report");
const writeStateEvidence = filesystemStateEvidence.get("write-synthetic-output");
invariant(
  readStateEvidence !== undefined && writeStateEvidence !== undefined,
  "Filesystem tool experiments lack linked state evidence",
);
invariant(
  Object.values(readStateEvidence.delta.changes).every(
    (changes) => changes.length === 0,
  ) &&
    !readStateEvidence.before.entries.some(
      (entry) => entry.path === "/sandbox/workspace/forge-output.txt",
    ) &&
    !readStateEvidence.after.entries.some(
      (entry) => entry.path === "/sandbox/workspace/forge-output.txt",
    ),
  "Filesystem read state artifacts contain an unexpected change",
);
invariant(
  writeStateEvidence.delta.changes.created.length === 1 &&
    writeStateEvidence.delta.changes.modified.length === 0 &&
    writeStateEvidence.delta.changes.deleted.length === 0 &&
    writeStateEvidence.delta.changes.typeChanged.length === 0 &&
    writeStateEvidence.delta.changes.created[0]?.path ===
      "/sandbox/workspace/forge-output.txt" &&
    !writeStateEvidence.before.entries.some(
      (entry) => entry.path === "/sandbox/workspace/forge-output.txt",
    ) &&
    writeStateEvidence.after.entries.some(
      (entry) =>
        entry.path === "/sandbox/workspace/forge-output.txt" &&
        entry.kind === "file",
    ),
  "Filesystem write state summary is not linked to an exact created-file delta",
);
const filesystemComparison = new Map(
  filesystemReport.staticRuntimeComparison.rows.map((row) => [row.capability, row]),
);
invariant(
  filesystemComparison.get("filesystem_access")?.staticSignal === "found" &&
    filesystemComparison.get("filesystem_access")?.runtimeObservation === "observed" &&
    filesystemComparison.get("process_execution")?.runtimeObservation ===
      "not_observed" &&
    filesystemComparison.get("network_access")?.runtimeObservation ===
      "not_observed",
  "Filesystem static/runtime comparison does not reflect selected tool effects",
);
for (const experimentId of [
  "read-synthetic-report",
  "write-synthetic-output",
]) {
  const scope = filesystemReport.behaviorComparison.scopes.find(
    (candidate) => candidate.experimentId === experimentId,
  );
  const filesystemRow = scope?.rows.find(
    (row) => row.capability === "filesystem_access",
  );
  const negativeRows = scope?.rows.filter(
    (row) => row.capability !== "filesystem_access",
  );
  invariant(
    filesystemRow?.advertisedState === "claimed" &&
      filesystemRow.staticState === "found" &&
      filesystemRow.runtimeState === "observed" &&
      filesystemRow.operatorScopeState === "configured" &&
      filesystemRow.withinOperatorScopeEventIds.length > 0 &&
      filesystemRow.outsideOperatorScopeEventIds.length === 0 &&
      filesystemRow.unclassifiedRuntimeEventIds.length === 0 &&
      negativeRows?.length === 2 &&
      negativeRows.every(
        (row) =>
          row.advertisedState === "not_claimed" &&
          row.staticState === "not_found" &&
          row.runtimeState === "not_observed" &&
          row.operatorScopeState === "configured" &&
          row.runtimeEventIds.length === 0 &&
          row.withinOperatorScopeEventIds.length === 0 &&
          row.outsideOperatorScopeEventIds.length === 0 &&
          row.unclassifiedRuntimeEventIds.length === 0,
      ),
    `Filesystem four-way comparison is incomplete for ${experimentId}`,
  );
}
const filesystemClaims = await readJson(
  join(filesystem.runDirectory, filesystemReport.evidence.advertisedClaims),
);
invariant(
  JSON.stringify(filesystemClaims) ===
    JSON.stringify(filesystemReport.advertisedClaims),
  "Filesystem advertised-claim artifact and report summary diverged",
);
assertBehaviorClaimReferences(filesystemReport, "Filesystem case study");
const attributions = new Map(
  (await readJsonl(join(filesystem.runDirectory, "attributions.jsonl"))).map(
    (value) => [value.eventId, value],
  ),
);
for (const event of expectedEvents) {
  const attribution = attributions.get(event.eventId);
  invariant(
    attribution?.activePhaseId?.includes(event.experimentId),
    `event ${event.eventId} is not linked to its tool phase`,
  );
  invariant(event.source.rawRef, `event ${event.eventId} lacks a raw evidence reference`);
  const reportExample = reportPositiveExamples.find(
    (example) => example.eventId === event.eventId,
  );
  invariant(
    reportExample?.attributionConfidence === attribution.confidence &&
      reportExample.rawRef === event.source.rawRef,
    `report summary for ${event.eventId} lost attribution or raw-evidence context`,
  );
}

const { stdout: leftoverContainers } = await execFileAsync(
  "docker",
  ["ps", "-a", "--filter", "label=forge.managed=true", "--format", "{{.Names}}"],
  { cwd: projectRoot, encoding: "utf8" },
);
invariant(leftoverContainers.trim() === "", "Forge left managed containers behind");

process.stdout.write(
  `${JSON.stringify(
    {
      status: "verified",
      observerImage,
      deceptiveRun: deceptive.runDirectory,
      filesystemRun: filesystem.runDirectory,
      filesystemPositiveEvents: expectedEvents.map((event) => event.eventId),
      deceptiveRules,
    },
    null,
    2,
  )}\n`,
);
