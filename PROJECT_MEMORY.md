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
  synthetic file reads/writes, successful child execs, network connections
  other than the two routine NSCD endpoints, credentials, and the full baseline
  pre-tool observation window without duplicating credential findings.
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
  attempts are retained; root execs, routine NSCD socket attempts, and
  non-profile filesystem activity remain excluded by documented rules.
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
- Status: **implemented, adversarially hardened, reconciled, and fully
  verified; ready for the primary-agent commit**.

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

Handoffs reconciled:

- Dependency/API correction: the installed TypeScript 7 package does not expose
  the stable classic Compiler API. Forge keeps TypeScript 7.0.2 as its build
  compiler and adds the exact runtime alias
  `typescript-semantic@npm:typescript@6.0.3`. Build/typecheck scripts name the
  TypeScript 7 binary explicitly because both packages publish a `tsc` bin. A
  production-only install smoke test confirmed TypeScript 6.0.3 and
  `createProgram` are available with development dependencies omitted.
- Analyzer boundary: `forge.node-semantic-static/v1` consumes only UTF-8 source
  artifacts admitted by the lexical scan, revalidates run/target/path/size/hash
  identity, and gives a closed deterministic virtual filesystem to a killable
  worker. Target `tsconfig`, plugins, dependencies, host paths, emit, and
  default module traversal are unavailable. File/byte/AST/callsite/diagnostic/
  module/alias/time/memory limits and completed/partial/failed states are
  explicit.
- Semantic model: a checked-in `node-sensitive-sinks/1` catalog covers selected
  filesystem, process, network, environment, dynamic-code/module, and native
  Node APIs. Direct ESM/CommonJS bindings, namespace/destructured access, static
  members, and bounded immutable aliases resolve; unused imports, locally
  shadowed globals, mutable aliases, monkey-patched namespaces, lookalike
  modules, and dynamic computed members do not fabricate positive callsites.
  IDs bind the target-relative path, source hash, exact span, catalog sink,
  operation, and capability without run/target/host identity.
- Honest first-version scope: malformed syntax, missing relative modules,
  admitted but unsupported cross-file binding flow, ceiling exhaustion,
  timeout, and worker failure cannot silently mean “no sink.” MCP-handler and
  entrypoint reachability plus source-to-sink data flow remain explicitly
  `not_assessed`; the current semantic sidecar inventories modeled callsites,
  not execution or intent.
- Integration: both pre-install and selected-runtime lexical snapshots receive
  separate semantic artifacts. The report exposes an additive semantic summary
  and SHA-256-bound evidence paths while every established lexical signal and
  four-way comparison field retains its old meaning. Report construction and
  the E2E verifier cross-check source coverage, artifact identity/digests, and
  summary partitions. Backwards-compatible report parsing leaves semantic
  fields optional for older records; newly completed analyses always emit them.
- Final adversarial hardening: content-derived callsite IDs now bind exact
  spans; handler reachability is contractually `not_assessed`; completed and
  partial status exactly reflect coverage; alias depth is independently bounded;
  literal built-in dynamic imports and TypeScript import-equals bindings are
  modeled; per-file JavaScript scope, ambient declarations, wrapped globals,
  static native imports, and `globalThis.process.env` have regressions. Mutable
  bindings and bindings affected by syntactically detected assignment/delete/
  update mutations are withheld and make evidence partial rather than yielding
  a false completed/empty result; reflective mutation remains unresolved.
  Timeout settlement waits
  for worker termination, parent preload hooks are not inherited, and the
  evidence discloses that V8 heap/stack limits are neither total-RSS limits nor
  an OS sandbox.
- Envelope/sample hardening: artifact and report contracts reject forged sink
  identities, impossible counters/statuses, duplicate truncations, and wrong
  run/target ownership. The E2E verifier compares every semantic summary field
  to the retained selected artifact and verifies both semantic artifacts against
  the manifest. The sample refresher likewise requires contained, JSON,
  byte-and-manifest-bound selected and pre-install semantic evidence before it
  publishes a report.
- Documentation and representative reports now describe and demonstrate the
  two-layer static design. The final real runs found 12 modeled callsites across
  two deceptive-control files with complete coverage, and 25 filesystem
  callsites across five official-package files. The official package is
  correctly marked partial because six admitted cross-file binding flows are
  not followed in this version; neither run truncated work.
- Concurrent synchronization: the separate malicious-MCP experiment advanced
  `main` from the recorded starting commit through `a2b0516` while this wave was
  active and committed its own ledger/fixture paths. Those changes were
  preserved. The out-of-scope `.gitignore`, generated `agent-runs/`, and later
  untracked `HardenedEvidenceInfrastructurePlan.md` remain unowned and must not
  be staged with this milestone.

Verification for this milestone:

