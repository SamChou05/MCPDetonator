# What Forge can and cannot do

**Status:** This describes the current code as of 2026-08-30.

Forge has two separate ways to test an MCP server:

- The **core test** studies the server itself. It looks at the package, starts
  it in a locked-down test environment, calls selected tools, and records what
  the software does.
- The **agent test** studies how an AI model behaves after seeing the server's
  tool names, descriptions, and input rules.

These tests answer different questions. They prepare the server separately,
collect different evidence, and create different reports.

## Core test: study the MCP server directly

Command: `forge analyze`

Put simply, Forge first looks for obvious clues in the package's code. It then
watches what the package actually does during a few chosen tests. Finally, it
compares those actions with the behavior you said was allowed. The result is
supporting evidence, not a safety grade.

### What you provide

- The exact npm package and version, or a local Node.js project.
- The command needed to start the MCP server.
- Whether to run a dedicated initialization experiment and, optionally, the
  file, process, and network scope allowed before any tool call.
- The tools and example inputs Forge should test.
- The file access, programs, and network connections you expect each tool to
  need. Forge treats this as the allowed behavior for the test.
- Time, memory, CPU, and process limits.

`forge validate` checks that these settings are well formed without running the
server.

### The three things Forge looks at

- **What is in the package:** package details, install commands, dependencies,
  and simple clues in the source code.
- **What the server says:** its name, version, tools, descriptions, and input
  rules.
- **What the server does in the selected tests:** the files it touches, programs
  it starts, and network connections it tries.

### How the core test works

```text
test settings
    -> exact copy of the package
    -> simple code scan
    -> start the MCP and list its tools
    -> call selected tools and record raw operating-system logs
    -> turn those logs into readable actions
    -> connect each action to a test step
    -> check the actions and write the report
```

1. **Get the exact code that will be tested.** Forge downloads one exact npm
   version or copies a local directory. It first prepares the package with
   install scripts turned off. It records where the code came from and creates
   a SHA-256 digital fingerprint for the package tree.

   When the npm files needed for a clean reinstall are available, Forge also
   runs two fresh offline installations: one with install scripts off and one
   with them on. If the install with scripts on succeeds, Forge uses that copy
   for the later tests. Otherwise it uses the safer scripts-off copy. Forge
   scans the chosen copy again so the code scan and the later behavior test
   refer to the same files.

2. **Read the package information and scan the code.** Forge reads
   `package.json` and basic information from common files that record exact
   dependency versions, often called lockfiles. This tells Forge things such as
   the package name, version, start files, dependencies, and install commands.

   Forge now keeps two deliberately separate static views. The original
   lexical scan searches JavaScript and TypeScript for a small set of broad
   capability clues; it remains the input to the existing four-way comparison.
   A new semantic sidecar parses the exact captured source bytes with a pinned
   TypeScript Compiler API and identifies actual calls to a versioned catalog
   of sensitive Node APIs. It resolves direct ESM/CommonJS bindings and bounded
   immutable aliases, while suppressing unused imports and locally shadowed
   globals such as `fetch`, `eval`, `process`, and `require`.

   The semantic sidecar is structural analysis, not full program
   understanding. It does not yet prove entrypoint or MCP-handler reachability,
   follow mutable or higher-order values, or track data from tool input to a
   sink. Bindings affected by syntactically detected assignment, delete, or
   update mutations are withheld regardless of source order and make the result
   partial rather than silently looking clean. Reflective mutation remains an
   explicit blind spot. Every
   retained callsite is therefore evidence that a modeled API is invoked in
   source, not evidence that the call executes for any selected input.

   The shared capture has safety limits. By default, it reads at most 250 source files,
   about half a megabyte from one file, about 10 megabytes across all source
   files, and 20,000 files or folders while searching. It does not follow
   source-file links or inspect dependency code under `node_modules`. The
   semantic compiler runs in a time-limited worker with V8 heap-generation and
   stack limits plus additional
   AST-node, callsite, diagnostic, alias-pass, and module-resolution ceilings.
   Those worker limits do not bound total process RSS or provide an OS
   permission sandbox.
   Its closed in-memory host cannot read target `tsconfig` files, plugins,
   dependency declarations, or other host files.

   These are the code clues it currently recognizes:

   | Code clue | What it may allow the package to do |
   | --- | --- |
   | Imports Node's `fs` API | Read or change files |
   | Imports `child_process` | Start another program |
   | Imports HTTP, socket, or DNS APIs | Use the network |
   | Calls `fetch` or `WebSocket` | Use the network |
   | Reads `process.env` | Read environment variables |
   | Uses `vm`, `eval`, or `new Function` | Run code created while the program is running |
   | Loads a module from a variable | Choose and load code while running |
   | Loads a `.node` file or calls `process.dlopen` | Load compiled native code |

   For every lexical clue or semantic callsite, Forge saves the file name, file
   fingerprint, line, column, short code excerpt, and the exact captured source
   file. Semantic callsite IDs also bind the source hash, span, catalog sink,
   operation, and capability. Parsing, resolution, truncation, timeout, and
   worker failures are represented explicitly; absence after incomplete
   analysis is never presented as proof that a sink is absent.

