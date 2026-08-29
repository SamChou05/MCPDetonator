# Forge prototype

Forge is a working, deliberately narrow detonator for locally executed Node.js MCP servers over STDIO. It accepts either an exact-version npm package or a local package directory, prepares it without running lifecycle scripts, performs focused static inspection, compares scripts-disabled and scripts-enabled installation in fresh sandboxes, and then observes initialization and isolated tool calls. The result is an evidence-linked `report.json`.

The same core pipeline is verified against two different targets:

- The pinned official `@modelcontextprotocol/server-filesystem@2026.7.10` package is the real positive case study.
- The local deceptive document MCP is a known-behavior negative control. It lets us prove that hidden file access, child execution, network attempts, and install-time behavior are visible.

Neither case study is special-cased in `src/` or `container/`; their package, command, tools, inputs, and expected scopes come from target YAML.

## Prerequisites

- Node.js 22 or newer
- Docker Desktop or a compatible Linux Docker worker
- Network access during exact-version npm acquisition

## Install and verify

From the repository root:

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run verify:e2e
```

`verify:e2e` builds Forge, rebuilds the observer image, analyzes both case studies, confirms that the same image was used, checks their expected reports and evidence links, and confirms that no managed containers remain. It also rejects selected case-study identifiers if they appear in the core `src/` or `container/` implementation.

Individual targets can be validated and analyzed directly:

```bash
npm run dev -- validate case-studies/filesystem/target.yaml
npm run dev -- analyze case-studies/filesystem/target.yaml --rebuild-image

npm run dev -- validate fixtures/deceptive-mcp/target.yaml
npm run dev -- analyze fixtures/deceptive-mcp/target.yaml
```

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
fresh install A/B sandboxes
scripts disabled             scripts enabled
                \             /
                 install delta
                      |
                      v
fresh runtime sandbox per initialization or tool experiment
                      |
                      v
raw MCP + strace -> normalized events -> phase attribution -> rules
                      |
                      v
                  report.json
```

Acquisition may use the network, but it runs in a restricted Docker container with lifecycle scripts disabled. The install A/B experiments then run offline from the captured npm cache in otherwise equivalent fresh containers. If the scripts-enabled install completes, that exact snapshot is mounted read-only for runtime experiments.

The installation experiments have a separate `sandbox.limits.installTimeoutMs` limit, defaulting to 60,000 ms. `sandbox.limits.timeoutMs` is the shorter MCP initialization/tool-call timeout; both checked-in case studies set it to 10,000 ms. This keeps a normal package installation from inheriting an unrealistically short tool timeout.

## Verified case-study results

The latest paired end-to-end verification produced:

- Deceptive control: [`runs/run-20260829222407-5431ab14/report.json`](runs/run-20260829222407-5431ab14/report.json). It reports the three intended runtime mismatches: out-of-scope credential read, unexpected child executable, and unexpected network attempt. The reused initialization process keeps those long-lived actions at medium confidence, while the child created inside the tool phase is high confidence. Its install delta also exposes the controlled postinstall execution, canary read, and marker write.
- Official Filesystem MCP: [`runs/run-20260829222445-5b77885d/report.json`](runs/run-20260829222445-5b77885d/report.json). It records exact npm provenance, preserves both pre-install and selected-runtime static inspections, completes both install modes, discovers the real MCP interface, and summarizes the configured `read_text_file` and `write_file` effects with event IDs, raw trace links, and appropriately limited confidence. It reports no mismatch within those selected experiments and rules; that is not a claim that the package is universally safe.

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

Some target evidence files are conditional. The primary static summary is explicitly tied to the selected runtime snapshot; the earlier inspection is retained to show the package before lifecycle scripts ran. Every normalized event contains a raw evidence reference, findings cite normalized event IDs, and attribution is stored separately from observed facts. `report.json` also includes compact expected-scope runtime examples so positive behavior is visible without hiding the complete event stream.

## Containment model

Runtime and install experiments use disposable Docker containers with blocked networking, read-only container roots, synthetic home/workspace data, bounded CPU/memory/processes/time, `no_new_privs`, and exact label-checked cleanup. The runtime target runs as UID/GID 65534 with all target capabilities cleared and cannot write the observer-owned trace directory.

This is useful take-home containment, not proof that arbitrary hostile code is perfectly safe. The trusted `strace` supervisor currently shares the target container. A production design should use disposable Linux workers or microVMs and place observation outside the target boundary, for example with host-side tracing or eBPF.

## Deliberate limits

- Support is currently Node.js packages on Linux, local execution over MCP STDIO, and npm or local-directory sources.
- Static inspection is bounded lexical analysis of selected Node source plus manifest, script, dependency, lockfile, and provenance metadata. It is not whole-program reachability or data-flow analysis, and dependency source under `node_modules` is not scanned.
- Runtime normalization covers a focused `strace` syscall subset for process, file, and socket behavior. It does not reconstruct every kernel action, DNS meaning, or encrypted network payload.
- Results cover only the configured initialization and isolated tool inputs. A clean report means no covered rule mismatch was observed, not that the target is safe for every input.
- Workflow execution, HTML reporting, LLM interpretation, and automated agent rollouts are not implemented.
- This is not yet a production VM/microVM or out-of-container eBPF observer.
