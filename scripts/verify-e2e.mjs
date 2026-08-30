import { execFile, spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
  postReturnFinding?.eventIds.some((eventId) => {
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
invariant(
  filesystemRunManifest.toolchain.observerImageReference === "forge-sandbox:dev" &&
    filesystemRunManifest.toolchain.observerImageId === observerImage,
  "Filesystem run did not record the immutable observer image identity",
);
invariant(
  filesystemReport.artifactProvenance.source.type === "npm" &&
    filesystemReport.artifactProvenance.source.requestedVersion === "2026.7.10",
  "Filesystem report is missing exact npm provenance",
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
