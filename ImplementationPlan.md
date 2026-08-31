# Forge MCP Detonator: implementation status and next plan

## Current outcome

The core take-home prototype is implemented and verified for its stated scope: exact-version npm or local Node.js MCP packages executed over STDIO on Linux/Docker.

Forge now provides one complete evidence path:

```text
target config
  -> sandboxed acquisition and exact provenance
  -> focused static inspection
  -> scripts-disabled / scripts-enabled install comparison when preparation
     produced a reusable npm cache
  -> isolated initialization and tool experiments
  -> advertised-interface claims plus raw MCP and operating-system evidence
  -> bounded before/after synthetic-profile state
  -> normalized events and phase attribution
  -> phase-scoped runtime summary and claimed/source/observed/scope comparison
  -> deterministic runtime findings
  -> report.json
```

The system is tested as a reusable pipeline, not as a detector written around one fixture. The real case study and deceptive control use the same observer image, contracts, target preparation, normalizer, correlator, rules, and report generator. Each run records the resolved immutable Docker image ID; only target YAML and target artifacts differ between the cases.

## Project-spec completion gate

The original project specification's “What done looks like” list remains the
acceptance gate. It is preserved verbatim in [`PROJECT_SPEC.md`](PROJECT_SPEC.md).

| Project-spec outcome | Current status | Evidence and boundary |
| --- | --- | --- |
| Point Forge at a real local MCP and return a concrete report | Complete for the scoped prototype | The pinned official Filesystem MCP is acquired from npm and executed locally; a sanitized representative report is [`examples/reports/official-filesystem.report.json`](examples/reports/official-filesystem.report.json). |
| Useful static analysis of tools, inputs, dependencies, and source behavior | Complete within a focused Node scope | Forge preserves exact package provenance; parses manifest claims, entrypoints, scripts, dependency counts, and available lock metadata; and emits evidence-linked lexical source capability signals. MCP tool descriptions and input schemas are discovered during the controlled MCP handshake rather than inferred statically. |
| Observe initialization and one or more tool calls | Complete | Each initialization/tool input runs in a fresh container. Forge records MCP messages plus process, file, and socket evidence through the tool's cooldown. The Filesystem case study exercises real reads and writes; the deceptive control exercises initialization-sensitive and delayed post-return behavior. |
| Connect runtime behavior to lifecycle events or specific tools | Complete for isolated experiments | The correlator records each event's active phase and infers process origin from that process's first observed event; isolated matching phases receive higher confidence. Parent/child lineage is preserved separately. Attribution remains an inference with raw references, not proof of unique causality. |
| If time permits, address agent behavior | Implemented as a separate opt-in V1 | [`AgentRolloutV1.md`](docs/history/agent-rollout-v1.md) defines the methodology and implemented boundary. `forge agent-evaluate` has separate scenarios, contracts, reports, controlled tools, clean/poisoned fixtures, fake-provider tests, and a Docker-backed poisoned-fixture verifier. A canonical ordered target-field projection destined for provider function fields is hash-bound before disclosure; complete wire bytes are not. Target results remain local. It does not change `forge analyze` or `forge.report/v1`. |

The four required core outcomes are demonstrated. “Complete” here means the
bounded prototype meets the project-spec criterion, not that two runs prove
universal MCP coverage or production-grade hostile-code containment.

## Implemented building blocks

### 1. Versioned target and evidence contracts

Zod validates target YAML and persisted `forge.*/v1` artifacts. Targets supply their source, generic STDIO command/arguments/cwd/environment, experiments, expected scope, and hard sandbox limits. Raw facts, attribution, and findings are separate records.

### 2. Generic npm/local target preparation

- Exact npm versions are acquired in a restricted Docker container with lifecycle scripts disabled. Acquisition reuses the bounded install timeout, preserves bounded output, and performs label-verified cleanup on success, failure, or timeout.
- Local directories can be copied directly or dependency-installed with scripts disabled.
- Target-tree digests are always recorded; package/lock hashes, resolved npm
  version, registry URL, and integrity are recorded when the source strategy
  provides them.
- The prepared artifact is mounted at `/opt/target`; the observer image does not contain either case study.
- The configured observer-image reference is resolved once per analysis, and its immutable Docker image ID is recorded in `run.json`.