- `npm run typecheck`: passed with TypeScript 7.0.2.
- `npm test`: 60 files / 466 tests passed.
- `npm run build`: passed, including inside the final E2E gate.
- `npm run verify:e2e`: passed.
  - Observer image:
    `sha256:83916e1adb0551d5eca7a740bf4589259e38fc03a9ea3ae9ed1e504fc6f13fe6`
  - Deceptive run: `runs/run-20260830181026-efaff1a4`
  - Filesystem run: `runs/run-20260830181057-0a5ff552`
- Sanitized sample reports were refreshed from those exact post-hardening runs;
  a second refresh produced identical hashes and the full contract suite passed.
- `npm audit --omit=dev`: passed with 0 vulnerabilities.
- Production-only local install smoke test: passed; runtime TypeScript 6.0.3
  exposed `createProgram` with development dependencies omitted.
- `git diff --check`: passed; rerun at the staged review gate.

Suggested commit subject: `feat: add bounded Node semantic callsite evidence`.

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
  `src/report.ts`, `test/unit/report-static-snapshot.test.ts`, additional
  untracked `src/static/node-semantic*.ts` files, and untracked Node semantic
  unit tests. Those paths are out of scope and must not be staged.
- Root owns primary-source research, contained fixtures, study execution,
  sanitized results, verification, and Git coordination. No parallel agents
  are used.
- Safety boundary: configured live MCP servers are inventoried only through
  redacted metadata. No installed MCP or host client configuration is modified.
  Reproductions use exact vulnerable public-package versions or purpose-built
  behaviorally representative fixtures inside Forge's synthetic Docker
  profiles with network blocked.
- Status: complete. Contained implementation, live execution, tracked result
  validation, and all required shared verification gates passed.

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

Milestones and verification:

- `f2828fe` (`test: add documented malicious MCP reproductions`) added the
  contained fixtures, exact real-package targets, fixture documentation, and
  focused validation.
- `e03bf4a` (`experiment: record documented malicious MCP study`) recorded the
  sanitized exact results and bounded regression assertions.
- From an isolated detached worktree at `e03bf4a`: `npm run typecheck` passed;
  `npm test` passed 58 files / 443 tests; `npm run build` passed;
  `npm run verify:e2e` returned `status: verified`; and
  `npm run verify:agent` returned `status: passed` with all 14 named checks
  true.

## Completed S3/Postgres run-publisher wave

Requested: 2026-08-30

- Starting branch and commit: `main` at `a2b0516`
  (`docs: record malicious MCP study milestone`).
- Baseline state was intentionally dirty because a concurrent Node semantic
  sidecar wave was active. That wave was reconciled and committed first as
  `51a473f` (`feat: add bounded Node semantic callsite evidence`), then
  hardened at the final coordination gate in `27f7deb`
  (`fix: harden semantic mutation resolution`). The
  pre-existing `.gitignore`, generated `agent-runs/`, and the unseen-MCP
  holdout paths (committed separately on `codex/unseen-mcp-holdout` and still
  untracked on `main`) remain outside this wave.
- `HardenedEvidenceInfrastructurePlan.md` began as an untracked draft and was
  explicitly adopted into this wave after the user requested the plan and then
  authorized the bounded S3/PostgreSQL implementation in parallel.
- This wave is additive. It must not alter the live `forge analyze` persistence
  path: it adds a post-run publisher for completed, locally verified bundles.
- Root owns `PROJECT_MEMORY.md`, Git coordination, dependency/CLI integration,
  orchestration, documentation, and shared verification.
- Initial parallel ownership was disjoint:
  - bundle-verification agent: `src/publish/bundle.ts` and
    `test/unit/publish-bundle.test.ts`;
  - S3 agent: `src/publish/s3.ts` and `test/unit/publish-s3.test.ts`;
  - Postgres agent: `src/publish/postgres.ts` and
    `test/unit/publish-postgres.test.ts`.
- Initial delivery boundary: verify an immutable completed run, publish
  manifest-listed artifacts to S3-compatible storage with the manifest last,
  record queryable run/artifact/finding metadata in Postgres, and make retries
  idempotent. Live event streaming, multi-tenancy, retention automation, KMS
  key administration, and cross-region replication remain follow-up work.
- Status: complete and independently reviewed. All editing agents handed off;
  three read-only adversarial passes found and drove fixes for mutable-path
  TOCTOU, checksum-less S3 retries, late Postgres validation, malformed Unicode,
  mutable published retry sets, unbounded cardinality/bytes, and unmanifested
  report evidence references. No blocking finding remains.

Implemented behavior and decisions:

- `forge analyze` is unchanged. `forge publish-run <run-directory>` is a
  separate post-run command configured through controller-only S3/PostgreSQL
  environment variables.
- Completed V1 bundles are schema/identity/path/symlink/hash verified under
  explicit count, byte, and cooperative time limits. Every report evidence
  path is cross-bound to the manifest. Artifact bytes are copied while hashed
  into private read-only anonymous snapshots, so later replacement of the run
  pathname cannot change or disclose different upload bytes.
