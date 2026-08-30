# Forge prototype

Forge is a working, deliberately narrow detonator for locally executed Node.js
MCP servers over STDIO. It accepts either an exact-version npm package or a
local package directory, prepares it without running lifecycle scripts, and
performs focused static inspection. When preparation produces a reusable npm
cache, it compares scripts-disabled and scripts-enabled installation in fresh
sandboxes; local `install:none` targets skip that pair. It then observes the MCP
handshake, tool discovery, isolated tool calls, and their observation windows
as separate stages. The dedicated initialization experiment includes its final
observation window as activity before any tool call. Each runtime experiment
also records bounded before/after state for its synthetic home and workspace.
Advertised interface text and schemas are preserved as untrusted claims, then
compared with package-source signals, selected runtime effects, and
operator-authored scope. The result is an evidence-linked `report.json`.

The same core pipeline is verified against two different targets:

- The pinned official `@modelcontextprotocol/server-filesystem@2026.7.10` package is the real positive case study.
- The local deceptive document MCP is a known-behavior negative control. It
  verifies for this controlled case that initialization-sensitive access,
  hidden tool activity, delayed post-return effects, and install-time behavior
  are visible.

Neither case study is special-cased in `src/` or `container/`; their package, command, tools, inputs, and expected scopes come from target YAML.

## Prerequisites

- Node.js 22 or newer
- Docker Desktop or a compatible Linux Docker worker
- Network access during exact-version npm acquisition

On macOS, start Docker Desktop and wait until `docker info` returns server details before running the end-to-end verifier. Having the `docker` CLI installed is not sufficient if the Desktop daemon is still stopped or starting.

## Install and verify

From the repository root:

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run verify:e2e
npm run verify:agent
```

`verify:e2e` builds Forge, rebuilds the observer image, analyzes both case studies, confirms that each run records the same immutable Docker image ID, checks their expected reports and evidence links, and confirms that no managed containers remain. It also rejects selected case-study identifiers if they appear in the core `src/` or `container/` implementation.

Individual targets can be validated and analyzed directly:

```bash
npm run dev -- validate case-studies/filesystem/target.yaml
npm run dev -- analyze case-studies/filesystem/target.yaml --rebuild-image

npm run dev -- validate fixtures/deceptive-mcp/target.yaml
npm run dev -- analyze fixtures/deceptive-mcp/target.yaml
```

## Optional Agent V1

The supplementary agent-context path is separate from the core report:

```bash
npm run verify:agent
OPENROUTER_API_KEY=<key> npm run dev -- agent-evaluate \
  fixtures/agent-tool-poisoning/scenario-poisoned.yaml
```

The offline verifier uses a deterministic scripted provider and synthetic
resources; it does not require an API key. A live OpenRouter run is an explicit
operator action. Before any external request, Forge requires the canonical
ordered target name/optional-description/input-schema projection destined for
provider function fields to match the operator-approved SHA-256 in the scenario;
this does not bind complete serialized HTTP request bytes. The target and
Docker-backed controlled filesystem tools receive
separate synthetic profiles and distinct canaries; the controlled receiver is
an in-memory sink. Target tool results/errors are withheld from provider history
behind one identical success/failure marker. Utility evidence records which
isolated domain satisfied each check, and bounded target-path final-state
observations are captured before the target tmpfs is destroyed. The target home
is read-only; its workspace is a 16 MB / 2,048-inode tmpfs, and per-trial quota
usage and cleanup status are persisted. Agent results remain in
`agent-runs/` under
`forge.agent-report/v1`; they are not merged into `forge analyze`.

## What one analysis does

```text
exact npm version or local directory
                |
                v
sandboxed preparation with scripts disabled + provenance hashes
                |
                v
bounded Node package inspection
manifest / dependencies / scripts / lockfile / lexical source signals
                |
                v
closed, bounded TypeScript sidecar -> modeled sensitive API callsites
                |
                v
reusable npm cache? -- yes --> fresh scripts-off/on install A/B + delta
        |
        no
        +--------------------> prepared snapshot
                                  ^
                                  |
                     selected installed snapshot
                      |
                      v
fresh runtime sandbox per initialization or tool experiment
                      |
                      v
advertised interface -> bounded claim extraction
before state -> raw MCP + strace -> after state + bounded delta
                            |
                            v
normalized events -> phase attribution -> deterministic rules
                      + phase-scoped counts
                      + claimed/static/observed/configured comparison
                      |
                      v
                  report.json
