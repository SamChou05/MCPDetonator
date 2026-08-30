# Reviewed unseen-MCP enrollment study

- **Run date:** 2026-08-30
- **Execution class:** `enrolled_node_stdio_single_call`
- **Result:** supported for the selected cases; target safety not assessed

## Result

The generalized setup worked for its bounded goal in this fixed, curated
candidate set. One previously unenrolled real npm MCP and all three local
controls reached the same target-independent one-call path. Two incompatible
real npm packages failed closed before receiving tool-call authority. A separate
declined-review case sent zero tool calls. Every case verified target-container
and temporary-input cleanup.

This is evidence that the enrollment machinery generalizes beyond the original
hard-coded fixture for at least one eligible real package. It is not a random
sample or success-rate estimate, and it is not evidence that any tested package,
its full tool catalog, or its dependency graph is safe.

| Candidate                      | Source         | Configured tool      | Result        | Calls | Interpretation                                                                                                                  |
| ------------------------------ | -------------- | -------------------- | ------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------- |
| Echo control                   | Local snapshot | `mirror_value`       | Completed     |     1 | The output-only taint stayed in raw quarantine and produced intrinsic-hazard evidence.                                          |
| Math control                   | Local snapshot | `add_numbers`        | Completed     |     1 | The result matched the hypothesis; the overall outcome remained inconclusive because behavior sensors were missing.             |
| Lifecycle blind-spot control   | Local snapshot | `readiness_probe`    | Completed     |     1 | The result looked expected while intentionally induced initialization process/filesystem effects remained invisible.            |
| Sequential Thinking `2026.7.4` | Exact npm      | `sequentialthinking` | Completed     |     1 | The selected result matched; no package-safety conclusion was made.                                                             |
| Server Everything `2026.8.18`  | Exact npm      | `echo`               | Rejected      |     0 | Discovery emitted a `tools/list_changed` notification, which the stable-catalog contract rejects; no execution session started. |
| WRTN Calculator `0.2.1`        | Exact npm      | `add`                | Rejected      |     0 | Its MCP process did not complete bounded discovery startup.                                                                     |
| Review-decline control         | Local snapshot | `add_numbers`        | Failed safely |     0 | The exact review bindings were echoed, approval was declined, and no dispatch occurred.                                         |

The completed cases each used one zero-call discovery session, one fresh
execution session, one second catalog read, exactly one `tools/call`, no retry,
and no follow-up. The dispatch authority was an opaque in-memory receipt; its
serialized evidence was not usable as authority.

## What changed technically

- Enrollment now accepts an exact npm version or a local `install: none`
  snapshot when it has a direct in-tree JavaScript entrypoint and a bounded,
  one-page MCP tool catalog. npm lifecycle scripts are disabled during
  acquisition.
- A zero-call discovery container records and bounds the catalog. A fresh
  no-network container then rechecks the prepared tree, runtime invocation,
  catalog, policy, exact tool, and exact arguments immediately before the sole
  call.
- The reviewer receives the frozen plan, policy, hypothesis, target evidence,
  selected tool, and exact arguments. Approval is bound to those values and
  expires after five minutes. Decline and callback failure produce bounded
  zero-call records.
- The MCP result remains in a private raw transcript. Non-raw artifacts retain
  structural observations, lexical signal locations and hashes, comparison
  summaries, dispatch counts, and cleanup receipts—not the returned text.
- An evidence index binds the key indexed evidence-artifact paths to their size
  and SHA-256. The verifier independently checks its exact expected coverage,
  transcript ordering and raw call payload, correlated response, receipt use,
  quarantine, and cleanup.

## The important blind spot

Only the MCP transcript and cleanup sensors are complete in this alpha.
Process, filesystem, and network behavior are explicitly unavailable. The
lifecycle control demonstrates why that matters: it creates temporary files and
starts a child process during initialization, but its benign-looking result
still yields `no_signal_observed` and an overall `inconclusive` comparison.

That means the setup can currently answer “did the reviewed call return the
expected shape or suspicious text?” It cannot yet answer “what did this MCP do
to the process, filesystem, or network while producing that result?” Adding
compatible behavior sensors is the next meaningful engineering step.

## Reproducing the study

```bash
npm run verify:v2-enrollment:local
npm run verify:v2-enrollment
```

The first command uses only controlled local fixtures. The second also acquires
the three exact npm versions recorded in the adjacent JSON file. Both commands
create private temporary evidence, verify it, remove it after success, and emit
a sanitized semantic summary. Failed verifier evidence is retained for local
diagnosis and remains untracked.

The exact stable results and npm integrity strings are in
[the JSON experiment record](./unseen-enrollment-study-2026-08-30.json).
