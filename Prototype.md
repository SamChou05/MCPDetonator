# Forge prototype

Forge is a working, deliberately narrow detonator for locally executed Node.js
MCP servers over STDIO. It accepts either an exact-version npm package or a
local package directory, prepares it without running lifecycle scripts, and
performs focused static inspection. When preparation produces a reusable npm
cache, it compares scripts-disabled and scripts-enabled installation in fresh
sandboxes; local `install:none` targets skip that pair. It then observes the MCP
handshake, tool discovery, isolated tool calls, and their observation windows
as separate stages. The dedicated initialization experiment includes its final
observation window as activity before any tool call. The result is an
evidence-linked `report.json`.

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
manifest / dependencies / scripts / lockfile / source signals
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
raw MCP + strace -> normalized events -> phase attribution -> rules
                      + phase-scoped counts + bounded static/runtime comparison
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
- Official Filesystem MCP: [`examples/reports/official-filesystem.report.json`](examples/reports/official-filesystem.report.json). It records exact npm provenance, preserves both pre-install and selected-runtime static inspections, completes both install modes, discovers the real MCP interface, and reports phase-scoped counts for the configured `read_text_file` and `write_file` effects. Its bounded static/runtime table finds filesystem signals and observes only the expected selected filesystem behavior; it reports no deterministic finding within those inputs and rules, which is not a claim that the package is universally safe.

## Evidence directory

Each run is written below `runs/`:

```text
runs/<run-id>/
|-- run.json
|-- target.json
|-- report.json
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
|   `-- inspection.json
|-- install/
|   `-- delta.json
|-- mcp/<runtime-experiment>/interface.json
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

Some target evidence files are conditional. The primary static summary is explicitly tied to the selected runtime snapshot; the earlier inspection is retained to show the package before lifecycle scripts ran. Every normalized event contains a raw evidence reference, findings cite normalized event IDs, and attribution is stored separately from observed facts. `report.json` also includes phase-scoped effect counts, compact expected-scope examples, and a bounded source-signal/runtime-observation comparison so positive behavior is visible without hiding the complete event stream or implying intent.

## Containment model

Runtime and install experiments use disposable Docker containers with blocked networking, read-only container roots, synthetic home/workspace data, bounded CPU/memory/processes/time, `no_new_privs`, and exact label-checked cleanup. The runtime target runs as UID/GID 65534 with all target capabilities cleared and cannot write the observer-owned trace directory. Each run manifest records both the configured observer-image reference and the resolved immutable image ID.

This is useful take-home containment, not proof that arbitrary hostile code is perfectly safe. The trusted `strace` supervisor currently shares the target container. A production design should use disposable Linux workers or microVMs and place observation outside the target boundary, for example with host-side tracing or eBPF.

## Deliberate limits

- Support is currently Node.js packages on Linux, local execution over MCP STDIO, and npm or local-directory sources.
- Static inspection is bounded lexical analysis of selected Node source plus manifest, script, dependency, lockfile, and provenance metadata. It is not whole-program reachability or data-flow analysis, and dependency source under `node_modules` is not scanned.
- Runtime normalization covers a focused `strace` syscall subset for process, file, and socket behavior, including supported failed exec/file attempts and terminal signal exits. It does not reconstruct every kernel action, DNS meaning, or encrypted network payload.
- Results cover only the configured initialization and isolated tool inputs. A clean report means no covered rule mismatch was observed, not that the target is safe for every input.
- Workflow execution, HTML reporting, and LLM interpretation are not implemented in the core path. Automated Agent V1 rollouts are available separately through `forge agent-evaluate`; they do not modify this report or core analysis flow.
- This is not yet a production VM/microVM or out-of-container eBPF observer.
