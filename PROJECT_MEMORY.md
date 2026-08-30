# Project memory

This is the durable coordination ledger for agents sharing this repository.
The primary/root agent owns updates. Always verify it against `git status`, the
actual diff, and the current commit before acting.

## Last synchronized baseline

- Branch: `main`
- Commit: `c62f862` (`feat: harden deterministic lifecycle evidence`)
- Remote: `origin/main` at `9fc0809`
- Worktree at synchronization: clean.

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
- `c62f862` added staged initialization lifecycle evidence, more honest process
  attribution, supported failed syscall evidence, terminal signal exits, and
  operator-authored initialization scope.

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

## Completed deterministic-core lifecycle wave

Requested: 2026-08-29

- Starting commit: `d5c8920` (`chore: add repository collaboration ledger`)
- Starting worktree: clean immediately before recording this wave; this ledger
  update is the only planned pre-delegation dirty path.
- Ownership: root owns shared contracts, report integration, sample targets,
  this ledger, Git coordination, and final verification. Parallel agents receive
  disjoint observer, lifecycle/attribution, and initialization-policy scopes.
- Completed commit: `c62f862` (`feat: harden deterministic lifecycle evidence`).

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

## Active deterministic-core state and comparison wave

Requested: 2026-08-29

- Starting commit: `c62f862` (`feat: harden deterministic lifecycle evidence`)
- Starting worktree: clean immediately before recording this wave; this ledger
  update is the only planned pre-delegation dirty path.
- Ownership: root owns shared contracts, analysis/report integration, fixtures,
  documentation, this ledger, Git coordination, and final verification.
  Parallel agents own disjoint filesystem-state, MCP-interface-claim, and
  comparison-design scopes.
- Status: **reconciled, independently audited, and verified; ready for the
  primary-agent commit**.

A final adversarial review reopened this wave before commit. Its independent
behavior, claim/catalog, and filesystem audits are complete, all identified
integrity gaps were resolved, and every editing agent finished before final
staging. Root retained ownership of catalog bounds, report-envelope integrity,
shared contracts, documentation, Git coordination, and final verification.

Goals:

1. Capture bounded before/after state for each isolated synthetic home and
   workspace without intentionally following entries observed as stationary
   symlinks, disclose pathname-replacement races, and persist experiment-level
   created/modified/deleted deltas without pretending they identify one process
   or source line.
2. Preserve and deterministically classify bounded claims from advertised tool
   names, descriptions, schemas, and MCP annotations as untrusted evidence.
3. Compare advertised claims, package-source signals, selected runtime effects,
   and operator-authored scope without conflating claims with authorization.
4. Link report summaries back to raw trace and filesystem-state artifacts, add
   adversarial tests, and run the full core verification gate.

Handoffs reconciled:

- Filesystem state: each isolated runtime experiment now records validated,
  bounded before/after snapshots plus created/modified/deleted/type-changed
  deltas. Capture does not intentionally follow entries observed as stationary
  symlinks, but the `lstat`-to-pathname-open replacement race is explicitly
  disclosed. Per-file work, aggregate visited entries/hash bytes/issues, depth,
  directory width, and best-effort elapsed time are bounded and explicit.
  Diffs require identical capture limits and make experiment-only attribution,
  unsafe metadata, and incomplete/zero-change semantics explicit.
- Advertised claims: names, titles, descriptions, and schemas receive bounded
  positive lexical classification for filesystem/network/process capabilities;
  standard annotations remain separate evidence. Exact JSON pointers, bounded
  excerpts, truncations, common negation, wide-object limits, and stable
  per-experiment claim IDs have adversarial coverage.
- Four-way comparison: every enabled initialization/tool experiment separates
  advertised claims, package-source signals, selected runtime events, and
  operator scope. Runtime IDs are partitioned inside/outside/unclassified, and
  tool-phase temporal-overlap IDs preserve correlation uncertainty. Failed
  attempts are retained; root execs, Unix sockets, and non-profile filesystem
  activity remain excluded by documented rules.