- S3 artifacts are content addressed and conditionally created. Existing
  objects are accepted only when length, Forge digest metadata, and the service
  SHA-256 checksum all match. The exact `run.json` is the final object-store
  write and is an artifact-completeness marker, not a cross-store atomic commit.
- All deterministic S3 keys plus every value destined for PostgreSQL are
  preflighted before schema, intent, or object writes. PostgreSQL begin/finalize
  transactions have lock/statement/idle guards; inserted rows are round-trip
  checked; published retries perform a read-only exact-set comparison.
  PostgreSQL `status = 'published'` is query authority.
- The synchronous safety ceilings are 2,048 artifacts, 4,096 findings,
  256 MiB per artifact, 1 GiB total artifact bytes, five minutes of cooperative
  local verification, 60 KiB compact public metadata, bounded metadata shape,
  and four concurrent artifact uploads by default (maximum 16).
- `compose.publisher-demo.yml`, `PublisherDemo.md`, and
  `npm run verify:publisher` provide a pinned, localhost-only synthetic demo.
  The verifier uses a full UUID Compose project, exact retry, Postgres/S3 key
  cross-checks, service checksums, GET-and-hash checks for the exact manifest
  and all 19 referenced artifacts, tamper rejection, and project-scoped cleanup.
- Production work remains explicit: reliable producer/spool semantics, stable
  storage-backend identity, versioned migrations and restricted runtime roles,
  S3 request deadlines/Object Lock, cross-store reconciliation, KMS signing,
  TLS policy, tenant authorization, retention/deletion, backups, monitoring,
  failure injection, and disaster recovery.

Verification for this milestone:

- `npm run typecheck`: passed.
- Focused publisher suite: 5 files / 49 tests passed.
- `npm test`: passed in the shared worktree, 66 files / 522 tests. This count
  includes the out-of-scope untracked unseen-holdout test, which remains
  unstaged.
- `npm run build`: passed.
- `npm run verify:publisher`: passed against real pinned MinIO/PostgreSQL with
  19 artifacts, 5 findings, idempotent retry, exact remote bytes/checksums, and
  rejection before publication for a tampered second run.
- `npm run verify:e2e`: passed after publisher integration.
  - Observer image:
    `sha256:1b2156ef65e8bac8977cc86d51310a6862d337887ac3beadeb34aab403cec295`
  - Deceptive run: `runs/run-20260830191448-b42b4d30`
  - Filesystem run: `runs/run-20260830191529-705903c6`
- Review-only live PostgreSQL 16 probes passed eight-way concurrent begin and
  finalize convergence, malformed-Unicode rejection with zero rows, and the
  60 KiB client/64 KiB JSONB ceiling.
- `npm audit --omit=dev`: passed with 0 vulnerabilities.
- `git diff --check`: passed before the final staging gate.

Completed implementation commit: `9716f99`
(`feat: publish verified runs to S3 and Postgres`).

## Active static AWS dashboard wave

Requested: 2026-08-30

- Starting branch and commit: `main` at `7d904b0`
  (`docs: record publisher milestone`).
- Pre-existing out-of-scope paths are the modified `.gitignore`, generated
  untracked `agent-runs/`, and the untracked unseen-MCP holdout directory/test.
  This wave must not edit, stage, or commit them.
- User goal: build and, when a configured AWS account is available, deploy a
  shareable Forge results website; document the considered infrastructure
  designs and why the selected design fits the bounded demo.
- After clarification, the user explicitly narrowed the product to a very bare
  bones single-page report viewer. It must not grow routes, filters, accounts,
  a backend API, live database reads, raw-evidence browsing, or a frontend
  framework. Its demo value is the fast controlled-vs-official story, not a
  claim that Forge is already a hosted product.
- Selected boundary: construct a strict field-by-field public export from only
  pinned, sanitized sample reports, render a read-only static dashboard, and
  serve it from a private S3 origin through CloudFront. Canonical evidence S3 and
  PostgreSQL remain private and are not queried by the browser.
- The decision is deliberately reversible: the versioned presentation contract
  can later be produced by an authenticated API without replacing the UI.
- Root owns `PROJECT_MEMORY.md`, shared/package integration, Git coordination,
  local preview, verification, final architecture review, and any AWS account
  inspection or deployment.
- Planned parallel ownership is disjoint:
  - public-export agent: `src/dashboard/` and its focused unit test;
  - infrastructure/docs agent: `infra/aws/`, the dashboard deployment script,
    and dashboard architecture/demo documentation;
  - read-only dashboard reviewer: public-content safety, information design,
    accessibility, and architecture critique without checkout edits.
- Root exclusively owns the `dashboard/` site source, its first preview,
  package/build integration, and generated presentation artifact.
- No AWS resource should be created until the complete local artifact and
  infrastructure template pass review and verification.
- Status: implementation complete; AWS publication is pending a non-root AWS
  identity.

## Static AWS dashboard wave completion

