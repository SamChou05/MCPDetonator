# Evidence-driven trace corpus

This corpus broadens Forge's deterministic runtime evidence beyond the
controlled deceptive fixture and official Filesystem case. It pins four public
Node.js MCP packages and gives each server one or two small synthetic tool
calls chosen for a distinct behavior class.

The corpus is an experiment set, not a target allowlist or a safety benchmark.
Package metadata, tool descriptions, results, and runtime behavior remain
untrusted evidence.

## Pinned targets

| Target | Exact package | Why it is included |
| --- | --- | --- |
| [Memory](memory.target.yaml) | `@modelcontextprotocol/server-memory@2026.7.4` | Exercises a bounded JSONL read/create/truncate/write path in the synthetic workspace. |
| [Everything](everything.target.yaml) | `@modelcontextprotocol/server-everything@2026.8.18` | Exercises an in-memory `data:` fetch and gzip operation plus one controlled failed loopback connection attempt. |
| [Sequential Thinking](sequential-thinking.target.yaml) | `@modelcontextprotocol/server-sequential-thinking@2026.7.4` | Provides a mostly compute-only control for separating Node/MCP framework activity from tool-specific behavior. |
| [Community Shell](shell.target.yaml) | `@mkusaka/mcp-shell-server@0.1.1` | Exercises child-process execution and one fixed write into the synthetic workspace. |

Every configured tool experiment receives a fresh synthetic home and workspace.
The Memory creation and other calls therefore do not share state across
experiments.

## Safety boundary

- The configurations contain no API keys, tokens, passwords, or real user
  data. Their only environment values are a synthetic workspace path and a
  logging-control boolean.
- Runtime containers use the existing `developer-v1` profile with Docker
  networking blocked. Public npm acquisition can download the pinned package,
  but lifecycle observation and target execution do not receive runtime
  network access or host credentials.
- The Everything network case targets only `127.0.0.1:54321` inside its own
  isolated container. Port 54321 is deliberate: Fetch rejects port 9 as an
  unsafe port before issuing a syscall, which would produce no connection
  trace to measure.
- The Shell case has the broad capability implied by its package, but this
  corpus invokes only the fixed `printf` command recorded in
  `shell.target.yaml`. It writes bounded text to
  `/sandbox/workspace/shell-output.txt`; its package log stays in the synthetic
  home.
- Exact top-level versions are pinned. Each run also retains resolved package
  provenance and its generated lockfile; a future acquisition can still
  resolve a different compatible transitive dependency, so cross-date studies
  should compare that retained provenance.

These controls contain the selected experiments. They do not establish that a
package is benign or suitable for installation outside Forge's sandbox.

## Run the corpus

Run from the repository root. Rebuild the observer image on the first command
so all four runs use the current trace entrypoint, then reuse that image:

```bash
npm run dev -- analyze case-studies/trace-corpus/memory.target.yaml --rebuild-image
npm run dev -- analyze case-studies/trace-corpus/everything.target.yaml
npm run dev -- analyze case-studies/trace-corpus/sequential-thinking.target.yaml
npm run dev -- analyze case-studies/trace-corpus/shell.target.yaml
```

Do not pass `--output`: the normal output root is the repository's ignored
`runs/` directory. Each command prints its exact `runs/run-*` directory. Keep
those four paths; do not select a run merely because it is the newest directory
or matches a broad glob.

After all four analyses complete, pass those explicit directories to the
bounded summarizer, replacing the descriptive suffixes below with the run IDs
printed by the commands:

```bash
node scripts/summarize-trace-coverage.mjs \
  runs/run-MEMORY_RUN_ID \
  runs/run-EVERYTHING_RUN_ID \
  runs/run-SEQUENTIAL_THINKING_RUN_ID \
  runs/run-SHELL_RUN_ID
```

The summarizer accepts only direct `runs/run-*` directories, validates each
terminal run and its manifest-bound `observation-health.json`, and emits JSON
to standard output. Inputs and aggregate parsing work are bounded by explicit
run-count and byte limits in the script.

## Interpret the result

Keep these cohorts separate when ranking improvements:

1. `install_lifecycle` records npm installation behavior and can dominate raw
   counts without saying anything specific about a tool call.
2. `baseline_initialization` records server startup, MCP handshake, and tool
   discovery before a configured tool invocation.
3. `tool` records the isolated configured tool experiments.

All four corpus configs deliberately set `workflows: []`. The summarizer uses
the reserved install and baseline experiment IDs and labels every other
experiment as `tool`; it is not a general phase-kind classifier for
workflow-bearing runs.

Compare tool cohorts with the compute-oriented Sequential Thinking control
before treating a frequent syscall as application-specific. Rank candidates by
the number of targets and experiments affected, outcome, semantic ambiguity,
and policy relevance as well as raw frequency.

The health artifact exactly accounts for trace records inside Forge's selected
`strace` filter. That is selected-surface evidence, not capture of every Linux
syscall and not 100% semantic syscall coverage. A gap record means Forge saw an
operation it deliberately did not reduce to stronger canonical evidence; it is
not itself a finding or proof of malicious behavior.
