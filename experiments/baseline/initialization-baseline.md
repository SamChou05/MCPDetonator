# Initialization baseline

**Status:** Implemented

## Question

What process, file, and network behavior occurs after the MCP starts but before
any tool is called?

## Why this is useful

Every tool experiment must initialize the server first. Without a no-tool
control, ordinary module loading and startup work could be incorrectly blamed
on the subsequent tool call.

## Hypothesis

The controlled fixture will load its runtime and package files and deliberately
read the synthetic GitHub credential during initialization. It will not perform
the tool-only SSH-key read, hidden child execution, controlled public connection
attempt to `198.51.100.1:443`, or delayed post-return read until
`summarize_file` is invoked. Other low-level initialization socket activity may
still be present and remains evidence.

## Control

This is the control for all isolated tool experiments. It uses the same target,
synthetic profile, sandbox policy, and observation window but stops after MCP
initialization and `tools/list`.

## Synthetic setup

- The standard fake developer profile.
- A synthetic workspace document.
- Unique fake SSH, GitHub, and install-file canaries.
- Blocked public networking.

The canaries remain present even though no tool should access them. This checks
whether startup behavior touches attractive resources on its own.

## Procedure

1. Create a fresh sandbox from the standard synthetic profile.
2. Start the MCP under the runtime observer.
3. Complete MCP initialization and `tools/list`.
4. Invoke no tools.
5. Observe the normal cooldown window.
6. Stop the sandbox and preserve evidence.

## Evidence to collect

- Initialization phase boundaries.
- MCP transcript and advertised interface.
- Successful process execution.
- File access, file-descriptor relationships, and outcomes.
- Network attempts and outcomes.

## Success criteria

- Startup facts are attributed to initialization rather than to a tool.
- Every normalized fact links to raw evidence.
- The synthetic GitHub credential read produces
  `runtime.initialization_sensitive_access`.
- Tool-only SSH read, child-process execution, controlled public connection to
  `198.51.100.1:443`, and post-return behavior do not appear in this control.
- Later tool experiments preserve their own phase-scoped evidence for manual or
  downstream comparison with this control; Forge does not currently perform a
  general automatic baseline subtraction.

## Alternative explanations

Nondeterministic Node or package initialization may create facts that appear in
only one run. A manual or future automated cross-run comparison is supporting
context, not proof that an unmatched event was caused by the tool.

## Limitations

One quiet initialization does not prove that startup behavior is always benign.
Time, environment, host identity, or probabilistic triggers may change it.

## Implementation dependency

Supported by the current runtime vertical slice.