3. **Ask the running MCP which tools it offers.** Forge starts the MCP over
   STDIO, meaning the server talks through its standard input and output, and
   asks it for its tool list. It saves the server name and version, plus each
   tool's name, description, input rules, and extra hints supplied by the
   server. It also records the MCP requests and responses.

   Forge separately performs a bounded, deterministic classification of
   positive filesystem, network, and program-execution claims in tool names,
   titles, descriptions, and input rules. Each claim points to the exact MCP
   interface field that produced it. Standard MCP hints are retained as their
   own evidence instead of being silently converted into permissions. The
   classifier handles common negation, but it remains a lexical aid: “no claim
   identified” does not mean the capability is absent.

   Because every isolated start may advertise a different interface, Forge
   records which experiment supplied the top-level summary and reports catalog
   drift or duplicate tool names instead of silently treating the first list as
   universal. Catalog drift uses a bounded, tool-order-independent SHA-256
   fingerprint, while an order-sensitive fingerprint binds the selected source
   interface. Object keys are sorted in JavaScript code-unit order; string
   contents are preserved rather than Unicode-normalized. Forge iteratively
   bounds the complete `tools/list` result—including fields it does not retain—
   before MCP shape validation, so an untrusted output schema is not compiled
   during discovery. It also bounds every JSON-RPC message before cloning or
   persistence, the aggregate transcript, and captured server stderr. The
   retained interface, claim extraction, and catalog fingerprints cover server
   name/version plus tool name, title, description, input schema, and standard
   annotations; output schemas and other unretained MCP metadata are not
   analyzed or fingerprinted.

   Before calling a selected tool, Forge checks the example input against the
   input rules advertised by that tool. The person running Forge still chooses
   the tools, example inputs, and allowed behavior. The core test does not trust
   a tool description to decide what access should be allowed.

4. **Record what the operating system sees.** Each test runs in Docker with no
   external network, a read-only container and package, fake home and workspace
   files, and strict time, memory, CPU, and process limits.

   Forge uses Linux `strace`, which acts like an audit log of requests made to
   the operating system. It follows the server and the child processes it
   starts, adds timestamps and file names, and writes a separate raw log for
   each process. It watches selected process, file, network, read, write,
   directory-enumeration, file-transfer, memory-mapping, and interference-related
   operations. The MCP runs as a low-permission user with no extra system powers
   and cannot change the protected trace logs.

   The network is blocked, but attempted connections are still recorded. This
   lets the report show that software tried to connect even when the connection
   failed.

   Forge also records bounded before-and-after state for the synthetic home and
   workspace. It hashes ordinary files up to a fixed size, records directories
   and stationary symlink targets without intentionally following them, and
   produces a durable
   created/modified/deleted/type-changed delta for each isolated experiment.
   Aggregate visited-entry, hash-byte, issue, and best-effort elapsed-time
   budgets prevent many individually small files or errors from bypassing the
   per-entry limits. Pathname-replacement races remain possible despite scanning
   after verified container cleanup and are stated as a limitation.

