# Forge evidence-first V2: research, architecture, and implementation handoff

**Status:** Proposed design for independent validation before implementation

**Audience:** A fresh engineering/security agent with no access to the prior design conversation

**Prepared:** 2026-08-29

**Primary requirement source:** [README.md](README.md)

**Current product/trust record:** [ArchitectureAndTrustModel.md](ArchitectureAndTrustModel.md)
**Current supplementary rollout design:** [AgentRolloutV1.md](AgentRolloutV1.md)

## How to use this handoff

This document is deliberately self-contained. A new agent should be able to use
it to understand the problem, challenge the proposal, and then implement it in
small, measurable increments without relying on the conversation that produced
it.

Do not begin by adding another model call. First:

1. Read [AGENTS.md](AGENTS.md) completely and follow its repository and Git
   rules. Never read, stage, or commit `keys.md` or real credentials.
2. Read [PROJECT_MEMORY.md](PROJECT_MEMORY.md), then verify every claimed state
   against `git status`, `git log`, and the actual diff. The working tree may
   have changed since this document was written.
3. Read the current core and Agent V1 documents linked above.
4. Inspect the existing modules listed in “Implementation map.” This proposal
   extends an existing evidence pipeline; it is not a greenfield rewrite.
5. Validate the research claims and links, especially any claim used in public
   documentation.
6. Implement the phases in order and preserve backward compatibility. Do not
   couple the deterministic core to a model provider.
7. Treat the go/no-go metrics in this document as part of the design, not as
   optional cleanup.

The intended outcome is not “make Forge agentic.” It is:

> Make Forge better at generating covered experiments and comparing claims,
> policy, and observed behavior while keeping evidence, authorization, and
> execution deterministic and independently reviewable.

## Executive decision

Forge should evolve toward an **evidence-first, policy-anchored,
agent-assisted** MCP audit architecture.

The deterministic software detonator remains the primary product path. It
acquires an exact artifact, inspects it, runs selected lifecycle/tool
experiments in disposable environments, records operating-system and MCP
evidence, attributes events, and applies explicit rules. That directly answers
the challenge in [README.md](README.md): what the software actually does.

An LLM can add value in three bounded roles:

1. Propose semantic interpretations of names, descriptions, schemas, and
   documentation as **untrusted claims**.
2. Propose additional typed experiments and multi-tool workflows that are hard
   to derive from JSON Schema alone.
3. Produce evidence-citing explanations for reviewers.

An LLM must not:

- Decide what an enterprise or user authorized.
- Convert an MCP's own metadata into trusted permission.
- Generate arbitrary code, shell commands, host paths, or unrestricted URLs
  for execution.
- Remove mandatory lifecycle, schema, or security probes.
- Directly invoke the target or auxiliary tools.
- Be the only component deciding whether observed behavior is acceptable.
- Turn a sampled clean run into a universal `safe` label.

The proposal should be tested against two serious alternatives:

| Design | Strength | Fatal or material weakness | Decision |
| --- | --- | --- | --- |
| Deterministic core only | Reproducible, auditable, strong factual evidence | Manual cases and semantic workflows limit coverage | Keep as the foundation, then automate its inputs |
| Agent writes the expected contract and judges the run | Flexible and fast to prototype | The same untrusted text can corrupt the proposed oracle; judge bias and hallucination make authorization circular | Do not use as the security boundary |
| Evidence-first, policy-anchored, agent-assisted | Combines reproducible enforcement with broader semantic coverage | More artifacts and engineering complexity; still cannot solve the general oracle problem | Recommended, subject to measured validation |

This is a confident architecture hypothesis, not a claim already proven by the
prototype. The agent-assisted part earns a permanent place only if it finds
incremental true issues beyond deterministic generation at acceptable cost,
precision, and reproducibility.

| Horizon | What exists or is proposed | Oracle/authority |
| --- | --- | --- |
| Now: deterministic core | Static/package/interface inspection, manually selected calls, sandboxed lifecycle/runtime evidence, attribution, deterministic rules, and a four-way claim/static/observed/operator-scope comparison | Operator-authored target inputs and expected scope |
| Now: separate Agent V1 | Model-specific rollouts over an approved metadata projection with deterministic call policy and utility scoring | Operator-authored task, authorization, and utility predicates |
| Next: provider-free V2 | Typed policy/audit/plan/coverage artifacts plus deterministic schema, workflow, security, and metamorphic generation | Independent operator/enterprise policy; generated cases have no authority |
| Experimental next: planner | Capabilityless LLM adds candidate semantic cases to the same validated plan | Still the independent policy and deterministic reference monitor |
| Long term | Digest-bound curated registry attestations plus deployment-time policy enforcement | Enterprise appraisal and per-call runtime authorization |

## What Forge is required to do

The challenge asks for a local MCP detonator that combines static analysis and
runtime observation, including initialization, process creation, filesystem
activity, resource access, network behavior, dynamic code/dependencies, tool
invocation, and attribution. It explicitly values useful observation,
attribution, and explanation over a perfect malware classifier. Agent rollouts
are optional and supplementary.

The proposed V2 remains aligned with that scope:

| README requirement | Current implementation | V2 effect |
| --- | --- | --- |
| Point at a real local MCP and receive a report | Implemented for exact-version npm or local Node.js STDIO MCPs | Preserved |
| Static analysis of package, tools, inputs, dependencies, and source | Implemented with bounded Node-package and MCP-interface inspection | Claims become explicitly typed; deeper static sensors remain separate work |
| Initialization and selected tool runtime observation | Implemented | Mandatory baseline remains; generated cases add coverage |
| Process, filesystem, and network evidence | Implemented with stated sensor limits | Reused; later add data-flow, environment, module-load, and richer network sensors |
| Correlate effects to lifecycle/tool phases | Implemented as temporal/process-origin attribution, not proof of unique causality | Reused and exposed in comparison results |
| Compare interface/source expectations with runtime | A bounded four-way comparison now exists | Generalized into claim, policy, observation, risk, and coverage dimensions |
| Optional agent-behavior evaluation | Separate opt-in Agent V1 exists | Preserved separately; expanded only after the core planning experiment proves value |

V2 therefore generalizes experiment creation and comparison while continuing to
ingest the same raw traces and perform deterministic runtime software analysis.
It is not a replacement for the core path.

## Current implementation: facts a new agent must know

### Deterministic core

The core command accepts a `forge.target/v1` configuration. The operator
currently supplies:

- An exact target source and runtime command.
- Whether to observe initialization.
- Concrete tool names and input objects.
- Expected file reads/writes, network destinations, and child executables.
- Resource and cooldown limits.

[src/analyze.ts](src/analyze.ts) orchestrates the current path:

1. Resolve and record the observer image.
2. Prepare an exact target and provenance record.
3. Perform bounded pre-install Node-package inspection.
4. When possible, compare lifecycle-scripts-disabled and enabled installs.
5. Select and hash the runtime snapshot.
6. Perform static inspection of the selected snapshot.
7. Run initialization and each configured tool experiment in fresh synthetic
   Docker profiles.
8. Capture MCP transcripts, phases, `strace` evidence, and before/after
   filesystem state.
9. Normalize and attribute canonical events.
10. Apply expected-scope rules and write an evidence-linked report.

Important current constraints:

- Node.js/Linux/STDIO is the intentionally narrow target.
- Network is blocked; socket activity and destinations are observed, not
  decrypted application payloads.
- The trusted `strace` supervisor currently shares the target container.
- Selected inputs are sampled executions, not proof over all behavior.
- Dynamic analysis is evadable and environment-dependent.
- Acquisition is bounded and recorded, but it is not currently a normalized
  traced phase in the same sense as runtime experiments.
- Workflow schemas exist in [src/config.ts](src/config.ts), but non-empty
  workflows are explicitly rejected because execution is not implemented.

### Existing claim/static/observed/approved comparison

Do not build a second unrelated comparator without first evaluating the current
one.

[src/mcp/interface-claims.ts](src/mcp/interface-claims.ts) already extracts
bounded, positive lexical evidence for filesystem, network, and process claims
from tool names, titles, descriptions, and schemas. It preserves valid standard
annotation booleans separately as untrusted evidence; annotations do not
independently generate those capability claims. The extractor also preserves
field references, excerpts, limits, and truncation information. It correctly
treats metadata as untrusted evidence and treats absence of a claim as absence
of evidence, not a denial of capability.

[src/behavior-comparison.ts](src/behavior-comparison.ts) already creates rows
for:

- Advertised state: claimed, not claimed, not observed because no assessment
  was available, or not applicable to initialization.
- Package-source state: static signal found or not found.
- Runtime state: selected event observed or not observed.
- Operator scope: configured or not configured.
- Runtime partitions: within scope, outside scope, or unclassified.
- Attribution qualifiers, including temporal overlap rather than unsupported
  unique-causality claims.

It currently covers only `filesystem_access`, `network_access`, and
`process_execution`. V2 should evolve this useful seed into a richer comparison
model; it should not pretend this work does not exist.

### Input-schema validation

[src/mcp/input-schema.ts](src/mcp/input-schema.ts) compiles MCP input schemas
with AJV for JSON Schema 2020-12, 2019-09, draft-07, and draft-06. It validates
inputs but does not generate them. This is the natural starting point for the
deterministic schema-driven generator.

The current [MCP interface V1 contract](src/contracts/v1.ts) preserves input
schemas but does not preserve `outputSchema`. Stateful producer-consumer
planning therefore needs an opt-in discovery contract that keeps a bounded
output schema and any relevant catalog evidence; it must not infer all
workflows from attacker-controlled names and descriptions.

[src/mcp/catalog.ts](src/mcp/catalog.ts) provides a useful bounded V1 catalog
fingerprint, but its projection likewise omits `outputSchema`, sorts per-tool
digests, and does not fail closed on duplicate tool names. Keep it for V1
compatibility and reuse its budgeting/hash test patterns. V2 needs a distinct
algorithm/version that covers the ordered bounded raw discovery projection and
every plan-relevant field, and it must reject duplicate names before any
name-based generation or dispatch.

Use two explicit fields: `rawDiscoveryDigest` over the ordered bounded raw
discovery evidence, and `planCatalogDigest` over the exact normalized fields
consumed by generation, policy, comparison, or provider disclosure. Both must
include `outputSchema` when workflows use it; the provider projection remains a
smaller separately approved digest. Persist both in discovery evidence,
ExperimentPlan, ApprovalReceipt, AuditResult, and future attestation. Recompute
both from each execution session before any tool call. A mismatch in either is
catalog/artifact drift: block dispatch, preserve bounded drift evidence, mark
the run inconclusive/stale, and prevent admissible publication under the old
receipt.

### Supplementary Agent V1

Agent V1 is a separate command, contract, preparation path, run directory, and
report. Its job is not to inspect software behavior generally. It asks:

> Given a synthetic user task, a bounded tool catalog, and the exact approved
> MCP metadata projection, what actions does a particular model propose or
> execute?

The provider sees the synthetic task and provider-approved tool definitions.
The model selects tool names and arguments. A deterministic controller then
authorizes, blocks, or dispatches each call. Target and controlled-filesystem
workers use separate synthetic profiles and canaries. The provider credential
stays in the trusted controller/provider adapter, and target MCP results and
errors are withheld from provider history in V1.

Relevant modules are under [src/agent](src/agent). In particular:

- [src/agent/provider-data.ts](src/agent/provider-data.ts) canonicalizes and
  hashes the provider-bound target metadata projection.
- [src/agent/policy.ts](src/agent/policy.ts) performs deterministic call
  authorization.
