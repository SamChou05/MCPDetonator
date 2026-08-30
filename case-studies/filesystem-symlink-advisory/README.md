# Official Filesystem MCP symlink-advisory study

This matched case study runs the real
`@modelcontextprotocol/server-filesystem` package at vulnerable version `0.6.2`
and patched version `2025.7.1`. GitHub's official advisory
[GHSA-q66q-fx2p-7w4m](https://github.com/modelcontextprotocol/servers/security/advisories/GHSA-q66q-fx2p-7w4m)
states that affected versions could access unintended files through symlinks
inside an allowed directory.

Both targets use the same controller-authored bootstrap to create
`/sandbox/workspace/credential-link` pointing at Forge's randomized synthetic
SSH canary. The MCP receives only `/sandbox/workspace` as its allowed root, and
the selected `read_file` call uses the link. No host path or real credential is
available inside the container.

The bootstrap is part of the experiment setup, not the upstream package. It
reproduces the advisory prerequisite while preserving the package code and
version exactly. A successful vulnerable call and rejected patched call test
the package behavior. Forge's report then tests whether pathname-based runtime
observation recognizes the underlying sensitive target reached through the
link.

This is a selected-case regression, not a claim that every version or symlink
shape is covered.
