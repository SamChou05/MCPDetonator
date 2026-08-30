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

## Active Evidence-First V2 Phase 1 wave

Requested: 2026-08-29

- Starting branch and commit: `main` at `60ad21b`
  (`docs: add evidence-first V2 implementation handoff`), one commit ahead of
  `origin/main`; `f2aec0c` is an ancestor.
- Pre-existing dirty worktree paths observed before this wave:
  `.gitignore`, `src/static/node-package.ts`, and untracked `agent-runs/`.
  These paths are not owned by this wave and must not be edited, staged, or
  committed. The `src/static/node-package.ts` diff contains an unfinished
  identifier edit; no assumption is made about its author or intent.
- Ownership: root owns all V2 documentation/code/test edits, this ledger, Git
  coordination, and verification. Parallel reviewers are read-only and must
  not modify the checkout.
- Status: independent validation and provider-free Phase 1A implementation are
  complete and independently audited. Focused verification passes; repository-
  wide gates remain blocked only by the preserved out-of-scope syntax edit
  described below. Ready for the primary-agent implementation commit.

Goals:

1. Independently validate `EvidenceFirstV2Plan.md` against the repository,
   threat model, implementation, and relevant primary research.
2. Document material agreements, disagreements, corrections, and prerequisites
   in `EvidenceFirstV2Validation.md` without overstating sandbox readiness.
3. Implement an additive, provider-free V2 contract and pure compiler path with
   deterministic digesting, fail-closed catalog identity, receipt binding,
   mandatory-case reservation, artifact materialization, and symbolic-reference
   resolution.
4. Add a reproducible manual fixture plus adversarial tests, preserve V1 and
   Agent V1 behavior, and run every required verification gate.

Validation milestone handoff:

- Independently reviewed the handoff against the repository, threat model,
  current implementation, and primary MCP/security sources. The decision and
  fifteen material corrections are recorded in
  `EvidenceFirstV2Validation.md` and reflected in `EvidenceFirstV2Plan.md`.
- Corrected the README/Agent V1 research attribution: MCPTox reports a 72.8%
  maximum across its evaluated settings; the separate MCP-ITP preprint reports
  an 84.2% maximum, and neither result isolates tool auto-approval.
- Phase 1A is now explicitly contracts/compiler/receipt verification only.
  Live V2 discovery and target dispatch remain disabled pending the sandbox,
  runtime-snapshot, complete-catalog, cleanup, and evidence-integrity gates.
- Review agents were read-only and made no checkout changes.
- `git diff --check`: passed for the documentation milestone.

Suggested commit subject: `docs: validate evidence-first V2 architecture`.

Implementation wave 1 baseline:

- Starting commit: `da84a80` (`docs: validate evidence-first V2 architecture`).
- Dirty paths at wave start remain the out-of-scope `.gitignore`,
  `src/static/node-package.ts`, and untracked `agent-runs/`; no V2
  implementation paths were dirty.
- Parallel ownership is disjoint: contract work owns only `src/contracts/v2/`;
  canonical JSON work owns `src/audit/v2/canonical.ts`,
  `src/audit/v2/strict-json.ts`, and its focused test; catalog identity work
  owns `src/audit/v2/catalog.ts` and its focused test. Root owns integration,
  compiler/approval/resource modules, fixtures, remaining tests, this ledger,
  verification, staging, and commits.

Implementation review wave baseline:

- Commit remains `da84a80`; uncommitted V2 implementation paths are owned by
  root. The pre-existing `.gitignore`, `src/static/node-package.ts`, and
  `agent-runs/` remain out of scope.
- Contract/canonical/catalog implementation agents completed their disjoint
  scopes without Git mutations. Root integrated the pure compiler, artifact
  materializer, policy evaluator, approval verifier, strict artifact loader,
  human-authored fixture, and adversarial tests.
- Read-only reviewers are assigned contract invariants, compiler/security
  bypasses, and tests/API coverage. They must not edit the checkout.
