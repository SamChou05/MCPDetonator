# Forge MCP Detonator

Forge is an evidence-first prototype for answering a narrow security question:

> What does a local MCP server actually do when it installs, initializes, and
> handles selected tool calls?

It combines bounded static inspection with isolated runtime observation for
exact-version npm packages and local Node.js MCP servers over STDIO. Forge
preserves raw evidence, separates observed facts from attribution, compares
advertised claims with source signals and selected runtime effects, and emits an
evidence-linked report rather than a universal safety verdict.

The unmodified take-home prompt that started this project is preserved in
[`PROJECT_SPEC.md`](PROJECT_SPEC.md).

## What Is Implemented

- Exact-version npm or local-directory acquisition with provenance hashes.
- Focused manifest, dependency, lifecycle-script, lexical source, and modeled
  sensitive-callsite inspection.
- Scripts-disabled versus scripts-enabled installation comparison when a
  reusable npm cache is available.
- Fresh Docker sandboxes for initialization and each selected tool experiment.
- Bounded MCP transcripts, process/file/socket evidence, synthetic filesystem
  state snapshots, lifecycle phases, and process lineage.
- Deterministic findings and a four-way comparison of advertised claims,
  static signals, observed effects, and operator-authored scope.
- A separate opt-in Agent V1 evaluator and evidence-first V2 experiments that
  never grant a model execution authority.
- Optional S3/PostgreSQL publication and a script-free static dashboard.

## Five-Minute Review

### Prerequisites

- Node.js 22 or newer
- Docker Desktop or a compatible Linux Docker worker
- Network access for exact-version npm acquisition

Install dependencies without running package lifecycle scripts:

```bash
npm install --ignore-scripts
```

Run the fast local checks:

```bash
npm run typecheck
npm test
npm run build
```

Run the core end-to-end demonstration:

```bash
npm run verify:e2e
```

This rebuilds the observer image, analyzes both checked-in case studies, checks
their reports and evidence links, verifies immutable observer identity, and
confirms that managed containers are cleaned up.

To inspect the generated dashboard:

```bash
npm run build:dashboard
npm run serve:dashboard
```

Then open <http://127.0.0.1:4173/>.

## Analyze a Target

Validate and analyze the pinned official Filesystem MCP:

```bash
npm run dev -- validate case-studies/filesystem/target.yaml
npm run dev -- analyze case-studies/filesystem/target.yaml --rebuild-image
```

Analyze the controlled deceptive MCP:

```bash
npm run dev -- validate fixtures/deceptive-mcp/target.yaml
npm run dev -- analyze fixtures/deceptive-mcp/target.yaml
```

Each completed analysis is written under `runs/<run-id>/`. The directory
contains the run manifest, target provenance, static inspection, raw MCP and
system evidence, normalized events, phase attribution, deterministic findings,
filesystem state deltas, observation health, and `report.json`.

## Verified Demonstrations

### Official Filesystem MCP

The pinned `@modelcontextprotocol/server-filesystem@2026.7.10` case exercises
real `read_text_file` and `write_file` calls. Its selected claims, static
signals, observed filesystem effects, and configured scope align. The sample
report has no deterministic finding for those selected inputs and covered
rules; that is not a claim that the package is universally safe.

- [Target configuration](case-studies/filesystem/target.yaml)
- [Sanitized report](examples/reports/official-filesystem.report.json)

### Deceptive Control

The local negative control exposes behavior that its tool description does not
adequately disclose. The verified report links findings to initialization-time
credential access, out-of-scope tool effects, child execution, a network
attempt, delayed cooldown activity, and controlled install-time behavior.

- [Fixture](fixtures/deceptive-mcp)
- [Sanitized report](examples/reports/deceptive-control.report.json)

Neither target is special-cased in `src/` or `container/`; package identity,
commands, experiments, inputs, and expected scope come from configuration.

## Design Principles

1. **Observed facts stay separate from interpretation.** Raw evidence,
   normalized events, attribution, findings, and report summaries are distinct
   layers with explicit references.
2. **Claims are untrusted evidence.** Tool names, descriptions, schemas, and
   source signals do not authorize behavior or prove intent.
3. **Experiments are isolated.** Initialization and selected tool calls run in
   separate sandboxes with explicit lifecycle phases and bounded cooldowns.
4. **Failure is preserved honestly.** Partial evidence and observation-health
   gaps remain visible instead of being converted into an ordinary clean report.
5. **Clean is not safe.** A report can only describe the selected target,
   inputs, sensors, rules, and observation window that were actually assessed.

The complete architecture and trust boundaries are documented in
[`docs/publishing/prototype.md`](docs/publishing/prototype.md) and
[`docs/architecture/architecture-and-trust-model.md`](docs/architecture/architecture-and-trust-model.md).

## Repository Guide

- [`CODEBASE.md`](CODEBASE.md) — source-level navigator and pipeline entry points.
- [`docs/publishing/prototype.md`](docs/publishing/prototype.md) — implemented
  architecture, evidence model, case studies, containment, and limits.
- [`docs/architecture/capabilities-and-limitations.md`](docs/architecture/capabilities-and-limitations.md)
  — plain-English capability and limitation audit.
- [`DashboardRunbook.md`](DashboardRunbook.md) — dashboard, CLI, and verification
  command reference.
- [`ImplementationPlan.md`](ImplementationPlan.md) — implementation status and
  prioritized engineering roadmap.
- [`docs/UNIFIED_ANALYSIS_NEXT_STEPS.md`](docs/UNIFIED_ANALYSIS_NEXT_STEPS.md) —
  proposed bridge between deterministic and agent-assisted analysis.

## Full Verification

```bash
npm run typecheck
npm test
npm run build
npm run verify:e2e
npm run verify:agent
npm run verify:publisher
npm run verify:v2-outcome
npm run verify:v2-enrollment:local
npm run verify:v2-enrollment
npm audit --omit=dev
```

Docker-backed checks require a running Docker daemon. The full V2 enrollment
verifier also requires network access to acquire its pinned npm packages. The
Agent V1 verifier uses a deterministic local provider and does not require a
real model credential.

## Scope and Limits

- Node.js targets only; Linux/Docker execution only; MCP STDIO transport only.
- Exact npm versions or local package directories only.
- Focused `strace` coverage, not complete kernel telemetry or decrypted payload
  inspection.
- Bounded lexical and modeled semantic source inspection, not whole-program
  reachability or taint analysis.
- Selected initialization and hand-authored tool experiments, not exhaustive
  workflow or input exploration.
- Temporal and lineage-based attribution, not proof of unique causality.
- Docker containment suitable for a prototype and curated cases, not a
  malware-grade VM boundary.
- No universal package-safety conclusion, including when no covered mismatch is
  observed.

See [`THINGS_TO_IMPROVE.md`](THINGS_TO_IMPROVE.md) for the shortest remaining
production-hardening list.
