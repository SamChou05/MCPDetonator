import { createHash } from "node:crypto";

import {
  demoExportV1Schema,
  type DemoExportV1,
  type DemoRunV1,
} from "./demo-export.js";

export const DASHBOARD_TEMPLATE_MARKER = "<!-- FORGE_DASHBOARD_CONTENT -->";
export const DASHBOARD_INDEX_MAX_BYTES = 128 * 1_024;
export const DASHBOARD_STYLES_MAX_BYTES = 64 * 1_024;

const CAPABILITY_ORDER = [
  "filesystem_access",
  "process_execution",
  "network_access",
] as const;
const CAPABILITY_LABELS: Readonly<Record<(typeof CAPABILITY_ORDER)[number], string>> = {
  filesystem_access: "Filesystem",
  process_execution: "Process",
  network_access: "Network",
};

export interface DashboardFileReceipt {
  readonly path: "index.html" | "styles.css";
  readonly sha256: string;
  readonly bytes: number;
}

export interface DashboardBuildManifestV1 {
  readonly schemaVersion: "forge.dashboard-build/v1";
  readonly files: readonly [DashboardFileReceipt, DashboardFileReceipt];
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/gu, (character) => {
    const entities: Readonly<Record<string, string>> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function formatTimestamp(value: string): string {
  return new Date(value).toISOString().replace(/\.000Z$/u, "Z");
}

function selectedCapabilities(
  run: DemoRunV1,
  predicate: (row: DemoRunV1["behaviorScopes"][number]["rows"][number]) => boolean,
): readonly (typeof CAPABILITY_ORDER)[number][] {
  const selected = new Set<string>();
  for (const scope of run.behaviorScopes) {
    for (const row of scope.rows) {
      if (predicate(row)) selected.add(row.capability);
    }
  }
  return CAPABILITY_ORDER.filter((capability) => selected.has(capability));
}

function capabilityText(
  capabilities: readonly (typeof CAPABILITY_ORDER)[number][],
): string {
  if (capabilities.length === 0) return "None in selected scopes";
  return capabilities
    .map((capability) => CAPABILITY_LABELS[capability])
    .join(", ");
}

function outsideScopeText(run: DemoRunV1): string {
  const counts = new Map(CAPABILITY_ORDER.map((capability) => [capability, 0]));
  for (const scope of run.behaviorScopes) {
    for (const row of scope.rows) {
      counts.set(
        row.capability,
        (counts.get(row.capability) ?? 0) + row.operatorScope.outsideCount,
      );
    }
  }
  const entries = CAPABILITY_ORDER.filter(
    (capability) => (counts.get(capability) ?? 0) > 0,
  );
  if (entries.length === 0) return "0 outside-scope events";
  return entries
    .map(
      (capability) =>
        `${CAPABILITY_LABELS[capability]} ${counts.get(capability) ?? 0}`,
    )
    .join(" · ");
}

function renderState(state: string, value: string): string {
  return `<span class="state" data-state="${escapeHtml(state)}">${escapeHtml(value)}</span>`;
}

function presentationText(run: DemoRunV1): string {
  const analyzed = `analyzed ${formatTimestamp(run.analyzedAt)}`;
  return run.presentation.source === "published"
    ? `Published ${formatTimestamp(run.presentation.publishedAt)} · ${analyzed}`
    : `Pinned sample · ${analyzed}`;
}

function renderRunCard(run: DemoRunV1): string {
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
          <p class="meta">${escapeHtml(presentationText(run))}</p>
        </article>`;
}

function renderFinding(finding: DemoRunV1["findings"][number]): string {
  return `
          <li class="finding" role="listitem">
            <span class="severity" data-severity="${escapeHtml(finding.severity)}">${escapeHtml(finding.severity)}</span>
            <div>
              <h3>${escapeHtml(finding.title)}</h3>
              <p>${escapeHtml(`${capitalize(finding.confidence)} confidence`)}</p>
            </div>
          </li>`;
}

function renderFindingGroup(run: DemoRunV1): string {
  return `
        <section class="finding-group" aria-label="${escapeHtml(`${run.target.displayName} findings`)}">
          <h3>${escapeHtml(run.target.displayName)}</h3>
          ${
            run.findings.length === 0
              ? '<p class="meta finding-empty">No deterministic findings in the selected cases.</p>'
              : `<ol class="findings-list">\n${run.findings
                  .map(renderFinding)
                  .join("\n")}\n          </ol>`
          }
        </section>`;
}

function renderMatrixRow(
  label: string,
  state: string,
  controlledText: string,
  referenceText: string,
): string {
  return `
            <tr>
              <th scope="row">${escapeHtml(label)}</th>
              <td>${renderState(state, controlledText)}</td>
              <td>${renderState(state, referenceText)}</td>
            </tr>`;
}

export function renderDashboardContent(input: DemoExportV1): string {
  const exported = demoExportV1Schema.parse(input);
  const [controlled, reference] = exported.runs;
  if (controlled?.role !== "controlled" || reference?.role !== "reference") {
    throw new Error("demo export did not contain the canonical run pair");
  }

  const advertised = (run: DemoRunV1): string =>
    capabilityText(
      selectedCapabilities(run, (row) => row.advertisedState === "claimed"),
    );
  const found = (run: DemoRunV1): string =>
    capabilityText(
      selectedCapabilities(run, (row) => row.staticState === "found"),
    );
  const observed = (run: DemoRunV1): string =>
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
            <h2 id="findings-title">Deterministic findings</h2>
          </div>
          <p class="section-note">Each list reflects only the selected tools, inputs, and current deterministic rules.</p>
        </div>
${exported.runs.map(renderFindingGroup).join("\n")}
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

      <p class="footer-note">Generated from schema-validated, allowlisted public projections. Raw reports, traces, transcripts, paths, source snapshots, and private storage remain unpublished.</p>`;
}

export function assertSafeDashboardOutput(
  html: string,
  stylesheet: string,
  exported: DemoExportV1,
): void {
  const combined = `${html}\n${stylesheet}`;
  const forbidden = [
    { pattern: /<script\b/iu, label: "script element" },
    { pattern: /\bhttps?:\/\//iu, label: "external URL" },
    { pattern: /\bfile:\/\//iu, label: "file URL" },
    {
      pattern: /(?:\/Users\/|\/home\/|\/root\/|\/sandbox\/|[A-Za-z]:\\|\\\\)/u,
      label: "host or sandbox path",
    },
    { pattern: /\brun-\d{8,}-[a-f0-9]+\b/iu, label: "run identifier" },
    { pattern: /\b[a-f0-9]{64}\b/iu, label: "SHA-256 digest" },
    {
      pattern:
        /\b(?:artifactProvenance|eventIds|attributionIds|objectKey|installLog|findingId|ruleId|targetId)\b/u,
      label: "private report field",
    },
    { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u, label: "private key" },
    { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u, label: "AWS key" },
    { pattern: /\bid_ed25519\b|\b198\.51\.100\.1\b/u, label: "fixture detail" },
  ];
  for (const { pattern, label } of forbidden) {
    if (pattern.test(combined)) {
      throw new Error(`dashboard output contains ${label}`);
    }
  }
  if (html.includes(DASHBOARD_TEMPLATE_MARKER)) {
    throw new Error("dashboard template marker remained in output");
  }
  for (const run of exported.runs) {
    if (!html.includes(escapeHtml(run.target.displayName))) {
      throw new Error("dashboard output is missing an expected comparison target");
    }
  }
  if (Buffer.byteLength(html) > DASHBOARD_INDEX_MAX_BYTES) {
    throw new Error("dashboard HTML exceeds its size limit");
  }
  if (Buffer.byteLength(stylesheet) > DASHBOARD_STYLES_MAX_BYTES) {
    throw new Error("dashboard stylesheet exceeds its size limit");
  }
}

export function buildDashboardDocument(input: {
  readonly template: string;
  readonly stylesheet: string;
  readonly exported: DemoExportV1;
}): {
  readonly html: string;
  readonly stylesheet: string;
  readonly manifest: DashboardBuildManifestV1;
} {
  const exported = demoExportV1Schema.parse(input.exported);
  if (input.template.split(DASHBOARD_TEMPLATE_MARKER).length !== 2) {
    throw new Error("dashboard template must contain exactly one content marker");
  }
  const html = `${input.template
    .replace(DASHBOARD_TEMPLATE_MARKER, renderDashboardContent(exported))
    .trimEnd()}\n`;
  assertSafeDashboardOutput(html, input.stylesheet, exported);
  return {
    html,
    stylesheet: input.stylesheet,
    manifest: {
      schemaVersion: "forge.dashboard-build/v1",
      files: [
        {
          path: "index.html",
          sha256: sha256(html),
          bytes: Buffer.byteLength(html),
        },
        {
          path: "styles.css",
          sha256: sha256(input.stylesheet),
          bytes: Buffer.byteLength(input.stylesheet),
        },
      ],
    },
  };
}