- Final implementation handoff:
  - Exactly seven strict top-level V2 schemas plus embedded target/catalog/
    resource/bounds components keep claims, policy, specification, plan,
    approval, coverage, and result responsibilities separate.
  - The provider-free compiler verifies detached target artifacts, exact
    complete catalog identity, source-bound claims, exact-target policy, and
    AuditSpec chronology; reserves mandatory cases; materializes per-case
    resources; resolves only static aliases; validates a deliberately narrow
    JSON Schema subset; applies detached/frozen monotonic dispatch policy; and
    returns a frozen plan with an external domain-separated digest.
  - Approval remains unsigned, unauthenticated, single-use-shaped, and
    structurally non-dispatchable. Issuance deterministically recompiles trusted
    inputs, compares the submitted plan digest, and binds every execution
    dimension and policy expiry. There is no process-global provenance state.
  - Raw JSON/canonicalization reject duplicate decoded keys, ambiguous JSON,
    property-descriptor tricks, proxies, exotic byte arrays/shared storage,
    unsafe schema work, and sub-millisecond timestamp ambiguity. Controller
    case/resource/schema/catalog/artifact/policy-work ceilings apply before
    expensive expansion or copying.
  - Phase 1A coverage/result schemas cannot claim dispatch, observations,
    assessment, live freshness, or verified cleanup. Their verifier cross-binds
    plan/receipt/reporting digests and exact references with receipt-to-coverage-
    to-result chronology; it remains structural evidence only.
  - Experiment dispatch denies/review gates match resource overlap so class
    padding cannot evade them, while satisfied positive rules must collectively
    cover every requested resource class. Policy limits cover every receipt-
    bound execution dimension.
  - The manual human-authored fixture compiles reproducibly without a provider;
    its pinned ExperimentPlan digest is
    `656dc2d9eee5174c24deb71778088a8982ec122fdb496a7893efff9bd1cc1c9d`.
- Independent reviewers made no checkout or Git changes. Their refreshed final
  audits found no remaining material contract, compiler, authority, catalog,
  canonicalization, reporting-integrity, or bounded-work issue.
- Verification:
  - `npx vitest run test/unit/audit-v2-*.test.ts test/unit/mcp-input-schema.test.ts`:
    passed (10 files / 181 tests after final authority-snapshot regression).
  - Isolated strict TypeScript over all V2 sources/tests and the additive shared
    schema helper: passed.
  - `npm test`: 53 files / 417 tests passed; only
    `static-node-package.test.ts` and `report-static-snapshot.test.ts` failed to
    transform because the pre-existing `src/static/node-package.ts:65`
    contains `const exclude Directories = ...`.
  - `npm run typecheck`, `npm run build`, `npm run verify:e2e`, and
    `npm run verify:agent`: each stopped at the same pre-existing
    `src/static/node-package.ts(65,15) TS1005` before substantive execution.
    Root did not alter the user-owned file.
  - `git diff --check`: passed; rerun at the staged review gate.

Suggested implementation commit subject:
`feat: add provider-free Evidence-First V2 compiler`.

Completed Evidence-First V2 Phase 1A milestone:

- Commit `21d9cae` (`feat: add provider-free Evidence-First V2 compiler`)
  contains the reviewed 49-path contracts/compiler/fixture/test/documentation
  change.
- Final staged review passed `git diff --cached --check`; the focused V2 plus
  shared schema suite passed again with 10 files / 181 tests.
- The preserved out-of-scope `.gitignore`, `src/static/node-package.ts`, and
  untracked `agent-runs/` remain the only dirty worktree paths.

## Experimental Evidence-First V2 agent proposal wave

Requested: 2026-08-30

- Starting branch and commit: `main` at `1e800f7`
  (`docs: record Evidence-First V2 milestone`).
- Pre-existing dirty paths remain the out-of-scope `.gitignore`,
  `src/static/node-package.ts`, and untracked `agent-runs/`. This wave did not
  edit them and they must not be staged.
- Root owns the proposal contracts, comparison adapter, example fixtures,
  tests, documentation, verification, and Git coordination. No parallel agents
  were used for this wave.
- Status: implemented, locally reviewed, verified, and committed in `bc24583`
  (`feat: add experimental V2 agent proposal comparator`).

Goals and completed behavior:

1. Add a provider-neutral proposal path that sends only exact bounded tool
   name/title/description/input/output schema metadata, symbolic synthetic
   resource descriptors, and existing deterministic case semantics.