```

Acquisition may use the network, but it runs in a restricted Docker container
with lifecycle scripts disabled. When a reusable npm cache exists, the install
A/B experiments run offline from it in otherwise equivalent fresh containers.
If the scripts-enabled install completes, that exact snapshot is mounted
read-only for runtime experiments. Local `install:none` targets have no install
pair and use the directly prepared snapshot.

Dependency acquisition and the installation experiments share `sandbox.limits.installTimeoutMs`, which defaults to 60,000 ms. A timed-out acquisition terminates the Docker client, performs label-verified managed-container cleanup, and preserves bounded acquisition output. `sandbox.limits.timeoutMs` is the shorter MCP initialization/tool-call timeout; both checked-in case studies set it to 10,000 ms.

## Verified case-study results

The checked-in representative paired verification produced:

- Deceptive control: [`examples/reports/deceptive-control.report.json`](examples/reports/deceptive-control.report.json). It reports five deterministic findings: a high-confidence sensitive credential read during initialization; an out-of-scope credential read, unexpected child executable, and unexpected network attempt during the tool experiment; and medium-confidence post-return file activity from a tool-originated worker during cooldown. Its install delta also exposes the controlled postinstall execution, canary read, and marker write.
- Official Filesystem MCP: [`examples/reports/official-filesystem.report.json`](examples/reports/official-filesystem.report.json). It records exact npm provenance, preserves both pre-install and selected-runtime static inspections, completes both install modes, discovers the real MCP interface, and reports phase-scoped counts for the configured `read_text_file` and `write_file` effects. Its filesystem claims, static signals, selected runtime effects, and configured scope align for those two tool experiments. The read experiment has no final-state change; the write experiment records the created synthetic-workspace output. It reports no deterministic finding within those inputs and rules, which is not a claim that the package is universally safe.

The deceptive tool's description explicitly negates network and process
behavior. The bounded claim extractor therefore records a filesystem claim but
no network or process claim, while static and runtime evidence independently
show both hidden capabilities outside configured scope. This is a selected-case
demonstration of useful disagreement, not a general semantic-understanding
claim.

## Evidence directory

Each run is written below `runs/`:

```text
runs/<run-id>/
|-- run.json
|-- target.json
|-- report.json
|-- observation-health.json
|-- events.jsonl
|-- phases.jsonl
|-- attributions.jsonl
|-- findings.jsonl
|-- target/
|   |-- provenance.json
|   |-- package.json
|   `-- package-lock.json
|-- static/
|   |-- pre-install-inspection.json
|   |-- pre-install-semantic-inspection.json
|   |-- inspection.json
|   `-- semantic-inspection.json
|-- install/
|   `-- delta.json
|-- mcp/
|   |-- advertised-claims.json
|   `-- <runtime-experiment>/interface.json
|-- runtime/filesystem-state/<runtime-experiment>/
|   |-- before.json
|   |-- after.json
|   `-- delta.json
|-- raw/
|   |-- acquisition/npm-install.log
|   |-- static/<evidence-id>.json
|   |-- install-scripts-disabled/
|   |   |-- install.json
|   |   |-- npm-stdout.log
|   |   |-- npm-stderr.log
|   |   `-- strace.<pid>
|   |-- install-scripts-enabled/
|   |   `-- ...
|   `-- <runtime-experiment>/
|       |-- mcp-transcript.jsonl
|       |-- server-stderr.log
|       `-- strace.<pid>
`-- sandboxes/<experiment>/profile.json
```

Some target evidence files are conditional. The primary static summary is explicitly tied to the selected runtime snapshot; the earlier inspection is retained to show the package before lifecycle scripts ran. Each lexical inspection also feeds a separate semantic artifact derived only from its hash-bound captured source bytes. The report summarizes the selected semantic artifact and binds its SHA-256 without changing the meaning of existing lexical comparison rows. Every normalized event contains a raw evidence reference, findings cite normalized event IDs, and attribution is stored separately from observed facts. `observation-health.json` keeps structural trace integrity separate from bounded policy-relevant operations that were parsed but not faithfully canonicalized. `report.json` includes that compact health summary, phase-scoped effect counts, an additive file-operation breakdown that distinguishes content, enumeration, and truncation, expected-scope examples, and the bounded four-way behavior comparison so positive behavior is visible without hiding incomplete coverage or implying intent. A failed analysis retains its failed manifest and partial artifacts and best-effort writes incomplete observation health; it does not emit an ordinary report whose later layers were never reconciled.

The report's per-experiment behavior comparison keeps four questions separate:
what the MCP advertised, what bounded package inspection found, what the
selected runtime experiment observed, and what the operator configured. Exact
event and claim evidence references remain attached to each row. Filesystem
state summaries link to complete bounded snapshot/delta artifacts; reported
differences show retained state change over the experiment window and do not by
themselves identify the responsible process, phase, or source line. Comparison
rows separately expose events whose association with a tool is temporal overlap
rather than matching process origin.

## Optional durable publisher demo

`forge analyze` still completes into the self-contained local directory above.
The separate `forge publish-run <run-directory>` command verifies a completed
bundle, snapshots its manifest-listed bytes away from mutable run paths,
uploads content-addressed objects to S3-compatible storage, and indexes bounded
run/artifact/finding metadata in PostgreSQL. All deterministic S3 keys and
PostgreSQL values are preflighted before remote writes; identical retries verify
service checksums and exact published metadata sets.

For the two exact reviewed demo identities, `publish-run --refresh-dashboard`
also stores a separate disclosure-safe projection after finalization and
regenerates the local script-free results page from up to five recent published
rows per target. The newest row drives the current summary and every retained
row can be expanded in the published-run history. The browser never reaches
PostgreSQL or the canonical evidence bucket; an explicit content-only deploy
moves only validated HTML/CSS to the AWS site bucket.

The S3 `run.json` is an artifact-completeness marker, not a cross-store atomic
commit. PostgreSQL `status = 'published'` is query authority; hosted use still
needs reconciliation for a database failure after manifest upload. See
[`PublisherDemo.md`](PublisherDemo.md) for the synthetic localhost walkthrough
and [`HardenedEvidenceInfrastructurePlan.md`](HardenedEvidenceInfrastructurePlan.md)
for the production sequencing and remaining controls.

## Containment model

Runtime and install experiments use disposable Docker containers with blocked networking, read-only container roots, synthetic home/workspace data, bounded CPU/memory/processes/time, `no_new_privs`, and exact label-checked cleanup. Runtime cleanup fails closed on ambiguous Docker responses and requires repeated verified absence before Forge scans host-mounted profile state. The runtime target runs as UID/GID 65534 with all target capabilities cleared and cannot write the observer-owned trace directory. Each run manifest records both the configured observer-image reference and the resolved immutable image ID.

This is useful take-home containment, not proof that arbitrary hostile code is perfectly safe. The trusted `strace` supervisor currently shares the target container. A production design should use disposable Linux workers or microVMs and place observation outside the target boundary, for example with host-side tracing or eBPF.

## Deliberate limits

- Support is currently Node.js packages on Linux, local execution over MCP STDIO, and npm or local-directory sources.
- Static inspection combines the existing bounded lexical analysis with a separate TypeScript Compiler API sidecar for modeled direct and immutable-alias Node callsites. The sidecar uses a closed in-memory host and a worker with time plus V8 heap/stack limits; those are not total-RSS or OS-sandbox limits. Bindings affected by syntactically detected assignment/delete/update mutations are withheld and make evidence partial, while reflective mutation remains unresolved. The pass is not whole-program, entrypoint/MCP-handler reachability, or data-flow analysis, and dependency source under `node_modules` is not scanned.
- Advertised-claim extraction is bounded lexical classification of tool names, titles, descriptions, and input schemas. Selected standard annotations are preserved separately and do not independently map to capabilities. The extractor handles nearby negation for its supported terms, but it is not general natural-language understanding; no detected claim is not a denial of capability or permission to perform it.
- The complete `tools/list` result and every recorded JSON-RPC message are bounded before schema validation or persistence. The retained interface, advertised-claim evidence, and catalog fingerprints intentionally omit output schemas and other unretained MCP metadata, so those fields are not analyzed for claims or drift.
- Runtime normalization covers a focused `strace` syscall subset for process, file, and socket behavior, including supported failed exec/file attempts, explicitly labeled directory enumeration, `execveat`, correlated bind/listen endpoints, and terminal signal exits. Directory enumeration remains a simultaneous alternate-access gap and is not used as proof of file-content reads by deterministic policy/comparison consumers. Every nonempty selected-trace line is structurally accounted for, while a bounded policy-gap taxonomy makes selected unsupported mutations, transfers, endpoint semantics, alternate access, opaque I/O, definitively failed capability probes, interference attempts, unresolved paths, truncated arguments, and indeterminate outcomes explicit. Neither accounting layer covers every kernel action, syscall meaning, DNS meaning, or encrypted network payload.
- Descriptor correlation covers common shared/copied `CLONE_FILES`, duplication,
  close, and close-range cases, but it is best effort across equal timestamps,
  standalone descriptor-table unsharing, exec/CLOEXEC transitions, and uncommon
  descriptor-transfer mechanisms. Thread-local `exit` is structurally visible
  but is not promoted to a process exit when doing so would guess about sibling
  threads.
- Observation health remains optional in report V1 so older reports stay
  readable and publishable. The current analyzer always emits it, and bundle
  verification hash-binds and cross-validates it whenever present; strict
  mandatory health needs an explicit producer feature marker or report V2.
- Selected trace logs are still batch-read for parsing and classification. The sandbox runtime is bounded, but raw trace bytes/lines do not yet have an independent aggregate ingestion quota; a production worker should stream them through explicit disk, byte, record, and processing-time ceilings.
- Before/after filesystem evidence is bounded to the synthetic home and workspace, does not intentionally follow entries observed as symlinks, hashes only supported files within configured limits, and omits unsupported special-file contents. Pathname-replacement races remain a documented limitation even though after-state capture waits for verified container absence. Reported differences show that retained state differed across the isolated experiment window; an empty delta is not proof that no unrecorded state changed, and neither result identifies exact syscall or process causality.
- Results cover only the configured initialization and isolated tool inputs. A clean report means no covered rule mismatch was observed, not that the target is safe for every input.
- Workflow execution, HTML reporting, and LLM interpretation are not implemented in the core path. Automated Agent V1 rollouts are available separately through `forge agent-evaluate`; they do not modify this report or core analysis flow.
- This is not yet a production VM/microVM or out-of-container eBPF observer.
