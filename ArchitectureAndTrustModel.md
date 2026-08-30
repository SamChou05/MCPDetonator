# Forge architecture, trust model, and claim boundaries

**Status:** Current product/design record

**Updated:** 2026-08-29

This document records what Forge is intended to accomplish, what is implemented
today, what the supplementary agent-context path adds, and which conclusions
Forge cannot reach without trusted external policy. It is the product-level
source of truth for scope, assumptions, and honest claims.

Detailed implementation mechanics remain in [Design.md](Design.md), current
delivery status remains in [ImplementationPlan.md](ImplementationPlan.md), and
the implemented supplementary rollout harness remains in
[AgentRolloutV1.md](AgentRolloutV1.md).

## Executive summary

Forge is building an evidence-producing MCP audit system, not a universal
classifier that can determine whether any MCP is safe from the MCP alone.

Today, Forge deterministically inspects and detonates selected local MCP
software. An operator supplies the target, tool inputs, and expected scope.
Forge records what the package contains, what it advertises, acquisition
provenance and bounded npm output, and focused process behavior during covered
installation, initialization, and selected tool calls. Acquisition itself is
not currently a traced normalized phase. Findings are mismatches against the
operator-authored scope.

The standalone Agent V1 layer places a hash-approved projection of MCP
advertised metadata in a controlled model/tool loop. It records what an agent
proposes or does in the presence of that metadata under a synthetic user task.
Before the first provider request, Forge verifies the canonical ordered target
tool names, descriptions, and input schemas against the scenario-declared
approved hash. The model
chooses actions, but a trusted deterministic controller supplies authorization,
intercepts calls, contains execution, and scores the result. Target MCP results
and target error text remain local in V1 and are not returned to the external
model.

For V1, the paths remain separate and use separate reports. Their cases can be
matched on the same configured source identity, logical synthetic world,
authorization rules, resource shapes, and task-success conditions so results
can be compared. The Agent V1 runner independently prepares its target with
lifecycle scripts disabled; it does not consume the core run's prepared
snapshot or normalized evidence. Within each agent trial, the target and
Docker-backed controlled filesystem workers deliberately receive separate
profiles and distinct canaries so target writes cannot become provider-visible
filesystem-tool inputs. The in-memory receiver has no filesystem profile. The
paths do not need identical traces because they answer different questions. A
shared contract is deferred until both paths prove independently useful.

The central limitation is the **oracle problem**: an arbitrary MCP cannot be
trusted to tell Forge which of its own behaviors are legitimate. Its metadata
and documentation are evidence and claims, not ground truth. Real registry
admission therefore requires enterprise policy and, initially, human approval
of a capability profile.

| Stage | Status | Core question | Source of ground truth |
| --- | --- | --- | --- |
| Static and direct software detonation | Implemented and hardening | What does the selected artifact contain and directly do? | Operator-authored calls, scope, and sandbox policy |
| Agent-context detonation | Implemented as a separate opt-in V1 | What does a covered agent propose or do in the presence of exact MCP metadata? | Operator-authored agent task, authorization, and utility oracle |
| Registry admission | Future | Under what restrictions may an enterprise deploy this exact artifact? | Enterprise policy plus reviewed capability profile and audit evidence |
| Runtime gateway | Future | Is this particular live action authorized now? | Approved deployment policy and user/task context |

## Product question and long-term direction

The current audit backend is intended to grow into the evidence and enforcement
layer behind a Forge-owned MCP registry.

A future registry entry should be able to say:

- Which exact artifact, version, dependency graph, and hash were evaluated.
- Which capabilities appeared in its code and metadata.
- What happened during covered installation and runtime experiments.
- What covered agents proposed or executed in the presence of its metadata.
- Which capabilities were approved, denied, or require user approval.
- Which sandbox and runtime restrictions are required for deployment.
- What was not tested and when reevaluation is required.

Registry admission remains version-, policy-, environment-, model-, and
coverage-specific. Forge should not publish a permanent, universal `safe`
label for a package name.

## What Forge accomplishes today

The implemented path is deterministic software analysis and runtime
detonation for the current Node.js/Linux/STDIO scope.