### 3. Focused static Node inspection

Forge records manifest claims, entrypoints, install lifecycle scripts, dependency inventory, supported lockfile metadata, source coverage, and bounded evidence-linked lexical signals for filesystem, process, network, environment, dynamic-code/module, and native-code capabilities. It retains an inspection from before lifecycle execution, then inspects and labels the exact selected runtime snapshot so static and runtime evidence cannot silently refer to different trees.

Each inspection now also feeds an additive `forge.node-semantic-static/v1`
sidecar. A pinned TypeScript 6 Compiler API runs in a time-limited worker with
V8 heap/stack limits over a closed virtual filesystem containing only the
previously captured, hash-revalidated source bytes. Those worker limits are not
a total-RSS bound or an OS sandbox. A checked-in sink catalog identifies actual
modeled API calls, direct ESM/CommonJS bindings, and bounded immutable aliases;
bindings affected by syntactically detected assignment/delete/update mutations
are withheld, while reflective mutation remains unresolved and coverage,
diagnostics, relative-module gaps, truncations, and worker failure remain explicit.
Existing lexical comparison fields are unchanged.

These are indicators, not verdicts. Package-authored metadata is labeled as a claim, neither lexical matches nor semantic callsites prove runtime reachability, and dependency source is not recursively analyzed. MCP-handler reachability and source-to-sink data flow remain future work.

### 4. Controlled install lifecycle comparison

When target preparation produced a reusable npm lock/cache, fresh, otherwise
equivalent Docker containers run offline `npm ci` with lifecycle scripts
disabled and enabled. Both are traced, and `install/delta.json` records
treatment-only and control-only process, file, and network event IDs. The
scripts-enabled snapshot becomes the runtime artifact when that install
completes. Local `install:none` targets skip the pair and use their prepared
snapshot directly.

Dependency acquisition and install use `sandbox.limits.installTimeoutMs` (default 60,000 ms), separate from `sandbox.limits.timeoutMs` for MCP initialization/tool operations (10,000 ms in both checked-in targets). Failed or timed-out install experiments are recorded honestly; an incomplete install pair makes the delta inconclusive.

### 5. Isolated runtime observation

Initialization and every configured tool input start from a fresh synthetic developer profile and fresh container. The Node target communicates over STDIO through the MCP SDK. Handshake, tool discovery, invocation, and the bounded observation window are recorded as separate stages. Tool discovery requests raw `tools/list` data, applies an iterative whole-result budget before MCP shape validation, and therefore does not ask the SDK to compile an untrusted output schema during discovery. Every JSON-RPC message is likewise iteratively bounded and cloned before persistence; per-message, aggregate transcript count/bytes, and server-stderr quotas fail the experiment closed. The dedicated initialization run includes its observation window as pre-tool evidence. `strace -ff` follows processes and records the selected process, file, network, read, and write syscalls. The normalizer retains supported failed exec/file attempts and terminal signal exits when the raw trace identifies them reliably. Before and after each isolated runtime experiment, Forge also captures bounded synthetic-home/workspace state, does not intentionally follow stationary symlinks, explicitly records pathname-replacement TOCTOU limits, and persists created/modified/deleted/type-changed deltas. Per-entry and aggregate entry/hash/error/time budgets are explicit, and the after-snapshot starts only after label ownership and repeated container absence are verified. The target runs without capabilities while the protected supervisor owns raw traces.

### 6. Normalization, attribution, and deterministic rules

The normalizer creates canonical process, file, and network events with raw
references, reconstructs parent/child lineage and file-descriptor paths, and
distinguishes Node threads from real child processes. A separate correlator
records the active lifecycle/tool phase per event and infers process origin from
that process's first observed event. Matching isolated phases raise confidence;
they do not prove unique causality.

Current policy rules compare tool effects with operator-owned expected scope for file reads/writes, child executables, and network destinations; file deletion is treated as a mutation governed by the write scope. Initialization remains backwards compatible as a boolean, but may instead carry its own expected scope; that enables deterministic checks for synthetic file access, child executables, and non-Unix network attempts before any tool call. Separate rules surface sensitive initialization access and meaningful effects from tool-originated processes after a response. Failed access attempts are described as attempts rather than completed access. The rules do not trust MCP-authored descriptions as policy.

