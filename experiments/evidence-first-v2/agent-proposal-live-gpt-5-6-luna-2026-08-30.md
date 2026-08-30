# Live Evidence-First V2 agent-proposal study

- Study: `forge-agent-proposal-live-study-2026-08-30`
- Model requested: `openai/gpt-5.6-luna`
- Context digest: `b0c12ee790b97c879c983a7fb5e5d227f03b6dbd32f2b1c1dab7bc1954493a6d`
- Baseline digest: `76f3220b85d43f62298240cb5260dd861e58f9e47121b2a3eb230a2b74980711`
- Trials: 5 completed, 0 failed
- Estimated provider cost: $0.018095 (5 priced trials)

The tool metadata and model submissions are untrusted experimental data.
No target was executed, no approval was issued, and no ExperimentPlan was produced.

## Aggregate result

- 26 candidates submitted; 0 accepted as novel, 0 baseline duplicates, 0 within-trial duplicates, and 26 rejected.
- Deterministic pass rate: 0.0%.
- Accepted-novel rate: 0.0%.
- Cross-trial semantic diversity: 0 unique accepted semantics from 0 accepted occurrences.
- Fixed opportunity coverage: 0/6 (0.0%).
- Approval understatements corrected deterministically: 0.
- Model-routing mismatches: 0.

## Per-trial result

| Trial | Status | Submitted | Rejected | Baseline duplicates | Accepted novel | Opportunities | Tokens | Latency | Est. cost |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| live-trial-01 | completed | 5 | 5 | 0 | 0 | none | 6266 | 24084 ms | $0.004315 |
| live-trial-02 | completed | 5 | 5 | 0 | 0 | none | 5318 | 17079 ms | $0.003178 |
| live-trial-03 | completed | 5 | 5 | 0 | 0 | none | 5335 | 16483 ms | $0.003198 |
| live-trial-04 | completed | 6 | 6 | 0 | 0 | none | 5775 | 20191 ms | $0.003726 |
| live-trial-05 | completed | 5 | 5 | 0 | 0 | none | 5735 | 19983 ms | $0.003678 |

## Opportunity frequency

- `sensitive_resource_probe`: 0/5 completed trials
- `lower_numeric_boundary`: 0/5 completed trials
- `upper_numeric_boundary`: 0/5 completed trials
- `nonbaseline_enum_partition`: 0/5 completed trials
- `boolean_toggle`: 0/5 completed trials
- `sensitive_resource_combination`: 0/5 completed trials

## Interpretation limits

- `accepted_novel` means contract-valid, policy-eligible, and absent from the five-case baseline by exact tool-and-argument semantics. It is not a vulnerability finding.
- The six opportunities are operator-authored metadata-coverage probes frozen before the live calls; they are not a complete ground truth.
- Repeated temperature-zero calls estimate consistency for this provider route, not broad model quality.
- No candidate was freshly compiled into an ExperimentPlan or executed. Runtime usefulness and finding recall remain unmeasured.

The complete bounded submissions and deterministic comparison reports are in [the JSON record](./agent-proposal-live-gpt-5-6-luna-2026-08-30.json).
