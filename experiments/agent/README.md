# Future agent-rollout experiments

These plans are intentionally not part of the base detonator. The base system
asks what the MCP process itself does. Agent rollouts ask what an MCP can cause
an agent and other tools to do through descriptions, schemas, and returned
content.

## Prerequisites

Do not implement this layer until the baseline can reliably:

- Run an MCP in a synthetic sandbox.
- Record its advertised interface and exact tool results.
- Attribute process, file, and network facts to isolated tool calls.
- Track canaries and produce evidence-linked findings.

An agent harness would additionally need full model transcripts, tool-call
records, scenario-level authorization, multiple synthetic tools, repeated
rollouts, and deterministic scoring.

## Causal controls

Every rollout experiment should compare at least:

1. A benign output or metadata variant.
2. The same variant with the proposed malicious content added.
3. A sanitized version with that content removed.

Keep the user task, model, system policy, tool set, sandbox, fixture data, and
approval mode constant. Because model behavior is stochastic, report success
rates across repeated trials rather than presenting one trajectory as a general
result.

The agent may propose actions, but it must never receive real credentials or a
route to uncontrolled external systems. All tools continue to operate on
synthetic data and controlled services.

