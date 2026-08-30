# Evidence-First V2 independent validation

**Status:** Phase A complete; provider-free Phase 1A implementation approved

**Validated:** 2026-08-30

**Scope:** independent review of [EvidenceFirstV2Plan.md](EvidenceFirstV2Plan.md)
against the repository, current threat model, implementation, and cited primary
research. This memo is a design decision record, not evidence that V2 runtime
execution, an agent planner, a registry, or a gateway exists.

## Conclusion

Proceed with the evidence-first, policy-anchored, agent-assisted direction, but
implement only the provider-free contracts/compiler foundation in this wave.
The design is appropriate because it preserves the deterministic engine as the
source of observed facts and enforcement while allowing future automation to
propose additional bounded experiments. An LLM is not a trustworthy source of
authorization, dispatch, appraisal policy, or admission decisions.

The handoff was directionally strong but not safe to freeze unchanged. The
review found material ambiguities in policy purpose, prediction ownership,
catalog completeness, target identity, mandatory-case timing, artifact loading,
receipt reuse, and the Phase 1 sandbox gate. Those corrections are recorded
below and in the handoff itself.

V2 live discovery and target dispatch remain disabled. The current V1
detonator and separate Agent V1 experiment remain unchanged and continue to be
the only implemented execution paths.

## Repository and implementation findings

The review began on `main` at `60ad21b`, which contains `f2aec0c`. The handoff
was already committed. Pre-existing dirty paths `.gitignore`,
`src/static/node-package.ts`, and `agent-runs/` were treated as out of scope and
preserved. The apparent unfinished identifier edit in
`src/static/node-package.ts` prevents treating the dirty worktree as a clean
verification baseline.

Relevant implementation facts:

- [src/mcp/tools-list.ts](src/mcp/tools-list.ts) bounds one complete
  `tools/list` response before SDK validation, but current orchestration does
  not follow `nextCursor`.
- [src/mcp/stdio.ts](src/mcp/stdio.ts) intentionally uses a raw request before
  SDK validation, then V1 drops `outputSchema` and selects tools by first name
  match. It does not reject duplicates before dispatch.
- [src/mcp/catalog.ts](src/mcp/catalog.ts) has useful bounded hashing patterns,
  but omits `outputSchema`, accepts duplicate names, and uses a private V1
  algorithm rather than a specified approval-boundary canonicalization.
- The installed MCP SDK strips unrecognized fields while parsing known tool
  shapes. A V2 raw discovery identity must therefore hash a bounded detached
  pre-SDK projection.
- [src/mcp/input-schema.ts](src/mcp/input-schema.ts) supports four JSON Schema
  dialects, but attacker-controlled regex keywords can consume unbounded CPU
  during in-process AJV validation unless rejected or separately isolated.
- [src/behavior-comparison.ts](src/behavior-comparison.ts) already separates
  advertised, static, observed, and operator-scope evidence for three broad
  capabilities. V2 should extend its concepts, not replace them with a model
  judgment.
- [src/sandbox/docker.ts](src/sandbox/docker.ts) provides blocked networking,
  a read-only root, PID/memory/CPU limits, transcript/stderr bounds, and
  label-verified normal cleanup. Writable target profiles and raw evidence are
  host bind mounts without independent byte/inode/file-descriptor/per-file or
  cumulative trace ceilings. The observer and cleanup control also remain too
  close to the guest for a production hostile-code boundary.
- The V1 target tree digest in [src/target/prepare.ts](src/target/prepare.ts)
  covers relative paths and file contents or symlink targets, but not every
  directory entry, effective mode, owner, or other execution-relevant
  attribute. The host tree is mounted later without an immediate identity
  recheck. It is provenance, not an exact V2 runtime identity.

## Required architecture assessment

### 1. Is evidence-first, policy-anchored, agent-assisted architecture appropriate?

Yes. It is superior to an agent-as-oracle design because untrusted metadata and
model output cannot define their own permission. It is also more extensible
than a permanently manual-only core, provided deterministic generation is the
baseline and any agent proposer must demonstrate incremental value under equal
budgets and information.

