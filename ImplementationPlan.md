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
  -> raw MCP and operating-system evidence
  -> normalized events and phase attribution
  -> phase-scoped runtime summary and bounded static/runtime comparison
  -> deterministic runtime findings
  -> report.json
```

The system is tested as a reusable pipeline, not as a detector written around one fixture. The real case study and deceptive control use the same observer image, contracts, target preparation, normalizer, correlator, rules, and report generator. Each run records the resolved immutable Docker image ID; only target YAML and target artifacts differ between the cases.

## README completion gate

The README's “What done looks like” list remains the acceptance gate.

| README outcome | Current status | Evidence and boundary |
| --- | --- | --- |
| Point Forge at a real local MCP and return a concrete report | Complete for the scoped prototype | The pinned official Filesystem MCP is acquired from npm and executed locally; a sanitized representative report is [`examples/reports/official-filesystem.report.json`](examples/reports/official-filesystem.report.json). |
| Useful static analysis of tools, inputs, dependencies, and source behavior | Complete within a focused Node scope | Forge preserves exact package provenance; parses manifest claims, entrypoints, scripts, dependency counts, and available lock metadata; and emits evidence-linked lexical source capability signals. MCP tool descriptions and input schemas are discovered during the controlled MCP handshake rather than inferred statically. |
| Observe initialization and one or more tool calls | Complete | Each initialization/tool input runs in a fresh container. Forge records MCP messages plus process, file, and socket evidence through the tool's cooldown. The Filesystem case study exercises real reads and writes; the deceptive control exercises initialization-sensitive and delayed post-return behavior. |
| Connect runtime behavior to lifecycle events or specific tools | Complete for isolated experiments | The correlator records each event's active phase and infers process origin from that process's first observed event; isolated matching phases receive higher confidence. Parent/child lineage is preserved separately. Attribution remains an inference with raw references, not proof of unique causality. |
| If time permits, address agent behavior | Implemented as a separate opt-in V1 | [`AgentRolloutV1.md`](AgentRolloutV1.md) defines the methodology and implemented boundary. `forge agent-evaluate` has separate scenarios, contracts, reports, controlled tools, clean/poisoned fixtures, fake-provider tests, and a Docker-backed poisoned-fixture verifier. A canonical ordered target-field projection destined for provider function fields is hash-bound before disclosure; complete wire bytes are not. Target results remain local. It does not change `forge analyze` or `forge.report/v1`. |

The four required core outcomes are demonstrated. “Complete” here means the bounded prototype meets the README criterion, not that two runs prove universal MCP coverage or production-grade hostile-code containment.

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

Forge records manifest claims, entrypoints, install lifecycle scripts, dependency inventory, supported lockfile metadata, source coverage, and bounded evidence-linked signals for filesystem, process, network, environment, dynamic-code/module, and native-code capabilities. It retains an inspection from before lifecycle execution, then inspects and labels the exact selected runtime snapshot so static and runtime evidence cannot silently refer to different trees.

These are indicators, not verdicts. Package-authored metadata is labeled as a claim, lexical matches do not prove reachability, and dependency source is not recursively analyzed.

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

Initialization and every configured tool input start from a fresh synthetic developer profile and fresh container. The Node target communicates over STDIO through the MCP SDK. Handshake, tool discovery, invocation, and the bounded observation window are recorded as separate stages. The dedicated initialization run includes its observation window as pre-tool evidence. `strace -ff` follows processes and records the selected process, file, network, read, and write syscalls. The normalizer retains supported failed exec/file attempts and terminal signal exits when the raw trace identifies them reliably. The target runs without capabilities while the protected supervisor owns raw traces.

### 6. Normalization, attribution, and deterministic rules

The normalizer creates canonical process, file, and network events with raw
references, reconstructs parent/child lineage and file-descriptor paths, and
distinguishes Node threads from real child processes. A separate correlator
records the active lifecycle/tool phase per event and infers process origin from
that process's first observed event. Matching isolated phases raise confidence;
they do not prove unique causality.

Current policy rules compare tool effects with operator-owned expected scope for file reads/writes, child executables, and network destinations. Initialization remains backwards compatible as a boolean, but may instead carry its own expected scope; that enables deterministic checks for synthetic file access, child executables, and non-Unix network attempts before any tool call. Separate rules surface sensitive initialization access and meaningful effects from tool-originated processes after a response. Failed access attempts are described as attempts rather than completed access. The rules do not trust MCP-authored descriptions as policy.

### 7. Evidence-linked report

`report.json` combines artifact provenance, advertised MCP interface, static summary, installation outcomes/delta, experiment inputs and expectations, phase-scoped effect counts, compact expected-scope examples, deterministic findings, a bounded static/runtime capability table, evidence paths, and explicit limitations. Each positive example keeps its event ID, observed effect, attribution confidence, and raw trace reference. The comparison distinguishes found/observed, not-found/not-observed, and not-comparable states without treating agreement as proof of safety or intent. JSON/JSONL remains the primary output so deterministic code or a future LLM can consume the same facts.

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

- The official `@modelcontextprotocol/server-filesystem@2026.7.10` package can be acquired, statically inspected, installed both ways, initialized, and exercised with `read_text_file` and `write_file`. Expected read/write events are linked to the correct tool phases and raw traces, tool counts exclude initialization/cooldown noise, and the bounded comparison reports static and observed filesystem capability. Its checked-in representative report has no deterministic finding.
- The local deceptive MCP passes through the same pipeline. Its representative report, [`examples/reports/deceptive-control.report.json`](examples/reports/deceptive-control.report.json), produces exactly five deterministic findings: high-confidence initialization-sensitive access; file-scope, child-process, and network violations; and medium-confidence tool-originated post-return activity. Its install delta also reveals the controlled postinstall process, synthetic canary read, and marker write.
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

`npm run verify:e2e` builds the CLI, runs both full analyses, validates positive and negative evidence, checks exact npm provenance, acquisition/install completion, phase-scoped counts, bounded static/runtime comparison, immutable observer-image identity, and cleanup.

`npm run verify:agent` uses a deterministic scripted provider and the poisoned
metadata fixture to verify policy modes, synthetic effects, provider-data
isolation, and cleanup without an API key. It does not run the clean sibling or
a live OpenRouter request.

## Remaining work, in priority order

1. **Challenge generalization with an unseen third target.** Select another independently authored Node/STDIO MCP and require a configuration-only integration. Any failure should improve a generic adapter or contract, never add package/tool-name branches.
2. **Harden evidence fidelity.** Failed exec/file attempts and terminal signal exits now have adversarial coverage. Continue with symlinks/path changes, create/rename/truncate semantics, concurrent children, timeouts, sockets, filesystem state deltas, and partial-run preservation. Expand the syscall model only where a concrete blind spot justifies it.
3. **Deepen capability correlation.** Add entrypoint-aware reachability context and carefully scoped dependency-source signals to the existing bounded static/runtime table, without treating either side as proof of safety or intent.
4. **Improve isolation before hostile production use.** Move execution to disposable Linux workers or microVMs and put observation outside the target boundary, potentially with eBPF or another host-side sensor.
5. **Add breadth only after the core is stronger.** Multi-tool core workflows, HTML, LLM explanation, and integration of the standalone Agent V1 results remain lower priority than target generalization and evidence correctness.

## Honest scope limits

- Node.js only; Linux/Docker only; MCP STDIO only; exact npm package or local-directory sources only.
- Focused `strace` syscall coverage, not complete kernel telemetry or decrypted payload capture.
- Bounded lexical Node source inspection, not whole-program reachability, dependency-source review, or taint/data-flow analysis.
- Hand-authored initialization/tool experiments only; workflow execution is not wired into analysis.
- No HTML report or LLM interpretation. Agent rollouts are implemented only as a separate supplementary V1 and are not part of core findings or admission decisions.
- No production VM/microVM boundary, out-of-container observer, or eBPF implementation.
- The static/runtime table covers selected capabilities and inputs; it is not whole-program reachability or a safety verdict.
- A clean selected-input report means “no covered mismatch observed,” never “safe.”