5. **Turn the raw trace logs into readable actions.** Raw `strace` lines are
   detailed and tied to Linux internals. Forge converts the supported lines into
   a smaller list of actions such as:

   - A process started, ran or attempted to run a program, or exited normally
     or because of a recorded terminal signal.
   - A process opened, read, enumerated, wrote, or deleted a filesystem path,
     including supported failed attempts whose target path is known.
   - A process tried to connect to or establish a listening endpoint.

   Forge also changes temporary host file paths back into the stable paths seen
   inside the test container. Every readable action points back to the exact raw
   trace line it came from. `observation-health.json` accounts for every nonempty
   selected-trace line as a parsed record, recognized control line,
   unfinished/resumed call, or malformed line; it also checks per-process
   terminal markers. Routine `strace` string abbreviation is counted separately
   because it loses argument detail without making the line structurally
   unparsable. A complete captured-syscall histogram makes every parsed syscall
   family auditable even when it produces neither a canonical action nor a
   selected policy-gap classification.

   Parsing and readable-action conversion are deliberately different claims.
   Not every parsed syscall becomes a canonical action. Forge therefore also
   records bounded examples and exact counts for a selected taxonomy of
   policy-relevant operations it cannot yet represent faithfully, including
   filesystem mutations, alternate file access, data transfer, opaque I/O,
   definitively failed capability probes, endpoint-establishment semantics,
   escape/interference attempts, and
   unresolved relevant paths, truncated relied-on arguments, or indeterminate
   syscall outcomes. These are coverage gaps, not automatic findings.
   Directory enumeration is retained as an explicitly labeled read-like event
   plus a gap, but it is not treated as proof that file contents were read in
   expected-scope matching, deterministic read findings, behavior comparison,
   or install `fileRead` deltas. The original trace files remain the source
   evidence. Compact runtime summaries retain their existing effect totals and
   add `fileOperationCounts`, which separates content reads, directory
   enumeration, content writes, and truncation without changing older fields.

6. **Connect actions to the part of the test that was running.** Forge records
   the start and end time of installation, the MCP handshake, tool discovery,
   each tool call, and the short observation window after a tool returns. It
   uses those times to say which step was active when an action happened. A
   dedicated initialization run also treats its final observation window as
   pre-tool activity, so delayed startup behavior is not silently discarded.

   Forge also notes when each process first appeared. This helps it distinguish
   a process created by a tool from the long-running MCP server. The connection
   is strongest when the tool call runs by itself, creates the process, and the
   action happens during that call. Timing by itself is weaker evidence, so the
   report says how confident Forge is instead of claiming perfect cause and
   effect. Four-way comparison rows also list tool-phase events supported only
   by temporal overlap with an earlier-origin process, so machine consumers do
   not have to infer that caveat from prose.

7. **Check the actions and write the report.** Forge applies the same fixed
   checks to every target. The current checks look for:

   - Reading or attempting to read a fake credential during MCP startup or its
     pre-tool observation window.
   - Exceeding an optional operator-authored initialization scope for synthetic
     files, child programs, or network destinations, including non-routine Unix
     socket paths.
   - Reading, writing, or deleting a file outside the allowed list for a tool;
     deletions use the configured write scope.
   - Starting a program outside the allowed list.
   - Trying an unexpected network connection, including a Unix domain socket
     not listed in the expected scope. Outbound connection attempts to the
     routine NSCD endpoints `/run/nscd/socket` and `/var/run/nscd/socket` are
     retained as canonical evidence but exempted from this policy check;
     listeners on those paths remain network evidence.
   - A process created by a tool continuing to act after the tool returned.

   Forge also compares four deliberately separate facts for file access, child
   programs, and network use: whether the tool interface made a
   bounded positive claim, whether package-authored source contained a lexical
   signal, whether the selected runtime phases produced matching events, and
   whether those exact events fell inside the operator-authored scope. Tool
   claims never enlarge operator approval. Environment-variable access, code
   created while running, modules chosen while running, and compiled native
   code are not yet checked in this four-way view.

   A row says `not_observed` when Forge did not obtain a bounded claim
   assessment for that experiment's configured tool. That is distinct from
   `not_claimed`, which means an available bounded assessment found no matching
   positive signal.

   “Not found in the code scan” means Forge did not find one of its known text
   patterns. “Not seen while running” means the selected test inputs did not
   cause matching recorded behavior. Neither statement means the ability is
   absent from the program.