Completed: 2026-08-30

- Implementation commit: `72260b5` (`feat: add bounded AWS results demo`).
- The presentation is a plain, script-free technical report, not a web
  application. It shows the deceptive control and official Filesystem MCP
  summaries, five controlled findings, one claims/static/runtime/scope table,
  and selected-case limitations.
- The public-export contract accepts only the two digest-pinned, schema-valid
  sample reports, extracts explicit fields, bounds all collections and strings,
  and rejects paths, URLs, controls, bidi text, malformed Unicode, and
  credential-like values.
- `npm run build:dashboard` emits exactly `index.html` and `styles.css` plus a
  private canonical manifest that binds their byte lengths and SHA-256 values.
- The AWS design is a separate private S3 origin behind CloudFront OAC. The
  deployer pins the reviewed template, checks the account and exact stack
  identity, refuses the account root user, snapshots manifest-bound files,
  uploads only two explicit keys, verifies remote metadata/checksums/bytes, and
  waits for invalidation completion.
- Architecture alternatives, cost boundaries, replacement triggers, demo
  commands, failure modes, and teardown are recorded in
  `DashboardArchitectureDecision.md` and `DashboardAwsDemo.md`.
- Independent final reviews passed with no blocking or material finding after
  the manifest-binding, exact-stack, claim-calibration, and accessibility
  fixes.
- Root verification passed: `npm run typecheck`; full `npm test` (67 files,
  539 tests); `npm run build:dashboard`; Node syntax checks for both scripts;
  focused dashboard tests (17); template digest check; local HTTP response;
  staged diff review; and `git diff --cached --check`. The infrastructure agent
  also passed `sam validate --lint` with AWS credentials/config disabled.
- AWS CLI v2 was available with Region `us-east-1`, but `aws login`
  authenticated the default profile as the AWS account root user. A real deploy
  was intentionally refused before any mutation, and the cached root login was
  removed. No AWS resource was created. Publication requires a federated or
  assumed-role profile, after which the reviewed deploy command can continue.
- Pre-existing `.gitignore`, `agent-runs/`, unseen-MCP holdout files, and their
  untracked test remained out of scope and uncommitted.

## Active publish-driven dashboard wave

Requested: 2026-08-30

- Starting branch and commit: `main` at `8182009`
  (`docs: record AWS results demo milestone`).
- Pre-existing out-of-scope paths remain the modified `.gitignore`, generated
  untracked `agent-runs/`, and the untracked unseen-MCP holdout directory/test.
  This wave must not edit, stage, or commit them.
- User goal: keep the page visually plain while making it reflect newly
  published runs instead of only the two checked-in sample report bytes.
- Product boundary: a successful explicit `publish-run` may update a strict,
  sanitized presentation snapshot. The browser must not connect to PostgreSQL
  or the canonical evidence bucket, and arbitrary run fields must not become
  public merely because they were persisted.
- Root is the sole site owner and owns all checkout edits, preview, integration,
  verification, Git coordination, and this ledger. Parallel agents are
  read-only reviewers for publisher seams, data-boundary risks, and test scope;
  they must not edit files, invoke Sites tooling, or mutate Git/AWS state.
- The implementation should reuse the existing publisher truth boundary:
  evidence S3 holds bytes, PostgreSQL `published` remains query authority, and
  dashboard refresh happens only after successful finalization. Publication
  remains valid if a later presentation refresh fails, and an identical retry
  must be able to converge the presentation.
- Status: completed; see the wave completion record below.

## Publish-driven dashboard wave completion

Completed: 2026-08-30

- Implementation commit: `783c4ed`
  (`feat: refresh dashboard from published runs`).
- `publish-run --refresh-dashboard` now keeps canonical publication unchanged,
  then stores a separate bounded projection only after PostgreSQL reports the
  exact run as `published`. Presentation failure returns a retryable partial
  failure and CLI exit code 2 without undoing the published evidence.
- `forge_dashboard_projections` stores normalized JSONB plus a canonical
  digest. Latest selection is restricted to published rows, serialized by a
  transaction-scoped advisory lock, uses the same checked-out connection to
  avoid pool starvation, rejects completion-time ambiguity, and prevents an
  older retry from replacing a newer run.
- The validated `dashboard/demo-policy-v1.json` owns the two reviewed
  target/config/source/package/experiment/scope/sandbox pins outside the
  generic engine. The stored policy ID includes a canonical SHA-256 of every
  pin, so a policy change automatically stops selecting prior-policy rows.
- The public projection omits run/target/finding/rule/event IDs, hashes, paths,
  URLs, object keys, raw evidence, report summaries, and report-authored
  finding prose. Counts and states are bounded; known rules map to fixed titles
  and unknown rules receive one generic title.
- Refresh atomically replaces the local HTML, repairs a stale private receipt
  on identical retry, keeps scratch files outside the strict two-file site
  directory, and falls back to the pinned sample for an unfilled slot. The
  browser remains script-free and has no database or evidence-bucket access.
