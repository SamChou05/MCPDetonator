# Forge technology whiteboard

This page is the short, implementation-level map. `Design.md` holds the deeper
reasoning and claim boundaries.

## Legend

```text
[REUSE] existing technology
[BUILD] Forge-specific code
[SAVE] evidence produced by the step
```

## Deterministic core path

```text
Exact npm version or local snapshot + target.yaml
                         |
                         v
+------------------------------------------------+
| 1. Acquire or snapshot                        |
| REUSE: npm, Docker, SHA-256                   |
| BUILD: source adapters, provenance, cleanup   |
| SAVE: source identity + tree hash; lock/cache |
|       and registry fields when available      |
+------------------------+-----------------------+
                         |
                         v
+------------------------------------------------+
| 2. Inspect source                             |
| REUSE: JSON/filesystem APIs                   |
| BUILD: bounded Node manifest/lexical scanner  |
| SAVE: pre-install and runtime-snapshot signals|
+------------------------+-----------------------+
                         |
                         v
+------------------------------------------------+
| 3. Compare installation when npm cache exists |
| REUSE: Docker, npm ci, strace                 |
| BUILD: scripts-off/on experiments and delta  |
| SAVE: logs, outcomes, traced events, snapshot|
+------------------------+-----------------------+
                         |
                         v
+------------------------------------------------+
| 4. Exercise MCP                              |
| REUSE: official MCP TypeScript SDK, Docker    |
| BUILD: initialization/tool plans and markers  |
| SAVE: tools/list, calls, results, raw traces  |
+------------------------+-----------------------+
                         |
                         v
+------------------------------------------------+
| 5. Normalize and attribute                   |
| REUSE: strace                                 |
| BUILD: syscall parser, event model, correlator|
| SAVE: events.jsonl and attributions.jsonl     |
+------------------------+-----------------------+
                         |
                         v
+------------------------------------------------+
| 6. Decide and report                         |
| REUSE: Zod, JSON/JSONL                        |
| BUILD: expected-scope rules and report builder|
| SAVE: findings.jsonl and report.json          |
+------------------------------------------------+
```

Each initialization and selected tool input gets a fresh Docker environment.
The sandbox uses fake developer files and blocked public networking. The
observer follows process children and records focused process, file, and socket
syscalls. This is prototype containment, not a guarantee that arbitrary hostile
code is harmless.

## What each part uses

| Part | Technology reused | Forge code | Main evidence |
| --- | --- | --- | --- |
| CLI/config | Node.js, TypeScript, Commander, YAML, Zod | `forge analyze` and strict schemas | Validated target plan |
| Acquisition | npm in Docker, filesystem copy, SHA-256 | exact-version/local adapters and bounded cleanup | provenance and tree hash; lock/cache/registry fields when available |
| Static inspection | JSON and filesystem APIs | bounded Node manifest, lockfile, and lexical signals | evidence-linked capability indicators |
| Install | Docker, npm, `strace` | conditional scripts-disabled/enabled experiments and semantic delta | logs, outcomes, events, selected snapshot hash when the pair applies |
| MCP | official MCP SDK | initialization and isolated tool experiments | advertised interface, inputs, results, phase markers |
| Observation | Linux `strace -ff` | protected supervisor and raw evidence storage | raw process/file/socket traces |
| Normalization | TypeScript | syscall parser, descriptor/path mapping, canonical event model | `events.jsonl` |
| Attribution | TypeScript | active phase plus first-observed process-origin inference | `attributions.jsonl` |
| Findings | TypeScript | deterministic expected-scope and lifecycle rules | `findings.jsonl` |
| Report | Zod, JSON/JSONL | bounded evidence-linked summary | `report.json` |
| Verification | Vitest, Docker | deceptive fixture and pinned Filesystem case study | unit and E2E gates |

## Are we building parsers?

We are not building a full JavaScript parser or whole-program analyzer. The
static inspector performs bounded textual/manifest checks and records its
coverage and limitations.

We do build two important small interpreters:

- A `strace` parser/normalizer that converts selected syscalls into typed
  process, file, and network events.
- A correlator that records each event's active phase and infers process origin
  from that process's first observed event. The normalizer preserves
  parent/child lineage separately; neither fact proves unique causality.

Those create the reusable evidence layer. They are independent of package and
tool names.

## What is specific and what generalizes?

```text
TARGET-SPECIFIC DATA
  target.yaml, runtime command, tool inputs, expected scope

REPLACEABLE ADAPTERS
  npm/local acquisition, Node static scanner, STDIO, strace

REUSABLE CORE
  sandbox phases, fake profiles, canonical events,
  process lineage, attribution, deterministic rules, reports
```

The verified implementation is Node.js + Linux/Docker + local STDIO + exact npm
or local-directory sources. Another Node STDIO MCP should normally need a
configuration and meaningful inputs, not core package-name branches. A new
language needs a new static inspector; a new local transport or observer needs
a new adapter.

## Why normalize?

Raw `strace` records are detailed but awkward and observer-specific. The
normalizer turns them into stable typed facts such as:

```text
process.start
process.exec
process.exit
file.read
file.write
network.connect_attempt
network.listen
```

Downstream code combines that event schema with separate phase records, target
configuration, expected scope, and sandbox context. A future eBPF/Tracee
observer could produce the same canonical events without rewriting those policy
and report layers. Every canonical event keeps a raw evidence reference so an
analyst can check the abstraction.

## Why no database or HTML yet?

One run is stored as a self-contained evidence directory. JSONL works for raw
and normalized streams; JSON works for validated summaries. The current
prototype does not generate an HTML report and does not need a database.

SQLite or Postgres could later index many immutable run folders for a registry
or UI without replacing the evidence files as the source artifact.

## Observer placement

For the take-home, a protected `strace` supervisor runs inside the disposable
container and starts the MCP as a different unprivileged user. In a stronger
production design, observation and containment would move outside the target
container onto a dedicated disposable Linux worker or microVM, for example
with eBPF/Tracee.

## Separate optional Agent V1 path

```text
agent scenario + target config
            |
            v
independent scripts-disabled target preparation
            |
            v
discover target tools -> hash canonical provider-field projection
            |
        hash matches?
         /       \
       no         yes
  stop locally    controlled model/tool loop
                         |
                         v
              policy + utility + rates
                         |
                         v
              forge.agent-report/v1
```

Agent V1 reuses preparation, Docker, fake-profile, MCP-session, and raw-trace
primitives. It does not consume a completed core run's install comparison,
static signals, normalized timeline, rules, or report. The target and
Docker-backed filesystem tools receive separate profiles and distinct canaries;
the receiver is an in-memory controller sink. Target results/errors stay local
behind one identical provider-visible outcome marker; only controlled-tool
results enter provider history. This provides a bounded way to evaluate metadata
influence under one recorded model/scenario, not universal MCP safety. The
offline gate uses a scripted poisoned trajectory and is not yet a causal
clean-versus-poisoned model study.

Agent-only containment keeps target home state read-only and places target
workspace writes in a 16 MB / 2,048-inode tmpfs. A container-wide 4 MB process
file-size limit applies to target and trace writers; linked raw traces and both
synthetic profile domains share a live current-tree byte/entry monitor whose
latest/peak usage and termination status are saved. The fixed controlled writer
also caps path depth and cumulative write attempts. Utility facts identify the
target, controlled, or receiver domain, and bounded target argument paths are
observed before tmpfs cleanup. Those observations are final-state evidence, not
proof of per-action causality. The aggregate `strace -ff` budget is still
polling-based, so a production worker needs a hard whole-filesystem quota and
out-of-band kill control.
