import { createHash } from "node:crypto";
import { readFile, readdir, rename, rm, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDemoExportV1 } from "../dist/dashboard/demo-export.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const outputDirectory = resolve(repositoryRoot, "dist", "dashboard-site");
const manifestPath = resolve(
  repositoryRoot,
  "dist",
  "dashboard-site.manifest.json",
);
const temporaryDirectory = resolve(
  repositoryRoot,
  "dist",
  `.dashboard-site-${process.pid}`,
);
const temporaryManifestPath = resolve(
  repositoryRoot,
  "dist",
  `.dashboard-site.manifest-${process.pid}.json`,
);
const templatePath = join(repositoryRoot, "dashboard", "index.html");
const stylesheetPath = join(repositoryRoot, "dashboard", "styles.css");
const templateMarker = "<!-- FORGE_DASHBOARD_CONTENT -->";

const controlledReport = {
  path: join(
    repositoryRoot,
    "examples",
    "reports",
    "deceptive-control.report.json",
  ),
  role: "controlled",
  expectedSha256:
    "45fa8a54cb9b6bf5ede4da2a03bd36e4ada55e8ae9cfcb3cf332171a87ab5411",
  expectedTargetId: "deceptive-document-summarizer",
  displayName: "Deceptive control",
  description:
    "Purpose-built negative case · selected tool: summarize_file",
  scopeLabels: [
    { experimentId: "baseline-initialization", label: "Initialization" },
    { experimentId: "summarize-file", label: "summarize_file tool" },
  ],
  limitations: [
    "This purpose-built synthetic negative case is not a third-party malware attribution.",
  ],
};

const referenceReport = {
  path: join(
    repositoryRoot,
    "examples",
    "reports",
    "official-filesystem.report.json",
  ),
  role: "reference",
  expectedSha256:
    "c1402b752d842d9717067ba4b17ed7aedfa2ba059c6c6eea4299a247ded0a34a",
  expectedTargetId: "official-filesystem",
  displayName: "Official Filesystem MCP",
  description:
    "Pinned real-package case study · selected tools: read_text_file and write_file",
  scopeLabels: [
    { experimentId: "baseline-initialization", label: "Initialization" },
    { experimentId: "read-synthetic-report", label: "read_text_file tool" },
    { experimentId: "write-synthetic-output", label: "write_file tool" },
  ],
  limitations: [
    "No deterministic findings appeared for these selected tools and inputs; this is not a universal safety claim.",
  ],
};