### 7. Evidence-linked report

`report.json` combines artifact provenance, advertised MCP interface, bounded interface-claim/annotation evidence, static summary, installation outcomes/delta, experiment inputs and expectations, phase-scoped effect counts, compact expected-scope examples, deterministic findings, filesystem-state deltas, evidence paths, and explicit limitations. The interface summary names its source experiment and reports cross-start catalog drift or duplicate tool names using a bounded, tool-order-independent SHA-256 catalog fingerprint; a separate order-sensitive fingerprint binds the selected source interface. Object keys are sorted in JavaScript code-unit order without Unicode-normalizing string contents, and over-limit interface catalogs fail explicitly before recursive serialization. The retained interface and fingerprints bind server name/version and each tool's name, title, description, input schema, and standard annotations; output schemas and other unretained MCP metadata are bounded during acquisition but are not included in claim extraction or drift fingerprints. Each positive syscall example keeps its event ID, observed effect, attribution confidence, and raw trace reference. A per-experiment four-way table keeps advertised claims, package-source signals, selected runtime events, and operator-configured scope separate, with exact event IDs partitioned inside/outside/unclassified and tool-phase temporal-overlap IDs called out. `not_observed` claim state means the configured tool lacked a bounded claim assessment, while `not_claimed` means an available assessment found no positive signal. Advertised claims remain untrusted and selected non-observation is never treated as proof of absence. State summaries are machine-labeled as isolated-experiment-window evidence with experiment-only attribution. JSON/JSONL remains the primary output so deterministic code or a future LLM can consume the same facts.

### 8. Supplementary Agent V1

`forge agent-evaluate` independently prepares the configured target with
lifecycle scripts disabled, discovers its MCP interface, and places the exact
provider-supported target projection into a controlled model/tool loop. It
does not consume the core install A/B result, static inspection, selected
scripts-enabled snapshot, normalizer, attribution, runtime rules, or core
report.

The scenario binds operator approval to the SHA-256 of a canonical ordered
target name/optional-description/input-schema projection destined for provider
function fields; it does not bind complete serialized HTTP request bytes. A
mismatch is recorded locally and aborts before a provider request. The target
and Docker-backed controlled filesystem tools use separate synthetic profiles
and distinct canaries; the controlled receiver is an in-memory controller sink.
Target results/errors are retained locally and represented in provider history
by one identical controller-authored marker for either outcome.
Policy decisions, controlled effects, utility, cleanup, and metric-specific
rate denominators are deterministic and evidence-linked. Agent MCP transcript
payload/message counts and stderr capture are cumulatively bounded, and raw
stdio also has a per-message buffer cap. Agent-only target home state is
read-only; the writable target workspace is a 16 MB tmpfs with a 2,048-inode
cap, and the container has a 4 MB process file-size limit. Linked raw-trace and
target/controlled profile trees also have a monitored per-trial current-tree
byte/entry budget with a persisted quota artifact, while controlled writes have
deterministic path-depth and cumulative attempt caps. Utility artifacts identify
the satisfying domain and bounded content hash; target synthetic-path state is
observed before tmpfs cleanup. Preflight persists and hashes the validated
scenario and target config used by the run. The core execution path is
unchanged.

## Two-case-study evidence

The paired end-to-end check currently verifies for these two cases:

- The official `@modelcontextprotocol/server-filesystem@2026.7.10` package can be acquired, statically inspected, installed both ways, initialized, and exercised with `read_text_file` and `write_file`. Expected read/write events are linked to the correct tool phases and raw traces, the interface/source/runtime/scope comparison aligns for both tools, the read leaves state unchanged, and the write produces a linked durable created-file delta. Its checked-in representative report has no deterministic finding.
- The local deceptive MCP passes through the same pipeline. Its representative report, [`examples/reports/deceptive-control.report.json`](examples/reports/deceptive-control.report.json), produces exactly five deterministic findings: high-confidence initialization-sensitive access; file-scope, child-process, and network violations; and medium-confidence tool-originated post-return activity. Its install delta also reveals the controlled postinstall process, synthetic canary read, and marker write. The four-way comparison shows advertised filesystem behavior but no bounded positive process/network claim, while runtime observes both outside operator scope.
- The verifier checks that both run manifests record the same resolved immutable observer image ID and that selected case-study identifiers do not appear in core source/container code.

