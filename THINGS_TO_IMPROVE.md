# Things to Improve

- **Turn reviewed enrollment into agent-selected planning.** The new enrollment
  alpha can pin an unfamiliar exact npm or local Node STDIO target, discover it
  without runtime network or secrets, manually approve one operator-authored
  YAML call, and quarantine the result. The optional proposer still predicts
  only the output; it does not choose a tool and arguments from the unfamiliar
  catalog. A future bounded proposal compiler should let an agent suggest that
  call while deterministic schema, policy, synthetic-resource, and manual-review
  gates retain all execution authority.

- **Observe enrolled lifecycle and tool effects.** Enrolled comparisons currently
  assess only the MCP result channel. A valid JavaScript entrypoint can import
  native code, spawn children, or touch its ephemeral filesystem during
  `initialize` and `tools/list`; the lifecycle-side-effect control demonstrates
  that these effects remain unobserved. Process, filesystem, and network sensors
  must be integrated before a matching result can become a within-policy
  behavioral conclusion.

- **Use stronger isolation for hostile enrollment.** The current no-network,
  read-only Docker profile is suitable for curated compatibility experiments,
  not known malware. Native-heavy or hostile packages need disposable workers
  or microVMs, content-addressed staging, acquisition storage quotas, and
  egress-controlled dependency acquisition.