- AWS delivery remains explicit. `--content-only` validates the exact non-root
  account/stack and two-key inventory, conditionally replaces each object by
  observed ETag, verifies remote checksums/downloaded bytes, and waits for
  CloudFront invalidation. OAC can read only `index.html` and `styles.css`;
  HTML revalidates immediately while CSS has a five-minute cache.
- The runbook now warns that the local MinIO credentials shadow real AWS
  profiles. No AWS resource was created because only an account-root identity
  was available; a federated or assumed-role identity is still required.
- Independent publisher, security, and delivery reviews completed with no
  remaining actionable high- or medium-severity finding. Their findings drove
  the lock-reader, crash-retry, policy-revocation, exact-object OAC, cache, and
  fake-AWS failure-path hardening.
- Final verification passed: `npm run typecheck`; full `npm test` (70 files,
  566 tests); `npm run build`; `npm run verify:publisher`; `npm run verify:e2e`
  with observer image
  `sha256:a1bc830e88e9b44fb524718bf20a1a64477a039dcfbb0d2b8b48c7bf11ce6774`;
  focused dashboard/publisher checks; fake-AWS success, ETag-conflict, and
  invalidation-failure tests; Node syntax checks; and `git diff --check`.
- The local page currently reflects the newest verified and published runs:
  controlled `run-20260830211145-69b02a0b` (111 artifacts, five findings) and
  reference `run-20260830211219-fe478a18` (108 artifacts, zero findings).
  Both PostgreSQL rows are `published`; the generated page contains neither
  run ID nor manifest digest and is available at `http://127.0.0.1:4173/`.
- Pre-existing `.gitignore`, `agent-runs/`, unseen-MCP holdout files, and their
  untracked test remained out of scope and must remain uncommitted.

## Active experiment-history dashboard wave

Requested: 2026-08-30

- Starting branch and commit: `main` at `c7315c9`
  (`docs: record publish-driven dashboard milestone`).
- Pre-existing out-of-scope paths remain the modified `.gitignore`, generated
  untracked `agent-runs/`, and the untracked unseen-MCP holdout directory/test.
  This wave must not edit, stage, or commit them.
- `ImplementationPlan.md` became modified by concurrent work after this wave's
  baseline was recorded. It is unrelated and must also remain unstaged and
  uncommitted by this wave.
- User goal: make the plain results page explain its update boundary and expose
  a simple selectable history of eligible published experiments rather than
  only the latest controlled/reference pair.
- Product boundary: keep a static HTML/CSS snapshot with no browser database
  connection, frontend framework, account system, or raw-evidence exposure.
  Use native HTML disclosure/navigation and a bounded recent-history query.
- Claim boundary: replace the visually prominent interpretation-limits section
  with one concise scope note; do not remove the selected-case qualification or
  turn zero findings into a universal safety claim.
- Root remains the sole site owner, editor, verifier, Git coordinator, and
  ledger writer. Parallel agents are read-only reviewers and must not edit the
  checkout, invoke Sites/hosting tools, mutate AWS, or mutate Git.
- Hosted freshness remains explicit unless this wave deliberately adds and
  verifies an authenticated AWS automation; local publication refresh and AWS
  content upload must not be described as the same event.
- Status: completed; see the wave completion record below.

## Experiment-history dashboard wave completion

Completed: 2026-08-30

- The existing `forge_dashboard_projections` store now drives one bounded
  recent-run query under the dashboard refresh lock. It selects only joined
  PostgreSQL `published` rows for the exact current policy, returns at most five
  per reviewed target, and orders deterministically by run completion,
  publication, then a private run-ID tie-breaker. No new table, public API, or
  browser database connection was added.
- The newest row per target drives the current summary; pinned samples are used
  only for an empty target group and never appear in published history. The
  stored publication timestamp is cross-checked against the schema-validated
  projection before rendering.
- The script-free page now exposes `Recent published runs` with native
  `details`/`summary` controls. The newest row for each target starts open;
  expanded rows show bounded counts, up to eight canonical findings, aggregate
  evidence, and reviewed behavioral-scope labels. Run IDs, hashes, paths, raw
  evidence, arbitrary report prose, and storage details remain absent.
- The prominent interpretation-limits section was replaced by one concise
  visible scope note. It still states that selected synthetic cases and current
  deterministic rules are not a general safety verdict or malware attribution.
- Update boundaries are now explicit in the page and runbooks: `analyze`
  uploads nothing; `publish-run` writes canonical evidence/metadata;
  `--refresh-dashboard` additionally regenerates the local website snapshot;
  and the public AWS copy changes only after a separate authenticated
  content-only deployment. No AWS resource was created or changed in this wave.
