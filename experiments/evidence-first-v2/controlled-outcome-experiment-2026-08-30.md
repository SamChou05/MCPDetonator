# Controlled V2 outcome experiment

- **Run date:** 2026-08-30
- **Execution class:** exact repository-controlled fixture only

## Result

The complete controlled path worked for the boundary it was designed to test.

Two fresh Docker sessions used the same pinned MCP server, catalog, policy,
plan, target tree, sandbox image, output schema, and 448-byte canonical result
shape. Synthetic document content was the intended treatment variable. This was
not a strict single-variable design: case and step identifiers, mandatory versus
manual origin, resource path, argument digest, and prediction identifier also
differed between arms.

| Arm       | Schema   | Expected behavior | Result indicators                                             | Policy        | Calls / follow-ups | Outcome                     |
| --------- | -------- | ----------------- | ------------------------------------------------------------- | ------------- | ------------------ | --------------------------- |
| Control   | Conforms | Matches           | None                                                          | Within policy | 1 / 0              | `expected_within_policy`    |
| Treatment | Conforms | Deviates          | Instruction override, secret request, external action request | Within policy | 1 / 0              | `intrinsic_hazard_evidence` |

The distinction matters: receiving structured data remained an authorized and
expected effect in both arms. The treatment result nevertheless contained
intrinsic hazard evidence, so the comparison did not confuse “within the
subject-behavior policy” with “safe content.”

## What was enforced

- A deterministic local, model-shaped proposer submitted one treatment case.
  The existing proposal comparator recomputed its exact context, submission,
  schema, resource, policy, budget, and novelty checks and accepted one novel
  call-semantic candidate.
- A separate controller-authored case adopted only the proposal's ordered tool
  and symbolic-argument semantics. The proposal's predictions, assertions,
  rationale, and approval suggestion did not enter the executable case. Fresh
  compilation rechecked aggregate bounds and produced the common two-case plan.
- The serialized proposal-review record remained non-bearer and explicitly
  non-authoritative. An object-identity, single-use review capability was burned
  into the separately issued execution authority; neither record could dispatch
  by itself. The local reviewer identity is a trusted test-controller boundary,
  not an externally authenticated human signature.
- A model-shaped prediction remained non-authoritative. Deterministic code
  bound it to the selected plan case, catalog, output schema, predicted effect,
  policy, target, exact arguments, and five-minute validity window.
- Dispatch required the original opaque in-memory one-use capability. Its JSON
  record was evidence, not a bearer token, and replay was rejected.
- The capability was consumed before Docker started. Immediately before the
  sole `tools/call`, the reference monitor recompiled against live discovery
  and rechecked the target tree, every mounted synthetic resource, policy,
  image, sandbox ceilings, case, step, tool, and arguments.
- Docker resolved a dedicated controlled tag to the exact reviewed,
  host-specific image ID, rejected declared image volumes, and executed that
  immutable ID with no network, IPC, or log driver; a
  read-only root, target, and resource mount; no writable host bind; no
  target-configured environment variables; only controller-set `HOME`, `PATH`,
  and `NODE_ENV`; a bounded `/tmp`; a read-only message-queue mount; dropped
  capabilities; and CPU, memory, PID, file-size, and open-file ceilings.
- The MCP transport permitted exactly one armed call and rechecked
  `tools/list_changed` immediately before the wire send. There was no retry,
  provider, workflow, or follow-up interface.
- Raw returned text stayed in the mode-0600 local transcript. Authorization,
  hypothesis, observation, comparison, attempt, this report, and the adjacent
  JSON contain only bounded classifications, offsets, counts, and hashes.
- Cleanup used label-checked forced removal followed by three consecutive
  absence checks before the observation and comparison were finalized. Random
  per-invocation container names prevent same-run-ID cleanup collisions. A
  successful attempt is emitted only after both temporary host input trees are
  also removed; partial cleanup is recorded as failure evidence.
- Failed sessions and failed post-return integrity checks persist a bounded
  failure record with exact 0/1 guarded transport-handoff evidence and cleanup
  status; raw target errors remain quarantined.

The adjacent JSON is a sanitized reproducible semantic summary, not a retained
raw evidence bundle. `npm run verify:v2-outcome` now reruns both arms and checks
its stable plan, policy, target, image, proposal/promotion, capture, signal, and
summary fields. Per-run authorization, observation, comparison, and transcript
digests are intentionally omitted because their raw artifacts are untracked.

## What this does not prove

This is a reference-monitor and quarantine experiment, not an arbitrary
malicious-MCP sandbox claim. V2 execution remains unavailable for arbitrary
local or npm targets because broader CPU/storage accounting, race-free runtime
snapshots, external cleanup supervision, and general sensor coverage are not
complete.

It also is not a live-model quality or model-robustness experiment: both the
proposer and outcome predictor are deterministic local fixtures, and the
treatment result was never shown to a model. A later matched study can replace
only those proposal/prediction adapters and deliberately expose quarantined
results to an agent-facing stage while keeping deterministic policy as the only
dispatch authority.

Exact bounded metrics and digests are in
[the JSON experiment record](./controlled-outcome-experiment-2026-08-30.json).
