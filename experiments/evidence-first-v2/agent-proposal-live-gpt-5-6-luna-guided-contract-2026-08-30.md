# Live Evidence-First V2 agent-proposal study

- Study: `forge-agent-proposal-live-study-2026-08-30`
- Model requested: `openai/gpt-5.6-luna`
- Context digest: `b0c12ee790b97c879c983a7fb5e5d227f03b6dbd32f2b1c1dab7bc1954493a6d`
- Baseline digest: `76f3220b85d43f62298240cb5260dd861e58f9e47121b2a3eb230a2b74980711`
- Trials: 5 completed, 0 failed
- Estimated provider cost: $0.016883 (5 priced trials)

The tool metadata and model submissions are untrusted experimental data.
No target was executed, no approval was issued, and no ExperimentPlan was produced.

## Aggregate result

- 27 candidates submitted; 27 accepted as novel, 0 baseline duplicates, 0 within-trial duplicates, and 0 rejected.
- Deterministic pass rate: 100.0%.
- Accepted-novel rate: 100.0%.
- Cross-trial semantic diversity: 14 unique accepted semantics from 27 accepted occurrences.
- Fixed opportunity coverage: 6/6 (100.0%).
- Approval understatements corrected deterministically: 0.
- Model-routing mismatches: 0.

## Per-trial result

| Trial | Status | Submitted | Rejected | Baseline duplicates | Accepted novel | Opportunities | Tokens | Latency | Est. cost |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| live-trial-01 | completed | 5 | 0 | 0 | 5 | sensitive_resource_probe, upper_numeric_boundary, nonbaseline_enum_partition, boolean_toggle | 5432 | 18130 ms | $0.003215 |
| live-trial-02 | completed | 6 | 0 | 0 | 6 | sensitive_resource_probe, upper_numeric_boundary, nonbaseline_enum_partition, boolean_toggle | 5600 | 17582 ms | $0.003417 |
| live-trial-03 | completed | 5 | 0 | 0 | 5 | sensitive_resource_probe, upper_numeric_boundary, nonbaseline_enum_partition, boolean_toggle | 5415 | 17026 ms | $0.003195 |
| live-trial-04 | completed | 5 | 0 | 0 | 5 | sensitive_resource_probe, lower_numeric_boundary, upper_numeric_boundary, nonbaseline_enum_partition, boolean_toggle, sensitive_resource_combination | 5626 | 18501 ms | $0.003448 |
| live-trial-05 | completed | 6 | 0 | 0 | 6 | sensitive_resource_probe, lower_numeric_boundary, upper_numeric_boundary, nonbaseline_enum_partition, boolean_toggle, sensitive_resource_combination | 5759 | 18991 ms | $0.003608 |

## Opportunity frequency

- `sensitive_resource_probe`: 5/5 completed trials
- `lower_numeric_boundary`: 2/5 completed trials
- `upper_numeric_boundary`: 5/5 completed trials
- `nonbaseline_enum_partition`: 5/5 completed trials
- `boolean_toggle`: 5/5 completed trials
- `sensitive_resource_combination`: 2/5 completed trials

## Interpretation limits

- `accepted_novel` means contract-valid, policy-eligible, and absent from the five-case baseline by exact tool-and-argument semantics. It is not a vulnerability finding.
- The six opportunities are operator-authored metadata-coverage probes frozen before the live calls; they are not a complete ground truth.
- Repeated temperature-zero calls estimate consistency for this provider route, not broad model quality.
- No candidate was freshly compiled into an ExperimentPlan or executed. Runtime usefulness and finding recall remain unmeasured.

The complete bounded submissions and deterministic comparison reports are in [the JSON record](./agent-proposal-live-gpt-5-6-luna-guided-contract-2026-08-30.json).
