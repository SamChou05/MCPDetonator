# Agent-rollout experiments

These experiments are intentionally not part of the base detonator. The base system
asks what the MCP process itself does. Agent rollouts ask what an MCP can cause
an agent and other tools to do through descriptions and schemas. Target MCP
returned content is retained locally but withheld from the external model in
V1; result-channel poisoning is future work.

The standalone Agent V1 harness is now implemented through
`forge agent-evaluate` and `forge.agent-report/v1`. It remains opt-in and does
not change `forge analyze` or the base report contract.

## Implemented foundation

Agent V1 reuses Forge's target preparation, Docker sandbox, synthetic-profile,
MCP-session, and raw-trace primitives. It independently prepares the configured
target with lifecycle scripts disabled; it does not consume a completed core
run, the core install A/B comparison, static findings, selected runtime
snapshot, normalized timeline, runtime rules, or `forge.report/v1`.

Agent V1 adds full model transcripts, tool-call records, scenario-level
authorization, controlled synthetic tools, repeated rollouts, and deterministic
scoring. Every scenario must:

- mark target metadata `operator_approved`;
- pin the SHA-256 of the exact ordered target names, descriptions, and input
  schemas that will be sent to the provider;
- declare target results `withheld`; and
- use an empty target runtime environment.

Forge checks the metadata hash before the first provider request. A mismatch
stops the rollout and leaves local evidence of the approved and observed
hashes. The hash proves identity of the disclosed projection, not that its
contents are safe. Individual experiment plans may still describe future
coverage beyond the implemented metadata-poisoning fixture.

## Real-target audits, paired fixtures, and causal controls

The V1 audit of a real MCP uses the exact original metadata returned by that
target. It does not rewrite the description or pretend that the target supplied
clean and poisoned variants. Such a run measures behavior under the recorded
metadata, model, tools, and task; without a matched control, it does not prove
that one sentence uniquely caused the behavior.

The repository provides two metadata variants:

1. A normal metadata variant.
2. The same implementation and schema with the proposed malicious description
   content added.

The automated offline verifier currently runs only the poisoned variant with a
fixed scripted provider trajectory. It does not compute a clean-versus-poisoned
comparison or establish that the description caused the scripted behavior. A
causal study requires separate repeated runs of both variants with a live or
otherwise metadata-responsive model, followed by an explicit rate comparison.

A separately reviewed sanitized or ablation variant is useful future work, but
it is not required by the current V1 contract.

Keep the user task, model, system policy, tool set, sandbox, fixture data, and
approval mode constant. Because model behavior is stochastic, report success
rates across repeated trials rather than presenting one trajectory as a general
result.

Both real-target audits and controlled experiments use an operator-authored
authorization and utility oracle. MCP metadata is untrusted evidence and cannot
grant itself permission. Direct-runtime and agent-runtime cases can match on
the pinned source identity, logical task, policy, resource shapes, and
task-success conditions while retaining arm-specific execution and evidence.
They should not be described as sharing one prepared artifact unless a future
integration enforces that.

The agent may propose actions, but it must never receive real credentials or a
route to uncontrolled external systems. Docker-backed controlled filesystem
tools operate only on their synthetic profile, and send actions terminate at an
in-memory receiver. The target operates on its read-only candidate artifact
and read-only synthetic home plus a separate 16 MB tmpfs workspace seeded with
distinct canaries, so target-written state cannot flow into provider-visible
controlled-filesystem results. Linked raw traces and both profile domains are
monitored with persisted quota status, and controlled writes have deterministic
path-depth and cumulative attempt caps. Utility evidence names the observed
domain. Bounded target-call argument paths are inspected before tmpfs cleanup as
point-in-time final state, not as proof that one action caused that state.
Operators must approve only metadata that is safe to send to the configured
model provider.
