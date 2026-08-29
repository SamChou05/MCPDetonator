# Forge MCP Detonator: implementation status and next plan

## Current outcome

The core take-home prototype is implemented and verified for its stated scope: exact-version npm or local Node.js MCP packages executed over STDIO on Linux/Docker.

Forge now provides one complete evidence path:

```text
target config
  -> sandboxed acquisition and exact provenance
  -> focused static inspection
  -> scripts-disabled / scripts-enabled install comparison
  -> isolated initialization and tool experiments
  -> raw MCP and operating-system evidence
  -> normalized events and phase attribution
  -> deterministic scope findings
  -> report.json
```

The system is tested as a reusable pipeline, not as a detector written around one fixture. The real case study and deceptive control use the same observer image, contracts, target preparation, normalizer, correlator, rules, and report generator. Only their YAML configuration and artifacts differ.

## README completion gate

The README's “What done looks like” list remains the acceptance gate.

| README outcome | Current status | Evidence and boundary |
| --- | --- | --- |
| Point Forge at a real local MCP and return a concrete report | Complete for the scoped prototype | The pinned official Filesystem MCP is acquired from npm and executed locally; its latest report is [`runs/run-20260829222445-5b77885d/report.json`](runs/run-20260829222445-5b77885d/report.json). |
| Useful static analysis of tools, inputs, dependencies, and source behavior | Complete within a focused Node scope | Forge preserves exact package provenance; parses manifest claims, entrypoints, scripts, dependency counts, and available lock metadata; and emits evidence-linked lexical source capability signals. MCP tool descriptions and input schemas are discovered during the controlled MCP handshake rather than inferred statically. |
| Observe initialization and one or more tool calls | Complete | Each initialization/tool input runs in a fresh container. Forge records MCP messages plus process, file, and socket evidence. The Filesystem case study exercises real reads and writes; the deceptive control exercises hidden file, process, and network behavior. |
| Connect runtime behavior to lifecycle events or specific tools | Complete for isolated experiments | Phase timestamps and process lineage connect normalized events to initialization, install mode, or the active tool, with confidence and raw evidence references. Attribution remains an inference and records uncertainty rather than claiming perfect causality. |
| If time permits, address agent behavior | Addressed as a design proposal | [`experiments/agent/README.md`](experiments/agent/README.md) defines causal controls, repeated trials, authorization scoring, and synthetic containment, with four concrete experiment plans. Forge does not implement a rollout harness, and the proposal says so explicitly. |

The four required core outcomes are demonstrated. “Complete” here means the bounded prototype meets the README criterion, not that two runs prove universal MCP coverage or production-grade hostile-code containment.

## Implemented building blocks

### 1. Versioned target and evidence contracts

Zod validates target YAML and persisted `forge.*/v1` artifacts. Targets supply their source, generic STDIO command/arguments/cwd/environment, experiments, expected scope, and hard sandbox limits. Raw facts, attribution, and findings are separate records.

### 2. Generic npm/local target preparation

- Exact npm versions are acquired in a restricted Docker container with lifecycle scripts disabled.
- Local directories can be copied directly or dependency-installed with scripts disabled.
- Package/lock hashes, resolved npm version, registry URL/integrity, and target-tree digests are recorded.
- The prepared artifact is mounted at `/opt/target`; the observer image does not contain either case study.

### 3. Focused static Node inspection

Forge records manifest claims, entrypoints, install lifecycle scripts, dependency inventory, supported lockfile metadata, source coverage, and bounded evidence-linked signals for filesystem, process, network, environment, dynamic-code/module, and native-code capabilities. It retains an inspection from before lifecycle execution, then inspects and labels the exact selected runtime snapshot so static and runtime evidence cannot silently refer to different trees.

These are indicators, not verdicts. Package-authored metadata is labeled as a claim, lexical matches do not prove reachability, and dependency source is not recursively analyzed.

### 4. Controlled install lifecycle comparison

Fresh, otherwise equivalent Docker containers run offline `npm ci` with lifecycle scripts disabled and enabled. Both are traced, and `install/delta.json` records treatment-only and control-only process, file, and network event IDs. The scripts-enabled snapshot becomes the runtime artifact when that install completes.

