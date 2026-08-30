# Live agent-proposal study: schema-only versus guided contract

**Run date:** 2026-08-30

**Provider route:** OpenRouter

**Requested and returned model:** `openai/gpt-5.6-luna` in all ten trials

**Execution authority:** none; no target call, `ExperimentPlan`, or approval was
created.

## Question

Can a model propose useful candidate experiments from only bounded tool names,
descriptions, input/output schemas, symbolic resources, and the existing
deterministic baseline? Does explicitly narrating the output contract change
whether those candidates survive deterministic validation?

## Frozen study design

Both arms used the same:

- five-tool catalog: `read_document`, `search_documents`,
  `convert_document`, `compare_documents`, and `write_summary`;
- five-case deterministic nominal baseline;
- four symbolic resources, including a synthetic credential and structured
  output, with no resource contents sent to the model;
- six-candidate and twelve-step limits;
- temperature `0`, 4,096 maximum completion tokens, and five sequential trials;
- context digest
  `b0c12ee790b97c879c983a7fb5e5d227f03b6dbd32f2b1c1dab7bc1954493a6d`;
- baseline digest
  `76f3220b85d43f62298240cb5260dd861e58f9e47121b2a3eb230a2b74980711`;
  and
- six operator-authored metadata opportunities frozen before live generation:
  sensitive-resource probe, lower numeric boundary, upper numeric boundary,
  non-baseline enum, boolean toggle, and sensitive multi-resource combination.

The arms differed only in prompt contract guidance:

- **Schema-only (`1alpha1`)** supplied the complete JSON function schema and
  short behavioral rules.
- **Guided (`1alpha2`)** added neutral field-placement instructions, including
  the exact allowed fields for proposal, case, predicted-effect, and assertion
  objects. It disclosed no held-out opportunity or candidate answer.

## Results

| Metric | Schema-only | Guided |
| --- | ---: | ---: |
| Completed provider trials | 5/5 | 5/5 |
| Submitted candidates | 26 | 27 |
| Deterministically valid candidates | 0 (0%) | 27 (100%) |
| Accepted novel candidates | 0 | 27 |
| Unique accepted semantics across trials | 0 | 14 |
| Fixed opportunity union | 0/6 | 6/6 |
| Provider routing mismatches | 0 | 0 |
| Tokens | 28,429 | 27,832 |
| Estimated provider cost | $0.018095 | $0.016883 |

Total measured usage was 56,261 tokens with an estimated OpenRouter cost of
$0.034978, using the prices returned by OpenRouter's model catalog on the run
date.

### Why the schema-only arm failed

All 26 candidates used the correct outer submission function, so provider
routing and the experiment envelope worked. Candidate-local validation then
rejected every proposal as `contract_invalid`.

The dominant deterministic issue paths were:

- missing `predictionId`, `resourceClass`, `phase`, and `limitations` inside
  `case.predictedEffects[0]`: 21 occurrences each;
- extra flattened fields on `case`: 21 occurrences;
- missing `origin` inside `case.predictedEffects[0]`: 16 occurrences;
- missing top-level proposal `ambiguities`: 16 occurrences; and
- missing `case.caseId`: 10 occurrences.

The generated JSON Schema was correct. The model repeatedly moved prediction
fields to the containing case despite that schema, demonstrating that this
provider route's function schema is guidance rather than guaranteed strict
decoding.

### What the guided arm proposed

The guided arm produced 27/27 contract-valid, schema-valid, reference-safe, and
policy-eligible candidates. The model covered every catalog tool:

- `read_document`: 7 candidates;
- `convert_document`: 6;
- `compare_documents`: 5;
- `search_documents`: 5; and
- `write_summary`: 4.

It proposed 20 ordinary tool calls and 7 security probes. Every trial proposed
a synthetic-credential case, a non-baseline enum, a boolean toggle, and an
upper numeric boundary. Lower boundaries and sensitive multi-resource
combinations appeared in 2/5 trials each.

The 27 accepted occurrences represented 14 unique tool-and-argument semantics.
Two sensible cases were repeated in all five trials:

- JSON conversion with metadata enabled; and
- semantic comparison with whitespace ignored.

This repetition is expected under temperature zero and is useful evidence of
consistency, but it also shows that raw accepted counts overstate diversity.

## Conclusion

For this model and fixed synthetic catalog, explicitly narrating the contract
was decisive: validity changed from 0% to 100% without changing the tool
metadata, baseline, model, budget, or opportunity set. The guided model then
generated broad schema-partition coverage and consistently noticed the
synthetic credential boundary.

This is evidence that the proposer can add statically novel candidates, not
that it finds vulnerabilities or improves runtime recall. `accepted_novel`
still means only exact semantic absence from the baseline plus candidate-local
contract, schema, reference, and policy eligibility. Assertion quality is not
semantically graded, the six opportunities are not complete ground truth, and
none of the candidates was freshly compiled or executed.

The next meaningful study should compare an equal-budget deterministic schema
generator against this guided agent, then operator-label the unique candidates
for usefulness before any runtime evaluation.

## Raw records

- [Schema-only arm](./agent-proposal-live-gpt-5-6-luna-2026-08-30.json)
  ([rendered summary](./agent-proposal-live-gpt-5-6-luna-2026-08-30.md))
- [Guided-contract arm](./agent-proposal-live-gpt-5-6-luna-guided-contract-2026-08-30.json)
  ([rendered summary](./agent-proposal-live-gpt-5-6-luna-guided-contract-2026-08-30.md))
