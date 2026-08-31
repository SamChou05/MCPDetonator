import { createHash } from "node:crypto";

import {
  demoExportV1Schema,
  demoRunV1Schema,
  type DemoExportV1,
  type DemoRunV1,
} from "./demo-export.js";

export const DASHBOARD_TEMPLATE_MARKER = "<!-- FORGE_DASHBOARD_CONTENT -->";
export const DASHBOARD_INDEX_MAX_BYTES = 128 * 1_024;
export const DASHBOARD_STYLES_MAX_BYTES = 64 * 1_024;
export const DASHBOARD_HISTORY_LIMIT_PER_TARGET = 5;

const DASHBOARD_HISTORY_FINDING_LIMIT = 8;
const DASHBOARD_SCOPE_NOTE =
  "Results cover only the selected synthetic cases, tools, inputs, and current deterministic rules. Zero findings is not a general safety verdict; the deceptive control is a purpose-built test fixture, not malware attribution.";

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

export interface UnseenHoldoutCaseSummary {
  readonly caseId: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly probeOutcome: "catalog_discovered" | "startup_failed_before_catalog";
  readonly probeFailureClass?: string;
  readonly invocationStatus:
    | "completed"
    | "tool_error_before_report"
    | "not_attempted_without_catalog";
  readonly selectedTool?: string;
  readonly invocationFailureClass?: string;
  readonly findings: readonly {
    readonly ruleId: string;
    readonly count: number;
  }[];
}

