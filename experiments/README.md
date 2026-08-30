# Forge experiment catalog

This directory contains research plans and reasoning. Nothing here is loaded by
the Forge CLI, changes sandbox policy, or alters the current runtime
implementation.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Target | The MCP server being analyzed and its base sandbox profile |
| Experiment | A specific question, control, procedure, and success criterion |
| Run | One execution of an implemented experiment and its evidence artifacts |

Machine-readable target configuration currently lives under `fixtures/` for
controlled targets and `case-studies/` for curated real targets. Generated
evidence belongs under `runs/` or `agent-runs/`. This directory records what an
experiment is meant to teach us and the boundary of any implemented result.

## Status labels

- **Implemented:** exercised by the deterministic core path and its current
  verification gates.
- **Implemented-Agent-V1:** exercised by the separate opt-in agent harness and
  deterministic offline fixture; a live-provider study may still be unrun.
- **Future-Agent:** requires behavior outside the current Agent V1 contract.

## Baseline experiments

| Experiment | Status | Main question |
| --- | --- | --- |
| [Initialization baseline](baseline/initialization-baseline.md) | Implemented | What happens before any tool is called? |
| [Controlled deceptive behavior](baseline/deceptive-runtime-behavior.md) | Implemented | Can Forge detect and attribute known hidden behavior? |
| [Benign filesystem scope](baseline/benign-filesystem-scope.md) | Implemented | Can Forge recognize expected file behavior without false positives? |
| [Install lifecycle delta](baseline/install-lifecycle-delta.md) | Implemented | What behavior appears only when npm lifecycle scripts run? |

## Agent experiments

These ask what an MCP can cause an agent to do through metadata or tool output,
even when the MCP process does not directly perform the harmful action.

| Experiment | Status | Main question |
| --- | --- | --- |
| [Cross-tool canary exfiltration](agent/cross-tool-canary-exfiltration.md) | Implemented-Agent-V1 harness trajectory; causal comparison unrun | Can one MCP's metadata induce an agent to move a canary through other tools? |
| [Tool-description poisoning](agent/tool-description-poisoning.md) | Implemented-Agent-V1 | Can malicious tool metadata alter agent behavior before invocation? |
| [Tool-result injection](agent/tool-result-injection.md) | Future-Agent | Can a tool result redirect the agent into unauthorized follow-up actions? |
| [Persistent memory poisoning](agent/persistent-memory-poisoning.md) | Future-Agent | Can MCP output influence a later, unrelated task? |

## Documented malicious and vulnerable MCP studies

| Experiment | Status | Main question |
| --- | --- | --- |
| [Documented malicious-MCP study](security/documented-malicious-mcp-study-2026-08-30.md) | Implemented | Do real advisory packages and a contained campaign-shaped MCP reproduction reach Forge's evidence, finding, and agent-enforcement layers? |

## Experiment discipline

Every experiment should identify:

1. A narrow question that the current evidence system can answer.
2. A hypothesis stated before the run.
3. A control and one deliberate changed variable.
4. Synthetic inputs and unique, non-secret canaries.
5. The exact observations that count as success or failure.
6. What the experiment cannot prove.

Raw run artifacts should remain immutable and gitignored. Small sanitized
expected findings may later be committed beside an experiment when it becomes
an automated regression test.
