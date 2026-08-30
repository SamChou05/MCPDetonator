# Evidence-First V2 Phase 1A implementation

**Status:** provider-free contracts and compiler implemented; V2 execution is
disabled.

This milestone proves deterministic artifact separation and binding. It does
not add a CLI, contact a model/provider, launch an MCP server, discover a live
catalog, dispatch a tool, sign a receipt, or claim that the current sandbox is
ready for V2 execution.

## Implemented boundary

- [src/contracts/v2/](src/contracts/v2/) defines exactly the seven approved
  top-level V2 artifacts plus strict embedded identities, bounds, cases,
  resources, predictions, assertions, and receipt components.
- [src/audit/v2/canonical.ts](src/audit/v2/canonical.ts) implements versioned,
  domain-separated RFC 8785/JCS-style SHA-256 inputs. The raw loader in
  [src/audit/v2/strict-json.ts](src/audit/v2/strict-json.ts) detects duplicate
  decoded keys and enforces limits before Zod sees the value. Public artifact
  boundaries detach plain JSON from property descriptors and reject proxies,
  accessors, hidden/symbol properties, decorated or sparse arrays, custom
  prototypes, cycles, non-finite numbers, and lone surrogates.
  Byte-array inputs are measured through intrinsic typed-array slots, reject
  proxies/subclasses/shared backing memory, and are copied before decoding or
  retained verification. Hash-only helpers use a fresh undecorated view after
  intrinsic length preflight, avoiding an attacker-sized copy. V2 timestamps
  use canonical UTC with exactly millisecond precision, matching the precision
  of every chronology comparison.
- [src/audit/v2/catalog.ts](src/audit/v2/catalog.ts) accepts only a supplied
  complete, non-invalidated catalog, rejects duplicate exact tool names,
  preserves advertised `outputSchema`, and computes both raw-discovery and
  normalized-plan identities. Returned identities and descriptors are detached
  and deeply frozen. It does not perform live pagination.
- [src/audit/v2/target.ts](src/audit/v2/target.ts) checks a 32 MiB per-artifact
  and 48 MiB aggregate controller ceiling before copying either target byte
  array. The lower AuditSpec ceiling still applies.
- [src/audit/v2/compile.ts](src/audit/v2/compile.ts) verifies detached target
  bytes under the AuditSpec pre-plan ceiling before hashing, recomputes
  claim/policy/spec/catalog/mandatory-suite identities, validates exact MCP
  claim-evidence references, reserves and inserts controller-owned mandatory
  cases, expands repetitions and environment variants, materializes every
  referenced synthetic resource, rejects any AuditSpec resource-class label
  that conflicts with a mandatory case's controller-owned deterministic
  expectation, resolves only static resource aliases, and applies precompiled
  complexity-limited input schemas plus monotonic experiment-dispatch policy.
  Resource maps expose no mutation methods and bytes are copy-on-read.
  Controller ceilings limit expansion to 1,024 cases/resource instances,
  4 MiB per resource, 16 MiB of materialized bytes, 4,096 expanded steps,
  2 MB/50,000 nodes of aggregate resolved arguments, 3 MB/75,000 nodes of
  retained compiled cases, and 100,000 policy predicate checks. Policy limits
  must also cover every receipt-bound execution dimension. These ceilings apply
  even when an operator-supplied execution bound is larger. The result is a
  frozen plan plus its external digest; the final plan still undergoes the
  4 MB/100,000-node envelope preflight before recursive schema parsing.

The accepted JSON Schema subset rejects references, regular-expression
keywords, `$async`, `uniqueItems`, excessive combinators, and `format` (the
shared AJV configuration has no format implementation). Unknown or unsupported
keywords fail closed rather than becoming silently unenforced assertions;
validators must return a synchronous boolean. Strict AJV compilation is
enabled only for this V2 path, leaving existing V1 behavior unchanged. Catalogs
are capped at 1,024 tools/1 MB; an individual schema or argument is capped at
262,144 bytes and 4,096 nodes.

Phase 1A argument references are intentionally narrower than arbitrary tool
schemas. A recognized path-like field must contain an exact
`{$forgeResource: alias}` marker before compilation and an exact controller
path afterward; recognized network-like fields are unsupported. Literal safety
checks include two rounds of percent decoding plus composed NFKC and slash-
confusable normalization, and executable/environment-like keys are rejected
after the same normalization. Field recognition is a finite conservative
heuristic, not universal semantic path or destination detection. Values not
classified by a trusted synthetic-resource alias add resource class `unknown`,
which is denied unless dispatch policy explicitly permits it.

