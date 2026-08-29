# Forge MCP Detonator: Initial Design

## Goal

Given a local MCP server, answer two questions:

1. What does it claim to do?
2. What does it actually do when it installs, starts, and runs its tools?

The output is an evidence-based report, not a simple "safe" or "malicious" label.

## Narrow first scope

We will go deep on exact-version public npm packages that run locally as Node.js STDIO MCP servers.

We will test against:

- The real, open-source Filesystem MCP server.
- A small MCP fixture we create with known hidden behavior. This proves that our detector can find and correctly attribute that behavior.

We will not initially support Git sources, private registries, arbitrary package URLs, remote MCP servers, every programming language, or agent rollouts. Those would add breadth before the core evidence is trustworthy.

## User experience

This will be a CLI tool:

```text
forge analyze target.yaml
```

It will produce:

- `report.html` for a person to read.
- `report.json` for structured results.
- `events.jsonl` containing normalized events linked to raw evidence.
- Raw `strace`, MCP transcript, and controlled-service logs for verification.

A CLI is the simplest fit because the tool must launch, monitor, and stop a local process. The HTML report gives us a clear UI without building a web service.

## Simple whiteboard view

```text
               exact npm package + version
                           |
              acquire and lock, scripts off
                           |
                     static inspect
                           |
               +-----------v------------+
               | install experiments    |
               | scripts off vs. on     |
               +-----------+------------+
                           |
                 snapshot installed MCP
                           |
               +-----------v------------+
               | MCP runs               |
               | initialize / tools /   |
               | one small workflow     |
               +-----------+------------+
                           |
            process / file / network evidence
                           |
                 rules + optional LLM
                           |
                    HTML + JSON report
```

## What is general and what is specific?

Most of the system is general detonation infrastructure:

- Creating and destroying a sandbox.
- Building fake environments and canaries.
- Watching processes, files, and network activity.
- Storing a normalized event timeline.
- Applying rules and building reports.

Some parts must understand MCP:

- Initializing an MCP server.
- Reading its tool descriptions and schemas.
- Calling tools and marking their start and end.
- Building small multi-tool workflows.
- Comparing observed behavior with a tool's stated purpose.

A general sandbox can say, "process 42 read this file." The MCP layer lets us say, "this happened during `summarize_file`, and it does not match that tool's description." That MCP context is a useful part of the design, not something we should remove.

STDIO is only the first MCP connection adapter. A later Streamable HTTP adapter could reuse the same infrastructure when the HTTP server runs inside an environment we control. For a remote MCP hosted by someone else, we could inspect its interface and client-visible traffic, but not its private processes or filesystem. Node.js is also only the first static-inspection plugin; Python or compiled-code inspection could be added later.

The public npm flow is likewise only the first source adapter. It produces a pinned installed snapshot whose source artifact, dependency lock, and file inventory are hashed. A later Git or local-directory adapter could produce the same handoff without changing the MCP runner or evidence pipeline.

We should not try to create a perfect generic framework before the first case works. We will keep these boundaries clear, implement the STDIO and Node path deeply, and prove that the shared core does not depend on them.

## Generalization boundaries

The system is narrow by adapter, not hardcoded to one MCP server:

| Layer | Initial implementation | How broadly it generalizes |
| --- | --- | --- |
| Target configuration | Tool inputs and one workflow in YAML | Specific to a server, but data only; no core-code changes |
| Source adapter | Public npm package at an exact version | npm-specific; Git or local-source adapters can later produce the same artifact handoff |
| Static inspector plugin | Node manifest reader and Semgrep rules | Node-specific; another language needs a new static plugin |
| MCP driver | Initialize, list, and call tools | Reusable across MCP servers |
| Transport adapter | STDIO | Replaceable with local Streamable HTTP without changing evidence analysis |
| Observer adapter | `strace` on Linux | Language-independent; replaceable with Tracee/eBPF using the same event schema |
| Detonation core | Runs, phases, canaries, normalized events, attribution, rules, and reports | General across languages, transports, and many kinds of untrusted local software |

There are two different kinds of rules:

- **Static signal extractors:** Node-specific Semgrep patterns for process execution, file access, environment access, network use, and dynamic code loading. They say "the source contains this capability," not "the package is malicious."
- **Runtime behavior rules:** Language-independent checks over canonical events, such as a read-only tool writing a file, a canary appearing in visible outbound data, or activity continuing after a tool returns.