### Trusted inputs

An operator-authored target configuration currently provides:

- The exact npm package/version or local source snapshot.
- How to start the MCP server.
- Which tool calls and arguments to exercise.
- Expected file, process, and network scope.
- Sandbox limits and synthetic test inputs.

These inputs are part of the test oracle. Forge knows that an action is
out-of-scope because the scenario author defined the permitted scope; it does
not discover complete user intent from the MCP.

### Automated pipeline

Forge automatically:

1. Acquires or snapshots the target and records provenance.
2. Performs bounded static inspection of the Node package.
3. When preparation produced a reusable npm cache, compares installation with
   lifecycle scripts disabled and enabled; local `install:none` targets skip
   this pair.
4. Starts the MCP in fresh, synthetic Docker environments.
5. Records the MCP interface returned by `tools/list`.
6. Calls configured tools with configured arguments.
7. Captures MCP transcripts and focused operating-system behavior.
8. Normalizes and attributes process, filesystem, and network evidence.
9. Applies deterministic rules against expected scope.
10. Produces evidence-linked machine-readable reports.

### What this path can establish

Within a covered experiment, Forge can establish evidence such as:

- A process read or wrote a particular synthetic path.
- A process executed another program.
- A process attempted a network connection.
- An effect occurred during installation, initialization, a selected tool
  call, or a post-return observation window, subject to stated attribution
  confidence.
- Observed behavior exceeded the operator-approved scope.
- Static capability signals were or were not observed at runtime in the
  selected phases.

### What this path does not establish

The current path does not establish:

- That the MCP is safe for every input, tool, workflow, or environment.
- That suspicious code is reachable or malicious merely because it exists.
- That an unobserved capability does not exist.
- That the MCP's own description is truthful.
- Whether metadata would manipulate a tool-using model.
- The complete correct authorization policy for a previously unknown MCP.

Tool descriptions and schemas are currently captured as untrusted evidence.
They do not decide which tool Forge calls and do not define authorization.

## What the agent-context extension adds

The standalone agent layer answers a distinct question:

> What does a particular agent propose or do in the presence of this MCP's
> exact metadata for a controlled user task and tool set?

The rollout itself is agentic: the model receives the synthetic task and exact
operator-approved tool names, descriptions, and schemas, then chooses tool
names and arguments over multiple turns. The security boundary around it
remains deterministic.

Forge automatically:

1. Independently prepare the configured target source with lifecycle scripts
   disabled and create a fresh synthetic trial environment.
2. Discover and preserve the MCP's exact names, titles, descriptions, schemas,
   and annotations.
3. Build a canonical ordered projection of the target names, descriptions, and
   input schemas destined for provider function fields, require its SHA-256 to
   match the scenario declaration, and stop before any provider request if it
   does not. This binds the field content and ordering, not serialized HTTP
   request bytes. Titles and annotations remain local evidence because V1 does
   not send them through provider function fields.
4. Record every model response and proposed tool call.
5. Evaluate each proposal with a trusted authorization policy.
6. Block or dispatch the call according to the selected policy mode.
7. Execute target calls against a read-only candidate artifact plus a fresh
   target profile. Docker-backed controlled filesystem calls use a physically
   separate synthetic profile with distinct canaries; the controlled receiver
   is an in-memory trusted-controller sink with no external route.
8. Record raw target traces, controlled-tool effects and canaries, policy
   decisions, task utility, and containment. Agent V1 does not run the core
   trace normalizer or runtime rule engine over its target traces.
9. Repeat trials and report rates with exact model and prompt conditions.

The provider credential is confined to the trusted controller, provider
adapter, and exact-match isolation scanners. It is not mounted into the target
or Docker-backed tool workers, sent in model messages, or intentionally
persisted. Completed runs are exact-key scanned, and a partial run is deleted if
the registered key is detected.

