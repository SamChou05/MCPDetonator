# Install lifecycle delta

**Status:** Implemented

## Question

What process, file, and network behavior appears only when npm lifecycle scripts
are allowed to run?

## Why this is useful

An MCP package can act before its server initializes. Comparing two controlled
installs exposes an observational delta between ordinary npm extraction and a
run where `preinstall`, `install`, and `postinstall` execution is allowed.

## Hypothesis

The controlled fixture's scripts-enabled install will execute its known
lifecycle behavior. The scripts-disabled install will unpack identical package
content without executing that behavior.

## Control

- Control: fresh offline installation with lifecycle scripts disabled.
- Treatment: fresh offline installation with lifecycle scripts enabled.

Both runs use the same exact artifact, dependency lock/cache, base image,
synthetic profile, observer, limits, and network policy.

## Synthetic setup

- Clean synthetic home and workspace for each install.
- Fake SSH, GitHub, and install-file canaries.
- Blocked public networking.
- Identical dependency artifacts prepared without target lifecycle execution.

## Procedure

1. Acquire the exact package and dependencies with lifecycle scripts disabled.
2. Create two fresh installation sandboxes.
3. Run the scripts-disabled install under observation.
4. Run the scripts-enabled install under observation.
5. Preserve both installation logs, outcomes, and traced events.
6. Compare normalized semantic install behavior while retaining both raw
   records.
7. If the scripts-enabled install completes, select and hash that installed
   snapshot for later runtime phases; otherwise preserve the scripts-disabled
   fallback and report the coverage limitation.

## Evidence to collect

- npm lifecycle transcript and exit status.
- Process lineage and successful executable launches.
- Install logs, outcomes, traced file/process/network events, and the selected
  runtime-snapshot hash.
- Network attempts and policy outcomes.
- The scripts-on versus scripts-off semantic delta and its evidence links.

## Success criteria

- Forge identifies behavior present only in the scripts-enabled experiment.
- Ordinary package extraction is not mislabeled as package-script behavior.
- Legitimate lifecycle behavior is described factually rather than treated as
  inherently malicious.
- Blocked network dependencies are reported as coverage limitations.

## Alternative explanations

Timestamps, caches, generated metadata, and nondeterministic package-manager
behavior can create differences unrelated to lifecycle scripts. Comparison
should focus on normalized semantic facts rather than byte-for-byte directory
identity alone.

## Limitations

The experiment observes consumer installation, not how the publisher built the
published artifact. Offline policy may prevent a legitimate installer from
reaching behavior it would perform on a normal machine.

## Implementation dependency

Satisfied by the implemented scripts-disabled/scripts-enabled installation
experiments, semantic comparison, and hashed selected runtime snapshot.