For provider-free MCP claim evidence, `jsonPointer` addresses the exact-name
sorted normalized plan catalog. `sourceDigest` is the domain-separated digest
of the evidence source kind, that pointer, and the referenced field value;
free-standing placeholder digests are rejected. ClaimProfile also records an
explicit bounded `truncations` list, even when it is empty. Identical evidence
rows within one claim are invalid, profiles carry at most 4,096 evidence rows,
and repeated references to one exact catalog field reuse one expected digest.
- [src/audit/v2/approval.ts](src/audit/v2/approval.ts) issues and verifies only
  an unsigned, single-use-shaped, non-dispatchable Phase 1 structural receipt.
  Issuance deterministically recompiles the supplied trusted inputs, requires
  the submitted plan digest to match, rechecks recomputed materialized bytes,
  and cannot outlive the plan-bound policy expiry. The compiler itself has no
  process-local provenance state. Successful parsing or verification returns
  `dispatchAuthorized: false`.
- [fixtures/evidence-first-v2/manual-phase1.json](fixtures/evidence-first-v2/manual-phase1.json)
  is the human-authored deterministic fixture. Its tests pin the resulting
  plan digest and exercise mutation, substitution, policy, budget, catalog,
  resource, canonicalization, and malformed-receipt failures.

The digest graph is one-way:

```text
verified target + complete catalog + claims + policy + AuditSpec + resources
                                   -> ExperimentPlan
                                   -> external plan digest
                                   -> ApprovalReceipt
                                   -> future AuditResult
```

The plan cannot contain its own digest or approval. Claims cannot contain
authority, and their evidence digests do not grant permission. Subject-behavior
appraisal is not consulted as audit-dispatch authorization; only
`experimentDispatchRules` can authorize a bounded probe. Matching denies remain
effective regardless of requested limits. Approval-required rules cannot be
bypassed by a broader allow. Positive matching rules must collectively cover
every resource class; a review rule cannot authorize an unrelated padded class.
Any unclassified resource is `unknown` and remains denied unless policy names
that class explicitly. Phase 1A cannot prove runtime data flow, so any review
gate needing that proof fails closed.

`forge.audit-result/v2` is honest about this milestone: execution is fixed to
`phase1_contract_compiler` with `dispatched: false`, status is inconclusive,
and observed/risk dimensions say `not_observed`/`not_assessed` rather than using
placeholder evidence hashes. Catalog freshness is `not_rechecked`, and cleanup
is fixed to `unverified` with no evidence field. A clean runtime outcome,
freshness-success claim, or verified cleanup is structurally invalid.
Expected-invalid calls, workflows, and metamorphic pairs remain AuditSpec
candidate vocabulary only; the Phase 1A compiler and ExperimentPlan contract
reject them because their dedicated validator/reference-monitor semantics do
not exist yet.

Coverage is likewise fixed to `phase1_contract_compiler`, `dispatched: false`,
zero executed/timed-out/truncated/inconclusive cases, a disabled proposer, and
`not_rechecked` catalog freshness. It rejects any `covered` status, duplicate or
contradictory set-like facts, inexact generated-case accounting, inconsistent
sensor gaps, and inconsistent exhausted-budget dimensions. Required partitions
and phases are carried into the plan as requirements; Phase 1A does not satisfy
them. [src/audit/v2/reporting.ts](src/audit/v2/reporting.ts) cross-binds the
CoverageRecord and AuditResult to the compiled plan and receipt, rejects ghost
tool/case/environment/sensor references, recomputes every reporting digest, and
requires coverage to postdate its bound receipt and results to postdate
coverage. This is structural integrity for nonexecution artifacts, not runtime
evidence or an attestation.

## Verification

Run the provider-free focused gate with:

```bash
npx vitest run test/unit/audit-v2-*.test.ts
```

The standard repository gates remain:

```bash
npm run typecheck
npm test
npm run build
npm run verify:e2e
npm run verify:agent
```

No V2 runtime work may begin merely because this compiler passes. Phase 1B
still requires the sandbox, immutable/reverified runtime snapshot, complete
live catalog acquisition, reference monitor, evidence-integrity, partial-run,
and cleanup gates in [EvidenceFirstV2Plan.md](EvidenceFirstV2Plan.md).

The separate [EvidenceFirstV2AgentProposals.md](EvidenceFirstV2AgentProposals.md)
prototype now exercises the future proposer boundary without weakening this
milestone: a provider may return bounded candidate data, but deterministic
comparison produces no ExperimentPlan, approval, dispatch, or runtime claim.