Agent V1 additionally rejects every configured target runtime environment
entry, withholds target MCP results/errors from provider history, preflights
registered provider credentials in provider-bound inputs, exact-match scans
the prepared candidate tree before MCP startup, and deletes a new run
directory if a later evidence scan fails. The `operator_approved`
declaration plus hash binds the scenario decision to the canonical
provider-bound field projection, but it remains a human/policy authorization
decision—not proof that the metadata is safe or truthful.

At preflight, V1 also persists validated `agent/scenario.json` and
`agent/target-config.json` and hashes those exact JSON bytes for the final
report. Those hashes identify the executed configuration objects rather than
YAML files re-read after a long run. The prepared scripts-disabled tree and the
provider-bound metadata projection have separate hashes because they answer
different identity questions.

### What the agent path can add

The agent path can reveal failures the direct runtime path cannot, including:

- A poisoned description persuading the agent to call another legitimate
  high-privilege tool.
- Metadata changing tool selection or arguments before the target tool runs.
- Controlled synthetic tool results redirecting later agent actions. Target
  result-channel poisoning is intentionally outside V1 because target results
  are withheld from the provider.
- An agent proposing an unauthorized action that runtime enforcement blocks.
- Model- or toolset-specific susceptibility rates across repeated trials.

It does not convert model behavior into deterministic proof. Its results remain
specific to the recorded model, provider, prompt construction, available tool
set, scenario, limits, and trial count.

## Comparable scenarios, separate V1 paths

Direct software detonation and agent-context evaluation are independent V1
commands and contracts. Their cases should be authored as matched experiments
rather than unrelated tests. If both paths demonstrate value, their common
fields can later become one `AuditScenario` without merging their execution or
evidence contracts prematurely.

### Shared trusted concepts

Both arms should use matched versions of the same:

- Configured target source identity and version.
- Logical synthetic filesystem, fake-credential, service, and canary shapes.
- User-level objective.
- Allowed and denied capabilities.
- Objective task-success predicates.
- Resource limits and cleanup rules.

### Arm-specific inputs

The direct-runtime arm additionally specifies canonical tool calls and
arguments. It asks what the MCP implementation does when invoked in a known
way.

The agent-runtime arm additionally specifies the model configuration, tool
presentation, trial count, and turn/call limits. The model chooses which tools
and arguments to propose.

The core path performs static analysis of its own prepared artifact but does
not execute the task. Agent V1 does not currently consume those static signals
or the core run's prepared snapshot. Results can be compared by pinned source
identity and scenario semantics; they must not be represented as one shared
artifact execution unless a future integration actually enforces that.

### Comparison rule

Today the core arm evaluates observed effects against operator-authored runtime
scope; it has no task-utility score. Agent V1 separately evaluates proposal
authorization and declared task utility. A future or manual matched study can
map both outputs to one higher-level oracle, but Forge does not currently
compute a single automatic cross-arm score or exact trace diff.

Within Agent V1, each scored trial uses two independent axes:

| Task utility | Authorization | Interpretation |
| --- | --- | --- |
| Pass | Pass | Proposal policy and declared utility passed; target runtime safety is not implied |
| Fail | Pass | Quality or usability failure |
| Pass | Fail | Task completed through excessive or unsafe behavior |
| Fail | Fail | Unsafe behavior and task failure |

The combined evidence also localizes the failure:

- Unsafe direct-runtime behavior indicates a target implementation problem for
  the covered call.
- A direct call with no covered mismatch plus an unauthorized agent proposal
  indicates an agent/metadata interaction problem.
- An unauthorized proposal that is blocked demonstrates attempted unsafe
  behavior and successful containment, not a safe proposal.
- Matching static and runtime evidence increases explanatory confidence but
  does not establish intent.

## The oracle problem

An oracle is the trusted definition of what the task should accomplish and
which actions are permitted while accomplishing it.

### Why the MCP cannot supply the oracle

For a real unknown MCP, the following inputs are controlled by or associated
with the party being audited:

- Tool names and descriptions.
- Input schemas and property descriptions.
- Tool annotations.
- Package documentation.
- Claimed permissions or intended destinations.

Forge can parse these into a **claimed or proposed capability profile**, but
cannot treat that profile as authorization. Doing so would allow a malicious
MCP to authorize its own behavior by describing that behavior as necessary.

