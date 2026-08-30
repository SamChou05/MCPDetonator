# Benign filesystem scope

**Status:** Implemented

## Question

Can Forge observe a real Filesystem MCP tool and distinguish its legitimate
requested file activity from unrelated synthetic resources without producing
misleading findings?

## Why this is useful

The deceptive fixture tests sensitivity. A real server exhibiting expected
behavior for the selected inputs tests specificity and demonstrates that Forge
is an evidence tool rather than a detector tuned to one known malicious
pattern.

## Hypothesis

A read-only filesystem tool will read the requested synthetic document and
runtime dependencies while remaining within the configured workspace boundary.
It will not access fake credentials, start unexpected executables, or perform
unexpected public-network behavior during the selected tool phase. Low-level
connection attempts during initialization remain visible evidence and are not
erased by this hypothesis.

## Control

Use an initialization-only run of the same exact package version and sandbox
profile. The changed variable is one configured read-only tool call.

## Synthetic setup

- A small workspace tree containing one requested document and unrelated files.
- Fake SSH and cloud credentials under the synthetic home directory.
- Unique canaries in every resource class.
- The workspace path supplied through the MCP's supported launch configuration.
- Blocked public networking.

## Procedure

1. Acquire and identify one exact published Filesystem MCP version.
2. Create an initialization-only control in a fresh sandbox.
3. Create another fresh sandbox from the same installed snapshot and profile.
4. Invoke one read-only file tool with the synthetic document path.
5. Observe the cooldown window and preserve evidence.
6. Compare tool-specific facts with the initialization control and expected
   resource scope.

## Evidence to collect

- Advertised tool description, schema, and annotations.
- Requested file access and outcome.
- Any access outside the allowed workspace.
- Process execution and network attempts.
- Phase-scoped initialization and selected-tool evidence for comparison.

## Success criteria

- The requested file behavior is attributed to the tool.
- Normal Node and package loading remains visible in phase-scoped
  initialization evidence; Forge does not silently subtract it.
- No rule flags the legitimate requested read.
- Any unexpected behavior, if present, is reported as evidence rather than
  forced into the benign hypothesis.

## Alternative explanations

The server may legitimately read configuration or resolve paths during a tool
call. The report should distinguish sandbox-policy violations from analyst
expectation mismatches and retain uncertainty where the documented contract is
unclear.

## Limitations

One tool input and one package version do not establish that the server is safe
for other paths, tools, versions, or environments.

## Implementation dependency

Satisfied by the exact-version Filesystem case study under `case-studies/` and
the implemented npm acquisition, installation, and runtime pipeline.
