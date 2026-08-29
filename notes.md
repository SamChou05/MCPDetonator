# Forge: Technology Whiteboard

## Legend

```text
[REUSE]  Existing technology we rely on
[BUILD]  Small Forge-specific code we write
[SAVE]   Evidence or artifact produced by the step
```

## End-to-end view

```text
Exact npm package + version
        |
        v
+-----------------------------+
| 1. Get and lock package     |
| REUSE: npm + Docker         |
| BUILD: safe resolver        |
| SAVE: tgz, hash, lock/cache |
+-------------+---------------+
              |
              v
+-----------------------------+
| 2. Inspect package          |
| REUSE: Semgrep + JSON       |
| BUILD: Forge rules          |
| SAVE: static-findings.json  |
+-------------+---------------+
              |
              v
+-----------------------------+
| 3. Install it safely        |
| REUSE: Docker + strace      |
| BUILD: sandbox policy       |
| SAVE: install evidence      |
+-------------+---------------+
              |
              v
+-----------------------------+
| 4. Exercise the MCP         |
| REUSE: official MCP client  |
| BUILD: run plans + markers  |
| SAVE: tools + results       |
+-------------+---------------+
              |
              v
+-----------------------------+
| 5. Connect cause + behavior |
| REUSE: strace + Docker      |
| BUILD: event normalizer     |
| SAVE: events.jsonl          |
+-------------+---------------+
              |
              v
+-----------------------------+
| 6. Explain results          |
| REUSE: Zod + Handlebars     |
| BUILD: correlation + rules  |
| SAVE: report.html/json      |
+-----------------------------+
```

## What each part uses

| Part | Existing technology | What we create | Main output |
| --- | --- | --- | --- |
| CLI and configuration | Node.js, TypeScript, Commander, YAML, Zod | `forge analyze` and strict config models | Validated run plan |
| Package acquisition | Pinned npm CLI inside Docker | Resolver that disables scripts and records provenance | Tarball, hashes, lockfile, dependency cache |
| Static inspection | Normal JSON parsing and Semgrep | Manifest reader and about 10–15 reusable Node signal extractors | Source and dependency findings |
| Sandbox lifecycle | Docker | Restrictions, fake environment, canaries, timeouts, and exact cleanup | Disposable run container |
| Install observation | `strace` plus before/after filesystem inventories | Scripts-off and scripts-on install experiments | Install timeline and installed snapshot |
| MCP communication | Official MCP TypeScript client | Initialization, isolated-tool, and workflow experiment plans | Tool definitions, inputs, results, phase markers |
| Process observation | `strace` following child processes | Process-tree normalizer | Process start, exec, parent, and exit events |
| File observation | `strace`, hashes, and Docker filesystem information | File-descriptor correlation and path normalization | File open, read, write, create, and delete events |
| Network observation | Docker network policy and `strace` socket events | Destination normalization and optional fake service logs | DNS/connect attempts and controlled requests |
| Attribution | TypeScript data structures | Baseline comparison and tool/phase correlation | Evidence linked to install, startup, tool, or workflow |
| Interpretation | Deterministic TypeScript rules; optional LLM | Mismatch rules and evidence-only LLM prompt | Findings with evidence IDs |
| Report | Handlebars, HTML, JSON, JSONL | Report layout and summaries | `report.html`, `report.json`, `events.jsonl` |
| Tests | Vitest, official Filesystem MCP, MCP Inspector | Deceptive fixture with known install/start/tool behavior | Repeatable ground-truth tests |

## Are we building parsers?

We are **not** building a JavaScript or TypeScript parser. Semgrep already understands the language syntax.

We are building only small, purpose-specific readers:

- A JSON reader for `package.json` and lockfiles.
- A `strace` normalizer that converts raw system calls into process, file, and network events.
- A correlator that joins those events with MCP phase markers.

The second and third items are core Forge work because they create the useful security explanation.

## What is specific and what generalizes?

```text
TARGET-SPECIFIC DATA
  target.yaml, tool inputs, one workflow

REPLACEABLE ADAPTERS
  npm acquisition, Node static rules, STDIO, strace

GENERAL CORE
  sandbox phases, canaries, canonical events,
  process lineage, attribution, rules, reports
```

Static signal extractors detect possible capabilities such as file access, subprocess execution, networking, environment access, and dynamic code. Separate runtime behavior rules operate on canonical observed events. Neither is written for one package name. The `strace` adapter maps Linux behavior into canonical events, so later observers such as Tracee can feed the same attribution and reporting code.

Adding another Node STDIO MCP should require a config and meaningful tool inputs, not changes to the core engine.

## Are we using a database?

Not in the first version. One analysis produces a small, self-contained evidence folder:

```text
reports/<run-id>/
├── acquisition.json
├── static-findings.json
├── tools.json
├── events.jsonl
├── filesystem-diff.json
├── findings.json
├── report.json
└── report.html
```

JSONL is a good append-only format for raw events, and JSON is enough for the final result. A database would add work without helping the first one or two deep case studies.

Later, SQLite or Postgres could index many runs, compare package versions, and power a hosted UI. The evidence-file format should remain the source artifact even if we add a database.

## Observer placement

For the take-home, a protected `strace` supervisor runs inside the disposable container and starts the MCP as an unprivileged user. In a stronger production design, an external eBPF observer such as Tracee would run outside the target container on a dedicated disposable Linux worker.
