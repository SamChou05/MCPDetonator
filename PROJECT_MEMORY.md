# Project memory

This is the durable coordination ledger for agents sharing this repository.
The primary/root agent owns updates. Always verify it against `git status`, the
actual diff, and the current commit before acting.

## Last synchronized baseline

- Branch: `main`
- Commit: `9fc0809` (`docs: summarize current capabilities and limitations`)
- Remote: `origin/main` at `9fc0809`
- Worktree at synchronization: only `AGENTS.md` and `PROJECT_MEMORY.md` were
  untracked; no implementation or documentation changes were pending.

Completed milestones:

- `9d10db0` hardened the generic deterministic core: acquisition cleanup,
  observer-image identity, install/static/runtime evidence separation, generic
  path/schema fixes, improved syscall coverage, controlled-fixture findings,
  and real Filesystem case-study verification.
- `ca625bb` added the separate opt-in Agent V1 evaluation harness.
- `a125bb5` hardened Agent V1 isolation, provider-data boundaries, cleanup,
  quotas, measurement, and evidence integrity.
- `e148ee7` reconciled architecture, experiments, and sanitized sample reports.
- `9fc0809` added the current plain-English capability and limitation audit.

Latest recorded full verification before this synchronization:

- `npm run typecheck`: passed.
- `npm test`: 34 files / 168 tests passed.
- `npm run build`: passed.
- `npm run verify:agent`: passed with deterministic run
  `agent-run-20260830020728-de7e2502`.
- `npm run verify:e2e`: passed with observer image
  `sha256:202b74abbbbe420a1dde24b55aee632c6801dc5ad8799b2042f0676ea2b01ee2`,
  deceptive run `runs/run-20260830013807-8daa4796`, and Filesystem run
  `runs/run-20260830013840-c9ebf039`.
- `npm audit --omit=dev`: passed with 0 vulnerabilities.

Generated `runs/`, `agent-runs/`, build output, and dependencies are ignored
and are not durable source artifacts.

## Durable product decisions

- The deterministic core is the primary product path for the current work.
- Core scope remains exact-version npm or local Node.js MCPs over STDIO in a
  Linux Docker environment.
- The real direct-runtime case study is the pinned official Filesystem MCP; the
  deceptive local MCP is a controlled negative case.
- Core implementation must remain target- and tool-name independent.
- Raw evidence, canonical events, attribution, deterministic findings, report
  interpretation, and authorization remain separate layers.
- MCP metadata and static signals are untrusted evidence, not authorization or
  proof of intent.
- A clean selected-input report never means universally safe.
- Agent V1 remains supplementary and separate; deterministic-core work must not
  depend on a model provider or agent scoring.
- Never read, stage, or commit `keys.md` or real credentials.
- Local-only personal notes `justforme.md` and `open_thoughts.md` remain excluded
  and must not be staged.

## Planned deterministic-core correctness wave

Requested: 2026-08-29

- Starting commit: `d5c8920` (`chore: add repository collaboration ledger`)
- Starting worktree: clean immediately before recording this wave; this ledger
  update is the only planned pre-delegation dirty path.
- Ownership: root owns shared contracts, report integration, sample targets,
  this ledger, Git coordination, and final verification. Parallel agents receive
  disjoint observer, lifecycle/attribution, and initialization-policy scopes.
- Status: **reconciled and verified; ready for the primary-agent commit**.

Goal: improve the deterministic core before expanding agent behavior work.

Completed first milestone:

1. Challenge and harden process/filesystem trace normalization, including
   failed exec, access, and mutation-attempt evidence where the raw observer
   already provides reliable facts.
2. Separate and improve lifecycle attribution around startup, handshake/tool
   discovery, tool execution, and cooldown without claiming unique causality.
3. Add operator-authored initialization scope and deterministic checks while
   preserving backwards-compatible target configurations.
4. Keep contracts, reports, sample targets, and adversarial tests synchronized.
5. Run focused checks, then `npm run typecheck`, `npm test`, `npm run build`, and
   `npm run verify:e2e` because this wave changes core observation and reports.

Handoffs reconciled:

- Trace fidelity: failed `execve`, supported file access/mutation attempts, and
  terminal signal exits now normalize with raw evidence references. Conventional
  errno syntax is required; `execveat`, unfinished/resumed syscalls, and unknown
  relative paths remain future coverage.
- Lifecycle/attribution: handshake, tool discovery, invocation, and observation
  window are separate staged phases. Earliest process evidence is selected by
  timestamp/sequence, boundary phases prefer the later stage, and
  initialization-origin activity during a tool call is explicitly labeled as
  temporal overlap rather than causal proof.
- Initialization policy: boolean configurations remain compatible; object form
  supplies expected scope. Deterministic initialization findings cover
  synthetic file reads/writes, successful child execs, non-Unix connections,
  credentials, and the full baseline pre-tool observation window without
  duplicating credential findings.
- Root integration: initialization observations aggregate all staged phases and
  the baseline observation window, expose a per-phase breakdown, persist the
  optional expected scope in the report, distinguish failed attempts from
  successful expected-scope examples, and exercise object-form scope in both
  core targets.

Verification for this milestone:

- `npm run typecheck`: passed.
- `npm test`: 35 files / 177 tests passed.
- `npm run build`: passed.
- `npm run verify:e2e`: passed.
  - Observer image:
    `sha256:e6f3b8b050d710b101a43e1f94dea88705821ad1ee2d1ac80a2a06bf4f24aac8`
  - Deceptive run: `runs/run-20260830042121-1cf74127`
  - Filesystem run: `runs/run-20260830042154-f10c24fd`
- `git diff --check`: passed; rerun at the staging gate.

Suggested commit subject: `feat: harden deterministic lifecycle evidence`.

Later deterministic-core milestones remain: pre/post filesystem state evidence,
claimed/static/observed/approved comparison, controlled network request
capture, environment and Node module-load sensors, generated input/workflow
coverage, a third independent target, and stronger out-of-container isolation.

## Synchronization checklist

1. Before parallel work, record the starting commit and dirty-worktree state.
2. Give each editing agent a disjoint file scope; agents never edit this ledger.
3. Wait for every editing agent to finish before staging or committing.
4. Compare handoffs with `git status` and path-scoped diffs.
5. Run focused checks and the required shared verification gates.
6. Stage reviewed paths explicitly; never use `git add .` or `git add -A`.
7. Inspect `git diff --cached --stat`, `git diff --cached`, and
   `git diff --cached --check` before committing.
8. Record the completed milestone and commit hash here.