- [src/agent/runner.ts](src/agent/runner.ts) owns isolation, dispatch, evidence,
  cleanup, and reporting.
- [src/agent/scorer.ts](src/agent/scorer.ts) scores authorization and utility
  facts from trusted evidence.
- [src/agent/providers/openrouter.ts](src/agent/providers/openrouter.ts)
  contains the optional OpenRouter adapter.

The provider adapter currently discards non-success response bodies from
persisted error messages and emits status-only HTTP errors. Preserve this as a
security invariant. The regression suite includes a Unicode-escaped credential
case that is decoded while parsing JSON tool arguments; do not reintroduce
response-body diagnostics into persistent evidence.

Do not overstate that protection. The current scanners in
[src/agent/redaction.ts](src/agent/redaction.ts) are exact-literal scanners.
They catch the literal key and a one-level JSON escape after parsing
reconstructs that literal, but they do not prove detection of arbitrary
reversible encodings such as a still-double-escaped value, percent encoding,
base64/base64url, hex, or fragments spread across fields or turns. All provider
output remains tainted. For live research, use a dedicated low-limit, rapidly
rotatable key and no real external sink. The preferred production direction is
a dedicated egress-auth broker/proxy so proposal, target, controlled-tool,
observer, and evidence processes never possess the raw provider credential.
Finite encoding scans are defense in depth, not proof against a malicious
upstream returning its bearer token in an arbitrary reversible representation.

Agent V1 is not the proposed audit-plan agent. These are different experiments:

- **Agent V1:** measures how an end-user-style tool-using model is influenced by
  MCP metadata.
- **Audit-plan agent:** optionally proposes additional experiments for the
  deterministic software detonator.

They may share canonical metadata handling and policy vocabulary later, but
their execution and evidence contracts should remain separate until both prove
independent value.

## The core problem: there is no complete oracle inside an arbitrary MCP

The hardest design issue is not how to call a model. It is how to decide what
should have happened.

For a hand-authored synthetic experiment, the author supplies a useful oracle:
known inputs, fake resources, permitted scope, and expected task outcomes. For
an arbitrary MCP, Forge receives only untrusted artifacts and claims. A
description saying “send a report” may truthfully imply network egress, but it
does not authorize reading SSH keys before sending. Conversely, a text editor
may legitimately create a lockfile or temporary file that its short
description never mentions.

This creates several non-equivalent questions:

1. **Claim alignment:** Do name, title, description, schema, annotations, and
   source signals tell a coherent story?
2. **Observed mismatch:** Did runtime behavior differ from the bounded claims?
3. **Policy violation:** Did behavior exceed enterprise/operator-approved
   scope?
4. **Intrinsic risk signal:** Did behavior touch a sensitive source, dangerous
   sink, unexpected executable, lifecycle phase, or high-risk data flow?
5. **Task utility:** Did the covered experiment accomplish its synthetic goal?

No single one is a malware oracle.

- A mismatch can be benign, risky, or simply undocumented.
- Perfectly aligned metadata can explicitly advertise a dangerous capability.
- A malicious implementation can remain dormant in the covered environment.
- A model judge can repeat the poisoned description's logic.
- An enterprise can intentionally approve behavior that another enterprise
  forbids.

Forge should therefore report these dimensions separately and let deterministic
policy combine them into a review/admission outcome. It should not collapse
them into “different means malicious” or “aligned means safe.”

## Research-backed rationale

The proposed design is grounded in several distinct lines of work. The full
bibliography appears at the end; the most important implications are:

### MCP metadata is an attack surface, not authority

