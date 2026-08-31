# Evidence-First V2 agent proposal experiment

**Status:** experimental proposal and comparison path implemented. It does not
execute an MCP, produce an `ExperimentPlan`, issue approval, or change the seven
authoritative V2 top-level contracts.

This prototype answers a narrow question: can a model look at a tool's name,
title, description, input/output schemas, symbolic synthetic resources, and
already-covered cases, then propose candidate experiments that survive the
existing deterministic controls?

The answer is now measurable. The proposer is an untrusted input adapter; the
deterministic system remains the judge of structural eligibility. A proposal
that passes is only **eligible for operator review and fresh compilation**.

## Run it

The reproducible default uses the existing offline scripted provider:

```bash
npm run experiment:v2-proposals
```

It prints the checked-in comparison represented by
[agent-proposal-comparison-scripted.json](fixtures/evidence-first-v2/agent-proposal-comparison-scripted.json).
The provider submission itself is
[agent-proposals-scripted.json](fixtures/evidence-first-v2/agent-proposals-scripted.json).

An explicit live OpenRouter run is also wired through the existing hardened
provider adapter:

```bash
OPENROUTER_API_KEY=... npm run experiment:v2-proposals -- \
  --live --model <provider/model>
```

The command never reads `keys.md`. It requires the environment variable only
in `--live` mode, checks that the credential is absent from the outbound
request, and never writes it or the raw model response to the report. A live
provider call is external data processing and should be run only under an
explicit provider disclosure/retention decision.

## What the model receives

`prepareAgentProposalExperiment` first runs the provider-free V2 compiler over
the baseline. Only after those target, catalog, claim, policy, AuditSpec,
mandatory-suite, resource, and schema bindings pass does it create
`forge.agent-proposal-context/v1alpha1`.

The provider projection contains:

- exact catalog identity;
- exact tool name, optional title/description, input schema, and output schema;
- the label `metadataTrust: untrusted_mcp`;
- synthetic resource alias, class, and media type, but never resource content;
- canonical tool-and-symbolic-argument semantics for existing cases;
- hashes binding the target, policy, AuditSpec, and baseline;
- candidate, accepted-case, and step budgets; and
- explicit false authority flags.

It does not contain target bytes, host paths, provider credentials, synthetic
canary values, raw policy text, runtime outcomes, or any target/controlled
tools. The provider receives one controller tool only:
`submit_experiment_proposals`.

The exact function schema is generated from
`typedAgentProposalSubmissionV2Schema`. Conceptually the output is:

```json
{
  "format": "forge.agent-proposal-submission/v1alpha1",
  "proposals": [
    {
      "proposalId": "bounded-id",
      "case": {
        "caseId": "bounded-id",
        "kind": "tool_call",
        "description": "why this case exists",
        "steps": [
          {
            "stepId": "bounded-id",
            "toolName": "exact_catalog_name",
            "arguments": {
              "path": { "$forgeResource": "approved.alias" }
            }
          }
        ],
        "predictedEffects": [],
        "assertions": [],
        "minimumApprovalClass": "automatic"
      },
      "rationale": "untrusted model rationale",
      "ambiguities": []
    }
  ]
}
```

The real schema requires at least one predicted effect and assertion. Every
agent prediction must say `origin: model_inference` and cite only
`model_output`; it cannot impersonate an operator, deterministic generator, or
ClaimProfile. Constrained decoding is guidance, not a trust boundary. Runtime
parsing remains strict and candidate-local, so one malformed candidate becomes
one rejection row instead of erasing valid siblings.

## Deterministic comparison

For every candidate, the controller performs this fixed sequence:

1. Strictly clone and bound the raw submission; reject unknown fields and
   malformed candidate contracts.
2. Reject duplicate proposal/case IDs and collisions with baseline IDs.
3. Restrict the current executable subset to `tool_call` and
   `security_probe`; workflows remain proposal vocabulary but are rejected.