This is meaningful evidence against direct case-specific branching. It is not enough to claim that every Node MCP, package layout, or behavior is supported.

## Verification gate

Run from the repository root with Docker available:

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run verify:e2e
npm run verify:agent
```

`npm run verify:e2e` builds the CLI, runs both full analyses, validates positive and negative evidence, checks exact npm provenance, acquisition/install completion, phase-scoped counts, claim-reference resolution, all cells of the four-way comparison, linked before/after/delta artifacts, immutable observer-image identity, and verified cleanup.

`npm run verify:agent` uses a deterministic scripted provider and the poisoned
metadata fixture to verify policy modes, synthetic effects, provider-data
isolation, and cleanup without an API key. It does not run the clean sibling or
a live OpenRouter request.

## Remaining work, in priority order

1. **Challenge generalization with an unseen third target.** Select another independently authored Node/STDIO MCP and require a configuration-only integration. Any failure should improve a generic adapter or contract, never add package/tool-name branches.
2. **Harden evidence fidelity.** Failed exec/file attempts, terminal signal exits, and bounded filesystem state deltas now have adversarial coverage. Continue with syscall-level create/rename/truncate semantics, concurrent children, timeouts, sockets, and partial-run preservation. Expand the syscall model only where a concrete blind spot justifies it.
3. **Add controlled network observation.** Route target traffic only to a synthetic local sink or proxy so Forge can safely retain bounded request metadata such as protocol, destination, method, host, and path without enabling uncontrolled Internet access or claiming visibility into encrypted traffic it did not terminate.
4. **Add missing runtime sensors.** Instrument environment-variable access, Node module loading, additional filesystem mutation forms, worker threads, and other concrete blind spots that the current focused `strace` normalizer does not model. Keep kernel-observed facts separate from any userspace instrumentation.
5. **Deepen static analysis.** Validate the semantic sink catalog on an independent corpus, discover MCP registration and handler roots, construct bounded local call graphs, and classify sensitive callsites by handler reachability. Add carefully scoped dependency-source context and source-to-sink data flow only with explicit uncertainty, truncation, and resource bounds.
6. **Improve causal attribution.** Add monotonic request boundaries, complete descendant-process lineage, and matched no-tool control experiments before considering an optional Node probe that carries invocation IDs through asynchronous work. Preserve the distinction between a kernel-observed event, a userspace invocation association, and causal proof.
7. **Strengthen isolation before hostile production use.** Move execution to disposable Linux workers or microVMs and put observation outside the target boundary, potentially with eBPF or another host-side sensor. Reduce the target's ability to detect, interfere with, or share privileges with the trusted observer.
8. **Expand the target corpus.** Add independently authored MCPs and adversarial cases, then expand to additional languages and transports only through generic adapters. Any failure should improve shared contracts or collection logic rather than introduce package- or tool-name branches.
9. **Extend agent evaluation.** Add result-channel prompt injection, cross-tool information flow, multiple providers/models, repeated rollouts, and statistical confidence. Continue separating model proposals, deterministic authorization, controlled execution, utility, and target runtime effects.

Multi-tool core workflows, HTML presentation, LLM explanation, and integration of standalone Agent V1 results should remain secondary to evidence correctness, causal honesty, and isolation.

## Honest scope limits

- Node.js only; Linux/Docker only; MCP STDIO only; exact npm package or local-directory sources only.
- Focused `strace` syscall coverage, not complete kernel telemetry or decrypted payload capture.
- Bounded lexical Node source inspection plus a separate modeled semantic-callsite sidecar, not whole-program reachability, dependency-source review, or taint/data-flow analysis.
- Hand-authored initialization/tool experiments only; workflow execution is not wired into analysis.
- No HTML report or LLM interpretation. Agent rollouts are implemented only as a separate supplementary V1 and are not part of core findings or admission decisions.
- No production VM/microVM boundary, out-of-container observer, or eBPF implementation.
- The four-way comparison covers selected capabilities and inputs; bounded claim/source absence and runtime non-observation are not whole-program reachability or a safety verdict.
- A clean selected-input report means “no covered mismatch observed,” never “safe.”