Neither kind is a hand-written policy for the Filesystem MCP. Adding another Node MCP should normally require only configuration and tool inputs, not new rules.

Some manual maintenance is expected when JavaScript APIs or evasion patterns change, and a new language requires a new static rule pack. That does not affect the runtime core: Python, Go, and native programs still cross the same Linux process, file, and network boundaries.

The trace normalizer is built around a stable canonical event model rather than around MCP or Node names:

```text
process_start / process_exec / process_exit
file_open / file_read / file_write / file_delete
network_connect / network_listen
phase_start / phase_end
```

One adapter maps `strace` records into those events. Attribution, rules, and reporting consume only canonical events, so a later Tracee/eBPF adapter can replace `strace` without rewriting them.

To prevent overfitting:

- Core rules may not branch on package names or hardcoded tool names.
- Target-specific paths, arguments, and workflows live in `target.yaml` fixtures.
- Runtime rules derive expected scope from tool arguments, annotations, sandbox policy, and canaries.
- Both the real Filesystem MCP and deceptive fixture must use the same pipeline and rules.
- Every normalized event links to raw evidence, so abstractions can be checked.
- Normalizer and correlator tests randomize process IDs, paths, and tool names so rules cannot depend on demo values.
- Runtime reporting must still work when static inspection is disabled or source is unavailable.

A practical generalization test is: a second Node STDIO MCP should need a new target config and inputs, not a new execution engine. Python should require a new static plugin, while the sandbox, observer, event model, attribution, and report remain unchanged.

## Technology choices

We will reuse mature tools where the problem is already solved:

| Job | Technology we reuse | What we build |
| --- | --- | --- |
| Controller and CLI | Node.js, TypeScript, Commander | The `forge analyze` flow |
| Package acquisition | Pinned npm CLI in a disposable resolver | Artifact, lock, and cache handoff |
| MCP communication | Official MCP TypeScript client | Experiment boundaries and tool plans |
| Config and event validation | YAML and Zod | Our config, event, and finding shapes |
| Node static inspection | Package manifest parsing and Semgrep | Reusable static signal extractors |
| Isolation | Hardened Docker containers | Safe policies, fake environments, and cleanup |
| Runtime tracing | `strace`, file hash inventories, and supplemental `docker diff` | Trace normalization and tool attribution |
| Reports | JSON/JSONL and Handlebars | The evidence-linked report |
| Tests | Vitest and the MCP Inspector | Benign and deceptive test scenarios |

TypeScript fits the first Node-focused slice and is already available in the workspace. We will pin the Node version, npm version, dependency lock, and container image digest used for every run. `strace` runs inside the Linux target image; it does not need to be installed on the Mac host. Semgrep can run in a separate limited scanner container.

We will build the parts that are specific to the question we are answering: baseline and tool experiments, canaries, the common evidence timeline, correlation, deterministic mismatch rules, and explanations. We will not build our own MCP protocol, container runtime, syscall tracer, JavaScript parser, or template escaping.

For the take-home, a trusted `strace` supervisor inside the disposable container starts the MCP as a different unprivileged user. The target has no effective capabilities and cannot write the protected trace files. This is still a weaker evidence boundary because the target may detect tracing or attack the same-container observer. Later, a dedicated disposable Linux worker could use an external eBPF observer such as Tracee, plus gVisor or a VM boundary.

We do not need a database for one or two deep case studies. Each run is a self-contained evidence directory containing raw logs, normalized JSONL events, findings, hashes, and the final reports. SQLite or Postgres can later index many runs without replacing these source artifacts.

## Main parts

### 1. Artifact acquisition

Accept a public npm package at an exact version. In a disposable networked resolver, download it with lifecycle scripts disabled and with a clean home directory containing no host npm configuration or credentials.

Preserve the published tarball, registry metadata, cryptographic hash, generated root lockfile, dependency cache, and Node/npm/container versions. The lockfile matters because pinning only the top-level package does not pin all transitive dependencies.

This observes the lifecycle visible to a package consumer. It does not observe how the publisher built the package before uploading it.

### 2. Static inspector

Before allowing package code to run, inspect the actual published artifact and record:

- Entry point and dependencies.
- Tool definitions found directly in source code, when visible.
- Source references to files, environment variables, network calls, subprocesses, and dynamic imports.

This tells us what the source suggests the server may do. The authoritative advertised MCP interface comes later from the runtime `tools/list` response.

### 3. Safe install and test environment

Run the target as an unprivileged process in a disposable Linux sandbox. Give it no real secrets or host directories. Limit its time, memory, CPU, processes, and writable files. The default MVP mode blocks external network access; `strace` records socket and connection attempts.

First, run two fresh offline installation experiments from the same lock and package cache:

```text
Install A: lifecycle scripts disabled
Install B: normal consumer lifecycle scripts enabled
```

The difference separates normal npm extraction from behavior caused by install scripts. Container-level policy blocks external network access even if a script launches another program. If that breaks a legitimate installer, report "blocked by network policy," not "malicious."

Snapshot the scripts-enabled installed filesystem, record its file hash inventory, and clone that exact state for later MCP runs. Run the resolved package binary directly so installation does not happen again during initialization.

The sandbox starts from a small, fixed, and versioned fake developer profile with fake SSH, cloud, and project-secret locations. Unique canary values are injected for each run. `target.yaml` may add fixtures needed for a particular scenario, and static inspection may suggest additional probes, but we do not generate the whole environment from static results. Otherwise, behavior missed or hidden from static analysis might never receive the resource that triggers it. The package being tested never defines its own sandbox policy.

Each fake secret is unique to the run and cannot authenticate to a real service. If that marker later appears in a command, file, tool result, or visible network data, we can show how information moved.

A later simulated-network mode can connect the target only to controlled DNS and HTTP services with no public-internet route. Those services can log request details. Without that mode, or when application-level encryption hides content, we only claim the connection and byte activity that the observer can actually see.

The sandbox reduces risk; it does not make unknown code perfectly safe. The report will state the containment limits.

### 4. MCP runner

The runner starts the server and speaks MCP over stdin and stdout. It performs initialization, gets the authoritative tool names, descriptions, and input schemas from `tools/list`, and invokes selected tools with recorded inputs.

The discovered descriptions, schemas, and annotations are the MCP's untrusted advertised contract. They describe the shape and claimed purpose of a tool, but they do not define the experiment's expectations or sandbox policy. An operator-authored `target.yaml` supplies the concrete inputs and analyst-expected scope. Forge records that expectation separately from the restrictions technically enforced by the sandbox.

For the MVP, meaningful inputs for the selected tools and one workflow are hand-authored, validated against the runtime `tools/list` JSON Schema, recorded, and frozen for repeatable experiments. A deterministic schema-based filler may provide primitive fallback values, but a structurally valid value is not necessarily a meaningful test. For example, a schema can identify a string without telling us whether a useful value is a path, query, URL, or document.

An optional LLM may later propose additional exploratory inputs or workflows. Its proposal is not ground truth: it must be treated as untrusted, checked against the tool schema and sandbox policy, saved with its model and prompt metadata, and frozen before execution. Neither an LLM nor the MCP being tested sets the expected security behavior or final verdict.

We use separate experiments:

```text
Run 1: initialization only
Run 2: fresh sandbox + Tool A
Run 3: fresh sandbox + Tool B
Run 4: fresh sandbox + a small Tool A -> Tool B workflow
```

Single-tool runs give clean evidence. One hand-picked workflow initially covers tools that need shared state or outputs from earlier tools.

### 5. Runtime observer

While the MCP runs, collect a timeline of the most useful signals:

- Processes and subprocesses.
- Files read, written, created, or deleted.
- Network and DNS attempts.
- Loaded code and dependencies where visible.
- MCP initialization, tool-call start, tool-call end, and tool result.
- Acquisition and installation phase boundaries.

Preserve raw trace files unchanged. A Forge normalizer converts selected system calls into process, file, and network events, and each normalized event links back to its raw record. Pre/post hash inventories are authoritative for changes inside volume-backed fake home and workspace directories; `docker diff` is only a supplemental check.

Direct reads of inherited environment variables are difficult to observe reliably. Instead, we record exactly what fake environment was supplied and look for its unique markers in later visible behavior.

### 6. Correlator and interpreter

First, deterministic code turns raw events into facts and applies simple rules. For example:

