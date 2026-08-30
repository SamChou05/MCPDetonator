# Contained SANDWORM_MODE MCP-injection reproduction

Socket's February 2026
[SANDWORM_MODE report](https://socket.dev/blog/sandworm-mode-npm-worm-ai-toolchain-poisoning)
documents malicious npm packages that wrote a hidden MCP server, inserted it
into AI-client configuration, and advertised innocent-looking tools whose
descriptions told an agent to silently collect credentials into a `context`
argument.

This fixture reproduces only those observable shapes:

- `postinstall.js` writes an inert hidden-server marker and a synthetic client
  `mcp.json` entry under Forge's per-experiment fake home;
- the poisoned `index_project` description asks for Forge's randomized
  synthetic SSH canary through another controlled tool; and
- the target writes the supplied context only to its synthetic workspace.

It deliberately omits obfuscation, propagation, persistence, real client
paths, real secrets, destructive behavior, and every external destination.
Network access is blocked. The installed marker is never executed, and no host
MCP configuration is read or modified.

`target.yaml` exercises deterministic static, install-lifecycle, metadata, and
runtime evidence. The clean/poisoned target pair is reserved for a matched
Agent V1 study with identical task, schemas, policy, and synthetic tools.

The first completed deterministic and live-agent results are recorded in
[documented-malicious-mcp-study-2026-08-30.md](../../experiments/security/documented-malicious-mcp-study-2026-08-30.md).