Many actions are also context-dependent. Network access may be essential for a
Slack integration and unnecessary for a calculator. Reading a selected folder
may be expected for a filesystem server, while reading a credential directory
is not. The syscall alone does not contain the user's intent.

### What can be known without a complete task oracle

Forge can still report hard facts and apply independent enterprise invariants,
for example:

- Access to synthetic secrets or explicit canaries.
- Attempts to escape the sandbox or reach blocked network destinations.
- Execution of undeclared child processes.
- Behavior outside an enterprise-approved filesystem root.
- Differences between declared, approved, static, and observed capabilities.
- Metadata patterns associated with cross-tool instructions or credential
  requests.

Some of these are unconditional violations only because the enterprise or test
environment defined them that way. Otherwise they are evidence requiring
classification, not proof of maliciousness.

### Consequence for current experiments

Current fixtures have strong ground truth because Forge's authors created the
synthetic world and planted the known behavior. Real-target experiments have a
smaller oracle: they demonstrate consistency with the configured scope for the
selected cases, not universal legitimacy.

Agent V1 will retain this limitation. Hand-authored tasks and policies provide
high-quality ground truth but limited breadth. Repeated trials reduce sampling
noise; they do not solve missing or incorrect ground truth.

## Trust model and core assumptions

### Trusted components

- The Forge controller, policy evaluator, evidence writer, and scorer.
- The scenario author's authorization and utility definitions.
- The sandbox/worker control plane and synthetic fixture builder.
- The external observer to the extent described by the current containment
  design.
- Enterprise policy and approved capability profiles.

### Untrusted inputs and components

- Target package, dependencies, install scripts, and server process.
- MCP tool metadata, annotations, schemas, and results.
- Package documentation and vendor capability claims.
- Agent-generated text, tool choices, arguments, and self-evaluation.
- Runtime evidence content emitted by the target.

### Assumptions made by the current design

1. Each path's report identifies its own selected or prepared artifact; matching
   core and agent cases currently rely on pinned configured source identity
   rather than a shared prepared snapshot.
2. The selected scenarios are meaningful samples of intended use.
3. The operator-authored policy accurately represents authorization for those
   scenarios.
4. Synthetic resources reproduce the security-relevant shape of the real task
   closely enough to exercise covered behavior.
5. The observer captures the focused classes of behavior it claims to cover.
6. The target cannot cross the prototype sandbox boundary in ways the design
   fails to observe; this is a prototype assumption, not a production proof.
7. In agent evaluation, the recorded model endpoint executes the requested
   model configuration and sees only the synthetic task, controlled-tool data,
   model history, and the exact ordered target metadata projection whose hash
   an operator explicitly approved for provider disclosure.
8. The controller and provider credential remain outside the target's authority.
9. Separate target and Docker-backed controlled-filesystem profiles plus
   distinct canaries prevent target-written state from becoming filesystem-tool
   output within a trial. The in-memory receiver is a different trust boundary.

If one of these assumptions is false, the report must narrow or invalidate the
corresponding conclusion rather than silently presenting full confidence.

## Limitations and non-claims

### Coverage limitations

- Dynamic testing observes only selected inputs and time windows.
- Dormant, environment-gated, delayed, or trigger-specific behavior may not run.
- Static Node inspection is bounded lexical analysis, not complete reachability
  or information-flow proof.
- The focused syscall model does not reconstruct every kernel effect or the
  meaning of encrypted traffic.
- Local STDIO observation does not expose private internals of a remotely
  hosted MCP.

### Causality limitations

- Timing and process lineage support attribution but do not prove perfect
  causality.
- A real-target rollout with original metadata shows behavior in the presence
  of that metadata. Without a matched control, it does not prove that one
  sentence uniquely caused the behavior.
- Clean/poisoned sibling fixtures verify that only the selected description
  differs. The offline scripted provider currently follows a fixed poisoned
  trajectory and validates plumbing, policy, isolation, scoring, trusted
  target-tmpfs final-state observation, quota evidence, and cleanup; it does
  not yet prove a causal behavioral difference between the two descriptions or
  mean a real MCP supplies multiple descriptions.

