# Evidence-First V2 reviewed enrollment alpha

**Status:** Implemented and verified for exact npm or local `install:none`
Node.js MCP servers over STDIO.

This path extends the pinned `controlled_fixture_only` outcome experiment
without weakening it. It can enroll an unfamiliar target and execute one
operator-authored call, but it does not declare the target safe and it does not
let a model choose an arbitrary call from the discovered catalog.

## What is bound before execution

The controller:

1. Acquires one exact npm version with lifecycle scripts disabled, or copies a
   local no-install snapshot.
2. Retains a bounded whole-tree snapshot, normalized direct Node invocation,
   immutable sandbox-image ID, package lock/integrity provenance when npm
   supplies it, and a complete one-page catalog.
3. Runs discovery in a no-network, no-secret, zero-`tools/call` container and
   verifies cleanup before review.
4. Compiles one exact call from the operator-authored target YAML. An optional
   proposer predicts the result shape/content class only; it cannot choose the
   tool or arguments and cannot grant authority.
5. Presents the full bounded plan, policy, hypothesis, exact arguments, and
   digests to a required manual-review callback with a 30-second deadline.
6. Starts a fresh session and rechecks the retained tree, resources, runtime,
   live catalog, plan, policy, tool, and argument digest immediately before the
   call. A process-local, one-use authority returns an opaque dispatch receipt.
7. Sends exactly one call with no retry or follow-up, keeps the raw result in
   local mode-0600 transcript evidence, derives only a structural/lexical
   observation, and verifies container plus temporary-input removal.

Serialized enrollment, review, dispatch, observation, comparison, and cleanup
records are evidence. They are not bearer capabilities. The key indexed
evidence artifacts are resolved from logical IDs to exact paths, byte lengths,
and SHA-256 values by `v2/evidence-index.json`; the index is a fixed evidence
subset, not an inventory of every retained file.

## What the comparison means

The current observer assesses the MCP result channel: protocol outcome, result
shape and size, advertised output-schema conformance, and bounded hazardous
content classes. It does not observe process, filesystem, or network effects.
Those required sensors remain explicitly unavailable, so a completed enrolled
run remains overall `inconclusive`, including when the returned value matches
the hypothesis and no result-text signal is found.

The lifecycle-side-effect control makes this limitation concrete. Its valid
JavaScript entrypoint imports another module, writes under the container's
ephemeral `/tmp`, and starts a direct child during `initialize`; the enrolled
result observer does not see those effects and therefore does not claim their
absence.

## Supported and unsupported risk

The runtime container has no network, no provider credential, read-only target
and resource mounts, a read-only root filesystem, dropped capabilities,
`no-new-privileges`, and bounded CPU, memory, PIDs, files, output, and time.
This is useful containment for curated compatibility experiments, not a
malware-grade isolation boundary. A JavaScript entrypoint can still load
transitive native add-ons, use Wasm/JIT, or start binaries already present in
the image. Known-hostile or native-heavy packages should run on a disposable
worker or microVM with compatible process/filesystem/network sensors.

Npm acquisition necessarily has network access and no hard quota on its host
bind. `--ignore-scripts` blocks lifecycle scripts, but dependency URLs need not
be confined to the npm registry and the fresh lock records the resolved
transitive closure only after acquisition. Local source copying and tree
rehashing also are not race-free content-addressed filesystem transactions.

Unsupported sources, unsafe runtime descriptors, incomplete or changing
catalogs, schemas that cannot compile a safe exact call, failed review, drift,
timeouts, and unverified cleanup fail closed with bounded records and no retry
authority.

## Verification

```bash
npm run verify:v2-enrollment:local
npm run verify:v2-enrollment
```

The local gate covers benign, result-injection, lifecycle-side-effect, and
review-decline cases. The full gate additionally acquires the pinned real npm
cases under `case-studies/v2-unseen-enrollment/`. Generated raw runs remain
gitignored; the sanitized study record under `experiments/evidence-first-v2/`
contains the durable exact dispositions and limitations.