The main code for these steps is in
[`src/static/node-package.ts`](../../src/static/node-package.ts),
[`src/mcp/stdio.ts`](../../src/mcp/stdio.ts),
[`src/mcp/catalog.ts`](../../src/mcp/catalog.ts),
[`src/mcp/interface-claims.ts`](../../src/mcp/interface-claims.ts),
[`container/trace-entrypoint.sh`](../../container/trace-entrypoint.sh),
[`src/observe/strace-parser.ts`](../../src/observe/strace-parser.ts),
[`src/observe/strace-normalizer.ts`](../../src/observe/strace-normalizer.ts),
[`src/observe/filesystem-state.ts`](../../src/observe/filesystem-state.ts),
[`src/attribute.ts`](../../src/attribute.ts),
[`src/behavior-comparison.ts`](../../src/behavior-comparison.ts),
[`src/rules.ts`](../../src/rules.ts), and [`src/report.ts`](../../src/report.ts).

### What a completed core test produces

- A short completion message and the main
  `runs/<run-id>/report.json` report.
- The exact target settings and information about where the package came from.
- The package and source-file fingerprints used to identify the tested code.
- Package scans from before installation and from the copy actually tested.
- Separate bounded semantic-callsite artifacts for both of those snapshots.
- MCP tool information and message logs.
- Bounded advertised-claim evidence and standard MCP annotation evidence.
- Raw `strace` logs and the smaller list of readable actions created from them.
- `observation-health.json`, containing exact parser-integrity accounting and
  bounded policy-relevant canonicalization-gap evidence for each experiment.
- Before/after synthetic-profile snapshots and durable filesystem deltas for
  every initialization or tool experiment.
- Test-step timings, action-to-step links, rule results, server error output, and
  a claimed/source/observed/configured-scope comparison.

If analysis fails before those layers can be reconciled, Forge deliberately
does not synthesize a normal `report.json`. It preserves a failed manifest and
the partial raw artifacts instead, and now best-effort writes
`observation-health.json` with incomplete canonicalization so operators can
distinguish retained trace evidence from a completed assessment.

### What the core test cannot tell you

- It currently supports local Node.js MCP servers that use STDIO and run in a
  Linux Docker container. It does not cover every language, remote server, or
  operating system.
- It runs only the tool calls and inputs supplied in the settings. It does not
  automatically explore every tool, workflow, input, or unusual edge case.
- The lexical scan can find broad clues that never run. The semantic sidecar is
  more precise for its modeled direct and immutable-alias callsites, but can
  still miss mutable, higher-order, reflective, dependency-provided, or
  deliberately disguised behavior. It does not yet assess handler reachability
  or source-to-sink data flow.
- The operating-system recorder watches a selected set of operations. It does
  not capture every possible effect or the readable contents of encrypted
  network traffic.
- Trace integrity does not mean semantic completeness. The policy-gap taxonomy
  is intentionally selected and cannot prove that every parsed but
  non-canonical syscall is irrelevant.
- Bind/listen descriptor correlation models common clone/fork, duplication,
  close, and close-range behavior, but remains best effort across equal trace
  timestamps, exec-time descriptor-table separation, standalone
  `unshare(CLONE_FILES)`, and uncommon descriptor-transfer mechanisms.
- Thread-local `exit` syscalls and normal terminal control lines are
  structurally accounted for but do not always become canonical process-exit
  events; Forge avoids guessing that one thread exiting ended the process.
- Trace parsing and classification currently batch-read the selected per-process
  logs. Runtime time/resource limits constrain the target, but Forge does not
  yet enforce a separate aggregate raw-trace byte/line quota; bounded streaming
  ingestion is required before treating this as hostile multi-tenant
  infrastructure.
- Observation health is optional in the V1 report schema for compatibility with
  previously retained reports. Current `forge analyze` runs always emit it, and
  publication cross-validates it when present; a legacy V1 bundle without the
  field remains accepted until a producer capability marker or report V2 can
  require it without reinterpreting old artifacts.