Install uses `sandbox.limits.installTimeoutMs` (default 60,000 ms), separate from `sandbox.limits.timeoutMs` for MCP initialization/tool operations (10,000 ms in both checked-in targets). Failed or timed-out install experiments are recorded honestly; an incomplete pair makes the delta inconclusive.

### 5. Isolated runtime observation

Initialization and every configured tool input start from a fresh synthetic developer profile and fresh container. The Node target communicates over STDIO through the MCP SDK. `strace -ff` follows processes and records the selected process, file, network, read, and write syscalls. The target runs without capabilities while the protected supervisor owns raw traces.

### 6. Normalization, attribution, and deterministic rules

The normalizer creates canonical process, file, and network events with raw references, reconstructs parent/child lineage and file-descriptor paths, and distinguishes Node threads from real child processes. A separate correlator joins events to lifecycle/tool phases and process-origin phases.

Current policy rules compare tool effects with operator-owned expected scope for file reads/writes, child executables, and network destinations. They do not trust MCP-authored descriptions as policy.

### 7. Evidence-linked report

`report.json` combines artifact provenance, advertised MCP interface, static summary, installation outcomes/delta, experiment inputs and expectations, compact expected-scope runtime examples, deterministic findings, evidence paths, and explicit limitations. Each positive example keeps its event ID, observed effect, attribution confidence, and raw trace reference. JSON/JSONL remains the primary output so deterministic code or a future LLM can consume the same facts.

## Two-case-study proof

The paired end-to-end check currently proves:

- The official `@modelcontextprotocol/server-filesystem@2026.7.10` package can be acquired, statically inspected, installed both ways, initialized, and exercised with `read_text_file` and `write_file`. Expected read/write events are linked to the correct tool phases and raw traces. Its latest scoped report has no deterministic mismatch.
- The local deceptive MCP passes through the same pipeline. Its latest report, [`runs/run-20260829222407-5431ab14/report.json`](runs/run-20260829222407-5431ab14/report.json), produces exactly the intended three runtime findings. Its install delta also reveals the controlled postinstall process, synthetic canary read, and marker write.
- The verifier checks that both targets use the same built observer image and that selected case-study identifiers do not appear in core source/container code.

This is meaningful evidence against direct case-specific branching. It is not enough to claim that every Node MCP, package layout, or behavior is supported.

## Verification gate

Run from the repository root with Docker available:

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run verify:e2e
```

`npm run verify:e2e` builds the CLI, runs both full analyses, validates positive and negative evidence, checks exact npm provenance and install A/B completion, and verifies cleanup.

## Remaining work, in priority order

1. **Challenge generalization with an unseen third target.** Select another independently authored Node/STDIO MCP and require a configuration-only integration. Any failure should improve a generic adapter or contract, never add package/tool-name branches.
2. **Harden evidence fidelity.** Add more adversarial trace fixtures and integration cases for exec failure, symlinks/path changes, concurrent children, timeouts, signals, sockets, and partial-run preservation. Expand the syscall model only where a concrete blind spot justifies it.
3. **Strengthen static/runtime comparison.** Present where bounded source capability signals agree or disagree with observed behavior without treating either side as proof of safety or intent.
4. **Improve isolation before hostile production use.** Move execution to disposable Linux workers or microVMs and put observation outside the target boundary, potentially with eBPF or another host-side sensor.
5. **Add breadth only after the core is stronger.** Multi-tool workflows, HTML, LLM explanation, and automated agent rollouts remain unimplemented and lower priority than target generalization and evidence correctness.

## Honest scope limits

- Node.js only; Linux/Docker only; MCP STDIO only; exact npm package or local-directory sources only.
- Focused `strace` syscall coverage, not complete kernel telemetry or decrypted payload capture.
- Bounded lexical Node source inspection, not whole-program reachability, dependency-source review, or taint/data-flow analysis.
- Hand-authored initialization/tool experiments only; workflow execution is not wired into analysis.
- No HTML report, LLM interpretation, or automated agent rollout.
- No production VM/microVM boundary, out-of-container observer, or eBPF implementation.
- A clean selected-input report means “no covered mismatch observed,” never “safe.”
