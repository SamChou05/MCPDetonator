# Unified analysis bridge: what to do next

## Current state

The deterministic core already chains multiple analysis layers inside one
`forge analyze` invocation (`src/analyze.ts`):

1. **Lexical** (`src/static/node-package.ts`) — regex-based signal detection.
2. **Semantic** (`src/static/node-semantic-engine.ts`) — TypeScript-AST
   callsite resolution against the trusted sink catalog.
3. **Runtime observation** — Docker sandbox with process/filesystem/network
   sensors.
4. **Claim comparison** — advertised claims vs. observed behavior.

Separately, the **Agent V1 harness** (`npm run verify:agent`) and the **V2
agent-proposal comparator** (`npm run experiment:v2-proposals`) each produce
their own reports. The **dashboard** (`npm run build:dashboard`) is a separate
build step that currently consumes only demo reports and the unseen-MCP
holdout summary — not live run evidence, agent results, or V2 proposal output.

## The gap

Today there is no single command that:

- runs the deterministic core (lexical + semantic + runtime),
- runs the Agent V1 live-provider study,
- runs the V2 agent-proposal comparator,
- aggregates all evidence into one dashboard view.

Each layer requires a separate invocation, a separate output directory, and
manual correlation of artifacts across `runs/`, `agent-runs/`, and the
dashboard export.

## Proposed bridge

### Phase 1: single pipeline command

Add a `forge analyze --all` (or new `forge analyze-full`) mode that:

- runs the existing deterministic core as today;
- optionally triggers an Agent V1 scenario against the same target;
- optionally triggers the V2 agent-proposal comparator against the same
  catalog snapshot;
- writes all artifacts into a single run directory with a shared evidence
  index that cross-references lexical, semantic, runtime, agent, and proposal
  layers by SHA-256.

Key design rule: each layer remains independently verifiable. The bridge
orchestrates; it does not merge semantics into one opaque blob.

### Phase 2: unified evidence index

Extend the existing evidence store to expose a **run-level index** that
binds:

- the lexical inspection artifact and its signals;
- the semantic callsite artifact and its resolutions;
- the runtime trace and filesystem deltas;
- the agent rollouts (if run);
- the V2 proposal comparison (if run);
- the final report and cross-references.

This index is the single source of truth the dashboard reads — not
per-layer JSON files scattered across directories.

### Phase 3: dashboard integration

Extend `npm run build:dashboard` (or add a new `forge dashboard` command) to:

- read the unified evidence index instead of hardcoded demo reports;
- render each analysis layer as a tab or section with drill-down links to
  the underlying evidence artifacts;
- show semantic/lexical signal correlations (e.g., which lexical signals
  corresponded to resolved semantic callsites, which runtime sensors
  confirmed or contradicted them);
- surface agent proposals alongside runtime results when both exist.

### Phase 4: single-command UX

The end goal:

```bash
forge analyze-full <target.yaml> --agent --proposals --publish --dashboard
```

This runs the full stack once and publishes an interactive dashboard that
shows every analysis layer correlated in one place.

## Why this matters

Right now the layers produce excellent evidence in isolation, but no one
view shows: "this tool's metadata claims X, its static code has Y, runtime
observed Z, the agent proposed W, and the enforce policy contained it." The
bridge makes the full analysis pipeline usable as a one-shot workflow without
losing the strict separation and auditability each layer currently provides.
