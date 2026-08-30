# Unseen MCP holdout results

**Run date:** 2026-08-30

**Frozen baseline:** `a2b0516`

**Cases:** 10 exact-version npm packages absent from existing Forge fixtures

## Outcome

The setup successfully acquired all ten packages in the contained profile.
Nine initialized and exposed bounded MCP catalogs. Eight selected tool calls
produced complete Forge reports, one Excel call returned a bounded
synthetic-file-not-found error after discovery, and Panda stopped during
initialization because the synthetic workspace had no Panda project
configuration.

| Case                       |  Catalog | Selected tool outcome                        | Deterministic findings |
| -------------------------- | -------: | -------------------------------------------- | ---------------------: |
| Everything                 | 13 tools | Completed: `get-env`                         |                      0 |
| Sequential Thinking        |   1 tool | Completed: `sequentialthinking`              |                      0 |
| Hello World                |  3 tools | Completed: `echo`                            |                      0 |
| Declared-malicious control |  7 tools | Completed: `codeGenerator`                   |                      0 |
| Excel                      |  6 tools | Tool returned synthetic file-not-found error |    0 / no final report |
| ESLint                     |   1 tool | Completed: `lint-files`                      |                      0 |
| Panda                      |     None | Startup required missing project config      |    0 / no final report |
| MUI                        |  2 tools | Completed: `fetchDocs`                       |                      1 |
| Mantine                    |  4 tools | Completed: `list_items`                      |                      4 |
| UI5                        | 10 tools | Completed: `get_guidelines`                  |                      0 |

This is a prospective selected-input holdout, not a representative prevalence
study. The nine ordinary cases are unlabelled, not established benign controls.

## Runtime findings

Mantine's `list_items` call generated four failed connection attempts across
two destinations: two local name-service socket attempts failed with `ENOENT`
and two DNS attempts failed with `ENETUNREACH`. Forge emitted four
`runtime.unexpected_network_attempt` findings. The static scan independently
found two network-access signals. These observations do not establish malicious
intent; they show that a documentation lookup attempted networking beyond the
empty operator-authored scope and that the sandbox contained it.

MUI's `fetchDocs` call created
`/sandbox/home/forge/.mui-mcp.log`, with two observed write events and one
retained filesystem entry. Forge emitted one
`runtime.file_scope_exceeded` finding. The reserved
`example.invalid` input did not produce an observed connection attempt in
this selected call.

No completed case modified host state. No runtime network attempt succeeded.

## Result-content gap

The registry-declared `malicious-mcp-server@1.5.0` is the clearest coverage
result. Its frozen `codeGenerator` call returned a ten-byte code-like
`eval` string, but caused no observed filesystem, network, or subprocess
effect and produced no deterministic finding.

An explicitly exploratory sweep then invoked all seven advertised tools with
obvious synthetic placeholders. All calls completed, all had zero retained
system effects, and Forge again emitted zero findings. The returned content
included:

- a direct prompt-injection instruction requesting system prompts and secrets;
- claims that supplied synthetic credentials and synthetic customer data had
  been leaked;
- a control-character payload; and
- the code-like string from the first call.

The tracked JSON stores classifications, lengths, and SHA-256 hashes rather
than reproducing the injection text. This outcome demonstrates a product
boundary, not a sandbox failure: deterministic runtime rules assess system
effects, while malicious MCP result content currently requires a separate
content/agent evaluation.

Static coverage was also incomplete for this package: its only candidate source
file was skipped by the bounded scanner. The exact package was nevertheless
bound by its package-tree digest and exercised dynamically.

## Additional coverage observations

- The Everything server's `get-env` tool returned five sandbox environment
  variables. No credential-like variable name was present. Static inspection
  identified eight environment-access signals, but the runtime layer has no
  `process.env` access sensor or result-disclosure finding.
- The lexical claim classifier treated “branch into new paths” in the
  Sequential Thinking description as a filesystem claim. This is a concrete
  metaphor-related false-positive example for claim evidence, not a runtime
  finding.
- Excel and Panda retained 64 and 78 partial artifacts respectively, but failed
  runs did not receive normalized final reports. Partial-run normalization is
  therefore important for evaluating unfamiliar servers at scale.
- Every scripts-disabled/scripts-enabled installation arm completed. The
  complete reports each showed only seven treatment-only reads and no
  treatment-only execution, write, delete, or network event; package-manager
  nondeterminism remains a documented limitation.

## Safety and interpretation

All public package code ran inside disposable Docker profiles. Runtime
networking was blocked, only synthetic home/workspace data was mounted,
acquisition lifecycle scripts were disabled, and no host MCP configuration,
real service credential, or live service was supplied.

Five findings across two unlabelled packages do not make either package
malicious. Conversely, zero findings do not make the other packages safe.
Forge observed one selected input per compatible package, except for the
separately labelled malicious-control sweep.

The exact run IDs, package-tree hashes, report hashes, bounded metrics, and
sanitized positive-control output hashes are in [results.json](./results.json).