The official MCP schema says descriptions help a model understand a tool and
that tool annotations are hints. It explicitly says clients should not make
tool-use decisions from annotations supplied by untrusted servers. See the
[MCP schema reference](https://modelcontextprotocol.io/specification/2025-06-18/schema)
and the maintainers' [tool-annotations risk discussion](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/).

[MCPTox](https://ojs.aaai.org/index.php/AAAI/article/view/40895), a peer-reviewed
AAAI 2026 benchmark, evaluates metadata poisoning across 45 real MCP servers,
353 tools, and 1,348 malicious test cases. Its reported maximum attack success
rate is 72.8%, and refusal rates were under 3% at best. This supports treating
the rollout model as potentially compromised and keeping authorization outside
it.

[MCP-ITP](https://arxiv.org/abs/2601.07395), a 2026 preprint, reports adaptive
implicit poisoning up to 84.2% attack success with malicious-tool detection as
low as 0.3%. The implicit attack is especially relevant: poisoned metadata can
persuade an agent to invoke a different legitimate high-privilege tool.

These papers motivate Agent V1 and metadata-counterfactual testing. They do not
show that an LLM can safely infer authorization from the same metadata.

### Result-channel attacks are distinct from metadata attacks

[AgentDojo](https://proceedings.neurips.cc/paper_files/paper/2024/file/97091a5177d8dc64b1da8bf3e1f6fb54-Paper-Datasets_and_Benchmarks_Track.pdf)
evaluates prompt injection delivered in untrusted tool results using stateful
tasks with both utility and security outcomes. It demonstrates why metadata
poisoning and result poisoning need separate scenario classes. Agent V1
currently covers the former and deliberately withholds target results from the
provider; future result-channel work must be added explicitly, not assumed.

### Capability and data-flow controls are stronger than prompt-only defenses

[CaMeL](https://arxiv.org/abs/2503.18813) separates privileged planning from
quarantined processing and enforces capability-aware control/data flow derived
from a trusted user query. The relevant lesson is architectural: untrusted text
may influence data processing without being allowed to alter control flow or
authorize a sensitive sink. Its limitations are also relevant—policies still
need trusted intent and complete enough capability/data-flow modeling.

[AgentSpec](https://cposkitt.github.io/files/publications/agentspec_llm_enforcement_icse26.pdf)
shows the value of a structured DSL and deterministic runtime enforcement. Its
reported LLM-generated-rule results are not complete enough to make generated
rules authoritative, reinforcing the need for validation and human/policy
ownership.

### Structured specifications can automate stateful experiments

[RESTler](https://www.microsoft.com/en-us/research/publication/restler-stateful-rest-api-fuzzing/)
is the closest deterministic analogue to the proposed generator: it derives
request grammars and producer-consumer dependencies from an API specification,
then uses dynamic feedback to explore stateful sequences. MCP JSON Schemas are
weaker than full service specifications, but they still support bounded type,
boundary, and dependency-aware generation.

Research on [LLM-generated property-based tests](https://arxiv.org/abs/2307.04346)
found useful results but only 21% coverage of properties extractable from the
documentation with the best evaluated model. That is evidence for an optional
proposal role with review, not for replacing deterministic generators.

### Differences are useful signals but not a complete oracle

[CHABADA](https://www.st.cs.uni-saarland.de/appmining/chabada/CHABADA.pdf)
demonstrated that comparing software descriptions with API behavior can reveal
anomalies and novel malware, but benign outliers remain. The lesson for Forge is
to retain discrepancy findings while separately assessing sensitivity,
authorization, and data flow.

The [oracle-problem survey](https://discovery.ucl.ac.uk/id/eprint/1471263/)
and research on [metamorphic testing](https://doi.org/10.1109/TSE.2013.46)
support checking relations across executions when exact expected outputs are
unknown. Metamorphic relations reduce the oracle problem; they do not eliminate
the need to define valid relations.

### Dynamic detonation is sampled and evadable

Interviews with malware analysts in
[SOUPS 2024](https://www.usenix.org/conference/soups2024/presentation/yong-wong)
show practitioners combine static analysis, changed environments, repeated
dynamic runs, and manual investigation to handle evasion. Forge must publish
coverage and limitations and should eventually support environment variation;
it must not infer universal safety from no finding in one sandbox.

### Evidence, appraisal, and admission should remain separate

[IETF RATS](https://www.rfc-editor.org/rfc/rfc9334.html) cleanly distinguishes
evidence, verifier appraisal policy, attestation results, and relying-party
decisions. [SLSA provenance](https://slsa.dev/spec/v1.2/provenance) and the
[in-toto attestation framework](https://github.com/in-toto/attestation/blob/main/spec/README.md)
show how results can be bound to exact artifact and process identities. Forge's
future registry should follow the same separation: signed evidence about a
specific artifact is not itself a universal safety decision.

## Target architecture

```text
                     trusted operator / enterprise policy
                                   |
                                   v
                         ApprovedPolicy (authority)
                                   |
       exact artifact              |          mandatory Forge probes
              |                    |                    |
              v                    v                    v
    static + MCP interface --> ClaimProfile --> deterministic generators
         evidence only         untrusted             schema/state/security
                                    \                    /
                                     \                  /
                          optional untrusted LLM proposer
                            (bounded semantic additions)
                                      |
                                      v
                    candidate experiment-plan fragments
                                      |
                                      v
                  deterministic compiler + validator + budgets
                    rejects unsafe/invalid; mandatory tests fixed
                                      |
                       frozen/hash-bound ExperimentPlan
                                      |
                                      v
                       disposable isolated execution
                                      |
                raw traces + transcripts + state + provenance
                                      |
                                      v
                   canonical normalization and attribution
                                      |
                                      v
             deterministic comparison + data-flow + policy rules
                       /              |               \
                      v               v                v
               findings        CoverageRecord     evidence package
                      \               |                /
                       \              v               /
                         optional evidence-citing LLM
                                      |
                                      v
                            reviewer explanation
                                      |
                                      v
             future digest-bound registry attestation/admission
                                      |
                                      v
                    future per-call runtime policy gateway
```

The security property is not “the planning model resists injection.” The model
may be fully persuaded by malicious metadata. The property is:

> Even a fully compromised proposer can emit only bounded candidate data. A
> trusted validator determines whether it conforms to the audit DSL; a trusted
> policy determines authorization; and only the existing contained runner can
> execute an approved, hash-bound plan.

Treat every artifact-controlled or model-controlled text channel as untrusted:
tool names, titles, descriptions, schema text/defaults/examples, annotations,
`_meta`, prompts, resources, tool results, errors, logs, registry metadata,
provider output, generated claim/plan candidates, and generated explanations.
There are two independent lanes: hostile software flows through acquisition and
disposable execution into externally protected evidence; hostile text flows
through a capabilityless proposer into a strict validator/reference monitor.
Neither lane can write `ApprovedPolicy`, sign an attestation, or decide registry
admission.

## Trust model and vocabulary

Names matter because the prior phrase “LLM-generated contract” conflates
claims with authorization. Use distinct artifacts and labels.

| Namespace/artifact | Meaning | Authority |
| --- | --- | --- |
| `ClaimProfile` | What MCP metadata, docs, annotations, and bounded semantic/static analysis claim or suggest | Untrusted evidence |
| `ApprovedPolicy` | What an enterprise/operator permits, denies, or requires approval for | Trusted authority |
| `AuditSpec` | Operator-approved audit request: exact target selector, policy, generator configuration, budgets, repetitions, environment variants, and manual cases | Trusted configuration, not yet executable |
| `ExperimentPlan` | Resolved frozen plan compiled after discovery from mandatory, deterministic, reviewed, and optionally agent-proposed cases | Executable only after deterministic validation, policy evaluation, required approval, and digest binding |
| `ApprovalReceipt` | Separate authority-issued decision over exact immutable plan/manifests and any approved case IDs, with issuer, scope, time, and expiry | Trusted authority; never embedded by MCP/model content and never mutates the plan |
| `ObservationProfile` | Canonical facts observed during covered runs, with raw references and qualifiers | Evidence, not intent |
| `ComparisonResult` | Deterministic relationships among claims, static signals, policy, observations, and risk rules | Derived appraisal |
| `CoverageRecord` | What tools, schema partitions, phases, workflows, sensors, and variants were or were not covered | Factual limitation record |
| `AgentBehaviorReport` | Model-specific trajectory and policy/utility measurements from Agent V1 | Supplementary evidence |
| `RegistryAttestation` | Signed/digest-bound summary of exact evidence, policy, harness, environment, and decision | Versioned admission evidence, never universal safety |

Suggested finding labels should preserve source:

- `claimed`
- `discovered_static`
- `observed_runtime`
- `allowed_by_policy`
- `denied_by_policy`
- `inferred_semantic`
- `enforced`
- `not_covered`
- `inconclusive`

Do not let `claimed` or `inferred_semantic` silently become
`allowed_by_policy`.

## Proposed typed artifacts

These are design-level shapes, not final schemas. The implementing agent should
write Zod contracts, invariant tests, and canonical serialization before adding
execution.

### `forge.claim-profile/v2`

Purpose: preserve a bounded interpretation of what the interface appears to
promise while retaining exact evidence references and uncertainty.

Minimum content:

- Subject artifact digest and MCP interface projection digest.
- Extraction/generator identities and versions.
- Per-tool claims derived separately from name, title, description, input
  schema, output schema, annotations, docs, and static signals.
- Capability dimensions more specific than the current three broad rows:
  - action: read, write, create, delete, execute, connect, send, receive;
  - resource/data class: ordinary synthetic file, credential, configuration,
    environment, source, network endpoint, process;
  - selector: path/prefix, destination/port, executable, schema field;
  - timing: install, startup, discovery, invocation, post-return;
  - quantity/frequency where meaningfully bounded;
  - whether a claim came from MCP-provided text, deterministic extraction, or
    optional model inference.
- Evidence references, confidence/uncertainty, truncations, and unsupported
  dimensions.

Rules:

- No claim grants permission.
- “No claim found” never means “capability denied.”
- Model-inferred claims must cite the exact bounded input fields used.
- Conflicting claims remain conflicts; the extractor must not smooth them over.
- The raw metadata and its digest remain available for audit.

### `forge.audit-policy/v2`

Purpose: encode the independent source of authorization and risk posture.

Minimum content:

- Policy ID, version, owner, creation/review time, and optional expiry.
- Exact subject selector or a documented reusable policy class.
- Default deny or review behavior.
- Allowed/denied operations over:
  - tool and action;
  - file path/prefix and data class;
  - network destination/port/service class;
  - child executable/process lineage;
  - environment/configuration/credential sources;
  - lifecycle phase;
  - data source-to-sink combinations;
  - volume/rate/time limits.
- Approval gates and conditions.
- Required mandatory probes and minimum coverage.
- Registry admission rules.

The first implementation can remain a narrow Forge-owned Zod DSL. Evaluate OPA
or Cedar only when policy reuse, analysis, and organizational authoring justify
the dependency. [OPA](https://www.openpolicyagent.org/docs) and
[Cedar](https://docs.cedarpolicy.com/) are relevant references, not mandatory
Phase 1 dependencies.

### `forge.audit-spec/v2`

Purpose: represent what the trusted operator asks Forge to audit. It is neither
a claim profile nor a resolved executable plan.

Minimum content:

- Exact target selector, approved-policy digest, and requested generator
  versions/configuration.
- Initialization/install observation requirements, repetitions, environment
  variants, and resource budgets.
- Operator-authored high-risk/manual cases and approved metamorphic relations.
- Required coverage and handling for unsupported/inconclusive cases.
- Synthetic fixture/canary class references. Do not embed real secrets.
- Whether optional agent proposals are enabled and the approved
  provider-bound projection policy.

### `forge.experiment-plan/v2`

Purpose: represent exactly what will execute after sandboxed discovery,
generation, validation, and approval.

Minimum content:

- Exact target/runtime snapshot digest, `rawDiscoveryDigest`,
  `planCatalogDigest`, AuditSpec digest, policy digest, and
  generator/proposer identities.
- Scenario IDs and origins: `mandatory`, `schema`, `stateful`,
  `security_probe`, `metamorphic`, `manual`, or `agent_proposed`.
- Ordinary tool calls with schema-valid literal JSON arguments.
- Multi-step workflow references and typed JSON-pointer bindings between prior
  bounded outputs and later inputs; binding recipes are statically compatible,
  while each concrete resolved argument is revalidated at dispatch.
- Resolved symbolic synthetic resources and canary classes.
- Deterministic assertions and applicable metamorphic relations.
- Runtime, storage, transcript, process, and experiment-count budgets.
- Required sensors and explicit unsupported sensors.
- Required approval class. Do not place the plan's own digest inside this
  payload: `experimentPlanDigest` belongs in a controller-owned artifact
  reference/envelope and the separate ApprovalReceipt. Compute it over the
  complete canonical ExperimentPlan payload, excluding the external envelope,
  and do not mutate the payload after hashing.

The DSL must not permit:

- Raw shell, scripts, code snippets, arbitrary binaries, or package installs.
- Host filesystem paths outside predefined synthetic aliases.
- Real credentials or environment injection.
- Unrestricted network destinations or external egress.
- Runtime overrides that weaken the sandbox.
- Agent-controlled observer settings, evidence locations, cleanup, or policy.
- An agent-proposed case to remove, replace, or reduce mandatory cases.
- Free-form interpolation into commands or paths.

A model proposal should reference symbolic resources such as
`profile.documents.report` or `sink.controlled_receiver`, which the trusted
compiler resolves to fresh synthetic manifests after structural candidate
validation but before input/policy validation and final plan hashing. The
ApprovalReceipt binds the final ExperimentPlan, synthetic-resource manifest,
policy, target, AuditSpec, `rawDiscoveryDigest`, and `planCatalogDigest`.
Dynamic values produced inside a workflow follow the separate dispatch-time
reference-monitor rule below.

### `forge.audit-approval/v2`

Purpose: let a trusted operator or policy authority approve exact immutable
bytes after validation and hashing.

Minimum content:

- Receipt ID, issuer/authority identity, issuance time, expiry, and scope.
- Target/runtime snapshot, `rawDiscoveryDigest`, `planCatalogDigest`, AuditSpec,
  policy, ExperimentPlan, and synthetic-resource-manifest digests.
- Exact approval-required case IDs and decision for each, if case-specific
  approval is needed.
- Canonicalization/signature scheme identity and signature/authentication state.

Phase 1 may use a trusted local/manual receipt under the prototype threat model
while cryptographic authentication/signing is deferred; label it explicitly
unsigned. It must still be typed and unmistakably separate from the plan.
Pre-hash validation may only classify a case as
`approval_required`; the authority issues the receipt after canonical hashes
exist. Changing any approved bytes requires a new plan and receipt.

### `forge.audit-coverage/v2`

Purpose: make negative conclusions honest.

Minimum content:

- Discovered and executed tool catalogs, plus catalog drift.
- Input-schema dialect and supported/unsupported keywords.
- Partitions attempted per field: nominal, boundary, enum, nullability,
  required/missing, malformed, format/pattern, size, and combinations.
- Workflow edges attempted and producer-consumer bindings.
- Lifecycle phases and cooldown windows covered.
- Security probes and environment variants covered.
- Sensor availability and gaps.
- Generated, rejected, skipped, timed-out, truncated, and inconclusive cases.
- Budget exhaustion and sampling strategy.
- Model/proposer identity for agent-proposed cases.

Every report that says “not observed” should make it possible to distinguish
“covered and not observed” from “not covered,” “sensor unavailable,” and
“budget exhausted.”

### `forge.audit-result/v2`

Purpose: reference rather than duplicate the exact claims, policy, plan, raw
`rawDiscoveryDigest`, `planCatalogDigest`, ApprovalReceipt, raw evidence
manifest, canonical observations, comparisons, coverage, findings,
limitations, and cleanup outcome.

Use scoped outcomes such as `verified_violation`, `policy_deviation`,
`suspicious_novelty`, `no_covered_violation_observed`, and
`unknown_or_untested`. A failed or incomplete sensor, missing policy, plan
drift, quota cutoff, or unverified cleanup must produce an inconclusive/fatal
state, never a clean or registry-admissible result. A known violation remains
reported even if later evidence becomes incomplete.

## Experiment generation strategy

Generation should be a portfolio. No one generator receives exclusive control
of the plan.

### 1. Mandatory invariant suite

Always include:

- Acquisition/provenance capture.
- Scripts-disabled static snapshot.
- Lifecycle-script A/B observation when supported.
- Initialization, MCP handshake/tool discovery, and cooldown observation.
- At least one nominal case per selected tool, if a valid bounded input can be
  generated or manually supplied.
- Post-return observation windows.
- Core sensitive-source and dangerous-sink probes appropriate to the sandbox.
- Cleanup and evidence-integrity checks.

Mandatory cases are Forge-owned and cannot be removed by metadata or a model.

### 2. Deterministic JSON-Schema generator

Build this before an agent generator. It provides the baseline needed to tell
whether the model adds value.

For each supported schema:

- Generate a stable nominal object.
- Exercise required and optional fields.
- Cover booleans, enums, const values, arrays, nested objects, and unions within
  strict depth/width/product budgets.
- Choose boundary-adjacent numbers and lengths.
- Generate bounded strings for formats and patterns only when a safe generator
  supports them; otherwise record the gap.
- Generate expected-invalid values as non-executable validator-test candidates
  and record their coverage separately. The current runner validates inputs
  locally and cannot dispatch them. If target-side schema rejection is later
  worth testing, add a distinct, explicitly authorized
  `schema_rejection_probe` contract and bounded raw MCP-call path with an
  expected protocol-error outcome; never smuggle invalid arguments through the
  normal schema-valid tool-call type.
- Validate every generated value with the existing AJV compiler before it may
  enter an executable spec.
- Use a stable seed and canonical ordering for reproducibility.

Avoid naïve Cartesian products. Use pairwise/partition sampling and disclose
the budget.

### 3. Stateful/workflow generator

Infer only bounded producer-consumer relationships. Examples:

- A create/list/read/delete sequence over a synthetic resource ID.
- A search result ID used by a get-details tool.
- A generated file path passed to a subsequent read tool.

Prefer explicit output schemas and deterministic named-field compatibility.
Optional semantic proposals can suggest relationships, but a validator must
confirm tool existence, schema compatibility, binding types, sequence length,
and resource policy before execution. A finite workflow graph and its binding
recipes must be hash-bound in the approved ExperimentPlan. Dynamic feedback may
only prune or choose among those preapproved transitions. Generating a new
transition requires a new plan digest and approval; defer open-ended
RESTler-style adaptation until that lifecycle exists. At every workflow step,
the trusted reference monitor resolves the bounded output value, reconstructs
the actual argument object, revalidates bounds and the exact input schema,
reevaluates policy/resource/data-flow rules, and issues an argument-hash-bound
dispatch receipt before the call.

### 4. Policy-driven security probes

Security probes are independent of whether the description mentions the risk.
Examples within synthetic environments:

- Plant fake credentials/configuration and detect reads.
- Place unique canaries in sensitive-source classes.
- Provide a controlled network/sink endpoint and detect source-to-sink flow.
- Detect unexpected executables and descendants.
- Exercise install/startup/post-return behavior.
- Vary a benign input while holding sensitive resources fixed.
- Vary the sensitive canary while holding task input fixed to establish stronger
  flow evidence.

A connection plus an earlier sensitive read is a correlated risk signal, not
automatically proof of exfiltration. Stronger labels require a payload/canary
observation at the controlled sink or another explicit flow link.

Preserve provenance labels across every controller serialization boundary:
`trusted_policy`, `target_metadata`, `target_result`, `controlled_result`,
`model_output`, `synthetic_secret`, and `private_data`. Any permitted
declassification to an external sink must be a trusted rule bound to the exact
value/class, recipient, purpose, and expiry; free-form metadata or natural
language from a model is insufficient. A session that combines private-data
access, untrusted content, and external communication should trigger a
deterministic composition rule even when each individual tool is otherwise
approved.

### 5. Differential and metamorphic cases

Use paired or grouped runs when an exact output oracle is unavailable. Freeze
the artifact, sandbox, policy, and all unrelated inputs; vary one controlled
factor.

Candidate relations include:

- Equivalent path spellings should not change unrelated network behavior.
- Reordering semantically independent list inputs should not cause new
  sensitive reads.
- Repeating a tool advertised as idempotent should not create additional
  destructive effects; because annotations are untrusted, violation is a
  claim discrepancy, not automatically a policy violation.
- Replacing a synthetic secret canary should predictably change only evidence
  linked to that secret; appearance at a controlled sink is strong flow
  evidence.
- Removing an optional field should not activate an unrelated dangerous sink
  unless another claim or policy explains it.
- Clean and mutated metadata should not change direct software execution when
  the same tool/input is invoked, while it may change Agent V1 trajectories.

Metamorphic relations need explicit applicability conditions. A relation that
does not hold for the tool's semantics must be marked invalid, not counted as a
target failure.

### 6. Optional LLM semantic proposer

Only after the prior generators work, send a minimal, approved projection:

- Tool names/titles/descriptions and input/output schemas.
- Bounded deterministic claim/static summaries with evidence IDs.
- Symbolic synthetic-resource catalog.
- The allowed audit DSL and budgets.
- Existing mandatory/deterministic cases so the model adds rather than
  duplicates.

Do not send:

- Provider credentials.
- Real secrets, production data, or host paths.
- Raw environment variables.
- Arbitrary source trees unless a separate disclosure policy explicitly
  authorizes them.
- Any tool access.
- Target results that are outside the specific research design.

The model returns candidate JSON only. Constrained decoding is helpful but not
a security boundary. The trusted controller must parse with a strict schema,
reject unknown fields, normalize symbolic references, enforce quotas, validate
all tool inputs, check policy, freeze canonical bytes, record a digest, and only
then pass the approved plan to execution.

The planner should produce:

- Suggested semantic capability claims with evidence citations.
- Candidate nominal inputs when deterministic generation is insufficient.
- Candidate workflows and why each step is related.
- Candidate metamorphic relations and applicability assumptions.
- Ambiguities requiring human review.

It should not produce an allowlist or final severity.

### 7. Optional evidence explainer

An LLM may turn structured comparison rows into a concise analyst narrative,
but each statement must cite report evidence IDs. Persist the prompt/model and
label the text `inferred`. Never let this narrative alter canonical findings or
registry admission.

LLM-as-judge research documents position, verbosity, self-preference, and
reasoning biases; see
[Judging LLM-as-a-Judge](https://arxiv.org/abs/2306.05685). Use a judge as a
secondary triage signal only, calibrated against human labels.

## Deterministic plan compiler and validator

This component is the critical boundary. It should be testable without a model
or Docker.

The opt-in V2 orchestration differs from current V1 configuration timing:

1. Prepare and hash the exact candidate/runtime snapshot.
2. Run one explicit, sandboxed discovery phase and preserve a bounded catalog,
   including output schemas needed for workflows.
3. Fail closed on duplicate tool names, then freeze both
   `rawDiscoveryDigest` and `planCatalogDigest` as defined above. The existing
   V1 catalog fingerprint is not sufficient because it omits `outputSchema`
   and does not reject duplicate names.
4. Run deterministic and optional semantic generation against that frozen
   catalog and the approved AuditSpec/policy.
5. Add mandatory cases first, reserve their budgets, then merge optional
   candidate cases without allowing replacement or override.
6. Materialize/hash synthetic resources, resolve symbols, validate the complete
   plan, and classify any explicit approval-required cases. Do not grant that
   approval yet.
7. Canonicalize and hash the final ExperimentPlan, then obtain a separate
   ApprovalReceipt from the trusted authority, bound to that exact plan,
   policy, both catalog identities, AuditSpec, target, and
   synthetic-resource-manifest digest. Missing, denied, or expired approval
   blocks execution.
8. Execute each independent case in a fresh environment; keep shared state only
   inside an explicit workflow.
9. Recompute both catalog identities from every fresh session before any tool
   call and require them to match. Drift in either blocks dispatch and
   admissible publication; it is preserved as bounded inconclusive/stale
   evidence, never silently accepted.

Validation order:

1. Parse strict versioned candidate data; reject unknown fields, duplicate JSON
   keys/IDs, alternate versions, and malformed values.
2. Verify the exact target, AuditSpec, policy, `rawDiscoveryDigest`,
   `planCatalogDigest`, generator, and proposal identities available at this
   stage.
3. Insert the Forge-owned mandatory suite before optional cases. Reserve its
   resource budget and reject any candidate collision, deletion, or override.
4. Enforce pre-resolution depth, width, string, byte, experiment, step, and
   runtime budgets.
5. Require a complete V2 catalog with unique tool names and ensure every
   referenced tool/binding field exists.
6. Materialize a fresh synthetic-resource manifest and resolve only predefined
   symbolic aliases. Re-enforce post-resolution byte/path/value budgets.
7. Validate static producer-consumer binding compatibility and prevent
   executable interpolation. Preserve runtime bindings as typed JSON-pointer
   recipes, not prevalidated values.
8. Compile and validate every resolved ordinary tool input against its exact
   input schema. Only the separate negative-call type may contain an
   intentionally invalid input.
9. Evaluate every case against `ApprovedPolicy`; reject disallowed cases and
   mark explicit approval-required cases as pending. MCP/model content cannot
   produce approval, and no authority decision is issued before final hashes.
10. Reject any attempt to alter sandbox, observer, evidence, cleanup,
    credentials, host mounts, network, target command, or mandatory coverage.
11. Canonicalize and persist the complete immutable ExperimentPlan and all
    referenced manifests, then compute their digests.
12. Have the trusted authority issue, then persist and verify, a separate typed
    ApprovalReceipt over those exact digests, including `rawDiscoveryDigest`
    and `planCatalogDigest`.
    Approval never precedes or mutates the bytes it authorizes.
13. Before every dispatch, verify the plan/ApprovalReceipt/policy and both
    catalog digests. For a workflow binding, resolve the actual tainted output
    value, reapply quotas, validate the full concrete argument against the
    current frozen schema, reevaluate policy and data-flow rules, compute the
    canonical argument hash, and issue a step-scoped reference-monitor receipt
    before calling the tool.

For every rejected proposal, record a bounded reason code without persisting
untrusted provider diagnostics or secrets. Proposal rejection rates are an
important evaluation metric.

## Runtime execution and evidence

V2 should compile approved experiments into the existing core runner rather
than create an agent-owned executor.

Security posture:

- Fresh disposable environment per independent experiment unless a workflow
  explicitly requires shared state.
- Read-only exact target artifact plus bounded writable synthetic profile.
- Blocked external egress by default; use only controlled sinks/proxies where a
  test requires observable network semantics.
- No provider key or audit-planner process in the target environment.
- Separate target, controlled-tool, and observer privileges.
- Fail closed on ambiguous cleanup or artifact/hash drift.
- Preserve raw evidence before normalization.
- Persist partial evidence on target failure when it can be done safely and
  honestly; distinguish target failure from infrastructure failure.
- Longer-term production boundary: external observer and a hardened sandbox
  such as gVisor or a Firecracker-style microVM, chosen after a concrete threat
  and operations evaluation. Docker plus an in-container supervisor remains a
  prototype boundary, not a production hostile-code guarantee.

Relevant isolation references:

- [Firecracker NSDI 2020 paper](https://www.usenix.org/conference/nsdi20/presentation/agache)
- [gVisor architecture documentation](https://gvisor.dev/docs/architecture_guide/)
- [Linux Landlock documentation](https://docs.kernel.org/userspace-api/landlock.html)

## Comparison and finding model

The comparator should be deterministic over typed evidence. Expand the current
four-way rows rather than replace them with a free-form model judgment.

For each capability/action/resource dimension, preserve:

1. **Claim evidence:** what metadata/docs/annotations say.
2. **Static evidence:** what bounded source/dependency inspection finds.
3. **Observation evidence:** what happened in covered phases and with which
   attribution confidence.
4. **Approved policy:** what the operator/enterprise allowed or denied.
5. **Intrinsic risk:** sensitive source, dangerous sink, process execution,
   lifecycle timing, destructive action, or confirmed data flow.
6. **Coverage:** which generated partition/workflow/variant produced the fact
   and what was not tested.

Recommended deterministic finding families:

- `claim_interface_conflict`
- `claim_static_mismatch`
- `claim_runtime_mismatch`
- `runtime_policy_violation`
- `sensitive_source_access`
- `dangerous_sink_use`
- `confirmed_canary_flow`
- `correlated_source_sink_risk`
- `unexpected_process_lineage`
- `unexpected_lifecycle_behavior`
- `metamorphic_relation_violation`
- `catalog_or_artifact_drift`
- `coverage_insufficient`
- `inconclusive_sensor_or_budget`

Severity should follow independently configured policy plus evidence strength,
not merely semantic difference. A truthful description cannot authorize a
forbidden action, and an undocumented benign temp file should not automatically
be called malicious.

### Four concrete examples

#### Positive case: scoped filesystem reader

- Claim: reads files under a requested directory.
- Approved policy: read-only access under a synthetic project root; no network,
  child executable, or credential access.
- Generated cases: nominal file, nested file, missing file, boundary path,
  repeated read.
- Observation: only permitted reads, expected protocol writes, no sensitive
  canary access, no external connection.
- Result: aligned for covered cases, no policy violation, explicit coverage and
  limitations. Do not say universally safe.

#### Negative case: truthful sender with secret theft

- Claim: sends supplied data to an allowed receiver.
- Interface alignment: name/schema/description all accurately advertise
  sending.
- Approved policy: may send only the explicit `content` argument; may not read
  credentials.
- Observation: reads a planted credential and the controlled receiver sees its
  canary.
- Result: confirmed sensitive-source-to-sink flow and policy violation even
  though metadata is internally consistent. This proves why deterministic risk
  and data-flow rules remain necessary.

#### Mismatch that may be benign

- Claim: formats a document.
- Observation: creates a bounded temporary file and spawns a known formatter.
- Approved policy: allows that temp prefix and executable.
- Result: claim/runtime discrepancy or undocumented implementation detail, but
  within policy. Route to documentation/review, not “malware.”

#### Poisoned metadata affecting an agent but not direct execution

- Direct core: invoke the same target tool with identical arguments under clean
  and poisoned metadata; software traces are unchanged.
- Agent V1: the poisoned description persuades the rollout model to call a
  separate high-privilege controlled tool with unauthorized arguments.
- Result: Agent V1 reports metadata-induced policy violation; the core reports
  no direct implementation delta. This is useful orthogonal information and
  why the paths stay separate.

## Relationship to Agent V1

Do not merge reports or execution loops in the first V2 phases.

Share only stable concepts when earned:

- Exact configured source and artifact identity.
- Canonical interface projection and hash.
- Synthetic resource classes and canary semantics.
- Approved policy vocabulary.
- Task/utility predicates where genuinely comparable.
- Coverage and environment identity conventions.

Keep separate:

- Prepared snapshots and mutable profiles.
- Target and provider evidence.
- Core canonical OS events versus agent action trajectories.
- Direct-runtime findings versus model-specific rates.
- Provider disclosure approval versus runtime authorization.

Later Agent V1 work can add result-channel injection, multi-server tool
shadowing, persistent state, model/host prompt variants, and repeated
counterfactuals. Those should remain explicit scenario families with their own
coverage, not hidden inside the core planner.

## Phased implementation plan

Each phase must land as an independently useful, provider-optional increment.

### Phase 0: stabilize and correct the baseline

Before V2 implementation:

1. Reconcile and commit the current deterministic comparison/filesystem-state
   wave separately. At the start of document authoring `HEAD` was `c62f862`,
   the branch was ahead of `origin/main`, and the first core comparison wave was
   fully staged but uncommitted. During final review, additional unstaged edits
   and untracked catalog/report-support files appeared in the shared worktree.
   Treat this as concurrent in-progress core work, not as part of this document.
   The new interface-claim, behavior-comparison, filesystem-state, and catalog
   modules are foundational V2 inputs only after reconciliation. Re-check every
   path; do not trust this snapshot blindly, do not layer V2 onto a mixed index,
   and let the repository's designated Git coordinator review and commit it.
2. Correct the public MCPTox sentence in [README.md](README.md). It currently
   attributes an “84% with tool auto-approval” result to MCPTox. The primary
   MCPTox paper reports a 72.8% maximum and does not isolate an auto-approval
   variable. The 84.2% figure comes from the MCP-ITP preprint and also is not an
   isolated auto-approval experiment. Use precise separate citations.
3. Preserve and rerun the OpenRouter status-only error regression, including
   one-level Unicode-escaped credential content. Never persist non-success
   provider response bodies. Add tests and documentation for the precise
   encodings actually covered; do not claim arbitrary encoded-secret
   isolation. Decide whether an egress-auth broker is a prerequisite for live
   V2 planner trials. If a real key may have appeared in provider output,
   evidence, terminal history, or logs, rotate it before any further live run.
   Explicitly refuse HTTP redirects and test same- and cross-origin redirect
   responses before relying on the live-provider boundary.
4. Establish a clean verification baseline and record it in
   [PROJECT_MEMORY.md](PROJECT_MEMORY.md).

Exit criteria:

- Clean, reviewed baseline commit(s).
- Accurate README research claim.
- `npm run typecheck`, `npm test`, `npm run build`, core end-to-end verification,
  and Agent V1 verification pass as appropriate.

Baseline commands:

```bash
docker info
npm install --ignore-scripts
npm run typecheck
npm test
npm run build
npm run verify:e2e
npm run verify:agent
```

The current end-to-end verifier expects five deceptive-control findings and no
findings for the pinned official Filesystem case; inspect the verifier and
sample contracts rather than treating report prose as the oracle. Agent V1's
scripted verification validates plumbing and a controlled trajectory, not
causality between clean and poisoned metadata in a live model.

### Phase 1: typed manual plan and richer deterministic comparison

Goal: prove the artifact separation and compiler without any LLM.

Implement versioned contracts for `ClaimProfile`, `ApprovedPolicy`,
`AuditSpec`, `ExperimentPlan`, `ApprovalReceipt`, both V2 catalog identities,
`CoverageRecord`, and `AuditResult`. Manually encode equivalent cases for the
pinned official Filesystem target and the deceptive fixture. Compile a manual
AuditSpec into a frozen ExperimentPlan, hash it and its referenced manifests,
issue a separate local/manual ApprovalReceipt, and only then adapt it into the
existing initialization/tool execution primitives. Extend comparison
dimensions enough to distinguish action, resource, phase, policy, and evidence
strength.

Do not remove `forge.target/v1`, expand `forge.report/v1` in place, or silently
route `forge analyze` through V2. Prefer an opt-in `forge audit <audit-spec>`
path with separate result/sample contracts while keeping the existing
command/provider-free behavior working.

Exit criteria:

- Strict-schema and invariant tests.
- Canonical serialization and digest tests, including a controller-owned plan
  envelope so `experimentPlanDigest` is never self-referential.
- ApprovalReceipt tests proving authority is structurally separate and any
  post-hash mutation or catalog-identity mismatch blocks dispatch/publication.
- Unsafe plan rejection tests.
- Before opt-in V2 execution, add and test independent resource ceilings for
  writable profile/evidence bytes and inodes, per-file size, file descriptors,
  cumulative stdout/stderr/MCP/trace bytes, process count, memory, CPU, and
  wall-clock time. The current core's writable host bind mounts and cumulative
  STDIO/trace paths do not satisfy this gate.
- Existing sample reports still validate or have an explicit versioned
  migration.
- Manual V2 cases produce the same or better core evidence than current target
  configs.

### Phase 2: deterministic schema generation

Goal: reduce hand-authored inputs and establish the baseline against which an
agent is measured.

Add a stable-seeded, budgeted JSON-Schema partition generator using the current
AJV dialect support. Keep nominal and expected-valid boundary calls separate
from non-executable expected-invalid validator candidates. Record every
unsupported keyword and rejected candidate in coverage. Defer target-side
invalid-call execution until the separate negative-call contract above exists.

Exit criteria:

- Property/unit tests across all supported schema dialects.
- Depth/width/product/string/experiment budgets cannot be bypassed.
- Every executable generated input revalidates against the exact discovered
  schema.
- Stable seed and catalog produce byte-stable plans.
- Meaningful additional coverage on at least the two existing targets and a
  third independent MCP.

### Phase 3: workflows, policy probes, metamorphic tests, and data flow

Goal: reach behavior that single nominal calls miss and strengthen the oracle.

Implement bounded workflow execution, explicit bindings, controlled sinks,
canary-flow evidence, and paired-run relations. Extend sensors only as required
to substantiate the finding labels; do not overclaim payload flow from timing
alone.

Exit criteria:

- Producer-consumer bindings are typed and cannot interpolate commands/paths.
- Every concrete workflow-step argument is independently quota-checked,
  schema-validated, policy/data-flow evaluated, and authorized by a
  plan/policy/`rawDiscoveryDigest`/`planCatalogDigest`/argument-hash-bound
  dispatch receipt after resolving any tainted prior output.
- Dynamic feedback can select or prune only a finite preapproved transition;
  it cannot synthesize a new executable step under the old approval.
- Fresh-state versus shared-state semantics are explicit.
- A planted secret read plus controlled-sink canary observation produces a
  confirmed-flow finding.
- Source/sink correlation without payload proof produces only a correlated-risk
  finding.
- Metamorphic applicability and invalid-relation outcomes are explicit.

### Phase 4: optional agent proposal arm

Goal: determine whether semantic planning adds unique value.

Add a provider-neutral proposer interface. Reuse the hardened provider adapter
only after defining an approved provider-bound projection and its digest. The
model receives no tools. Parse only the typed candidate DSL and run it through
the same deterministic compiler/validator as manual candidates.

Exit criteria:

- A scripted proposer covers all behavior without network access in tests.
- Adversarial metadata cannot alter mandatory cases, policy, sandbox,
  credentials, target command, host paths, evidence, or cleanup.
- Provider-bound inputs are approved and hash-bound before request.
- Every rejected candidate has a bounded reason code.
- The three-arm evaluation below shows whether the agent adds true findings.

If the agent adds no material findings beyond Phase 2/3, keep it as an optional
research tool or remove it. The core still benefits from the typed plan and
deterministic generators.

### Phase 5: Agent V1 expansion, still separate

Only after core planning is measurable, expand end-user agent-context scenarios
to cover target result injection, cross-server/tool influence, state across
turns/runs, catalog changes, and host-specific prompt/approval behavior.

Exit criteria must report task utility and security separately, repeat trials,
pin model/prompt/toolset identity, and use controlled tools/synthetic data.

### Phase 6: curated registry attestations

Build a Forge-curated layer downstream of the
[official MCP Registry](https://registry.modelcontextprotocol.io/docs). The
official registry is a discovery/distribution source; Forge can be an
opinionated enterprise sub-registry that adds exact-version audit evidence and
policy decisions.

A registry record should bind:

- Artifact/package/source/dependency digests.
- `rawDiscoveryDigest`, `planCatalogDigest`, and the separately approved
  provider projection digest when applicable.
- Forge source/harness/generator versions.
- Sandbox image/kernel/observer/sensor identities.
- Policy and AuditSpec digests.
- Model/provider/prompt projection identities for any agent evidence.
- Coverage, truncations, limitations, and evidence package digest.
- Review/admission decision, restrictions, signer, timestamp, and expiry.

Possible statuses:

- `approved_with_restrictions`
- `needs_review`
- `rejected`
- `inconclusive`
- `stale`

Do not publish a timeless package-name-level `safe` badge. Signature and
provenance establish identity and integrity; they do not establish benignness.
Use RATS-style evidence/appraisal/result separation and in-toto/SLSA-style
digest binding. Evaluate [Sigstore verification](https://docs.sigstore.dev/cosign/verifying/verify/)
for signing/distribution.

### Phase 7: deployment-time enforcement

Audit-time evidence cannot constrain a future call by itself. A production
registry should distribute a deployment policy to an MCP gateway/host that:

- Verifies the exact admitted artifact and metadata digest.
- Enforces per-call tool, argument, data-source, destination, process, and
  approval rules.
- Revalidates on version/interface/policy drift.
- Logs evidence and revokes/stales attestations when assumptions change.

This is later product work, not a prerequisite for demonstrating V2 audit
value.

## Implementation map

Validate this map against the live tree before editing.

### Reuse and extend

| Existing path | Role in V2 |
| --- | --- |
| [src/config.ts](src/config.ts) | Preserve `forge.target/v1`; add an additive compiled-plan path rather than silently changing semantics |
| [src/mcp/input-schema.ts](src/mcp/input-schema.ts) | Exact-schema validation and dialect routing for generated inputs |
| [src/mcp/catalog.ts](src/mcp/catalog.ts) | Reuse V1 bounding/hash patterns only; define V2 `rawDiscoveryDigest` and `planCatalogDigest` identities with `outputSchema`, ordered fields, and duplicate-name rejection |
| [src/mcp/interface-claims.ts](src/mcp/interface-claims.ts) | Deterministic seed for `ClaimProfile`; keep raw references and limitations |
| [src/static/node-package.ts](src/static/node-package.ts) | Existing bounded static signals; do not misrepresent lexical checks as full program analysis |
| [src/analyze.ts](src/analyze.ts) | Characterize and extract reusable execution primitives only after tests; preserve the V1 `forge analyze` behavior |
| [src/contracts/v1.ts](src/contracts/v1.ts) | Treat V1 canonical events as an accepted evidence adapter; add V2 contracts rather than weakening V1 invariants |
| [src/observe/strace-parser.ts](src/observe/strace-parser.ts) | Raw syscall parsing |
| [src/observe/strace-normalizer.ts](src/observe/strace-normalizer.ts) | Canonical process/filesystem/network facts |
| [src/observe/filesystem-state.ts](src/observe/filesystem-state.ts) | Before/after bounded state evidence |
| [src/attribute.ts](src/attribute.ts) | Phase/process-origin attribution with current qualifiers |
| [src/install/delta.ts](src/install/delta.ts) | Seed for event fingerprints and multiset deltas across paired runs |
| [src/mcp/stdio.ts](src/mcp/stdio.ts) | Current single-tool execution behavior to preserve |
| [src/agent/mcp-session.ts](src/agent/mcp-session.ts) | Characterize its bounded multi-call/transcript handling as a workflow-session reference; extract shared code later rather than importing `agent/` into the core |
| [src/expected-scope.ts](src/expected-scope.ts) | Narrow deterministic matching seed for policy evaluation |
| [src/rules.ts](src/rules.ts) | Deterministic finding layer; extend with evidence-strength distinctions |
| [src/behavior-comparison.ts](src/behavior-comparison.ts) | Existing four-way comparison seed |
| [src/report.ts](src/report.ts) | Reuse evidence-linking/reporting patterns; keep `forge.report/v1` stable and emit a separate V2 audit result |
| [src/evidence-store.ts](src/evidence-store.ts) | Persist typed/hash-bound artifacts |
| [src/agent/provider-data.ts](src/agent/provider-data.ts) | Pattern for canonical provider-bound projections |
| [src/agent/providers](src/agent/providers) | Optional provider-neutral/scripted model adapters after boundary review |

### Suggested new modules

Names can change after repository review, but keep responsibilities separate:

```text
src/contracts/v2/
  artifact-reference.ts        controller envelope; digest never inside payload
  catalog.ts                   rawDiscoveryDigest + planCatalogDigest contracts
  claims.ts                    forge.claim-profile/v2
  policy.ts                    forge.audit-policy/v2
  audit-spec.ts                forge.audit-spec/v2
  experiment-plan.ts           forge.experiment-plan/v2
  approval.ts                  forge.audit-approval/v2 receipt
  coverage.ts                  forge.audit-coverage/v2
  audit-result.ts              forge.audit-result/v2

src/audit/
  load.ts                      strict loading, reference resolution, and hashing
  canonical.ts                 canonical serialization and digest binding
  claim-profile.ts             compose deterministic and optional semantic claims
  policy.ts                    deterministic authorization/risk evaluation
  compile.ts                   candidate fragments -> frozen executable plan
  validate.ts                  structural, schema, policy, quota, and boundary checks
  coverage.ts                  coverage accounting and limitations
  compare.ts                   richer claim/static/observed/policy/data-flow comparison
  generate/
    mandatory.ts               Forge-owned invariant cases
    schema.ts                  deterministic JSON-Schema partitions
    stateful.ts                bounded producer-consumer workflows
    probes.ts                  sensitive-source/dangerous-sink/canary cases
    metamorphic.ts             paired-run relations
    agent.ts                   optional untrusted semantic proposal adapter

src/mcp/
  discovery-v2.ts              bounded catalog, duplicate rejection, both V2 digests
  workflow-session.ts          bounded multi-call execution and step phases

src/compare/
  event-fingerprint.ts         run-independent canonical effect fingerprints
  trace-comparison.ts          added/removed/count/order deltas with evidence IDs
  policy-evaluator.ts          one typed policy decision per observable effect
  metamorphic-evaluator.ts     pass/fail/inconclusive relation evaluation

# Future, after the audit result is stable
src/attestation/
  contracts.ts                 in-toto Statement + Forge audit predicate
  build.ts                     bind exact evidence/policy/plan/coverage identities
  verify.ts                    recompute subjects and reject tampering
src/registry/
  contracts.ts                 scoped status, restriction, and expiry records
  appraise.ts                  enterprise decision kept separate from evidence
  drift.ts                     stale/revocation rules over every bound identity
```

Keep the provider-free contracts, compiler, validators, generators, comparison,
and tests outside `src/agent`. The agent proposer is one input adapter, not the
owner of the audit subsystem.

Use a standards-based canonical JSON representation for any future signing
boundary. The private sorter currently used for report comparison and ordinary
`JSON.stringify` hashes are useful internal identities but should not be
promoted to a cross-implementation attestation format without a specified
canonicalization algorithm and test vectors.

Suggested tests:

```text
test/unit/audit-contracts.test.ts
test/unit/audit-catalog-v2.test.ts
test/unit/audit-canonical.test.ts
test/unit/audit-plan-validation.test.ts
test/unit/audit-approval-receipt.test.ts
test/unit/audit-schema-generation.test.ts
test/unit/audit-stateful-generation.test.ts
test/unit/audit-policy.test.ts
test/unit/audit-metamorphic.test.ts
test/unit/audit-coverage.test.ts
test/unit/audit-comparison.test.ts
test/unit/audit-agent-boundary.test.ts
test/unit/audit-discovery-v2.test.ts
test/unit/audit-workflow-session.test.ts
test/unit/audit-trace-comparison.test.ts
test/unit/audit-metamorphic-evaluator.test.ts
test/unit/audit-attestation-binding.test.ts
test/unit/audit-registry-drift.test.ts
```

Do not implement custom signing cryptography. An early attestation prototype
may emit a standards-shaped **unsigned** statement that is unmistakably labeled
unsigned; integrate an established signer such as Sigstore only at a separate
deployment/security boundary.

Add adversarial fixtures only when they test a specific threat or mutation; do
not turn the repository into a broad collection of shallow examples.

## Validation experiment: prove whether the agent helps

Use a common mandatory suite, then evaluate three optional-case strategies:

| Arm | Cases included | Question |
| --- | --- | --- |
| A: manual | Mandatory suite plus cases authored by a human under a fixed authoring and execution budget | What does today's manual approach find? |
| B: deterministic | The same mandatory suite plus schema/stateful/security/metamorphic cases under the same optional execution budget | What can non-LLM automation add? |
| C: hybrid | The same mandatory suite plus deterministically generated and validated LLM-proposed cases under the same total optional execution budget | Does semantic planning improve selection/yield? |

All arms must use the same artifact, environment family, policy, evidence
sensors, finding rules, and gold labels. Differences in the model arm must not
come from weaker policy or broader host access.

Run two analyses:

1. **Fixed-budget head-to-head:** equal optional-case count and Docker-minute
   ceilings after the common mandatory suite. Fix the human authoring budget
   for Arm A, including on the independently selected third target. Preregister
   how Arm C divides its budget between deterministic and agent-proposed cases,
   plus proposer-call, input/output-token, candidate-count, latency, and cost
   limits. Rejected, invalid, and duplicate proposals consume that generation
   budget. Select candidates for the execution ceiling using a deterministic
   ranking and tie-break rule fixed before outcomes are revealed; an arbitrarily
   large proposal pool followed by favorable selection is not a fair arm.
2. **Nested marginal-yield curve:** A, then A+B additions, then A+B+C additions
   may be run to show which extra cases found which mutations, but do not call
   raw recall differences causal when later arms executed more cases. Plot
   confirmed unique findings against cumulative cases, Docker minutes, and
   total cost.

Mutation curators and gold-label reviewers should be separate from generators
and, where practical, blinded. The manual author receives the public
interface/policy/synthetic world, not the hidden mutation implementation or
gold label.

### Corpus and mutations

Start with:

- Pinned official Filesystem MCP as a real positive/mostly benign case.
- Existing deceptive MCP fixture as a controlled negative case.
- Existing agent tool-poisoning fixture for metadata studies.
- At least one third independent real MCP with different semantics.

The **direct-runtime generator corpus** should contain hand-reviewed mutations
covering:

- Legitimate temp file, DNS lookup, and worker process.
- Hidden sensitive-file or configuration read.
- Wrong destination and parameter tampering.
- Unexpected child process.
- Delayed post-return behavior.
- Install/startup-only behavior.
- Interface/catalog drift and claim/runtime mismatch.
- Persistent or multi-step trigger.
- Schema boundary and oversized catalog traps.
- Sandbox/environment detection where safely reproducible.

The gold set must distinguish policy violation, confirmed flow, correlated
risk, benign undocumented behavior, invalid experiment, and inconclusive
evidence. Do not use an LLM's labels as the gold set.

Keep a separate **Agent V1 trajectory corpus** for metadata poisoning,
cross-tool steering, and eventually target-result injection. Metadata attacks
test the proposal/rollout trust boundary; they are not direct-runtime mutation
kills. Target-result injection is not implemented until Phase 5. Neither class
belongs in Arms A/B/C's direct-generator recall denominator.

For the existing clean/poisoned metadata pair, randomize or block-interleave
condition order. Use the same requested model, provider, task, tool catalog and
ordering, policy, limits, synthetic-world shape, and scoring. Persist an exact
initial provider-request projection/diff proving only the declared treatment
field changed, and verify the provider's returned model identity; routing drift
makes the trial invalid/inconclusive. Later requests may legitimately diverge
because earlier treatment-influenced outputs and tool decisions enter history;
use identical request-construction logic and record later differences as
treatment descendants rather than requiring byte equality. Analyze `enforce`
and `observe` modes separately. Before live trials, preregister the primary
outcome, sample size/power rationale, interval or hypothesis-test method, and
handling of refusals, provider errors, routing drift, and other inconclusive
trials. Report the matched rate delta with uncertainty; do not call the
scripted `verify:agent` trajectory causal evidence. If an ablated or
researcher-written description is used, call it `ablated` or `sanitized`, not
`canonical` or ground truth.

### Metrics

Define units and denominators before measuring:

- Primary recall unit: one curator-labeled in-scope target/mutation pair. A
  detection requires at least one hand-confirmed finding with canonical raw
  evidence mapped to that mutation. Primary recall is detected configured
  mutation pairs divided by all configured mutation pairs; also publish a
  conclusive-only secondary rate so infrastructure failure cannot disappear.
- Precision unit: one deduplicated finding group keyed by target/mutation,
  finding family, and run-independent effect fingerprint. Precision is
  hand-confirmed groups divided by all reviewed groups. Duplicate warnings do
  not increase numerator or denominator.
- Benign false-positive unit: one benign control/variant incorrectly receiving
  a policy-violation or confirmed-flow finding. Publish configured and
  conclusive denominators plus inconclusive counts.
- Reproducible finding: the same finding family and run-independent evidence
  fingerprint appears in three independent runs of the pinned configuration;
  preregister any less strict threshold before results. These reruns establish
  repeatability for one target/mutation pair; they are not three independent
  mutation samples for inferential statistics.
- Arm C marginal cost: proposer tokens/provider charge plus validation and
  execution Docker minutes beyond Arm B, divided by C-only confirmed mutation
  detections. If there are no C-only detections, cost per novel finding is
  infinite/undefined and the arm fails the value gate.

Then measure at least:

- Unique true findings by arm and finding family.
- False-positive/overblocking rate.
- Tool, schema-partition, workflow, lifecycle, sensor, and mutation coverage.
- Invalid or unsafe generated plans rejected before execution.
- Reviewer edit distance and review time for generated plans.
- Reproducibility across repeated generation and execution.
- Inconclusive/timeout/truncation rate.
- p50/p95 latency, token use, and provider cost.
- Containment and cleanup failures.
- Agent-proposal duplication of deterministic cases.
- Sensitivity to model/provider/prompt version.

For A/B/C inference, preregister the recall-difference confidence interval or
test, use the target/mutation pair as the statistical unit, and account for
clustering within targets. Do not inflate sample size with reproducibility
reruns of the same mutation.

### Go/no-go rule

Call the agent proposer an improvement only if Arm C adds hand-confirmed unique
findings over Arm B at an agreed precision, review burden, reproducibility, and
cost. A higher number of warnings is not success. If it primarily restates
claims or generates rejected/duplicate cases, retain only deterministic V2.

Pre-register numeric thresholds before looking at the held-out results. A
reasonable initial proposal, subject to reviewer adjustment before execution,
is:

- Arm B recall is no more than five percentage points below Arm A, with no
  precision/benign-false-positive regression, and produces at least twice as
  many valid cases per operator-hour.
- Arm C finds at least two reproducible, evidence-backed held-out mutations
  across two targets that Arm B misses, **or** improves recall by at least ten
  points with a confidence interval excluding zero.
- Arm C causes no authorization, credential, containment, evidence-integrity,
  or cleanup regression. Its marginal cost must remain below an absolute
  provider/Docker/operator budget preregistered for the corpus. When Arm B has
  at least one comparable confirmed novel detection, also require Arm C's cost
  per C-only detection to be no more than three times Arm B's cost per B-only
  detection; otherwise use the absolute ceiling rather than dividing by zero.
- Any unauthorized dispatch/effect, credential exposure, containment escape,
  accepted evidence tamper, or unverified cleanup is a zero-tolerance stop.

Do not fine-tune a model until there is a versioned, hand-reviewed dataset and a
held-out evaluation. Prompt tuning on the same fixtures used for acceptance
would give a misleading result.

## Threat model and required adversarial tests

Assume all of the following can be malicious:

- Package source, dependencies, install scripts, and runtime code.
- Tool names, descriptions, schemas, annotations, and results.
- Provider responses and diagnostics.
- Agent-proposed plan fragments and explanations.
- Timing, output volume, process behavior, symlinks, and cleanup behavior.

Assume the external model can be prompt-injected. Reading poisoned metadata
outside the target sandbox is acceptable only because that model has no direct
tools, credentials, host access, approval authority, or executable output. The
trusted controller must still treat every returned byte as hostile. If metadata
is proprietary or regulated, provider disclosure is a separate confidentiality
decision; use an approved provider projection, a local model, or no model.

Required negative tests include attempts to:

- Insert extra DSL fields or alternate schema versions.
- Encode shell commands in strings and symbolic references.
- Traverse paths through aliases, Unicode, normalization, or symlinks.
- Select real network destinations.
- Override target command, environment, mount, sandbox, observer, or limits.
- Remove mandatory tests or lower coverage requirements.
- Reference nonexistent/drifted tools or stale schemas.
- Cause combinatorial generation explosions.
- Smuggle provider credentials in escaped/decoded response values or errors.
- Poison an evidence explanation so it claims nonexistent event IDs.
- Exploit target output size, stderr, transcript, trace, file, inode, PID, time,
  or cleanup budgets.
- Trigger behavior after the declared observation window.
- Make the target detect the sandbox and suppress behavior.

Some attacks can only be mitigated, not eliminated. Record residual risk rather
than burying it.

### Release-blocking acceptance matrix

Turn these IDs into automated tests or explicit production gates. Phases 1–4
may run on the documented prototype boundary, but any test marked
**production** blocks registry/runtime claims until a hardened external boundary
exists. A skipped test is visible coverage debt, not a pass.

| ID | Scope | Acceptance condition |
| --- | --- | --- |
| TB-01 | Phase 1 | Inject one policy-changing sentinel into every untrusted channel. Only captured evidence may differ; policy, mounts, egress, model, quotas, scoring, and admission inputs remain identical. |
| TB-02 | Phase 1 | Missing policy, validator failure, malformed proposal, model timeout, observer error, or plan drift yields fatal/inconclusive and cannot publish an admissible result. |
| TB-03 | Phase 1 | A typed ApprovalReceipt is issued only after hashing and binds exact normalized metadata, `rawDiscoveryDigest`, `planCatalogDigest`, policy, AuditSpec, ExperimentPlan, and synthetic-manifest bytes. Any later mutation or either catalog mismatch fails before dispatch and admissible publication. |
| TB-04 | Phase 4 | Inventory environment, file descriptors, mounts, routes, identities, capabilities, and reachable endpoints for controller/proposer/target/worker/observer; each matches a versioned allowlist. |
| CRED-01 | Existing/Phase 4 | Literal credentials in task, metadata, schema keys/values, or history cause pre-fetch refusal; fetch and dispatch counts remain zero. |
| CRED-02 | Existing/Phase 4 | A one-level JSON Unicode escape reconstructed during completion parsing is rejected before dispatch and persistence. |
| CRED-03 | Phase 4 | Tests enumerate and enforce every additional claimed representation—surviving `\\u` text, double escaping, percent, base64/base64url, hex, mixed case, chunk boundaries. Documentation must not claim more than the tests. |
| CRED-04 | Phase 4 | Network exceptions, HTTP bodies, malformed fields, target/tool errors, cleanup diagnostics, and reports never persist the literal key; redirects are refused so an authorization header cannot cross origin. |
| CRED-05 | Production | The raw provider key exists only in an egress-auth component; controller/proposer/guest/evidence/signer cannot read it. Broker failure is fatal with no fallback. Provider-origin fragments can never reach a real external sink. |
| EXP-01 | Phase 1 | Unknown fields, duplicate IDs/keys, invalid Unicode/numbers, over-depth/width/size/count inputs, remote `$ref`, executable hooks, shell/code/templates, arbitrary URLs, host paths, and environment references are rejected. |
| EXP-02 | Phase 1 | MCP or model content is structurally unable to set approval authority, alter mandatory probes, lower budgets, or change sandbox/observer/cleanup. |
| EXP-03 | Phase 1 | Without an operator/enterprise policy, the result is `oracle_missing`/inconclusive; metadata-derived expectations cannot substitute. |
| EXP-04 | Phase 2 | Every positive generated input revalidates against the exact frozen schema; unsupported keywords and generator failures reduce coverage rather than yield a clean result. |
| EXP-05 | Phase 3 | Workflow bindings use bounded JSON pointers and typed values only. Tool results remain tainted data and cannot become instructions or executable interpolation. |
| EXP-06 | Phase 3 | Clean/control and treatment runs freeze every dimension except the declared variable. Applicability, nondeterminism, failed runs, and inconclusive relations are explicit. |
| AG-01 | Phase 4 | The proposer has no target/controlled tools or direct dispatch path. Unknown/forbidden tool proposals are recorded and dispatch count remains zero. |
| AG-02 | Phase 3/4 | Every dispatch path—including dynamically bound workflow steps, retries, concurrency, fallbacks, and resumed workflows—requires one reference-monitor receipt bound to trial, plan, `rawDiscoveryDigest`, `planCatalogDigest`, tool identity, canonical arguments, policy digest, sequence, and expiry. |
| AG-03 | Phase 4 | Duplicate keys, Unicode-confusable names, traversal, schema confusion, canonicalization collisions, quota races, and unsafe automatic retries fail closed. Untrusted `idempotentHint` never authorizes a retry. |
| AG-04 | Phase 4 | Arbitrarily changing explanation-model output leaves structured findings, scores, approval, and admission bytes unchanged. |
| SBX-01 | Phase 1/production | Before V2 execution, acquisition with lifecycle disabled and each lifecycle/discovery/runtime execution boundary are explicit and tested; malicious install/runtime code cannot access host/control-plane credentials or arbitrary networks. Production hostile-code claims require physically disposable workers/microVMs and an external observer. |
| SBX-02 | Phase 1/production | Guest probes cannot access host home/workspace, Docker/KVM APIs, block devices, control sockets, provider/signing/registry credentials, metadata services, private ranges, DNS/IPv4/IPv6 egress, or other trials. Re-run the inventory against both prototype and production profiles; do not inherit the claim from Docker configuration alone. |
| SBX-03 | Phase 1 before V2 execution | Fork, memory, CPU, writable-profile/evidence disk and inode use, per-file size, stdout/stderr/MCP/trace totals, file descriptors, oversized JSON, sleep, and orphan-process attacks hit independent host-enforced or externally monitored limits and are killed by a declared deadline. Current core bind mounts/cumulative streams do not yet meet this gate. |
| SBX-04a | Existing/Phase 1 | Under normal controller operation, success, timeout, target crash, forced target kill, and quota violation receive label-verified cleanup and leave no live managed process/container/cgroup/mount or writable execution profile. Ambiguous cleanup blocks publication. Retained evidence/profile artifacts may remain intentionally and must be bounded/read-only to consumers. |
| SBX-04b | Production | After hard controller interruption or host-worker failure, an external lease/supervisor/reaper removes every live managed process/VM/cgroup/TAP/mount/writable execution profile by deadline. In-process `finally` cleanup is not sufficient. |
| SBX-05 | Production | Observer and kill switch are outside the guest. Guest attempts to stop, forge, truncate, reorder, or overwrite evidence fail and are externally recorded. |
| EVID-01 | Phase 1 | `proposed`, `authorized`, `dispatch_attempted`, `target_acknowledged`, `effect_observed`, and `cleanup_verified` are separate facts; no stage is inferred from another. |
| EVID-02 | Phase 1 | Controller-owned monotonic sequence/hash manifests detect byte changes, deletion, insertion, reordering, policy replacement, or fabricated findings. |
| EVID-03 | Phase 1 | Missing/truncated/error evidence makes negative claims inconclusive. Atomic publication prevents a killed partial run from exposing a completed/admissible marker. |
| EVID-04 | Phase 1 | HTML, Markdown links, terminal escapes, path traversal, and prompt text in evidence render inertly and never execute or fetch content. |
| EVID-05 | Production | Signing keys live in an isolated signer/KMS/HSM; attestations bind artifact/dependency, metadata, policy, plan, model, harness, sandbox, observer, evidence-manifest, result, and coverage digests. |
| EVAL-01 | Phase 4 | Report task utility, unauthorized proposal, authorization decision, dispatch, observed harmful effect, containment, and cleanup as separate axes with every configured trial in denominators. |
| EVAL-02 | Phase 4 | 429/5xx, disconnect, timeout, malformed/truncated/oversized data, duplicate delivery, forged usage, unexpected model routing, and provider drift are bounded or inconclusive; deterministic CI never needs a live key. |
| EVAL-03 | Phase 4 | Local completion/call/byte/time/cost/concurrency quotas hold even when provider usage is absent or false; held-out and adaptive attacks remain separate from tuning data. |
| REG-01 | Production | Admission is exact-identity and scoped to organization/policy/environment, uses restricted/review/rejected/inconclusive/stale statuses, and never treats publisher authenticity as safety. |
| REG-02 | Production | Artifact, dependency, metadata/schema, endpoint, policy, analyzer, sandbox, observer, or critical model/client drift marks the entry stale before use; revocation and rollback tests fail closed. |
| REG-03 | Production | Registry evidence grants no capability by itself. A runtime gateway still authorizes every exact tool call/argument and enforces restrictions. |

For statistical marketing claims, pre-register the statement and sample size.
For example, observing zero failures is not evidence that an attack-success rate
is below 1% at 95% confidence until roughly 299 independent trials have been
run for that exact model/client/policy/scenario configuration; even then the
claim remains configuration-specific.

## Known limitations that must remain visible

- Metadata and source analysis cannot prove reachability or intent.
- Runtime analysis observes only selected inputs, workflows, timing windows,
  sensors, and environments.
- Blocked egress changes target behavior and cannot reveal all real-world
  protocol interactions.
- An in-container observer has a weaker trust boundary than an external
  observer or microVM.
- OS traces may show correlation without payload-level data flow.
- A schema rarely specifies complete business semantics or authorization.
- Current V1 `expected` scope mixes predicted behavior with effective approval;
  V2 must separate authorization, expected utility, and predicted behavior.
- Current effect classes do not express every policy distinction uniformly:
  failed attempts, `file.delete` as a write-like mutation, `network.listen`, and
  file-open access mode need explicit V2 semantics or an `unclassified` result.
- Generated tests can be invalid even when structurally schema-valid.
- Stateful workflow inference is incomplete.
- Current core orchestration aborts after an experiment failure. V2 needs an
  append-only experiment ledger that preserves partial evidence, safely
  continues independent cases when possible, and marks never-started/skipped
  coverage rather than silently losing it.
- Agent proposals are model-, prompt-, provider-, metadata-, and version-specific.
- LLM explanations and judgments can be biased or injected.
- An enterprise policy can be incomplete or wrong.
- Signed evidence proves origin/integrity under stated assumptions, not safety.
- Registry results become stale when artifacts, dependencies, metadata,
  policies, models, harnesses, or threat intelligence change.

## Definition of success

The V2 design is successfully validated when a fresh reviewer can answer, from
the artifacts rather than prose alone:

1. Exactly which artifact and interface were evaluated?
2. Which statements came from the MCP, deterministic extraction, an LLM,
   operator policy, or runtime observation?
3. Who or what authorized each executed experiment?
4. Could a malicious proposer have changed policy, sandbox, target command,
   credentials, or mandatory coverage?
5. Which tools, inputs, workflows, phases, variants, and sensors were covered?
6. Which raw evidence supports each finding?
7. Is a source-to-sink finding confirmed or merely correlated?
8. What did the agent add beyond deterministic generation?
9. What remains untested or inconclusive?
10. Under which exact restrictions and expiry could a registry rely on the
    result?

## Immediate review questions for the implementing agent

Before writing code, independently answer and record:

1. Should the frozen `ExperimentPlan` adapt into existing V1 execution
   primitives, or does the runner need a smaller internal experiment interface
   first? Do not make the V2 AuditSpec pretend the interface was known before
   sandboxed discovery.
2. Which new claim dimensions can current `strace` and filesystem-state sensors
   actually substantiate without overclaiming?
3. What is the smallest useful manual Phase 1 schema that does not prematurely
   embed a full enterprise policy language?
4. Which JSON Schema keywords are safe and valuable to generate in Phase 2?
5. How will expected-invalid MCP calls be represented and distinguished from
   target/infrastructure failures?
6. What output evidence is required before implementing producer-consumer
   workflows?
7. Can controlled network payload observation be added without enabling real
   egress?
8. How will plan hashes bind the discovered interface and post-install runtime
   snapshot rather than only the input YAML?
9. How will partial runs and cleanup failures affect coverage and admission?
10. What precision/cost threshold will make Arm C worth operating?

If these answers materially contradict the design, update this document with a
decision record before implementation rather than silently changing the trust
model.

## Non-goals for the next implementation wave

- A universal malware verdict.
- A public registry or deployment gateway before the evidence model is stable.
- Automatic enterprise-policy discovery from MCP metadata.
- Fine-tuning a planner on the current tiny fixture set.
- Arbitrary LLM-authored code execution.
- Real credentials, production accounts, or uncontrolled network access.
- Merging direct software evidence and agent trajectories into one ambiguous
  score.
- Broad language/transport support at the expense of depth on the current
  Node.js/STDIO path.
- Replacing current core hardening with supplementary agent work.

## Annotated research and standards links

Primary/official sources are preferred here. Re-check versions and publication
status when implementing.

### MCP protocol and registry

1. [MCP specification, 2025-03-26](https://modelcontextprotocol.io/specification/2025-03-26/index) — protocol baseline and security context.
2. [MCP tools specification, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) — model-controlled tools, inputs, outputs, and client responsibilities.
3. [MCP schema reference, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/schema) — descriptions and explicitly untrusted tool-annotation hints.
4. [Tool Annotations as Risk Vocabulary](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/) — official explanation of what annotations can and cannot establish.
5. [Official MCP Registry documentation](https://registry.modelcontextprotocol.io/docs) and [registry launch/subregistry model](https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/) — basis for Forge as an opinionated downstream enterprise registry.

Additional official trust-boundary references:

- [MCP Security Policy and Intended Trust Model](https://github.com/modelcontextprotocol/modelcontextprotocol/security) — local STDIO servers run with environment-level privilege, and the protocol/SDK is not a sandbox.
- [MCP transport specification, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) — includes Origin validation and local-binding guidance for Streamable HTTP; relevant when Forge later considers remote MCPs.
- [Official MCP Registry: About](https://modelcontextprotocol.io/registry/about) — the official registry is intentionally a distribution/discovery foundation rather than Forge-style behavioral approval.

### MCP and agent security

6. [MCPTox: A Benchmark for Tool Poisoning on Real-World MCP Servers](https://ojs.aaai.org/index.php/AAAI/article/view/40895) and [paper PDF](https://ojs.aaai.org/index.php/AAAI/article/download/40895/44856) — metadata poisoning benchmark; 45 servers, 353 tools, 1,348 cases, 72.8% maximum reported ASR.
7. [MCP-ITP: An Automated Framework for Implicit Tool Poisoning in MCP](https://arxiv.org/abs/2601.07395) — adaptive implicit metadata poisoning, including steering toward other privileged tools; preprint status must be stated.
8. [AgentDojo](https://proceedings.neurips.cc/paper_files/paper/2024/file/97091a5177d8dc64b1da8bf3e1f6fb54-Paper-Datasets_and_Benchmarks_Track.pdf) — dynamic utility/security evaluation for result-channel prompt injection.
9. [InjecAgent](https://aclanthology.org/2024.findings-acl.624/) — indirect prompt-injection benchmark for tool-integrated agents.
10. [CaMeL: Defeating Prompt Injections by Design](https://arxiv.org/abs/2503.18813) and [research artifact](https://github.com/google-research/camel-prompt-injection) — capability/data-flow separation around a trusted query.
11. [AgentSpec](https://cposkitt.github.io/files/publications/agentspec_llm_enforcement_icse26.pdf) — structured policy DSL and runtime enforcement; generated policy remains incomplete.
12. [ToolEmu](https://proceedings.iclr.cc/paper_files/paper/2024/file/7274ed909a312d4d869cc328ad1c5f04-Paper-Conference.pdf) — emulated tool-use safety testing and adversarial scenarios.

- [Adaptive Attacks Break Defenses Against Indirect Prompt Injection](https://aclanthology.org/2025.findings-naacl.395/) — fixed defenses must be evaluated against adaptive held-out attacks, not only the attacks used to design them.

### Test generation, discrepancies, and the oracle problem

13. [RESTler: Stateful REST API Fuzzing](https://www.microsoft.com/en-us/research/publication/restler-stateful-rest-api-fuzzing/) and [paper PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/2021/03/RESTler.pdf) — specification-derived, dependency-aware, feedback-guided stateful generation.
14. [Can Large Language Models Write Good Property-Based Tests?](https://arxiv.org/abs/2307.04346) — supports model-assisted test proposals while quantifying incomplete property coverage.
15. [CHABADA: Checking App Behavior Against App Descriptions](https://www.st.cs.uni-saarland.de/appmining/chabada/CHABADA.pdf) — useful precedent for description/behavior anomaly detection and its false-positive limits.
16. [The Oracle Problem in Software Testing: A Survey](https://discovery.ucl.ac.uk/id/eprint/1471263/) — specifications, contracts, metamorphic testing, and other partial oracle strategies.
17. [How Effectively Does Metamorphic Testing Alleviate the Oracle Problem?](https://doi.org/10.1109/TSE.2013.46) — empirical support for diverse metamorphic relations as partial oracles.

### Dynamic analysis and isolation

18. [Comparing Malware Evasion Theory with Practice](https://www.usenix.org/conference/soups2024/presentation/yong-wong) — why static, dynamic, varied-environment, and manual techniques remain complementary.
19. [Firecracker: Lightweight Virtualization for Serverless Applications](https://www.usenix.org/conference/nsdi20/presentation/agache) — microVM isolation/performance design reference.
20. [gVisor documentation](https://gvisor.dev/docs/) — user-space application-kernel isolation reference.
21. [Linux Landlock userspace API](https://docs.kernel.org/userspace-api/landlock.html) — unprivileged restriction of ambient filesystem/network rights as a possible defense-in-depth layer.

- [Firecracker production-host setup](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md) — production use requires the jailer, seccomp, patched hosts, resource controls, and an external overwatcher; “use a microVM” is not a complete security design.

### Policy, evidence, and attestations

22. [Open Policy Agent documentation](https://www.openpolicyagent.org/docs) — separation of policy decision from enforcement.
23. [Cedar policy language](https://docs.cedarpolicy.com/) and [validation](https://docs.cedarpolicy.com/policies/validation.html) — analyzable authorization-policy reference.
24. [IETF RFC 9334: RATS Architecture](https://www.rfc-editor.org/rfc/rfc9334.html) — evidence, verifier appraisal, attestation result, and relying-party policy separation.
25. [SLSA v1.2 provenance](https://slsa.dev/spec/v1.2/provenance) — binding artifacts to how and where they were produced.
26. [in-toto Attestation Framework](https://github.com/in-toto/attestation/blob/main/spec/README.md) — generic signed statement/envelope model.
27. [Sigstore Cosign verification](https://docs.sigstore.dev/cosign/verifying/verify/) — possible future distribution and verification mechanism.

### LLM evaluation caution

28. [Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685) — documents position, verbosity, self-enhancement, and reasoning biases; useful for calibrating but not authorizing LLM judgment.

### Provider privacy and governance

- [OpenRouter data collection and retention controls](https://openrouter.ai/docs/guides/privacy/data-collection) — live-provider experiments need an explicit disclosure/retention decision in addition to execution containment.
- [NIST AI RMF Generative AI Profile](https://doi.org/10.6028/NIST.AI.600-1) — governance, measurement, documentation, and residual-risk framing for generative-AI systems.

## Suggested kickoff prompt for a fresh implementation agent

> Read `AGENTS.md`, `PROJECT_MEMORY.md`, `README.md`,
> `ArchitectureAndTrustModel.md`, `AgentRolloutV1.md`, and
> `EvidenceFirstV2Plan.md` completely. Verify the live Git/worktree state and
> current tests; never read or stage `keys.md`. Independently validate the
> research claims and challenge the proposed trust boundaries. Then write a
> concise validation memo covering: (1) whether the evidence-first,
> policy-anchored, agent-assisted design is superior to deterministic-only and
> agent-as-oracle alternatives; (2) the smallest provider-free Phase 1 change;
> (3) exact existing modules to reuse; (4) schema and security invariants; and
> (5) acceptance tests. Do not implement until the memo identifies any
> disagreements and confirms that the current deterministic-core wave is
> committed or intentionally isolated. Once validated, implement Phase 1 only,
> preserve `forge.target/v1`, `forge.report/v1`, `forge analyze`, and Agent V1
> separation; add V2 behind an opt-in path, run all required gates, and report
> evidence rather than unsupported safety claims.

## Final recommendation

Proceed, but proceed in the order above.

The theoretically stronger system is not one where an LLM decides what an MCP
meant and then grades itself. It is one where Forge:

1. Preserves untrusted claims.
2. Applies independent policy.
3. Generates more and better bounded experiments from several sources.
4. Validates and freezes those experiments before execution.
5. Runs the same deterministic, sandboxed evidence pipeline.
6. Compares claims, policy, risk, observations, and coverage separately.
7. Uses models only to propose or explain, with measured incremental value.
8. Eventually binds the result to an exact artifact in a curated registry and
   enforces the approved policy at deployment time.

That direction remains faithful to the README, makes the system more
generalizable, and avoids making prompt-injected model output the foundation of
the security decision.
