# Controlled deceptive runtime behavior

**Status:** Implemented

## Question

Can Forge detect and attribute known hidden file, process, and network behavior
performed during one otherwise legitimate MCP tool call?

## Why this is useful

The deceptive fixture provides ground truth. It verifies for this controlled
case that the runtime
observer, normalizer, phase attribution, rules, and evidence links work together
before Forge is pointed at an unknown public package.

## Hypothesis

Initialization will deliberately read the synthetic GitHub credential. Calling
`summarize_file` will read the requested synthetic document and also:

- Read the fake SSH-key canary outside the expected scope.
- Execute a fixed Node child process.
- Attempt a connection while public networking is blocked.
- Leave delayed child activity that reads a synthetic file during the
  post-return cooldown window.

The initialization-only control contains the GitHub read but not the four
tool-specific behaviors.

## Control

Use the initialization baseline from the same target and synthetic profile. The
changed variable is the single `summarize_file` invocation.

## Synthetic setup

- `/sandbox/workspace/report.txt` as the legitimate tool input.
- A unique fake SSH credential outside the expected read scope.
- A fixed harmless child program.
- Documentation-only destination `198.51.100.1:443` with network blocked.

## Procedure

1. Create a fresh sandbox.
2. Initialize the fixture and record its advertised tool interface.
3. Mark the start of `summarize_file`.
4. Invoke it with the synthetic report path.
5. Mark the response and observe the cooldown window.
6. Preserve raw traces, normalized events, attribution, and findings.

## Evidence to collect

- Successful read of the requested report.
- Successful read of the fake SSH path and observed byte activity; the syscall
  trace does not claim to recover the file contents.
- Successful execution of the fixed child process and its lineage.
- Blocked connection attempt and destination.
- Active phase and process-origin phase for every relevant event.

## Success criteria

Forge produces the five expected finding categories:

- `runtime.initialization_sensitive_access`
- `runtime.file_scope_exceeded`
- `runtime.unexpected_process_exec`
- `runtime.unexpected_network_attempt`
- `runtime.post_return_activity`

Each finding cites canonical events, and each event cites raw evidence. The
legitimate report read is recorded but not classified as a scope violation.

## Alternative explanations

Timestamp overlap alone is insufficient. The process tree, phase of process
creation, and absence from the initialization control should support the tool
attribution.

## Limitations

This is a deterministic fixture designed for observability, not a realistic
evasion benchmark. Passing it does not establish coverage of obfuscation,
encrypted exfiltration, native code, or dormant triggers.

## Implementation dependency

Supported by the current runtime vertical slice and controlled fixture.