- Root integration: report contracts enforce row/partition invariants, preserve
  interface titles/annotations, disclose the source interface and cross-run
  catalog drift/duplicate names, link claim/state artifacts, summarize bounded
  state changes, and treat deletes as write-scope mutations. Runtime-container
  cleanup now verifies label ownership and repeated absence before host state
  scanning, failing closed on ambiguous Docker errors.
- Review hardening: filesystem capture received aggregate-work and compatible-
  limit checks; behavior correlation gained machine-readable qualifiers; the
  legacy comparison now includes failed child-exec attempts consistently; claim
  excerpts cannot name terms absent from the excerpt; wide schemas no longer
  defeat the advertised node bound; repeated delete examples deduplicate.
- Post-review identity and scope hardening: absolute operator paths are
  canonicalized before comparison, internal experiment IDs are reserved,
  process references are experiment-scoped, and `not_observed` is distinct from
  an assessed `not_claimed` result.
- Post-review catalog and claim hardening: MCP catalogs fail closed under
  explicit tool/depth/node/key/string bounds and carry both order-independent
  drift hashes and order-sensitive source hashes. Claim truncation drops partial
  tokens, common contractions are recognized, and nested counts, IDs, pointers,
  limits, coverage, annotations, issues, and truncations are cross-validated.
- Post-review acquisition hardening: tool discovery now requests raw
  `tools/list` data and iteratively bounds the complete result before MCP shape
  validation, avoiding SDK output-schema compilation ahead of Forge's limits.
  Every JSON-RPC message is bounded and cloned before recording; per-message,
  transcript-count, transcript-byte, and stderr quotas fail closed, and
  recorder or cleanup failures propagate without replacing an earlier primary
  error. Output schemas and other unretained MCP metadata remain outside the
  retained interface, claim extraction, and catalog fingerprints.
- Post-review envelope hardening: report contracts require exact reverse
  coverage for claim and static evidence, unique run/experiment/finding identity,
  catalog provenance, operator-scope agreement, selected runtime-snapshot
  equality, and an actual first-observed source interface. Mutation tests cover
  erased evidence, reordered catalogs, stale provenance, ghost interfaces,
  miscounts, changed snapshots, and source-selection substitution.
- Final contract and sample hardening: legacy static/runtime process identity is
  experiment-scoped; its rows, states, IDs, and static-evidence links have exact
  reverse-coverage checks. Claim evidence quotas are contract-enforced. The E2E
  verifier now checks every behavior row and linked state artifact before its
  case-specific assertions. Sample refresh validates schemas, completed run and
  target identity, manifest-bound report hashes, run-root containment, and one
  immutable observer identity before same-directory atomic per-file replacement.
  A multi-file sample refresh is not crash-atomic as one transaction.

Verification for this milestone:

- `npm run typecheck`: passed.
- `npm test`: 46 files / 261 tests passed.
- `npm run build`: passed as part of the final end-to-end gate.
- `npm run verify:e2e`: passed.
  - Observer image:
    `sha256:fa7345f9cae96c06bfc120236f19177cd160c826b00e73fae79e42a96c1cf3df`
  - Deceptive run: `runs/run-20260830060508-bb4e84ee`
  - Filesystem run: `runs/run-20260830060540-a345a4d7`
- Sanitized sample reports were refreshed from those exact final runs; a second
  refresh produced identical hashes and the current contract tests passed.
- `git diff --check`: passed; rerun at the staged review gate.

Suggested commit subject: `feat: correlate deterministic behavior evidence`.

Later deterministic-core milestones remain: controlled network request
metadata capture, environment and Node module-load sensors, generated
input/workflow coverage, a third independent target, partial-run preservation,
stronger out-of-container isolation, analysis/fingerprinting of output schemas
and other currently unretained MCP metadata, and deeper semantic binding between
advertised claim evidence and its source tool/catalog.

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