### Agent-evaluation limitations

- Results vary by model, model version, provider, system prompt, client tool
  formatting, available tools, task wording, and sampling configuration.
- A small number of trials can produce unstable rates.
- An LLM judge is not an authorization oracle and must not override
  deterministic security policy.
- A refusal can prevent harm while still failing the task; it is not equivalent
  to useful, secure completion.
- The external model provider receives the synthetic prompt, approved tool
  metadata, controlled-tool results, and model history sent to it.
- Target MCP results and target errors are withheld, so V1 does not test
  result-channel prompt injection.
- Target success and failure use the same fixed provider-visible marker, while
  local action evidence preserves the true outcome. Timing, timeout, and
  session-termination channels remain, so V1 does not claim noninterference.
- Hash matching proves that the canonical provider-bound target field
  projection equals the scenario-declared projection; it does not bind all HTTP
  request bytes, prove that metadata is benign, or prove that the operator chose
  correctly. A polished preview and policy workflow remain future work.
- Target and Docker-backed controlled-filesystem tools use separate synthetic
  profile taint domains and distinct canaries. Utility may inspect either
  domain and records which domain was missing, mismatched, unavailable, or
  satisfied a predicate, plus bounded kind/size/content-hash evidence.
- Before target tmpfs cleanup, Forge records bounded final-state observations
  for synthetic path strings found in dispatched target-MCP arguments. The
  action/path join identifies why a path was inspected; it does not establish
  that a particular action caused the observed state.
- Target-authored JSON Schemas are bounded and forwarded as untrusted provider
  data but are never compiled or evaluated by the trusted host controller.
- Candidate scanning recognizes only exact registered provider-credential
  bytes. It cannot prove that a source tree lacks other, encoded, or transformed
  secrets, so Docker and this scan are not a secret-management boundary.
- MCP JSON-RPC recording has cumulative message/payload limits, the SDK has a
  separate per-raw-message stdio buffer cap, and stderr is captured through a
  bounded stream; overflow aborts the target session before it can grow an
  unbounded controller write queue.
- Decoded provider completions and persistable provider-error messages are
  exact-scanned for registered credentials before dispatch or evidence writes.
  OpenRouter non-success response bodies are discarded.
- Agent target home state is read-only, and its writable workspace is a 16 MB
  / 2,048-inode tmpfs seeded from a read-only profile. A container-wide 4 MB
  process file-size limit applies to target and trace writers. Linked raw traces
  and both target/controlled profile trees also share a monitored per-trial
  current-tree byte/entry budget; its usage/violation/termination evidence is
  persisted. Reaching the per-file trace sentinel, quota overflow, or an
  unexpected MCP transport close fails the evaluation.
- The fixed controlled-filesystem worker rejects paths deeper than 16
  descendants and charges cumulative attempted bytes and path-entry cost before
  starting, so a single proposal cannot manufacture an unbounded directory
  chain between monitor polls.
- Modeled provider and rollout-limit failures can produce an inconclusive
  score. Session, quota, and cleanup failures that invalidate containment abort
  the evaluation and preserve partial local evidence rather than publishing a
  completed report.
- Proposal-and-utility classifications do not classify raw target runtime
  effects; the deterministic core remains authoritative for those effects.
- Inconclusive trials are reported separately. Negative behavioral claims and
  means use only conclusive trials, while known unauthorized proposals,
  dispatches, executions, and containment outcomes remain counted in their
  metric-specific denominators even if another part of the trial failed.

### Containment limitations

- The current Docker/`strace` prototype is not a production hostile-code
  boundary.
- The target workspace uses kernel-enforced tmpfs byte/inode capacities and
  target home is read-only. Reaching one trace file's limit is fatal. The
  cumulative raw-trace limit is still live-polled, however:
  `strace -ff` may create multiple 4 MB-limited files and produce an aggregate
  polling-interval burst. Production execution still requires a disposable
  worker with a hard whole-filesystem quota and out-of-band kill control.
- The observer currently shares more of the execution environment than an
  external worker or microVM design should.