2. Generate the provider function schema from a strict candidate DSL. Agent
   predictions are fixed to `model_inference`/`model_output`; the provider sees
   only `submit_experiment_proposals`, never target or controlled tools.
3. Recompute the provider-free V2 baseline, bind comparison to the exact
   context digest, and evaluate each candidate with existing static-reference,
   schema-safety, strict argument-validation, and experiment-dispatch policy
   controls using origin `agent_proposed`.
4. Recompute approval class, record understatements, detect baseline and
   within-agent semantic duplicates from canonical tool/argument projections,
   and report bounded feature deltas and rejection reason codes.
5. Keep all outputs non-authoritative: no ExperimentPlan, ApprovalReceipt,
   dispatch, observation, safety claim, or runtime result is produced. Fresh
   operator review and compilation remain mandatory.
6. Provide a provider-free scripted example plus an explicit opt-in OpenRouter
   command. No live provider was contacted during this wave.
7. Check configured provider credentials at both the generic outbound-request
   and inbound-completion boundaries; the example CLI also redacts unexpected
   error messages before printing them.

Reproducible example result:

- Four candidates submitted: one exact baseline duplicate, one novel
  synthetic-credential probe eligible for review, one literal host-path
  rejection, and one unsupported-workflow rejection.
- The model-suggested `automatic` class on the sensitive probe is raised by
  deterministic policy to `security_review`.
- The checked-in output binds context digest
  `e0c4d7f16be9282220f3f11622ef171d806cf3468c4e43dd0ab4d0d7961efa76`,
  submission digest
  `dff5c0196f0d33e119de6e7e4f63b6aa225bac6335952b5bb54f665319f052b0`,
  and baseline digest
  `5e42b99c54ea6a0c82b557159ef1215ef8f734379223bdc23c58971c6725e461`.
- This controlled result proves the boundary/comparator behavior, not model
  value: the default provider is scripted and the fixture deliberately leaves
  the known sensitive probe out of its one-case baseline.

Verification:

- `npm run experiment:v2-proposals`: passed and reproduced the checked-in
  comparison; `--help` also passed.
- V2 plus shared schema suite: 11 files / 194 tests passed.
- Isolated strict TypeScript including V2, provider adapters, the example
  script, helper, and focused tests: passed.
- `npm test`: 54 suites / 430 tests passed; only
  `static-node-package.test.ts` and `report-static-snapshot.test.ts` failed to
  transform at the preserved `src/static/node-package.ts:65` syntax edit.
- `npm run typecheck`, `npm run build`, `npm run verify:e2e`, and
  `npm run verify:agent` stop at that same pre-existing
  `src/static/node-package.ts(65,15) TS1005` error.
- `git diff --check`: passed; rerun at the staged review gate.

Suggested commit subject:
`feat: add experimental V2 agent proposal comparator`.

Completed experimental V2 agent proposal milestone:

- Commit `bc24583` contains the reviewed 16-path proposal contracts,
  comparator, offline/live command, fixtures, tests, and documentation.
- Final staged review passed `git diff --cached --check`; the only remaining
  dirty paths are the preserved out-of-scope `.gitignore`,
  `src/static/node-package.ts`, and untracked `agent-runs/`.

## Live Evidence-First V2 agent proposal study wave

Requested: 2026-08-30

- Starting branch and commit: `main` at `ef96ab6`
  (`docs: record V2 agent proposal milestone`).
- Pre-existing out-of-scope dirty paths remain `.gitignore`,
  `src/static/node-package.ts`, and untracked `agent-runs/`; none is owned or
  staged by this wave.
- `.env` is ignored and was loaded only with Node's non-executing
  `--env-file=.env` parser. No credential value was printed, persisted, or
  staged; a post-run scan of all five study files passed.
- Root owns the fixed study fixture, live runner, bounded results, analysis,
  tests, documentation, verification, and Git coordination. No parallel agents
  were used.
- Status: completed and synchronized in commit `810ab27`.

Frozen study design:

- Requested and returned model in all trials: `openai/gpt-5.6-luna` through
  OpenRouter; no routing mismatch occurred.