[CaMeL](https://arxiv.org/abs/2503.18813) supports keeping trusted control and
data-flow policy outside an injection-susceptible model. [RESTler](https://www.microsoft.com/en-us/research/publication/restler-stateful-rest-api-fuzzing/)
supports deterministic specification-derived producer/consumer exploration;
neither source supports making model text an authorization oracle.

### 2. Does deterministic enforcement remain final authority?

Yes after correction. Structural schemas alone are not authority. The trusted
controller must recompute identities, apply experiment-dispatch policy, issue
approval after final hashing, and eventually mediate every dispatch. Subject
behavior appraisal remains deterministic but is a different decision from
whether Forge may run a synthetic probe.

### 3. Are trust responsibilities adequately separated?

Partially in the original handoff; adequately after these changes:

- `ClaimProfile` contains advertised/documentary and explicitly inferred
  claims only. Deterministic static signals remain separate evidence.
- `ApprovedPolicy` has distinct `subjectBehaviorRules` and
  `experimentDispatchRules`. Future registry admission policy remains a
  separate relying-party decision.
- `AuditSpec` is trusted intent but not executable.
- Candidate cases cannot set origin, approval, policy, bounds, target,
  sandbox, observer, evidence, or cleanup fields.
- `ExperimentPlan` contains compiler-assigned cases, literal resolved inputs,
  predictions, assertions, bounds, and required approval, but no authority
  receipt and no self-digest.
- `ApprovalReceipt` is issued only over an already hashed plan and authorizes
  audit execution only. An unsigned persisted receipt is non-dispatchable in
  Phase 1A and does not become authority merely by parsing successfully.
- `CoverageRecord`, observations, comparisons, findings, and any future
  attestation remain factual/derived outputs, not permission.

This follows the evidence/appraisal/result/relying-party separation in
[RFC 9334](https://www.rfc-editor.org/rfc/rfc9334.html).

### 4. Do the two catalog identities prevent substitution and normalization ambiguity?

They can, but the original definitions were incomplete. Phase 1A defines:

- `rawDiscoveryDigest`: RFC 8785-canonical digest of a versioned complete
  ordered discovery projection containing negotiated protocol/server identity
  and detached pre-SDK tool descriptors. JSON-RPC IDs, opaque cursors, response
  `_meta`, and page boundaries are evidence but not cross-session identity.
- `planCatalogDigest`: digest of a strict versioned normalized projection,
  sorted by exact unique tool name, containing every field the compiler may
  consume and always preserving advertised `outputSchema`.

Object-key order changes neither digest. Raw tool order or raw-only extension
changes affect the raw identity. Any planning-field change affects the plan
identity. Any mismatch fails freshness. Duplicate names are rejected before
normalization or name lookup.

The official [MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
defines unique tool names, `outputSchema`, paginated `tools/list`, and
`notifications/tools/list_changed`. Phase 1A accepts only a controller-supplied
catalog already marked complete. Future live discovery must exhaust pages under
cumulative page/tool/byte/time limits, detect cursor cycles and list-change
notifications, and reject duplicates across pages.

### 5. Does the plan avoid self-referential hashing?

Yes. `experimentPlanDigest` is structurally rejected from
`forge.experiment-plan/v2`. The digest graph is acyclic:

```text
target/catalog/claim/policy/AuditSpec/resources
                         -> ExperimentPlan
                         -> controller envelope
                         -> ApprovalReceipt
                         -> AuditResult
```

The compiler uses [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html)
semantics and SHA-256. Raw loaders must reject duplicate keys before
`JSON.parse`/Zod can erase that ambiguity, and canonicalization rejects
non-I-JSON numbers and lone surrogates.

### 6. Is catalog freshness rechecked before dispatch?

It is required by design but not implemented in any V2 runtime path. Phase 1A
provides a pure freshness verifier for both identities. Future execution must
perform complete fresh discovery immediately before each call, invalidate on
`list_changed`, and fail closed. Matching metadata still cannot prove matching
behavior between list and call, so containment remains necessary.

### 7. Can generated arguments and workflow-bound values be revalidated?

Static synthetic-resource aliases are materialized, hashed, resolved to whole
typed values, then re-bounded, schema-validated, resource-class-validated, and
dispatch-policy-validated before final plan hashing. Phase 1A has no runtime
taint lineage, so producer-output bindings and dispatch rules that require
declared data-flow proof are unsupported and fail closed; they are not claimed
as data-flow-validated until the Phase 3 reference monitor exists.

The concrete implementation recognizes a finite conservative set of path- and
network-like field-name tokens after NFKC normalization; it does not claim
universal semantic destination detection. Recognized path fields require exact
synthetic-resource binding and recognized network fields are unsupported.
Up to two rounds of percent-encoded variants plus Unicode-normalized,
slash-confusable, traversal, URI, environment/interpolation, and executable-key
variants fail closed. Other
literal values remain resource class `unknown`, so an explicit dispatch-policy
decision is still required.

Producer-output workflow bindings cannot be resolved at compile time. Phase 1A
rejects them. A later reference monitor must accept only bounded detached
`structuredContent` validated against the frozen `outputSchema`; bind producer
action, output digest, JSON pointer, value digest, and taint lineage; rebuild
the whole argument; and repeat bounds, schema, policy, data-flow, catalog, and
receipt checks before issuing a single-use step receipt.

### 8. Are advertised, approved, predicted, observed, dangerous, and coverage states distinct?

Not in the original handoff: predicted behavior had no explicit artifact home.
Phase 1A adds non-authoritative per-case `predictedEffects` with source and
confidence. They remain distinct from `ClaimProfile`, subject behavior policy,
deterministic assertions, observations, policy-independent risk signals, and
coverage. “Intrinsic danger” is reported as a risk signal rather than an
absolute context-free verdict.

### 9. Is an LLM limited to proposal and explanation?

Yes. Phase 1A contains no provider or model. Future model output must parse only
as a candidate fragment that structurally lacks authority fields. A model may
propose claims, cases, workflows, predictions, or explanations; it cannot
write `ApprovedPolicy`, create approval, dispatch, alter mandatory cases or
bounds, or change canonical findings.

### 10. Can evaluation determine incremental proposer value?

Mostly, after one correction. The three-arm manual/deterministic/hybrid design
has appropriate shared budgets, gold labels, marginal-yield metrics, and a
go/no-go rule. All proposal arms must receive the same pre-outcome evidence
projection. Giving only the hybrid arm static signals derived from a hidden
mutation would confound semantic-planning value with privileged information.
Candidate pools, rankings, and Arm C allocation must be preregistered.

The reported 21% best-model property coverage in
[the LLM property-testing study](https://arxiv.org/abs/2307.04346) supports an
optional proposal arm, not sole ownership of test generation.

### 11. Is the current sandbox sufficient for V2 execution?

No. Phase 1A is contracts/compiler/receipt verification only. Live V2
discovery also executes hostile code and is disabled. Before any V2 target
dispatch, Forge needs at least:

- hard writable-profile and evidence byte/inode limits;
- per-file and file-descriptor limits;
- cumulative stdout, stderr, MCP, and trace limits;
- host-enforced CPU and wall-clock deadlines plus process recovery;
- bounded complete discovery and catalog freshness;
- the stronger immutable/reverified V2 runtime snapshot identity;
- evidence integrity and atomic incomplete/completed publication states;
- verified cleanup across success, timeout, crash, kill, and quota failure.

Production hostile-code claims additionally require a physically disposable
worker or microVM, an external observer/kill switch, and a crash-resilient
lease/reaper. Docker itself documents that containers have no resource limits
unless explicitly configured; bind mounts expose host-backed paths directly
([resource constraints](https://docs.docker.com/engine/containers/resource_constraints/),
[bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)).

### 12. What residual security risks remain?

- Prompt injection: bounded proposal data may still waste review/generation
  budgets; it cannot gain authority.
- Confused deputy: subject policy and audit-dispatch policy must never be
  interchanged; receipts carry purpose `audit_execution`.
- Artifact substitution: a digest is insufficient if a mutable pathname is
  reopened. The loader must use detached verified bytes or an immutable
  content-addressed object.
- Approval reuse: future authenticated receipts need audience, validity,
  case/trial/run scope, reuse state, compiler/runner/sandbox identities, and
  exact bounds. Pure verification cannot enforce one-time use without trusted
  state.
- TOCTOU: matching catalog metadata does not freeze target semantics. Recheck
  immediately before dispatch and keep the target contained.
- Data flow: source classification must come from trusted resource manifests
  or runtime taint and sink classification from policy. Metadata/model text
  cannot declassify.
- JSON Schema denial of service: Phase 1A rejects remote references and regex
  keywords; later support requires a bounded worker/deadline.
- Evidence injection: rendered logs/descriptions remain inert data and may not
  create links, fetches, terminal effects, or finding IDs.

## Material disagreements and corrections to the handoff

1. Split subject-behavior appraisal from authorization to run synthetic audit
   calls. A truthful claim or a denied deployment behavior neither authorizes
   nor automatically forbids a bounded negative test.
2. Add explicit non-authoritative predicted effects.
3. Define complete paginated catalog acquisition and `list_changed` handling;
   never hash one page as a complete catalog.
4. Preserve `outputSchema` unconditionally in normalized planning.
5. Define the raw digest over a stable decoded pre-SDK projection, not volatile
   wire IDs/cursors and not an SDK-stripped object.
6. Treat acquisition, preparation, lifecycle A/B, initialization, and discovery
   as pre-plan obligations with separate budgets; only post-discovery cases
   belong in `ExperimentPlan`.
7. Make Phase 1A non-executing. Runtime adaptation and evidence equivalence are
   Phase 1B behind the sandbox/snapshot/evidence gates.
8. Do not treat V1 `treeSha256` as an exact V2 runtime identity.
9. Make content-addressed `ArtifactReference` and recomputed `CatalogIdentity`
   strict embedded components; do not invent additional top-level contract IDs.
10. Use RFC 8785 JCS semantics and a duplicate-key-aware raw loader.
11. Reject producer-output workflow bindings and hazardous JSON Schema regex,
    remote-reference, or unenforced `format` features in Phase 1A.
12. Materialize and hash every concrete per-case/per-repetition canary before
    plan hashing; “fresh after approval” is an identity change.
13. Treat an unsigned Phase 1A receipt as structural binding under a trusted
    local controller, not transferable dispatch authority.
14. Give evaluation arms equal pre-outcome information.
15. Keep deterministic static evidence outside `ClaimProfile` to avoid
    conflating claims with observations or double counting.
16. Treat overlapping deny/review rules as monotonic gates, but require the
    union of satisfied positive dispatch rules to cover every resource class;
    a sensitive-class review rule must not grant an unrelated padded class.
17. Restrict V2 timestamps to canonical UTC at exact millisecond precision.
    Allowing finer fractions while comparing with JavaScript `Date` would make
    distinct authority chronology collapse onto the same millisecond.
18. Measure byte arrays through intrinsic typed-array slots, reject mutable
    shared storage and exotic wrappers, and require nonexecution coverage to
    postdate its bound receipt before a result can bind that coverage.

## Research attribution correction

The public README incorrectly combined “MCPTox,” “84%,” and “tool
auto-approval.” Primary sources establish:

- [MCPTox](https://ojs.aaai.org/index.php/AAAI/article/view/40895) contains 45
  real MCP servers, 353 tools, and 1,348 malicious cases. Across 20 evaluated
  agent settings its reported maximum attack-success rate is 72.8%, and it
  does not isolate approval mode as an experimental variable.
- The separate [MCP-ITP preprint](https://arxiv.org/abs/2601.07395) reports up
  to 84.2% attack success and a minimum 0.3% malicious-tool detection rate
  across its evaluated settings. Those extrema are not one shared
  model/defense setting, and the study also does not isolate auto-approval.
- The [MCP schema reference](https://modelcontextprotocol.io/specification/2025-06-18/schema)
  says tool annotations are hints and must not drive decisions when supplied
  by an untrusted server.

[README.md](README.md) and [AgentRolloutV1.md](AgentRolloutV1.md) were corrected
accordingly.

## Phase 1A implementation decision

The justified smallest foundation is:

- the seven top-level identifiers already specified in the handoff:
  `forge.claim-profile/v2`, `forge.audit-policy/v2`, `forge.audit-spec/v2`,
  `forge.experiment-plan/v2`, `forge.audit-approval/v2`,
  `forge.audit-coverage/v2`, and `forge.audit-result/v2`;
- strict embedded `ArtifactReference`, `CatalogIdentity`, target identity,
  execution-bounds, and synthetic-resource-manifest shapes;
- RFC 8785 canonicalization and strict duplicate-key-aware JSON loading;
- complete supplied-catalog validation, duplicate rejection, unconditional
  output-schema retention, and both catalog digests;
- a pure compiler that recomputes all identities, inserts controller-owned
  mandatory security cases before manual cases, reserves their budget,
  materializes concrete resources, resolves only static aliases, validates AJV
  schemas under the Phase 1 restrictions, applies experiment-dispatch policy,
  and hashes the final literal plan. Controller-owned case/resource/step and
  aggregate argument/case byte-node ceilings bound product expansion before
  the final artifact-envelope preflight;
- a controller-owned envelope and unsigned/non-dispatchable receipt issuer plus
  structural receipt/freshness verification. Issuance reruns the pure compiler
  from trusted inputs and compares the submitted digest rather than relying on
  process-local provenance history;
- Phase 1A result semantics fixed to non-dispatch, inconclusive,
  not-observed/not-assessed, freshness-not-rechecked, and unverified cleanup,
  plus nonexecuted/model-disabled coverage that cannot claim a covered row. A
  deterministic verifier cross-binds reporting digests and rejects ghost
  plan/catalog references without treating the records as runtime evidence;
- a human-authored fixture and adversarial reproducibility/mutation tests.

No provider, planner, runtime adapter, V1 schema/report change, Agent V1 merge,
automatic approval, registry, signing system, or gateway is justified in this
phase.

The resulting implementation and its non-goals are documented in
[EvidenceFirstV2Phase1.md](EvidenceFirstV2Phase1.md). It remains an additive
library-only path: existing V1 and Agent V1 entry points are unchanged, and a
structurally valid Phase 1 receipt still authorizes no dispatch.

## Phase 2 readiness judgment

Proceed to deterministic schema generation only after Phase 1A contracts and
compiler tests pass and the current unrelated dirty work is reconciled. Do not
proceed to V2 runtime execution merely because Phase 1A compiles a plan. The
sandbox, runtime-snapshot, catalog-acquisition, reference-monitor, partial-run,
and evidence-integrity prerequisites above remain separate blockers.
