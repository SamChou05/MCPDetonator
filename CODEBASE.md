# Codebase navigator

Forge observes locally executed Node.js MCP servers over STDIO. This guide
maps the implementation from untrusted input to evidence, reporting, and
delivery. Command-level instructions live in the runbooks and prototype guide.

## Start here

- [`README.md`](README.md) — assignment background and high-level capability.
- [`DashboardRunbook.md`](DashboardRunbook.md) — local dashboard and publisher
  workflow.
- [`docs/publishing/prototype.md`](docs/publishing/prototype.md) — core
  architecture, demo commands, verification, and honest limitations.
- [`docs/architecture/architecture-and-trust-model.md`](docs/architecture/architecture-and-trust-model.md)
  — trust boundaries and evidence model.
- [`docs/architecture/capabilities-and-limitations.md`](docs/architecture/capabilities-and-limitations.md)
  — current scope and known limits.

## Entry point and pipeline

| Path | Responsibility |
| --- | --- |
| [`src/cli.ts`](src/cli.ts) | Command-line dispatch for `analyze`, `publish-run`, `validate`, and `agent-evaluate`. |
| [`src/analyze-command.ts`](src/analyze-command.ts) | Orchestrates a complete deterministic analysis. |
| [`src/analyze.ts`](src/analyze.ts) | Coordinates target preparation, acquisition, static inspection, runtime experiments, and report assembly. |
| [`src/config.ts`](src/config.ts) | Loads and bounds target configuration. |
| [`src/target/prepare.ts`](src/target/prepare.ts) | Prepares exact npm or local Node.js targets without executing lifecycle scripts. |
| [`src/evidence-store.ts`](src/evidence-store.ts) | Creates private, structured run evidence. |

## MCP interface

| Path | Responsibility |
| --- | --- |
| [`src/mcp/stdio.ts`](src/mcp/stdio.ts) | Runs bounded STDIO sessions and protocol phases. |
| [`src/mcp/catalog.ts`](src/mcp/catalog.ts) | Computes normalized catalog identity. |
| [`src/mcp/tools-list.ts`](src/mcp/tools-list.ts) | Handles bounded tool discovery. |
| [`src/mcp/input-schema.ts`](src/mcp/input-schema.ts) | Validates tool arguments. |
| [`src/mcp/interface-claims.ts`](src/mcp/interface-claims.ts) | Extracts claims as untrusted evidence. |
| [`src/mcp/json-bounds.ts`](src/mcp/json-bounds.ts) | Enforces JSON size, depth, and node bounds. |

## Static and runtime evidence

| Path | Responsibility |
| --- | --- |
| [`src/static/`](src/static) | Package inspection and bounded Node semantic analysis. |
| [`src/install/lifecycle.ts`](src/install/lifecycle.ts) | Compares scripts-disabled and scripts-enabled installation. |
| [`src/install/delta.ts`](src/install/delta.ts) | Converts lifecycle changes into bounded evidence. |
| [`src/observe/strace-parser.ts`](src/observe/strace-parser.ts) | Parses observer syscalls. |
| [`src/observe/strace-normalizer.ts`](src/observe/strace-normalizer.ts) | Normalizes process, filesystem, and network events. |
| [`src/observe/filesystem-state.ts`](src/observe/filesystem-state.ts) | Captures bounded before/after state. |
| [`src/observe/observation-health.ts`](src/observe/observation-health.ts) | Reports observation completeness. |
| [`src/attribute.ts`](src/attribute.ts) | Links events to lifecycle and tool phases. |
| [`src/rules.ts`](src/rules.ts) | Produces deterministic findings. |
| [`src/report.ts`](src/report.ts) | Assembles the final report. |
| [`src/contracts/v1.ts`](src/contracts/v1.ts) | Defines core evidence and report schemas. |

## Sandboxing and observation

| Path | Responsibility |
| --- | --- |
| [`src/sandbox/docker.ts`](src/sandbox/docker.ts) | Runs contained target workloads. |
| [`src/sandbox/profile.ts`](src/sandbox/profile.ts) | Reads operator sandbox constraints. |
| [`container/trace-entrypoint.sh`](container/trace-entrypoint.sh) | Prepares the syscall observer. |