const capabilityOrder = [
  "filesystem_access",
  "process_execution",
  "network_access",
];
const capabilityLabels = {
  filesystem_access: "Filesystem",
  process_execution: "Process",
  network_access: "Network",
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function capitalize(value) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function selectedCapabilities(run, predicate) {
  const selected = new Set();
  for (const scope of run.behaviorScopes) {
    for (const row of scope.rows) {
      if (predicate(row)) selected.add(row.capability);
    }
  }
  return capabilityOrder.filter((capability) => selected.has(capability));
}

function capabilityText(capabilities) {
  if (capabilities.length === 0) return "None in selected scopes";
  return capabilities.map((capability) => capabilityLabels[capability]).join(", ");
}

function outsideScopeText(run) {
  const counts = new Map(capabilityOrder.map((capability) => [capability, 0]));
  for (const scope of run.behaviorScopes) {
    for (const row of scope.rows) {
      counts.set(
        row.capability,
        (counts.get(row.capability) ?? 0) + row.operatorScope.outsideCount,
      );
    }
  }
  const entries = capabilityOrder.filter(
    (capability) => (counts.get(capability) ?? 0) > 0,
  );
  if (entries.length === 0) return "0 outside-scope events";
  return entries
    .map((capability) => {
      const count = counts.get(capability);
      return `${capabilityLabels[capability]} ${count}`;
    })
    .join(" · ");
}

function renderState(state, text) {
  return `<span class="state" data-state="${escapeHtml(state)}">${escapeHtml(text)}</span>`;
}

function renderRunCard(run) {
  const severity = run.counts.findingsBySeverity;
  const severitySummary =
    run.counts.findings === 0
      ? "No findings in selected cases"
      : `${severity.high} high · ${severity.medium} medium`;
  const tone = run.role === "controlled" ? "attention" : "quiet";
  return `
        <article class="run-card" data-tone="${tone}">
          <div class="run-card-header">
            <div>
              <h2>${escapeHtml(run.target.displayName)}</h2>
              <p>${escapeHtml(run.target.description)}</p>
            </div>
            <div class="finding-total" aria-label="${escapeHtml(`${run.counts.findings} findings`)}">
              <strong>${run.counts.findings}</strong>
              <span>findings</span>
            </div>
          </div>
          <p class="run-summary">${escapeHtml(run.summary)}</p>
          <p class="meta">${escapeHtml(severitySummary)}</p>
          <dl class="stats">
            <div><dt>Advertised tools</dt><dd>${run.counts.advertisedTools}</dd></div>
            <div><dt>Experiments</dt><dd>${run.counts.experiments}</dd></div>
            <div><dt>Static callsites</dt><dd>${run.semantic.callsiteCount}<span class="stat-status">${escapeHtml(run.semantic.status)}</span></dd></div>
          </dl>
        </article>`;
}

function renderFinding(finding) {
  return `
          <li class="finding" role="listitem">
            <span class="severity" data-severity="${escapeHtml(finding.severity)}">${escapeHtml(finding.severity)}</span>
            <div>
              <h3>${escapeHtml(finding.title)}</h3>
              <p>${escapeHtml(`${capitalize(finding.confidence)} confidence`)}</p>
            </div>
          </li>`;
}

function renderMatrixRow(label, state, controlledText, referenceText) {
  return `
            <tr>
              <th scope="row">${escapeHtml(label)}</th>
              <td>${renderState(state, controlledText)}</td>
              <td>${renderState(state, referenceText)}</td>
            </tr>`;
}

function renderDashboard(exported) {
  const [controlled, reference] = exported.runs;
  if (controlled?.role !== "controlled" || reference?.role !== "reference") {
    throw new Error("demo export did not contain the canonical run pair");
  }

  const advertised = (run) =>
    capabilityText(
      selectedCapabilities(run, (row) => row.advertisedState === "claimed"),
    );
  const found = (run) =>
    capabilityText(selectedCapabilities(run, (row) => row.staticState === "found"));
  const observed = (run) =>
    capabilityText(
      selectedCapabilities(run, (row) => row.runtimeState === "observed"),
    );

  return `
      <section class="comparison-grid" aria-label="Run comparison">
${exported.runs.map(renderRunCard).join("\n")}
      </section>

      <section class="section" aria-labelledby="findings-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Results</p>
            <h2 id="findings-title">Findings from the deceptive control</h2>
          </div>
          <p class="section-note">The official target produced no deterministic findings under the selected tools, inputs, and current rules.</p>
        </div>
        <ol class="findings-list">
${controlled.findings.map(renderFinding).join("\n")}
        </ol>
      </section>

      <section class="section" aria-labelledby="matrix-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Comparison</p>
            <h2 id="matrix-title">Claims and evidence</h2>
          </div>
          <p class="section-note">Capabilities are aggregated across the displayed initialization and tool experiments.</p>
        </div>
        <div class="matrix-wrap" role="region" aria-label="Scrollable claims and evidence comparison" tabindex="0">
          <table class="matrix">
            <caption>Advertised, static, runtime, and operator-scope results by target</caption>
            <thead>
              <tr>
                <th scope="col">Evidence layer</th>
                <th scope="col">${escapeHtml(controlled.target.displayName)}</th>
                <th scope="col">${escapeHtml(reference.target.displayName)}</th>
              </tr>
            </thead>
            <tbody>
${renderMatrixRow("Advertised capability", "claimed", advertised(controlled), advertised(reference))}
${renderMatrixRow("Found in captured source", "found", found(controlled), found(reference))}
${renderMatrixRow("Observed in selected tests", "observed", observed(controlled), observed(reference))}
${renderMatrixRow("Outside configured scope", "outside", outsideScopeText(controlled), outsideScopeText(reference))}
            </tbody>
          </table>
        </div>
        <p class="meta matrix-key">Advertised claims are untrusted. Static signals do not prove reachability. Runtime observations cover only selected inputs. Scope is operator-authored.</p>
      </section>

      <section class="section" aria-labelledby="limits-title">
        <p class="eyebrow">Method</p>
        <h2 id="limits-title">Interpretation limits</h2>
        <ul class="limitations">
          <li>${escapeHtml(exported.disclaimer)}</li>
          <li>${escapeHtml(controlled.limitations[0])}</li>
          <li>${escapeHtml(reference.limitations[0])}</li>
        </ul>
      </section>

      <p class="footer-note">Generated from pinned, schema-validated sample reports. Raw traces, transcripts, paths, source snapshots, and private storage remain unpublished.</p>`;
}

function assertSafeOutput(html, stylesheet) {
  const combined = `${html}\n${stylesheet}`;
  const forbidden = [
    { pattern: /<script\b/iu, label: "script element" },
    { pattern: /\bhttps?:\/\//iu, label: "external URL" },
    { pattern: /\bfile:\/\//iu, label: "file URL" },
    {
      pattern: /(?:\/Users\/|\/home\/|\/root\/|\/sandbox\/|[A-Za-z]:\\|\\\\)/u,
      label: "host path",
    },
    { pattern: /\brun-\d{8,}-[a-f0-9]+\b/iu, label: "run identifier" },
    {
      pattern: /\b(?:artifactProvenance|eventIds|attributionIds|objectKey|installLog)\b/u,
      label: "private report field",
    },
    { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u, label: "private key" },
    { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u, label: "AWS key" },
    {
      pattern: /45fa8a54cb9b6bf5ede4da2a03bd36e4ada55e8ae9cfcb3cf332171a87ab5411|c1402b752d842d9717067ba4b17ed7aedfa2ba059c6c6eea4299a247ded0a34a/u,
      label: "report digest",
    },
    { pattern: /\bid_ed25519\b|\b198\.51\.100\.1\b/u, label: "fixture detail" },
  ];
  for (const { pattern, label } of forbidden) {
    if (pattern.test(combined)) throw new Error(`dashboard output contains ${label}`);
  }
  if (html.includes(templateMarker)) {
    throw new Error("dashboard template marker remained in output");
  }
  if (!html.includes("Deceptive control") || !html.includes("Official Filesystem MCP")) {
    throw new Error("dashboard output is missing the expected comparison");
  }
  if (Buffer.byteLength(html) > 128 * 1024) {
    throw new Error("dashboard HTML exceeds its size limit");
  }
  if (Buffer.byteLength(stylesheet) > 64 * 1024) {
    throw new Error("dashboard stylesheet exceeds its size limit");
  }
}

async function build() {
  if (outputDirectory !== join(repositoryRoot, "dist", "dashboard-site")) {
    throw new Error("refusing to write an unexpected dashboard output path");
  }

  const [template, stylesheet, controlledBytes, referenceBytes] =
    await Promise.all([
      readFile(templatePath, "utf8"),
      readFile(stylesheetPath, "utf8"),
      readFile(controlledReport.path),
      readFile(referenceReport.path),
    ]);
  if (template.split(templateMarker).length !== 2) {
    throw new Error("dashboard template must contain exactly one content marker");
  }

  const exported = buildDemoExportV1({
    reports: [
      {
        role: controlledReport.role,
        reportBytes: controlledBytes,
        expectedSha256: controlledReport.expectedSha256,
        expectedTargetId: controlledReport.expectedTargetId,
        displayName: controlledReport.displayName,
        description: controlledReport.description,
        scopeLabels: controlledReport.scopeLabels,
        limitations: controlledReport.limitations,
      },
      {
        role: referenceReport.role,
        reportBytes: referenceBytes,
        expectedSha256: referenceReport.expectedSha256,
        expectedTargetId: referenceReport.expectedTargetId,
        displayName: referenceReport.displayName,
        description: referenceReport.description,
        scopeLabels: referenceReport.scopeLabels,
        limitations: referenceReport.limitations,
      },
    ],
  });
  const html = `${template.replace(templateMarker, renderDashboard(exported)).trimEnd()}\n`;
  assertSafeOutput(html, stylesheet);
  const manifest = {
    schemaVersion: "forge.dashboard-build/v1",
    files: [
      {
        path: "index.html",
        sha256: sha256(html),
        bytes: Buffer.byteLength(html),
      },
      {
        path: "styles.css",
        sha256: sha256(stylesheet),
        bytes: Buffer.byteLength(stylesheet),
      },
    ],
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

  await Promise.all([
    rm(temporaryDirectory, { recursive: true, force: true }),
    rm(temporaryManifestPath, { force: true }),
  ]);
  await mkdir(temporaryDirectory, { recursive: true });
  try {
    await Promise.all([
      writeFile(join(temporaryDirectory, "index.html"), html, "utf8"),
      writeFile(join(temporaryDirectory, "styles.css"), stylesheet, "utf8"),
    ]);
    const entries = await readdir(temporaryDirectory, { withFileTypes: true });
    const names = entries.map((entry) => entry.name).sort();
    if (
      names.join("\n") !== "index.html\nstyles.css" ||
      entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    ) {
      throw new Error("dashboard output must contain exactly two regular files");
    }
    await rm(outputDirectory, { recursive: true, force: true });
    await rename(temporaryDirectory, outputDirectory);
    await writeFile(temporaryManifestPath, manifestJson, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryManifestPath, manifestPath);
  } catch (error) {
    await Promise.all([
      rm(temporaryDirectory, { recursive: true, force: true }),
      rm(temporaryManifestPath, { force: true }),
    ]);
    throw error;
  }

  process.stdout.write(
    "Built dist/dashboard-site/index.html, styles.css, and the private deployment manifest\n",
  );
}

await build();
