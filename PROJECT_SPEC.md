# Background

Over the past year, MCP servers and skills have become the fastest-growing attack surface in agentic AI. A February 2026 audit found 43% of public MCP servers vulnerable to command execution, and a separate scan of 7,000+ servers found 36.7% exposed to SSRF. Nearly 500 servers were found sitting on the open internet with zero authentication. On the skills side, Snyk's ToxicSkills study scanned roughly 4,000 skills on marketplaces like ClawHub and found 36% contained detectable prompt injection, 1,467 had at least one security flaw, and 91% of confirmed-malicious skills combined prompt injection with traditional malware. Koi Security separately flagged 341 malicious skills in one marketplace audit, including a coordinated campaign ("ClawHavoc") pushing infostealer malware through 335 of them.

Researchers at Cato Networks took Anthropic's own legitimate GIF Creator Skill, added a single hidden helper function, and turned it into a MedusaLocker ransomware dropper, without tripping any additional approval prompt, because Claude's consent flow covers the visible script, not what it fetches and runs at runtime. Separately, the peer-reviewed [MCPTox benchmark](https://ojs.aaai.org/index.php/AAAI/article/view/40895) reported a maximum 72.8% attack-success rate across its evaluated agent settings. The later [MCP-ITP preprint](https://arxiv.org/abs/2601.07395) reported up to 84.2% for an adaptive implicit-poisoning method. Neither result isolates tool auto-approval as the causal experimental variable.

> In short: today, almost nobody actually knows what an MCP server or skill does before they run it. People read a README, maybe skim the code, and trust it. This trial is about building the thing that closes that gap.

---

# Forge

At Forge, we’ve always been focused on behavior and intent as mechanisms for assessing risk. Many customers are increasingly worried about the threat posed by MCPs and skills downloaded from the internet to their environment.

Thus, we’re attracted to the idea of “detonating” local MCP servers before their use to assess what the software actually does.

A handful of companies were built almost entirely around this idea of “don’t trust the file, detonate it and watch.” FireEye is the most famous case. They launched around 2004, IPO’d in 2013, and their core focus was file detonation for malware detection.

With an MCP server, there are several layers to understand. There is what it claims to do through its source code, tool definitions, descriptions, and schemas, and there is what the software actually does when it starts up and when those tools are invoked. An MCP may read local files, access credentials or environment variables, spawn subprocesses, make network requests, modify the filesystem, load additional code, or perform other behavior that is not obvious from its public interface.

---

# The challenge

The primary goal is to build a detonator for local MCP servers that helps answer a simple question:

> What does this piece of software actually do?

Your system should combine static analysis with runtime observation. Before execution, inspect what you can learn about the server from the code and its MCP interface: what tools it exposes, their descriptions and input schemas, dependencies, permissions or resources it appears to require, and anything else you think is useful. Then execute the MCP in an instrumented environment and observe its behavior across its lifecycle.

We’re particularly interested in understanding:

- What happens when the MCP initializes, before any tool has been called?
- What processes and subprocesses does it create?
- What files does it read, write, create, or modify?
- What environment variables, credentials, configuration, or other local resources does it access?
- What network connections and requests does it make?
- What code or dependencies does it load dynamically?
- What happens when individual MCP tools are invoked?
- Can you correlate a specific tool invocation with the process, filesystem, and network activity it caused?
- Does the runtime behavior match what the tool's name, description, schema, and source code suggest it should do?
- Are there behaviors or side effects that would have been difficult to identify from the MCP interface alone?

The goal is not necessarily to build a perfect malware classifier. We care more about whether you can build useful infrastructure for observing, attributing, and explaining an MCP server's software behavior.

> A narrow prototype that deeply analyzes one or two MCP servers is worth more here than a broad, shallow scanner.

---

## If time permits: what about the agent?

Once you've understood what the MCP itself does and how its tools are defined, there is a second question we're interested in:

> Do you think there is more to learn about the MCP's impact by observing how an agent actually uses it?

You've already seen the MCP's static definitions and observed the underlying software behavior during initialization and tool calls. Is that enough to assess the important risks, or are there behaviors that only become apparent once those tools and their outputs are placed into an agent's context?

For example, an MCP might return content that changes what an agent does next, cause information to flow between otherwise unrelated tools, or steer an agent toward actions that would not be visible when testing each MCP tool independently.

If time permits, feel free to explore this question. Think about whether studying agent rollouts provides meaningfully different information from static analysis and software detonation, and, if so, how you would design a system to evaluate that automatically at scale.

Consider questions like how you would generate useful trajectories, what signals you would score, how many rollouts you might need, and how you would distinguish behavior caused by the MCP from a poor decision made independently by the agent.

This is deliberately open-ended. A well-reasoned conclusion that agent rollouts add little beyond software analysis is just as interesting as a prototype showing that they expose an important new class of behavior.

The repository now includes two separate experiments for this question:
[AgentRolloutV1.md](docs/history/agent-rollout-v1.md) studies model tool-use trajectories,
while [EvidenceFirstV2AgentProposals.md](docs/history/evidence-first-v2-agent-proposals.md)
tests whether an untrusted model can add useful audit-plan candidates beyond a
deterministic baseline without receiving execution authority.

[EvidenceFirstV2Enrollment.md](docs/history/evidence-first-v2-enrollment.md) documents the
separate reviewed alpha for one operator-authored call against an unfamiliar
exact npm or local Node STDIO target. Its result-channel comparison remains
inconclusive whenever process, filesystem, or network sensors are unavailable.

---

# What "done" looks like

By the end of the day on Sunday, we'd like to see:

Within the prototype's explicitly documented local Node.js/STDIO/Linux scope,
the repository now satisfies each requested deliverable. These checkmarks do
not claim universal behavior coverage; see
[`CapabilitiesAndLimitations.md`](docs/architecture/capabilities-and-limitations.md).

- [x] A working prototype we can point at a real local MCP server and get back a concrete report of what it observed.
- [x] Some useful static analysis of the MCP itself: its tools, inputs, dependencies, source behavior, and anything else you think helps establish what the software claims or appears to do.
- [x] Runtime observation of the MCP during initialization and during one or more tool calls, including signals such as processes spawned, filesystem activity, network activity, resources accessed, and other relevant system behavior.
- [x] The ability to connect that runtime behavior back to MCP lifecycle events or specific tool invocations so that we can understand why a particular system action occurred.
- [x] If time permits: your answer to the agent-behavior question above, either as a design proposal or prototype for automatically evaluating what additional information can be learned from agent rollouts.

Our goal is to measure your ability to make intelligent design choices and think through a largely unexplored systems and security problem. There are interesting considerations here around sandbox infrastructure, runtime instrumentation, static analysis, behavioral attribution, and, optionally, agent evals.

---

# Repository implementation

- [`Prototype.md`](docs/publishing/prototype.md) explains the implemented architecture,
  evidence model, verified cases, limitations, and core demo.
- [`case-studies/trace-corpus/README.md`](case-studies/trace-corpus/README.md)
  provides four pinned public MCP targets and a manifest-bound coverage
  summarizer; the [recorded experiment](experiments/baseline/trace-coverage-corpus-2026-08-30.md)
  explains which gaps warranted implementation work.
- [`PublisherDemo.md`](docs/publishing/publisher-demo.md) runs the optional synthetic
  S3/PostgreSQL completed-run publisher locally.
- [`HardenedEvidenceInfrastructurePlan.md`](docs/history/hardened-evidence-infrastructure-plan.md)
  separates that bounded integration slice from the remaining production
  hardening roadmap.
- [`DashboardAwsDemo.md`](docs/dashboard/dashboard-aws-demo.md) builds, publish-refreshes, and
  deploys the minimal script-free results report; [`DashboardArchitectureDecision.md`](docs/dashboard/dashboard-architecture-decision.md)
  records the alternatives, database boundary, cost, and replacement triggers.