- Supported failed syscall attempts are evidence of attempted behavior, not
  proof that the requested access or execution succeeded.
- Filesystem snapshots are bounded and omit some metadata. Large same-size
  content changes can be missed when a file exceeds the hashing limit, and a
  state delta identifies an isolated experiment window rather than one process,
  source line, or exact phase. The elapsed-time bound is checked between
  operations and cannot interrupt one blocking filesystem call.
- Connecting an action to a tool uses timing and process history. This is useful
  evidence, but it is not perfect proof that one exact line of code caused the
  action.
- Forge knows that behavior is unexpected only because a person supplied the
  allowed behavior for the test.
- A report with no warnings means that the selected tests found no mismatch
  covered by the current checks. It does not mean the package is safe in every
  situation.

## Agent test: study the AI and tool descriptions together

Command: `forge agent-evaluate`

### What you provide

- A fake user task and a reference to the MCP target settings.
- A previously approved digital fingerprint for the exact tool names,
  descriptions, and input rules that may be shown to the outside AI service.
- Clear rules describing which tool actions are allowed or denied.
- Clear checks describing what counts as successfully completing the task.
- The model, number of trials, and limits on turns and tool calls.
- An OpenRouter API key for a live run. The built-in offline test does not need
  a real key.

### What Forge does

- Prepares the MCP independently with install scripts turned off.
- Starts it in a fresh fake environment and asks it for its tool list.
- Stops before contacting the outside AI service if the tool names,
  descriptions, or input rules no longer match the approved fingerprint.
- Lets the model choose tools and arguments, but checks every proposed action
  against fixed allow/deny rules before running it.
- In `enforce` mode, refuses denied actions. In `observe` mode, it may run a
  denied action only against Forge's fake, controlled resources so the attempted
  behavior can be measured safely.
- Keeps the MCP's fake files separate from the fake files used by Forge's own
  controlled tools. This prevents a tested MCP from secretly changing what the
  AI later sees from a trusted test tool.
- Does not send MCP tool results or MCP error details back to the outside AI
  service.
- Repeats the test and reports both rule-following and task-completion results.

### Questions the agent test helps answer

- Does wording in an approved MCP tool description change which tools the model
  chooses or which arguments it supplies?
- Does the model propose an action that the test rules forbid?
- Does blocking forbidden actions still allow the task to succeed?
- Under these exact test conditions, how often did the model follow the rules
  and complete the task?

### What the agent test produces

- A short completion message and
  `agent-runs/<run-id>/agent/report.json`.
- A record of each trial, model response, proposed tool call, allow/deny
  decision, and task-completion result.
- Local MCP logs, controlled-tool actions, final observations of selected test
  files, resource-limit evidence, and cleanup results.

### What the agent test cannot tell you

- Live runs currently use OpenRouter only.
- A person must write the fake task, allow/deny rules, and success checks.
- Because MCP results are hidden from the model, this version does not test
  attacks placed inside an MCP tool result or long-term model memory.
- Results apply only to the recorded model, prompt, tool set, test setup, and
  small number of trials. A few trials cannot establish a general failure rate
  or prove that a description caused the behavior.
- Only fake, controlled resources are included. This test does not permit access
  to real accounts, credentials, or external services.
- The agent test is separate from the core report and is not yet used to approve
  packages for a registry.

## Limits shared by both tests

- Neither test can give a universal “safe” or “malicious” verdict.
- The current Docker and in-container `strace` setup is suitable for a prototype,
  but it is not the strongest possible barrier for hostile software. A separate
  virtual machine and an outside observer would provide stronger protection.
- Reports are primarily JSON files intended for machines and technical review.
  A polished web or HTML explanation is not implemented.
- Automatic package approval, continuous checks for changed packages, and live
  enforcement during real use remain future work.
- The checked-in example reports are cleaned representative examples. Full test
  runs are intentionally not committed to the repository.

See [Prototype.md](../publishing/prototype.md) for commands and output files,
[ArchitectureAndTrustModel.md](architecture-and-trust-model.md) for the deeper
security design, and [AgentRolloutV1.md](../history/agent-rollout-v1.md) for the full agent
test design.