- A read-only tool wrote a file.
- A tool accessed a credential outside its requested path.
- A fake secret appeared in visible outbound data.
- A process continued doing work after the tool returned.

The correlator builds process lineage from fork, clone, and exec events plus process and parent IDs. Every process records which phase created it, while every later event separately records which phase was active when it happened. Tool calls are serialized, followed by a cooldown window, and compared with the initialization-only baseline.

This gives high confidence when a process is created and finishes inside an isolated tool run. Reused workers, detached processes, and workflow background activity can remain ambiguous. The report keeps that uncertainty and states whether attribution confidence is high, medium, or low.

An optional LLM can explain whether the observed facts make sense for the tool description. It may only use recorded evidence and must cite event IDs. MCP descriptions and outputs are treated as untrusted data so they cannot instruct the evaluator. `forge analyze --no-llm` still produces the complete deterministic evidence and rule report.

### 7. Report

The report clearly separates:

- What the MCP advertised.
- What static inspection found.
- What happened during installation.
- What runtime observation recorded.
- Which behavior was linked to startup, an individual tool, or a workflow.
- Where observed behavior did not match the stated purpose.
- What was not tested or could not be observed.

Static and runtime evidence are related but not interchangeable. For the same normalized behavior category, the report uses the following interpretation instead of presenting a misleading single coverage score:

| Static signal | Runtime observation | Report interpretation |
| --- | --- | --- |
| Found | Observed | A matching static signal and runtime behavior agree in this experiment |
| Found | Not observed | A matching static signal was found, but the behavior was not observed; the signal may be unused, unreachable, imprecise, or simply unexercised |
| Not found | Observed | Runtime exposed behavior without a matching static signal, possibly through dynamic, dependency, native, hidden, or missed code |
| Not found | Not observed | No evidence was found in these experiments; this is not proof of safety |

For each important behavior, the report keeps these concepts separate: the advertised contract, static signals, configured input, analyst-expected scope, enforced sandbox policy, observed runtime facts, and the evidence-linked finding.

The report describes behavior seen in these runs. It does not claim to prove every behavior the MCP could ever have.

## Where effort goes and why it matters

| Step | Expected effort | Main Forge work | Why it is valuable infrastructure |
| --- | --- | --- | --- |
| Acquire and lock | Medium | Safe npm resolution, provenance, hashes, and reproducible handoff | Ensures every later finding refers to exact package bytes and dependencies |
| Static inspection | Medium | Manifest reader and focused Semgrep rules | Builds the claimed/suspected behavior baseline and guides runtime tests |
| Install and sandbox | High | Restrictions, two install experiments, fake environment, snapshots, and reliable cleanup | Safely exposes behavior that happens before MCP initialization |
| MCP experiments | Medium | Baseline, isolated-tool, and workflow plans | Produces repeatable lifecycle boundaries and meaningful test coverage |
| Runtime observation | High | Normalize noisy process, file-descriptor, filesystem, and network traces | Creates the reusable factual evidence layer beneath every finding |
| Attribution | Highest | Join phase markers, process lineage, baselines, cooldowns, and confidence | Turns raw activity into the answer users need: what action caused it? |
| Rules and report | Medium | Deterministic mismatches, evidence links, optional LLM explanation, and HTML | Makes the technical evidence understandable and reviewable |

The MCP SDK, CLI parsing, JSON reading, container runtime, Semgrep parser, syscall tracer, and HTML templating are mostly existing plumbing. Most implementation attention should go to sandbox safety, trace normalization, and honest causal attribution. Those are also the pieces that remain valuable when we later add other package sources, languages, transports, or agent experiments.

## First success case

The first end-to-end demo is successful if it can:

1. Acquire an exact published version of the real Filesystem MCP and record its artifact, hash, and dependency lock.
2. Inspect its source, dependencies, and install scripts before running them.
3. Observe installation with scripts disabled and enabled.
4. Show its advertised tools and record initialization plus at least two tool calls.
5. Attribute activity to installation, initialization, the correct tool, or a workflow.
6. Run our deceptive fixture and catch known unexpected behavior in one or more phases.
7. Produce a report with links from every conclusion back to concrete evidence.

This directly tests the assignment's central idea: observe, attribute, and explain what an MCP server actually does.