## Publishing and dashboard

| Path | Responsibility |
| --- | --- |
| [`src/publish/`](src/publish) | Verifies bundles and publishes runs to S3-compatible storage and PostgreSQL. |
| [`src/dashboard/`](src/dashboard) | Builds and refreshes the static private-origin dashboard. |
| [`dashboard/index.html`](dashboard/index.html) | Dashboard template. |
| [`dashboard/styles.css`](dashboard/styles.css) | Dashboard styles. |
| [`scripts/build-dashboard.mjs`](scripts/build-dashboard.mjs) | Builds the two-file local site. |
| [`scripts/serve-dashboard.mjs`](scripts/serve-dashboard.mjs) | Serves the local dashboard. |
| [`docs/publishing/publisher-demo.md`](docs/publishing/publisher-demo.md) | Local publisher demo. |
| [`docs/dashboard/dashboard-architecture-decision.md`](docs/dashboard/dashboard-architecture-decision.md) | Dashboard design decision. |

## Agent V1 evaluation

The agent path is separate from deterministic-core reporting.

| Path | Responsibility |
| --- | --- |
| [`src/agent/runner.ts`](src/agent/runner.ts) | Runs controlled agent rollouts. |
| [`src/agent/loop.ts`](src/agent/loop.ts) | Coordinates provider turns and tool calls. |
| [`src/agent/policy.ts`](src/agent/policy.ts) | Authorizes controlled agent actions. |
| [`src/agent/provider-data.ts`](src/agent/provider-data.ts) | Separates target data from provider history. |
| [`src/agent/report.ts`](src/agent/report.ts) | Produces agent evaluation reports. |
| [`docs/history/agent-rollout-v1.md`](docs/history/agent-rollout-v1.md) | Agent methodology and boundary. |

## Evidence-First V2 experiments

V2 separates proposal, approval, one-call authority, result quarantine, and
cleanup. Proposals do not authorize execution.

| Path | Responsibility |
| --- | --- |
| [`src/audit/v2/agent-proposal.ts`](src/audit/v2/agent-proposal.ts) | Prepares and compares bounded agent proposals. |
| [`src/audit/v2/controlled-runner.ts`](src/audit/v2/controlled-runner.ts) | Runs the pinned controlled outcome fixture. |
| [`src/audit/v2/enrolled-runner.ts`](src/audit/v2/enrolled-runner.ts) | Runs reviewed unseen-MCP enrollment. |
| [`src/audit/v2/controlled-authority.ts`](src/audit/v2/controlled-authority.ts) | Issues one-use execution authority. |
| [`src/contracts/v2/`](src/contracts/v2) | Defines V2 contracts. |
| [`scripts/verify-v2-controlled-outcome.mjs`](scripts/verify-v2-controlled-outcome.mjs) | Verifies controlled comparison. |
| [`scripts/verify-v2-enrollment.mjs`](scripts/verify-v2-enrollment.mjs) | Verifies reviewed enrollment. |
| [`docs/history/evidence-first-v2-phase1.md`](docs/history/evidence-first-v2-phase1.md) | V2 design history. |
| [`docs/history/evidence-first-v2-enrollment.md`](docs/history/evidence-first-v2-enrollment.md) | Enrollment design and limits. |

## Targets, fixtures, and experiments

| Path | Contents |
| --- | --- |
| [`case-studies/`](case-studies) | Curated real-target configurations. |
| [`fixtures/`](fixtures) | Controlled local targets and V2 fixtures. |
| [`experiments/`](experiments) | Experiment plans and sanitized durable results. |
| [`examples/reports/`](examples/reports) | Pinned sample reports. |
| [`scripts/`](scripts) | Verification, dashboard, and experiment helpers. |
| [`test/unit/`](test/unit) | Focused Vitest suites. |

Generated `runs/`, `agent-runs/`, `dist/`, and coverage output are not durable
source artifacts.