export interface UnseenHoldoutSummary {
  readonly runDate: string;
  readonly caseCount: number;
  readonly cases: readonly UnseenHoldoutCaseSummary[];
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

function humanizeIdentifier(value: string): string {
  return capitalize(value.replace(/[._]/gu, " "));
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

function presentationText(run: DemoRunV1): string {
  const generated = `report generated ${formatTimestamp(run.analyzedAt)}`;
  return run.presentation.source === "published"
    ? `Published ${formatTimestamp(run.presentation.publishedAt)} · ${generated}`
    : `Pinned sample · ${generated}`;
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
              <strong class="finding-title">${escapeHtml(finding.title)}</strong>
              <p>${escapeHtml(`${capitalize(finding.confidence)} confidence`)}</p>
            </div>
          </li>`;
}

function advertisedText(run: DemoRunV1): string {
  return capabilityText(
    selectedCapabilities(run, (row) => row.advertisedState === "claimed"),
  );
}

function foundText(run: DemoRunV1): string {
  return capabilityText(
    selectedCapabilities(run, (row) => row.staticState === "found"),
  );
}

function observedText(run: DemoRunV1): string {
  return capabilityText(
    selectedCapabilities(run, (row) => row.runtimeState === "observed"),
  );
}

function historyFindingList(run: DemoRunV1): string {
  if (run.findings.length === 0) {
    return '<p class="meta finding-empty">No deterministic findings in the selected cases.</p>';
  }
  const visible = run.findings.slice(0, DASHBOARD_HISTORY_FINDING_LIMIT);
  const remainder = run.findings.length - visible.length;
  return `<ol class="findings-list">\n${visible.map(renderFinding).join("\n")}\n          </ol>${
    remainder === 0
      ? ""
      : `\n          <p class="meta history-truncation">Showing ${visible.length} of ${run.findings.length} findings in this bounded view.</p>`
  }`;
}

function renderSemanticCounts(run: DemoRunV1): string {
  if (run.semantic.capabilityCounts.length === 0) {
    return '<p class="meta metric-empty">No static capability callsites reported.</p>';
  }
  return `<dl class="metric-list">
${run.semantic.capabilityCounts
  .map(
    (entry) => `                <div><dt>${escapeHtml(humanizeIdentifier(entry.capability))}</dt><dd>${entry.count}</dd></div>`,
  )
  .join("\n")}
              </dl>`;
}

function renderRuntimeCounts(run: DemoRunV1): string {
  const effects =
    run.runtime.effectCounts.length === 0
      ? '<p class="meta metric-empty">No runtime effects counted.</p>'
      : `<dl class="metric-list">
${run.runtime.effectCounts
  .map(
    (entry) => `                <div><dt>${escapeHtml(humanizeIdentifier(entry.effectKind))}</dt><dd>${entry.count}</dd></div>`,
  )
  .join("\n")}
              </dl>`;
  const changes = run.runtime.filesystemChangeCounts;
  return `${effects}
              <h6>Filesystem changes</h6>
              <dl class="metric-list">
                <div><dt>Created</dt><dd>${changes.created}</dd></div>
                <div><dt>Modified</dt><dd>${changes.modified}</dd></div>
                <div><dt>Deleted</dt><dd>${changes.deleted}</dd></div>
                <div><dt>Type changed</dt><dd>${changes.typeChanged}</dd></div>
              </dl>`;
}

function renderBehaviorScope(
  scope: DemoRunV1["behaviorScopes"][number],
  open: boolean,
): string {
  return `
                <details class="scope-detail"${open ? " open" : ""}>
                  <summary>
                    <span class="scope-summary-content">
                      <strong>${escapeHtml(scope.label)}</strong>
                      <span class="scope-summary-meta">${escapeHtml(capitalize(scope.kind))} · ${scope.rows.length} capability comparisons</span>
                    </span>
                  </summary>
                  <div class="scope-table-wrap" role="region" aria-label="${escapeHtml(`${scope.label} capability comparison table`)}" tabindex="0">
                    <table>
                      <caption class="visually-hidden">${escapeHtml(scope.label)} capability comparison</caption>
                      <thead>
                        <tr>
                          <th scope="col">Capability</th>
                          <th scope="col">Advertised</th>
                          <th scope="col">Captured source</th>
                          <th scope="col">Selected runtime</th>
                          <th scope="col">Operator scope</th>
                          <th scope="col">Inside</th>
                          <th scope="col">Outside</th>
                          <th scope="col">Unclassified</th>
                        </tr>
                      </thead>
                      <tbody>
${scope.rows
  .map(
    (row) => `                        <tr>
                          <th scope="row">${escapeHtml(humanizeIdentifier(row.capability))}</th>
                          <td>${escapeHtml(humanizeIdentifier(row.advertisedState))}</td>
                          <td>${escapeHtml(humanizeIdentifier(row.staticState))}</td>
                          <td>${escapeHtml(humanizeIdentifier(row.runtimeState))}</td>
                          <td>${escapeHtml(humanizeIdentifier(row.operatorScope.state))}</td>
                          <td>${row.operatorScope.insideCount}</td>
                          <td>${row.operatorScope.outsideCount}</td>
                          <td>${row.operatorScope.unclassifiedCount}</td>
                        </tr>`,
  )
  .join("\n")}
                      </tbody>
                    </table>
                  </div>
                </details>`;
}

function renderBehaviorScopes(run: DemoRunV1, openFirst: boolean): string {
  if (run.behaviorScopes.length === 0) {
    return '<p class="meta history-empty">No selected runtime scopes are available for this run.</p>';
  }
  return `<p class="meta scope-count">${run.behaviorScopes.length} selected initialization/tool ${run.behaviorScopes.length === 1 ? "scope" : "scopes"} from ${run.counts.experiments} total experiments. Counts below are selected policy-comparison events, not all system calls. Other experiments remain in the run total but are not expanded here.</p>
              <div class="scope-list">
${run.behaviorScopes
  .map((scope, index) => renderBehaviorScope(scope, openFirst && index === 0))
  .join("\n")}
              </div>`;
}

function historyRunAnchor(role: DemoRunV1["role"], index: number): string {
  return `published-${role}-run-${index + 1}`;
}

function renderHistoryRun(run: DemoRunV1, index: number): string {
  if (run.presentation.source !== "published") {
    throw new Error("dashboard history cannot contain a pinned sample");
  }
  const publishedAt = formatTimestamp(run.presentation.publishedAt);
  const scopes =
    run.behaviorScopes.length === 0
      ? "None"
      : run.behaviorScopes.map((scope) => scope.label).join(" · ");
  const anchor = historyRunAnchor(run.role, index);
  return `
          <article class="history-run" id="${anchor}" aria-labelledby="${anchor}-title" tabindex="-1">
            <header class="history-run-header">
              <div>
                <p class="eyebrow">${index === 0 ? "Latest published run" : `Published run ${index + 1}`}</p>
                <h4 id="${anchor}-title">${escapeHtml(run.target.displayName)} · <time datetime="${escapeHtml(run.analyzedAt)}">report generated ${escapeHtml(formatTimestamp(run.analyzedAt))}</time></h4>
              </div>
              <p class="meta">Published ${escapeHtml(publishedAt)}</p>
            </header>
            <div class="history-result">
              <p>${escapeHtml(run.summary)}</p>
              <dl class="stats history-stats">
                <div><dt>Advertised tools</dt><dd>${run.counts.advertisedTools}</dd></div>
                <div><dt>Static callsites</dt><dd>${run.semantic.callsiteCount}<span class="stat-status">${escapeHtml(run.semantic.status)}</span></dd></div>
                <div><dt>Outside scope</dt><dd>${escapeHtml(outsideScopeText(run))}</dd></div>
              </dl>
              <h5>Deterministic findings</h5>
${historyFindingList(run)}
              <h5>Evidence summary</h5>
              <dl class="history-evidence">
                <div><dt>Advertised</dt><dd>${escapeHtml(advertisedText(run))}</dd></div>
                <div><dt>Found in captured source</dt><dd>${escapeHtml(foundText(run))}</dd></div>
                <div><dt>Observed in selected tests</dt><dd>${escapeHtml(observedText(run))}</dd></div>
              </dl>
              <div class="aggregate-evidence">
                <section aria-label="Static capability callsites">
                  <h5>Static capability callsites</h5>
                  <p class="meta">${run.semantic.callsiteCount} total · ${escapeHtml(run.semantic.status)}</p>
${renderSemanticCounts(run)}
                </section>
                <section aria-label="Aggregate runtime evidence">
                  <h5>Aggregate runtime evidence</h5>
                  <p class="meta">Event counts across all recorded runtime observations; they are not finding or unique-file counts and are separate from the selected-scope classifications below.</p>
${renderRuntimeCounts(run)}
                </section>
              </div>
              <h5>Selected runtime scopes</h5>
              <p class="meta"><strong>Included:</strong> ${escapeHtml(scopes)}</p>
${renderBehaviorScopes(run, index === 0)}
            </div>
          </article>`;
}

function validateHistory(
  exported: DemoExportV1,
  input: readonly DemoRunV1[],
): readonly DemoRunV1[] {
  if (!Array.isArray(input)) throw new Error("dashboard history must be an array");
  const history = input.map((run) => demoRunV1Schema.parse(run));
  let referenceGroupStarted = false;
  for (const run of history) {
    if (run.role === "reference") referenceGroupStarted = true;
    if (run.role === "controlled" && referenceGroupStarted) {
      throw new Error("dashboard history target groups are not canonical");
    }
  }
  for (const role of ["controlled", "reference"] as const) {
    const runs = history.filter((run) => run.role === role);
    if (runs.length > DASHBOARD_HISTORY_LIMIT_PER_TARGET) {
      throw new Error("dashboard history exceeded its per-target limit");
    }
    const current = exported.runs.find((run) => run.role === role);
    if (current === undefined) throw new Error("dashboard current selection is incomplete");
    if (runs.length === 0) {
      if (current.presentation.source !== "sample") {
        throw new Error("dashboard current selection lacks its published history");
      }
      continue;
    }
    if (JSON.stringify(runs[0]) !== JSON.stringify(current)) {
      throw new Error("dashboard current selection is not the newest history row");
    }
    for (const run of runs) {
      if (run.presentation.source !== "published") {
        throw new Error("dashboard history cannot contain pinned samples");
      }
    }
  }
  return history;
}

function renderHistoryIndexGroup(
  current: DemoRunV1,
  history: readonly DemoRunV1[],
): string {
  const runs = history.filter((run) => run.role === current.role);
  return `
            <section class="run-index-group" aria-label="${escapeHtml(`${current.target.displayName} published runs`)}">
              <h3>${escapeHtml(current.target.displayName)}</h3>
${
  runs.length === 0
    ? '              <p class="meta history-empty">No eligible published runs yet.</p>'
    : `              <ol class="run-index-list">
${runs
  .map(
    (run, index) => `                <li>
                  <a href="#${historyRunAnchor(run.role, index)}">
                    <time datetime="${escapeHtml(run.analyzedAt)}">${escapeHtml(formatTimestamp(run.analyzedAt))}</time>
                    <span>${index === 0 ? "Latest · " : ""}${run.counts.findings} findings · ${run.counts.experiments} experiments</span>
                  </a>
                </li>`,
  )
  .join("\n")}
              </ol>`
}
            </section>`;
}

function renderHistoryDetailGroup(
  current: DemoRunV1,
  history: readonly DemoRunV1[],
): string {
  const runs = history.filter((run) => run.role === current.role);
  return `
            <section class="history-group" aria-label="${escapeHtml(`${current.target.displayName} run details`)}">
              <div class="history-group-heading">
                <h3>${escapeHtml(current.target.displayName)}</h3>
                <span class="meta">${runs.length} published ${runs.length === 1 ? "run" : "runs"}</span>
              </div>
${
  runs.length === 0
    ? '              <p class="meta history-empty">No eligible published runs yet; the current card uses a pinned sample.</p>'
    : runs.map((run, index) => renderHistoryRun(run, index)).join("\n")
}
            </section>`;
}

function holdoutProbeText(caseSummary: UnseenHoldoutCaseSummary): string {
  if (caseSummary.probeOutcome === "catalog_discovered") return "Catalog discovered";
  return `Startup failed: ${caseSummary.probeFailureClass ?? "unspecified failure"}`;
}

function holdoutInvocationText(caseSummary: UnseenHoldoutCaseSummary): string {
  if (caseSummary.invocationStatus === "completed") {
    return `Completed · ${caseSummary.selectedTool ?? "selected tool"}`;
  }
  if (caseSummary.invocationStatus === "tool_error_before_report") {
    return `Tool error · ${caseSummary.invocationFailureClass ?? "unspecified failure"}`;
  }
  return "Not attempted without a catalog";
}

function holdoutFindingText(caseSummary: UnseenHoldoutCaseSummary): string {
  if (caseSummary.findings.length === 0) return "No deterministic findings";
  return caseSummary.findings
    .map((finding) => `${finding.ruleId} ×${finding.count}`)
    .join("; ");
}

function validateUnseenHoldoutSummary(
  input: UnseenHoldoutSummary,
): UnseenHoldoutSummary {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.runDate)) {
    throw new Error("unseen holdout run date must be YYYY-MM-DD");
  }
  if (input.caseCount !== input.cases.length) {
    throw new Error("unseen holdout case count does not match its cases");
  }
  const seenCaseIds = new Set<string>();
  for (const caseSummary of input.cases) {
    if (caseSummary.caseId.length === 0 || seenCaseIds.has(caseSummary.caseId)) {
      throw new Error("unseen holdout case IDs must be nonempty and unique");
    }
    seenCaseIds.add(caseSummary.caseId);
    if (
      caseSummary.packageName.length === 0 ||
      caseSummary.packageVersion.length === 0
    ) {
      throw new Error("unseen holdout package identity is incomplete");
    }
    if (caseSummary.invocationStatus === "completed" && !caseSummary.selectedTool) {
      throw new Error("completed unseen holdout case lacks its selected tool");
    }
    if (
      caseSummary.probeOutcome === "startup_failed_before_catalog" &&
      !caseSummary.probeFailureClass
    ) {
      throw new Error("failed unseen holdout probe lacks a failure class");
    }
    for (const finding of caseSummary.findings) {
      if (finding.ruleId.length === 0 || finding.count < 1) {
        throw new Error("unseen holdout findings must have a rule and positive count");
      }
    }
  }
  return input;
}

function renderUnseenHoldoutSummary(
  holdout: UnseenHoldoutSummary,
): string {
  return `
      <section class="section" aria-labelledby="unseen-holdout-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Prospective study</p>
            <h2 id="unseen-holdout-title">Unseen MCP holdout</h2>
          </div>
          <p class="section-note">Study date ${escapeHtml(holdout.runDate)} · ${holdout.caseCount} exact-version npm packages</p>
        </div>
        <p class="meta">These are selected-input study summaries, not publication-history runs and not general safety verdicts. Raw evidence and private run identities remain undisclosed.</p>
        <div class="table-scroll" tabindex="0">
          <table>
            <caption>Package, selected-call outcome, and deterministic findings</caption>
            <thead>
              <tr>
                <th scope="col">MCP package</th>
                <th scope="col">Startup / catalog</th>
                <th scope="col">Selected call</th>
                <th scope="col">Findings</th>
              </tr>
            </thead>
            <tbody>
${holdout.cases
  .map(
    (caseSummary) => `              <tr>
                <th scope="row">${escapeHtml(caseSummary.packageName)} <span class="meta">${escapeHtml(caseSummary.packageVersion)}</span></th>
                <td>${escapeHtml(holdoutProbeText(caseSummary))}</td>
                <td>${escapeHtml(holdoutInvocationText(caseSummary))}</td>
                <td>${escapeHtml(holdoutFindingText(caseSummary))}</td>
              </tr>`,
  )
  .join("\n")}
            </tbody>
          </table>
        </div>
      </section>`;
}

export function renderDashboardContent(
  input: DemoExportV1,
  historyInput: readonly DemoRunV1[] = [],
  unseenHoldoutInput?: UnseenHoldoutSummary,
): string {
  const exported = demoExportV1Schema.parse(input);
  const history = validateHistory(exported, historyInput);
  const unseenHoldout =
    unseenHoldoutInput === undefined
      ? undefined
      : validateUnseenHoldoutSummary(unseenHoldoutInput);
  const [controlled, reference] = exported.runs;
  if (controlled?.role !== "controlled" || reference?.role !== "reference") {
    throw new Error("demo export did not contain the canonical run pair");
  }

  return `
      <p class="scope-note"><strong>Scope:</strong> ${escapeHtml(DASHBOARD_SCOPE_NOTE)}</p>
      <p class="snapshot-note"><strong>Snapshot freshness:</strong> Eligible local publications appear after dashboard refresh; the hosted AWS copy changes only after a separate content deployment.</p>

      <section class="comparison-grid" aria-label="Latest result by selected target">
${exported.runs.map(renderRunCard).join("\n")}
      </section>

      <section class="section" aria-labelledby="history-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Results</p>
            <h2 id="history-title">Published run explorer</h2>
          </div>
          <p class="section-note">Choose a run from the index to move to its result. Up to five eligible publications per selected target.</p>
        </div>
        <div class="run-explorer">
          <nav class="run-index" aria-label="Published run index">
            <p class="eyebrow">Past runs</p>
${exported.runs.map((run) => renderHistoryIndexGroup(run, history)).join("\n")}
          </nav>
          <div class="run-details">
${exported.runs.map((run) => renderHistoryDetailGroup(run, history)).join("\n")}
          </div>
        </div>
      </section>

${unseenHoldout === undefined ? "" : renderUnseenHoldoutSummary(unseenHoldout)}

      <p class="footer-note">Generated from schema-validated, allowlisted public projections. Raw reports, traces, transcripts, paths, source snapshots, and private storage remain unpublished.</p>`;
}

export function assertSafeDashboardOutput(
  html: string,
  stylesheet: string,
  exported: DemoExportV1,
  history: readonly DemoRunV1[] = [],
): void {
  const combined = `${html}\n${stylesheet}`;
  const forbidden = [
    { pattern: /<script\b/iu, label: "script element" },
    { pattern: /\bon[a-z]+\s*=/iu, label: "inline event handler" },
    { pattern: /\bjavascript:/iu, label: "JavaScript URL" },
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
  for (const run of history) {
    if (!html.includes(escapeHtml(formatTimestamp(run.analyzedAt)))) {
      throw new Error("dashboard output is missing an expected history row");
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
  readonly history?: readonly DemoRunV1[];
  readonly unseenHoldout?: UnseenHoldoutSummary | undefined;
}): {
  readonly html: string;
  readonly stylesheet: string;
  readonly manifest: DashboardBuildManifestV1;
} {
  const exported = demoExportV1Schema.parse(input.exported);
  const history = validateHistory(exported, input.history ?? []);
  if (input.template.split(DASHBOARD_TEMPLATE_MARKER).length !== 2) {
    throw new Error("dashboard template must contain exactly one content marker");
  }
  const html = `${input.template
    .replace(
      DASHBOARD_TEMPLATE_MARKER,
      renderDashboardContent(exported, history, input.unseenHoldout),
    )
    .trimEnd()}\n`;
  assertSafeDashboardOutput(html, input.stylesheet, exported, history);
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