- Final verification passed: `npm run typecheck`; full `npm test` (70 files,
  568 tests); `npm run build`; `npm run verify:publisher`; focused dashboard,
  repository, export, and deploy tests; `git diff --check`; local HTTP and
  disclosure/privacy checks; and an isolated `npm run verify:e2e` with observer
  image `sha256:0121fdda09b3048b0422c63fb407e495c53087da57ad2855c8cdf76fe82b6a84`.
  An earlier E2E attempt overlapped another verifier and preserved one failed
  transport-cleanup run; the isolated rerun passed with deceptive run
  `run-20260830214124-9fd2822c` and reference run
  `run-20260830214202-f8dcb0fd`.
- The local page at `http://127.0.0.1:4173/` is refreshed from the existing
  synthetic publisher state and currently shows two published rows per target.
  Its generated HTML contains no run ID, SHA-256 digest, script, JavaScript URL,
  or former interpretation-limits heading.
- Independent data, UX, delivery, and final implementation reviews completed
  with no remaining blocking or material finding after query consolidation,
  timestamp-source, accessibility, privacy, and runbook wording fixes.
- The modified `.gitignore`, concurrent `ImplementationPlan.md`, generated
  `agent-runs/`, unseen-MCP holdout directory, and its untracked test remain
  out of scope and must remain unstaged and uncommitted.

## Active deterministic trace-coverage wave

Requested: 2026-08-30

- Starting branch and commit: `codex/trace-coverage-v1` at `7d904b0`
  (`docs: record publisher milestone`).
- Starting worktree: clean. This isolated worktree was created because the
  primary `main` worktree contains an active dashboard wave and the separate
  `/private/tmp/forge-v2-outcome.oS4qJ8` worktree contains active V2 controlled
  result-content work. Neither concurrent scope is owned by this wave.
- Goal: make the selected `strace` observation surface coverage-accounted,
  turn low-ambiguity high-value syscall families into canonical evidence, and
  represent harder policy-relevant operations as explicit coverage gaps rather
  than silently clean non-observation.
- Root owns shared contracts, analysis/report integration, this ledger, Git
  coordination, and final verification. Parallel editing scopes are disjoint:
  parser health owns `src/observe/strace-parser.ts`, the trace entrypoint, and
  a new focused parser-health test; syscall normalization owns
  `src/observe/strace-normalizer.ts` and its focused existing test. A separate
  reviewer is read-only.
- No agent may edit V2 result-content files, dashboard files, publisher files,
  or another agent's active scope. Root will not stage or commit until every
  editing agent has completed.
- Scope amendment after read-only integration review: root may make the minimal
  `src/publish/bundle.ts` evidence-reference update (plus a focused test) needed
  to require the new report-bound health artifact in completed publication
  bundles. No parallel task owns those paths; broader publisher behavior remains
  out of scope.
- Final read-only audit wave baseline: commit remains `7d904b0`; the dirty
  worktree consists only of the trace-coverage implementation and refreshed
  verified sample reports listed by `git status --short` on 2026-08-30. Audit
  agents may inspect but must not edit, stage, or commit any path.
- Scope amendments owned by root: bind health into the report, publication
  bundle, real sample refresh, E2E/publisher verifiers, directory-enumeration
  policy consumers, install comparison, compact file-operation counts, and the
  public README/limitations documents. These are direct consumers of the new
  evidence contract and no active parallel task owned the paths.

Completed behavior and handoffs:

- The parser now exactly partitions every nonempty line emitted by the selected
  filter into parsed syscall/signal-termination, recognized exit/signal-delivery
  control, unfinished, resumed, or malformed counts. It separately records
  string abbreviation, bounded raw references, and per-file terminal markers.
- The selected filter and normalizer now cover high-value descriptor, directory,
  xattr, file-transfer, legacy/uring I/O, mapping, endpoint, mutation, and
  escape/interference families. Canonical additions include `execveat`,
  directory enumeration, truncation, and correlated bind/listen evidence.
  Ambiguous return text no longer becomes false successful canonical evidence.
- Descriptor correlation distinguishes shared/copied `CLONE_FILES` tables and
  handles close, close-range/unshare/CLOEXEC, dup, fcntl duplication, and target
  reuse conservatively. The final audit added successful unresolved metadata,
  conditional O_CREAT+O_TRUNC creation, failed relevant mmap, and ordinary
  TCP/UDP descriptor I/O to explicit gap accounting.
- `observation-health.json` is schema validated and report/manifest/hash bound.
  It records the complete captured-syscall histogram, exact structural health,
  canonicalization execution/event counts, and bounded selected gap examples
  with exact category/syscall/outcome totals. Contract refinements reject
  aggregate/example, trace-detail, cross-experiment, and report/artifact
  contradictions.
- Directory enumeration remains a labeled canonical event plus an
  alternate-access gap, but deterministic read/scope/comparison/install
  consumers do not treat it as file-content proof. Additive
  `fileOperationCounts` partition compact read/write totals into content,
  directory enumeration, and truncation.