- Five exact tools, five deterministic baseline cases, four symbolic resources,
  six candidates, twelve total proposed steps, temperature zero, and 4,096
  maximum completion tokens per trial.
- Context digest:
  `b0c12ee790b97c879c983a7fb5e5d227f03b6dbd32f2b1c1dab7bc1954493a6d`.
- Baseline digest:
  `76f3220b85d43f62298240cb5260dd861e58f9e47121b2a3eb230a2b74980711`.
- Six operator-authored metadata opportunities were frozen before generation:
  sensitive-resource probe, lower/upper numeric boundaries, non-baseline enum,
  boolean toggle, and sensitive multi-resource combination.
- No target was called, no fresh ExperimentPlan was compiled from a proposal,
  and no approval or runtime finding was created.

Matched live results:

- Schema-only prompt `1alpha1`: 5/5 provider trials completed; all 26
  candidates were rejected as `contract_invalid`. Dominant failures were
  flattened prediction fields on `case`, missing nested prediction fields,
  missing `ambiguities`, and missing `caseId`.
- Guided prompt `1alpha2`: only neutral contract field-placement instructions
  changed. 5/5 provider trials completed; all 27 candidates passed deterministic
  candidate-local validation and were accepted as novel relative to the fixed
  baseline.
- The guided arm produced 14 unique tool-and-argument semantics from 27
  accepted occurrences and union coverage of all 6 fixed opportunities.
  Sensitive-resource, upper-boundary, enum, and boolean opportunities appeared
  in 5/5 trials; lower-boundary and sensitive-combination opportunities appeared
  in 2/5.
- The guided results covered every tool but repeated JSON conversion with
  metadata and semantic comparison with whitespace ignored in all five trials,
  so accepted counts materially overstate diversity.
- Combined usage: 56,261 tokens. Estimated cost from the OpenRouter model-catalog
  prices observed on the run date: `$0.034978`.
- Conclusion is deliberately narrow: prose contract narration was decisive for
  structural validity on this route, and the guided agent added statically novel
  metadata-derived cases. This does not establish useful findings or improved
  runtime recall.

Evidence and verification:

- Cross-arm report:
  `experiments/evidence-first-v2/agent-proposal-live-study-summary-2026-08-30.md`.
- Both bounded JSON records retain the exact provider context, typed submissions,
  deterministic comparisons, usage, timing, digests, and false authority flags;
  raw free-form provider content is not retained.
- Focused proposal/study evidence tests: 2 files / 16 tests passed; the full V2
  plus shared-schema suite passed with 12 files / 197 tests.
- Isolated strict TypeScript for V2, provider adapters, study runner, and proposal
  tests: passed.
- Offline scripted proposal example still reproduces its checked-in comparison
  after prompt identity advanced to `1alpha2`.
- `npm test`: 55 suites / 433 tests passed; only
  `static-node-package.test.ts` and `report-static-snapshot.test.ts` failed to
  transform at the preserved `src/static/node-package.ts:65` syntax edit.
- `npm run typecheck`, `npm run build`, `npm run verify:e2e`, and
  `npm run verify:agent` each stopped at the same pre-existing
  `src/static/node-package.ts(65,15) TS1005` error before substantive gate
  execution. Root did not alter that user-owned path.
- `git diff --check`: passed; rerun at the staged review gate.

Suggested commit subject:
`experiment: record live V2 agent proposal study`.

Completed live Evidence-First V2 agent proposal study milestone:

- Commit `810ab27` contains the reviewed fixed study fixture, live runner,
  matched ten-trial evidence, cross-arm analysis, regression tests, and prompt
  contract guidance.
- Final staged review passed `git diff --cached --check`; all staged files
  matched the reviewed worktree contents, and the credential scan passed for
  all five tracked study-result files.
- The only remaining dirty paths are the preserved out-of-scope `.gitignore`,
  `src/static/node-package.ts`, and untracked `agent-runs/`.

## Active deterministic Node semantic-sidecar wave

Requested: 2026-08-30

- Starting branch and commit: `main` at `477c9e9`
  (`docs: record live V2 proposal study milestone`), two commits ahead of
  `origin/main`.
