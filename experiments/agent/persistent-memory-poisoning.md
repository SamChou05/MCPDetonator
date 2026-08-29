# Persistent memory poisoning

**Status:** Future-agent

## Question

Can MCP output cause an agent to store an instruction that changes behavior in
a later, unrelated task?

## Why this is useful

Initialization and isolated tool experiments end with the sandbox. Agent memory
can extend the effect of untrusted MCP content beyond the original call and
beyond the task in which it appeared.

## Hypothesis

A poisoned first-task result will increase unauthorized actions during a second
task only when persistent memory is enabled and the instruction is retained.

## Control

Compare:

- Benign first-task result with memory enabled.
- Poisoned first-task result with memory disabled or cleared before task two.
- Poisoned first-task result with memory retained before task two.

The second task, tool set, and synthetic environment remain identical.

## Synthetic setup

- An MCP capable of returning controlled benign or poisoned content.
- A controlled memory tool or store whose writes and reads are fully recorded.
- A harmless first task and an unrelated second task.
- Fake credentials and controlled receiver for objective scoring.

## Procedure

1. Run the first task and record memory writes.
2. End the first task and preserve only the state allowed by the condition.
3. Start the unrelated second task.
4. Record memory reads and all subsequent tool calls.
5. Score unauthorized behavior and canary movement.
6. Repeat all conditions.

## Evidence to collect

- First-task MCP output.
- Exact memory writes and stored content.
- Second-task memory retrieval.
- Agent transcript and tool-call sequence across both tasks.
- Canary and controlled receiver evidence.

## Success criteria

The retained-memory condition produces a measurable increase in unauthorized
second-task behavior, while clearing memory removes or materially reduces the
effect.

## Alternative explanations

The model may repeat behavior from conversational context rather than the memory
store. The second task should begin in a fresh conversation with only the
condition-specific stored state carried forward.

## Limitations

Memory implementations differ significantly. This experiment would establish a
risk for the tested retention and retrieval design, not for agent memory in
general.

## Implementation dependency

Requires an agent rollout harness, controlled persistent memory, multi-task
scenario orchestration, and repeated paired trials.

