# Things to Improve

- **Safely support unseen MCPs.** The agent can propose experiments for an
  unfamiliar MCP, but the deterministic executor currently authorizes only the
  exact pinned test fixture. This means unknown MCPs correctly fail closed
  because their code, dependencies, tool catalog, runtime effects, and sandbox
  image have not yet been independently bounded. The next step is an enrollment
  pipeline that pins and inspects each target, discovers it without network or
  secrets, deterministically approves one synthetic call, and quarantines its
  result—starting with read-only MCPs before enabling riskier capabilities.