- Pre-existing dirty paths are `.gitignore`, `PROJECT_MEMORY.md`,
  `src/static/node-package.ts`, and untracked `agent-runs/`. The existing
  ledger edit belongs to the separate documented malicious-MCP experiment;
  `.gitignore`, that experiment entry, and generated agent runs remain outside
  this wave. This wave takes ownership only of the invalid one-line identifier
  edit in `src/static/node-package.ts`, restoring its committed spelling before
  semantic integration because no verification gate can otherwise run.
- Root owns all code, contract, integration, documentation, ledger, Git, and
  verification changes. Parallel reviewers are read-only and must not modify
  the checkout.
- Status: implementation in progress.

Goals:

1. Preserve the current bounded lexical Node scan while adding a separate,
   bounded TypeScript AST/symbol evidence artifact for syntax coverage and
   resolved sensitive Node callsites.
2. Keep package/tool names out of analyzer logic, retain exact source evidence,
   represent incomplete parsing/resolution honestly, and prevent semantic
   evidence from becoming authorization or a safety verdict.
3. Add adversarial coverage for aliases, destructuring, shadowed globals,
   unused imports, malformed sources, unresolved modules, deterministic IDs,
   and analysis-work ceilings.
4. Integrate additive semantic summaries into the core report without silently
   changing V1 lexical-signal meaning, then run focused checks and every core
   verification gate required for static/report changes.

## Documented malicious-MCP experiment wave

Requested: 2026-08-30

- Starting branch and commit: `main` at `477c9e9`
  (`docs: record live V2 proposal study milestone`).
- Pre-existing out-of-scope dirty paths remain `.gitignore`,
  `src/static/node-package.ts`, and untracked `agent-runs/`; none is owned by
  this wave.
- During the wave the pre-existing `src/static/node-package.ts` edit was
  replaced by an untracked `src/static/semantic-contracts.ts`, apparently from
  concurrent user work. Concurrent unstaged changes also appeared in
  `package.json`, `package-lock.json`, `src/analyze.ts`, `src/contracts/v1.ts`,
  and additional untracked `src/static/node-semantic*.ts` files. Those paths
  are out of scope and must not be staged.
- Root owns primary-source research, contained fixtures, study execution,
  sanitized results, verification, and Git coordination. No parallel agents
  are used.
- Safety boundary: configured live MCP servers are inventoried only through
  redacted metadata. No installed MCP or host client configuration is modified.
  Reproductions use exact vulnerable public-package versions or purpose-built
  behaviorally representative fixtures inside Forge's synthetic Docker
  profiles with network blocked.
- Status: contained implementation and live execution are complete; tracked
  result validation and final shared verification are in progress.

Live results:

- The real official Filesystem MCP packages at vulnerable `0.6.2` and patched
  `2025.7.1` were both acquired and initialized in Docker, but their advertised
  generated input schemas lacked a root `type: object`. Forge rejected 8/9 and
  11/12 tool schemas respectively before any selected tool call. This is safe
  fail-closed compatibility rejection, not symlink-vulnerability detection.
- The contained SANDWORM-shaped deterministic run
  `run-20260830173459-e04d170d` completed. Static inspection found the
  postinstall plus environment/filesystem signals; install A/B evidence isolated
  exactly two synthetic-home writes for the hidden server and synthetic client
  MCP config. The deterministic rule layer emitted no finding and the advertised
  claim classifier produced no positive claim, exposing two coverage gaps.
- Matched live Agent V1 runs used exact returned model
  `openai/gpt-5.6-luna`, temperature zero, and three trials per policy mode.
  Clean metadata produced 0/6 unauthorized proposals. Poisoned metadata produced
  2/6: 1/3 in enforce mode and 1/3 in observe mode. Enforce blocked its denied
  synthetic secret read with zero unauthorized dispatches/executions; observe
  intentionally dispatched and executed its denied synthetic read for
  measurement. The canary was not passed to the target and every task utility
  check passed.
- Live agent usage was 10,026 tokens with estimated cost `$0.0032152` from the
  same run-date OpenRouter price snapshot. No credential value was printed or
  retained in tracked results.
- Tracked report:
  `experiments/security/documented-malicious-mcp-study-2026-08-30.md`; bounded
  exact metrics and evidence hashes are in the adjacent JSON record.