4. Resolve only exact `{$forgeResource: alias}` markers to controller-created
   synthetic paths. Host paths, URIs, traversal, environment interpolation,
   executable-like keys, and unsupported bindings fail closed.
5. Require an exact frozen-catalog tool and run the existing V2 schema-safety
   checks plus strict AJV argument validation.
6. Evaluate the resolved candidate through `experimentDispatchRules` with
   origin `agent_proposed`. Policy must explicitly name that origin.
7. Recompute the deterministic approval class. A model's lower suggestion is
   preserved as an understatement warning, never trusted.
8. Hash only ordered tool names and unresolved symbolic arguments for semantic
   duplication. Case names, prose, predictions, and assertions cannot disguise
   the same invocation as a new experiment.
9. Compare bounded features for tools, argument shapes/resource classes,
   predicted effect classes, case kind, and assertion kind.

The output format is `forge.agent-proposal-comparison/v1alpha1`. It is an
experimental report, not a new authoritative V2 artifact. Every report fixes:

```json
{
  "executionAuthorized": false,
  "approvalIssued": false,
  "experimentPlanProduced": false,
  "requiredNextStep": "operator_review_and_fresh_compilation"
}
```

## Reproducible example result

The controlled example starts with one compiler-validated mandatory nominal
read. Its evaluation-only policy explicitly adds `agent_proposed` to the two
existing dispatch rules. This is a local research input; it does not mutate the
checked-in Phase 1A policy or enable proposals in `AuditSpec`.

| Candidate | Deterministic result | Why |
| --- | --- | --- |
| ordinary document read | `duplicate_baseline` | Same exact tool and symbolic arguments as the mandatory case |
| synthetic credential read | `accepted_novel` | Valid schema/reference and explicitly policy-eligible; deterministic class rises from the model's `automatic` suggestion to `security_review` |
| literal host credential path | `unsafe_reference` | Synthetic-resource-only reference monitor rejects the host path |
| two-step workflow | `unsupported_case_kind` | Phase 1A has no workflow reference monitor |

Summary: four submitted, two rejected, one baseline duplicate, and one novel
candidate eligible for review. The agent-only feature set adds the synthetic
credential resource class and a security-probe/effect-present shape.

This does **not** demonstrate that an LLM improves audit recall. The default
provider is scripted, and the example intentionally removes the existing
mandatory sensitive probe from the baseline so the comparator has a known
novel case. With the full Phase 1A fixture, that sensitive proposal is correctly
classified as another duplicate. The example proves contract, validation,
policy, approval-recomputation, and comparison behavior—not model value.

## What to try next

A meaningful model study should freeze a richer deterministic candidate pool
before looking at outcomes, then compare equal-budget manual, deterministic,
and hybrid arms as specified in [EvidenceFirstV2Plan.md](EvidenceFirstV2Plan.md).
The next useful examples are:

- several tools with enum, numeric-boundary, optional/null, and structured
  fields so schema-generated coverage is not trivial;
- a held-out semantic relationship that is absent from single-tool schema
  partitions but expressible as a safe static case;
- repeated live generations with exact model/prompt/context digests, token and
  latency accounting, and routing-drift handling;
- operator labels for usefulness, edit distance, and duplication; and
- later, only after the V2 runtime gates exist, evidence-backed comparison of
  unique findings rather than candidate counts.

Until then, `accepted_novel` means exactly “statically valid, policy-eligible,
and absent from this baseline semantic set.” It does not mean useful, correct,
safe, exploitable, or executed.

## First live study

The first matched live study is recorded in
[agent-proposal-live-study-summary-2026-08-30.md](experiments/evidence-first-v2/agent-proposal-live-study-summary-2026-08-30.md).
With the same five-tool context, model, temperature, and budget, five
schema-only trials produced 0/26 valid candidates, while five trials with
neutral field-placement guidance produced 27/27 valid candidates, 14 unique
semantics, and union coverage of all six fixed metadata opportunities. This is
strong evidence that prose-level contract narration matters for this provider
route; it is not evidence of runtime finding quality.
