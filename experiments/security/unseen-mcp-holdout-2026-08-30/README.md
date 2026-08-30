# Unseen MCP holdout study

This directory freezes a pre-execution set of exact-version npm MCP packages
that were absent from Forge's existing fixtures and case studies on 2026-08-30.
The study runs only in Forge's disposable Docker developer profile, with
synthetic home/workspace data, lifecycle-script acquisition disabled on the
host, and runtime networking blocked.

The package set was selected from npm registry search metadata before package
contents or MCP catalogs were inspected:

| Case                | Package                                            | Version     | Registry stratum                        |
| ------------------- | -------------------------------------------------- | ----------- | --------------------------------------- |
| everything          | `@modelcontextprotocol/server-everything`          | `2026.8.18` | Official protocol feature server        |
| sequential-thinking | `@modelcontextprotocol/server-sequential-thinking` | `2026.7.4`  | Official reasoning utility              |
| hello-world         | `mcp-hello-world`                                  | `1.1.2`     | Minimal example                         |
| declared-malicious  | `malicious-mcp-server`                             | `1.5.0`     | Registry-declared malicious E2E control |
| excel               | `@negokaz/excel-mcp-server`                        | `0.12.0`    | Local file-processing server            |
| eslint              | `@eslint/mcp`                                      | `0.3.11`    | Developer tooling                       |
| panda               | `@pandacss/mcp`                                    | `1.12.0`    | Framework documentation/tooling         |
| mui                 | `@mui/mcp`                                         | `0.1.4`     | Framework documentation/tooling         |
| mantine             | `@mantine/mcp-server`                              | `9.5.2`     | Framework documentation                 |
| ui5                 | `@ui5/mcp-server`                                  | `0.2.18`    | Developer tooling                       |

Except for the package that explicitly labels itself as an E2E malicious
server, these cases are unlabelled rather than presumed benign. Package names,
publishers, and registry descriptions are not security ground truth.

The first pass uses the deliberately absent
`forge_holdout_probe_missing` tool name. Forge still performs acquisition,
static inspection, install-lifecycle comparison, MCP initialization, and
bounded tool discovery before failing the configured-tool lookup. After all
catalogs are captured, a deterministic safe-input rule selects at most one
bounded tool per compatible catalog. Inputs use only literal synthetic data,
synthetic profile paths, or the reserved `example.invalid` domain; no host
credential, host path, or live service is supplied.

Primary metrics are acquisition outcome, scripts-enabled install outcome,
startup/catalog outcome, catalog size/schema compatibility, selected-tool
outcome, deterministic finding count/rules, runtime network attempts, synthetic
credential access, process/filesystem effects, and evidence completeness.

Frozen invocation selection:

| Case                | Tool                    | Synthetic input rationale                                         |
| ------------------- | ----------------------- | ----------------------------------------------------------------- |
| everything          | `get-env`               | Measures explicit environment exposure; only sandbox values exist |
| sequential-thinking | `sequentialthinking`    | One terminal synthetic thought                                    |
| hello-world         | `echo`                  | Literal synthetic string                                          |
| declared-malicious  | `codeGenerator`         | First zero-required-input advertised tool                         |
| excel               | `excel_describe_sheets` | Nonexistent synthetic-workspace workbook                          |
| eslint              | `lint-files`            | Existing synthetic-workspace text file                            |
| panda               | none                    | Startup closed before discovery                                   |
| mui                 | `fetchDocs`             | Reserved `example.invalid` URL with runtime networking blocked    |
| mantine             | `list_items`            | One documentation item                                            |
| ui5                 | `get_guidelines`        | Zero-input documentation tool                                     |

After the frozen holdout pass, an explicitly exploratory positive-control sweep
invokes all seven tools advertised by `malicious-mcp-server`. It supplies only
obviously synthetic placeholder credentials and PII. The sweep is not counted
as an additional holdout package or as preregistered recall evidence.

Completed results are recorded in [results.md](./results.md), with exact
bounded metrics and hashes in [results.json](./results.json).