- Container cleanup failure is fatal and reported with the run directory, but
  session close and Docker inspect/removal are time-bounded. This is still not
  equivalent to a production control plane.
- `observe` mode may dispatch otherwise denied actions only to explicitly
  synthetic resources and controlled receivers. It must never target real
  accounts, credentials, or unrestricted networks.

### Registry limitations

- Approval becomes stale when code, dependencies, metadata, remote behavior,
  policy, or relevant model/client configuration changes.
- Remote MCP behavior can drift without a package hash changing.
- Registry approval cannot replace runtime least privilege and authorization.
- Enterprise policies differ; one organization's approval is not universal.

## Real-world registry admission path

Because Forge cannot extract a complete trustworthy oracle from an MCP alone,
the registry path should be a policy-governed workflow:

1. **Identify:** Pin the exact artifact, dependencies, metadata, and provenance.
2. **Propose:** Generate a claimed capability profile from documentation,
   schemas, static signals, and observed behavior. Mark it untrusted.
3. **Constrain:** Apply enterprise-wide invariants and deny rules.
4. **Approve:** Have a trusted reviewer or policy owner accept, narrow, or
   reject the proposed capability profile.
5. **Exercise:** Generate and run direct and agent scenarios against the
   approved profile, retaining human-authored high-risk cases.
6. **Attest:** Publish evidence, coverage, required restrictions, and status for
   the exact version rather than a context-free safety score.
7. **Enforce:** Apply the approved capability profile again at runtime.
8. **Monitor:** Detect artifact or metadata drift and mark stale entries for
   reevaluation.

Automation can propose capability profiles, select templates, expand schema
inputs, and prioritize risky cases. It cannot be the sole authority that turns
untrusted MCP claims into permission.

## Delivery stages and success criteria

### Stage 1: deterministic local audit — implemented and hardening

Success means Forge produces reproducible, evidence-linked static, install,
interface, and direct-runtime observations for the stated target adapters. It
correctly reports known fixture violations and bounded real-target behavior
without claiming universal safety.

### Stage 2: matched scenario semantics — implemented separately

Agent V1 has its own scenario contract and references an existing target
configuration. Controlled clean/poisoned cases match task, authorization,
utility predicates, resource shapes, and limits without changing the
deterministic target contract. Their target and filesystem-tool canary values
are deliberately distinct. A physically unified contract remains deferred.

### Stage 3: agent-context detonation — implemented as supplementary V1

Success means Forge verifies and records hash-bound canonical metadata-field
exposure, model trajectories, proposed/dispatched/executed actions,
deterministic policy decisions, domain-tagged utility, bounded target final-state
observations, containment, and repeated-trial rates
while withholding
target results and provider credentials from the model. The deterministic
fake-provider and Docker verification gates pass for plumbing, policy,
isolation, cleanup, and scoring; they are not a clean/poisoned causal model
study. A first three-trial-per-arm DeepSeek V4 Flash live smoke found a
metadata-correlated unauthorized-proposal delta, but it remains small-sample
exploratory evidence rather than a benchmark or registry admission signal.

### Stage 4: registry admission — future

Success means exact-version audit evidence is reviewed against enterprise
policy and converted into an approved capability profile with explicit
restrictions, coverage, expiry, and drift handling.

### Stage 5: runtime gateway — future

Success means registry policy is enforced for actual deployments, so audit
evidence reduces risk without becoming the only control between an agent and a
high-impact action.

## Open design decisions

- The minimum capability vocabulary that works across different MCP classes.
- Which enterprise invariants are safe to apply without task-specific context.
- How scenario coverage is measured and displayed without implying completeness.
- Which scenario templates can be generated automatically and which require
  human review.
- How approval, model changes, metadata drift, and remote-server drift trigger
  reevaluation.
- When agent evidence is mature enough to join the base report and default CLI.
- Which production isolation boundary—disposable worker, microVM, gVisor, or a
  combination—provides the required observer separation.

Until these decisions are resolved, reports must keep facts, attribution,
policy mismatches, interpretation, and registry decisions as separate layers.