- Failed analyses retain the failed manifest and partial artifacts, best-effort
  write incomplete health, and do not synthesize a completed report. Current
  successful analyzes always include health; report V1 keeps it optional for
  legacy compatibility and publication validates it whenever present.
- Sample refresh now uses bounded FD-pinned regular-file reads, no-follow and
  containment/state checks, exact manifest rows, and health/report/event-count
  cross-binding. Its residual intermediate-component race limitation is
  documented by the handoff because Node lacks portable atomic openat traversal.
- Two independent final read-only audits reported no remaining high-severity or
  material correctness issue after the audit findings above were fixed.

Verification for this milestone:

- `npm run typecheck`: passed.
- `npm test`: passed, 67 files / 558 tests.
- `npm run build`: passed.
- `npm run verify:e2e`: passed against the deceptive fixture and official
  filesystem MCP.
  - Observer image:
    `sha256:c491d431445d2e28b03a69e81c0c46e5c7d4e49a893183694a9f52d8a35ef767`
  - Deceptive run: `runs/run-20260830214347-1b3001cf`
  - Filesystem run: `runs/run-20260830214423-2072a19a`
- Checked-in sample reports were refreshed from those exact runs. The official
  filesystem run has complete selected-surface structural integrity, completed
  canonicalization, and 57,328 selected gap records; these are coverage records,
  not findings.
- `npm run verify:publisher`: passed with 19 artifacts, 5 findings, idempotent
  retry, and rejection of tampered evidence before publication.
- Focused parser/normalizer/health/publication/sample suites, Linux filter
  acceptance, `git diff --check`, shell syntax, and JavaScript syntax checks
  passed during the wave.

Post-rebase integration verification:

- Rebased the milestone onto `e2f1729` (`feat: add bounded dashboard run
  history`) and preserved both publisher/dashboard behavior and trace-health
  bundle validation.
- Synchronized the reviewed dashboard policy and exact dashboard fixture tests
  with the refreshed sample report hashes and identities. The checked-in
  samples remain the hash-bound reports from the trace wave above; the rebase
  did not change the trace producer or report semantics.
- `npm run typecheck`, `npm run build`, and `npm run verify:publisher` passed.
  Publisher verification retained 19 artifacts, 5 findings, idempotent
  publish-driven dashboard refresh, and pre-publication tamper rejection.
- `npm test` passed, 71 files / 604 tests.
- A fresh `npm run verify:e2e` passed on the integrated branch:
  - Observer image:
    `sha256:7ad6c08789925fbe5c964f7522d49c419f1aff81905c03653ac086c4946bcce3`
  - Deceptive run: `runs/run-20260830214903-6f684acf`
  - Filesystem run: `runs/run-20260830214939-db0a53ba`

Residual scope is explicit: selected-filter accounting is not all-syscall
capture; the gap taxonomy is not exhaustive; raw trace ingestion is batch based
without its own aggregate byte/line quota; descriptor correlation is best
effort across uncommon transfer/exec/unshare cases; thread-local `exit` is not
guessed into a process exit; and legacy report V1 can omit health.

Status: complete. The implementation commit is the commit containing this
ledger entry (`feat: expand and account for deterministic trace coverage`).

## Active evidence-driven trace-corpus wave

Requested: 2026-08-30

- Starting branch and commit: `codex/trace-corpus-v1` at `c460abd`
  (`feat: expand and account for deterministic trace coverage`).
- Starting isolated worktree: clean. The primary `main` worktree remains at
  `e2f1729` with unrelated active `.gitignore`, `ImplementationPlan.md`,
  `PROJECT_MEMORY.md`, generated `agent-runs/`, and unseen-MCP holdout changes;
  none is owned by this wave.
- Goal: run a small representative corpus of exact-version Node/STDIO MCPs in
  the existing network-blocked Linux sandbox, aggregate their bound
  `observation-health.json` records, rank selected-surface gaps by frequency,
  policy relevance, and semantic ambiguity, then implement and measure only
  the highest-value timely canonicalization improvements.
- Safety and claim boundary: package metadata and runtime evidence are
  untrusted; experiments use synthetic inputs and directories, no host
  credentials, no configured live MCPs, and no universal coverage claim.
  Corpus results are observations for the exact packages/tools/inputs only.
- Root owns this ledger, Git coordination, target admission, execution,
  integration, normalizer/contracts/report decisions, documentation, and final
  verification. Parallel scopes are disjoint:
  - corpus-design agent is read-only and recommends bounded exact targets and
    controlled calls from repository/package evidence;
  - aggregation agent owns only
    `scripts/summarize-trace-coverage.mjs` and
    `test/unit/summarize-trace-coverage.test.ts`;
  - normalizer-review agent is read-only and ranks current gap families and
    identifies low-ambiguity additive candidates.
- Root will not stage or commit until every editing agent has completed. Core
  observation changes require typecheck, full tests, build, and Docker E2E;
  any new corpus harness also receives focused deterministic validation.

Scope amendments and completed handoffs:

- The corpus-design agent's follow-up editing scope was limited to
  `case-studies/trace-corpus/README.md` and
  `test/unit/trace-corpus-configs.test.ts`. It documented and regression-tested
  the four exact pins, synthetic calls, network/resource bounds, and direct
  `runs/run-*` workflow.
- The normalizer reviewer found that failed `io_uring_setup` records were
  overstated as opaque I/O. Its follow-up editing scope was limited to the
  normalizer, health contract, and focused tests. Definitive failures now use
  `failed_capability_probe`; succeeded/unknown setup and all other ring/AIO
  control or submission records remain `opaque_io`.
- The aggregation agent added a deterministic bounded summarizer. It FD-pins
  and no-follow reads `run.json` and `observation-health.json`, validates both
  current contracts, requires a terminal matching run and exactly one JSON
  health artifact, verifies the health SHA-256, rejects duplicate identities,
  and emits stable run/experiment plus install/initialization/tool cohort
  partitions.
- Root added the four configs, executed the corpus, reviewed raw/event/report
  evidence, and fixed routine outbound NSCD socket connection attempts being
  misclassified as unexpected network destinations. The exemption is limited
  to `/run/nscd/socket` and `/var/run/nscd/socket` connections across
  initialization, tool, cooldown, and comparison paths. Listeners and other
  Unix socket paths remain reportable and can be explicitly allowed by address;
  adversarial listen, Docker-socket, and TCP regression tests preserve that
  boundary.
- The generated comparison limitations and both checked-in sample reports now
  describe the same narrow NSCD-connection exemption. Their two reviewed
  dashboard-policy digests and digest regression constants were refreshed; no
  dashboard behavior or layout changed.

Final corpus evidence:

- Memory: `run-20260830220441-a105ae93`.
- Sequential Thinking: `run-20260830220519-c6aa0f41`.
- Everything: `run-20260830221048-ab50a46c`. Its controlled
  `127.0.0.1:54321` TCP attempt emitted a canonical failed
  `network.connect_attempt` and no selected gap. Port 9 was rejected by Fetch
  before a syscall in an exploratory run and was replaced before the final
  corpus.
- Community Shell post-fix: `run-20260830223403-5dedeb50`. The exploratory run
  produced four false network findings for `/var/run/nscd/socket`; the final
  run retained those Unix events and produced zero findings.
- All 17 experiments had complete selected-trace integrity and completed
  canonicalization. The four final reports contain zero findings for their
  configured expected scopes.
- The manifest-bound aggregate contains 581,136 parsed selected syscall
  records and 204,984 selected gap records. Installation accounts for 204,966
  gaps (99.991%); baseline initialization has 6 and tools have 12. `statx`,
  `mkdirat`, and mutating `openat` account for 99.43% of install gaps, while
  scripts-enabled/disabled counts differ by only 2-8 records per target.
- The eighteen non-install gaps are eight metadata probes, four conservative
  `openat` creation/truncation gaps already backed by canonical file evidence,
  and six definitively failed `io_uring_setup` capability probes that created
  no ring. No repeated high-consequence gap-only runtime operation was observed.
  Therefore this wave does not mislabel metadata probes as content reads or
  bulk-normalize npm mechanics to improve a percentage.

Final verification:

- Focused trace/policy integration suite: 8 files / 58 tests passed.
- `npm run typecheck`: passed.
- `npm test`: passed, 73 files / 620 tests.
- `npm run build`: passed.
- `npm run verify:e2e`: passed.
  - Observer image:
    `sha256:5a9fcc22e53136a5348d12b7ffd87acbe09768e24b74d382da3c12d4ceae829f`
  - Deceptive run: `runs/run-20260830223516-c7029a9e`
  - Official Filesystem run: `runs/run-20260830223550-aefd9e2f`
- The four-run manifest-bound summarizer completed with exact cohort
  partitions; `node --check scripts/summarize-trace-coverage.mjs` and
  `git diff --check` passed.
- A final independent read-only audit found no remaining correctness or
  security issue after the NSCD exemption was narrowed to outbound connections
  and adversarial listener coverage was added.

Residual scope remains explicit: this is a four-package Node/STDIO calibration
corpus over the selected Linux trace filter, not all-syscall or universal MCP
coverage. Compatible transitive dependencies may change across acquisitions;
raw runs are gitignored; and V1 manifest artifact rows do not carry a byte-size
field, so the summarizer enforces local per-file and aggregate byte ceilings but
cannot compare them with a manifest-declared size. The corpus forbids workflows;
the summarizer classifies all non-install/non-baseline experiment IDs as tools
and is not a general workflow-kind classifier. The next evidence priority is
separating gap-only behavior from lossy canonical projections, followed by
multi-effect file transfers such as `sendfile`, `splice`, and `copy_file_range`
when a corpus actually exercises them.

Status: complete. The implementation commit is the commit containing this
ledger entry (`feat: calibrate trace coverage with MCP corpus`).
