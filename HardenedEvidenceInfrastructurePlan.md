# Forge hardened evidence infrastructure plan

**Status:** Draft for implementation sequencing and review; bounded publisher
integration slice implemented and verified

**Date:** 2026-08-30

**Scope:** Deterministic core evidence first; reusable by Agent V1 and later
audit paths where their trust boundaries agree

## Executive decision

Forge should preserve the current self-contained run directory as its portable
evidence format, then harden the collector and add durable storage around that
format.

The recommended production shape is:

- A **bounded local spool** on each disposable worker while a run is active.
- An **immutable artifact store** for raw evidence, normalized evidence, and
  reports. S3-compatible object storage is the preferred hosted backend.
- A **transactional metadata index** for run state, artifact references,
  experiments, findings, retention, and authorization. PostgreSQL is the
  preferred hosted backend; SQLite is sufficient for a local index.
- A **canonical manifest and detached attestation** uploaded last. The
  attestation binds the manifest digest to a trusted signing identity.
- Optional **columnar event storage** only when cross-run event volume justifies
  it. JSONL compressed with Zstandard is sufficient initially; Parquet or
  ClickHouse is a later scaling choice.

Large `strace` files, MCP transcripts, filesystem snapshots, and captured
source should not be stored as PostgreSQL blobs. The database indexes the
evidence; it does not replace the evidence.

The first implementation milestone should be a hardened local collector, not a
cloud migration. A database does not prevent an untrusted target from filling
the worker disk, does not make partial writes recoverable, and does not create
a trustworthy chain of custody.

## Current baseline

`forge analyze` currently creates one directory per run beneath the selected
output root, which defaults to `runs/`:

```text
runs/<run-id>/
|-- run.json
|-- target.json
|-- report.json
|-- events.jsonl
|-- phases.jsonl
|-- attributions.jsonl
|-- findings.jsonl
|-- target/
|-- static/
|-- install/
|-- mcp/
|-- runtime/filesystem-state/
|-- raw/
`-- sandboxes/
```

The existing `EvidenceStore` already provides useful foundations:

- Run-relative path containment.
- Schema validation before structured evidence is persisted.
- Mode `0600` for structured evidence files.
- Temporary-file, file-sync, and rename behavior for complete JSON and JSONL
  replacements.
- Append-and-sync behavior for incremental JSONL records.
- Stable run, experiment, event, attribution, finding, and evidence identities.
- A running/completed/failed `run.json` lifecycle.
- A final artifact inventory containing path, media type, and SHA-256.
- Raw-reference linkage from normalized events back to exact trace records.
- Partial evidence preservation for failures caught by the controller.

This is a good case-study format. It is portable, inspectable without a
service, and preserves the important separation among raw observations,
canonical facts, attribution, findings, and report interpretation.

### Empirical size baseline

The representative deceptive run
`runs/run-20260830060508-bb4e84ee` occupies approximately 49 MB:

- Approximately 27 MB of raw evidence.
- Approximately 13 MB of normalized events.
- Approximately 9.4 MB of attribution records.

This is manageable for individual analysis, but it makes the scaling direction
clear. One thousand similarly sized runs would approach 49 GB before replicas,
indexes, longer traces, or richer sensors.

### Current robustness gaps

1. **No hard aggregate core-run quota.** MCP messages, stderr, acquisition
   output, static capture, and filesystem snapshots have useful bounds, but
   core raw traces, normalized event count, total run bytes, and the writable
   synthetic profile do not share one hard aggregate budget.
2. **Host-backed writable profiles.** Core synthetic home and workspace paths
   are bind-mounted writable directories. A fast writer can consume host disk
   until another boundary stops it.
3. **Unbounded trace production.** Runtime duration and process count limit the
   window, but a syscall-heavy target can still generate substantial `strace`
   output.
4. **Whole-file and whole-run memory work.** Artifact hashing currently reads
   a complete file into memory. Normalization and attribution retain complete
   event arrays. Artifact collection traverses the run tree before applying
   all exclusions.
5. **Incomplete crash recovery.** A caught failure receives a failed manifest;
   a worker loss or `SIGKILL` can leave a run marked `running` with a partial
   JSONL record or unsealed raw files.
6. **Hashes without independent authenticity.** Artifact SHA-256 values detect
   change only while the manifest is trusted. A writer that can replace both an
   artifact and `run.json` can invent a new consistent bundle.
7. **Unmanifested retained sandbox bytes.** The artifact collector intentionally
   excludes sandbox contents other than `profile.json`, but the physical files
   remain in the run directory. Production bundles should contain no retained
   file outside their manifest and explicit retention policy.
8. **Single-disk durability.** There is no replication, upload retry state,
   retention policy, backup, or orphan reconciliation.
9. **No cross-run index.** Package/version history, behavior drift, findings,
   and artifact lookup require filesystem traversal and ad hoc `jq` queries.
10. **No production data-governance layer.** Real MCP messages, stderr, source,
    and filesystem evidence may contain customer data or credentials. Local
    file modes alone are not sufficient for a shared service.

## Goals

The hardened infrastructure must:

1. Bound every target-influenced storage and processing dimension.
2. Preserve useful terminal evidence when a limit is reached.
3. Never label incomplete evidence as complete.
4. Make a completed run independently verifiable without the Forge service.
5. Distinguish integrity from authenticity: hashes verify bytes; signatures
   identify the attesting controller.
6. Preserve the separation between raw facts, normalized facts, inference,
   policy findings, and presentation.
7. Support local-only execution and hosted execution through the same logical
   artifact contract.
8. Permit reprocessing derived evidence from retained raw evidence without
   silently replacing the historical result.
9. Provide searchable run and finding metadata without forcing large blobs into
   a transactional database.
10. Apply encryption, access control, retention, and deletion by evidence class
    and tenant.
11. Remain target-, package-, and tool-name independent.

## Non-goals

This plan does not:

- Turn Docker into a production hostile-code boundary. Disposable workers or
  microVMs and an out-of-target observer remain separate isolation work.
- Guarantee that the current sensors observe every behavior.
- Replace operator-authored authorization or produce a universal safety score.
- Build a general security data lake before Forge has demonstrated that need.
- Require the deterministic core to depend on Agent V1 or a model provider.
- Make derived findings immutable truth. Raw evidence is retained so later
  normalizer or rule versions can produce separately identified derivations.

## Threat and failure model

### Untrusted

- Target package, dependencies, lifecycle scripts, and MCP process.
- MCP metadata, schemas, messages, tool results, and stderr.
- Target-created paths and file contents.
- Raw trace text as input to later parsers.
- Any filename, identifier, or display text derived from the target.
- A worker that may crash, lose power, run out of resources, or lose network
  connectivity during a run.

### Trusted for this plan

- Forge controller and evidence-writer code on the worker.
- The resource-control plane outside the target process.
- Storage credentials that are never mounted into the target sandbox.
- The metadata database and object store control planes, subject to their
  configured durability and access controls.
- The signing service or KMS key used for final attestations.

### Failures that must have explicit outcomes

- Target timeout or resource quota violation.
- Observer output quota violation.
- Controller crash or worker disappearance.
- Object-store outage or partial upload.
- Database outage after evidence collection.
- Artifact checksum mismatch.
- Container cleanup uncertainty.
- Duplicate finalization attempt.
- Retention deletion that succeeds for some artifacts but not others.
- Evidence parser failure on truncated or attacker-shaped raw input.

## Design principles

### 1. Local spool first, remote durability second

Collectors need a local write path that does not depend on continuous network
availability. The spool must be hard-bounded and treated as temporary. A run is
not remotely durable until every retained artifact and its manifest have been
uploaded and verified.

### 2. Raw evidence is immutable; derivations are versioned

Raw traces and transcripts are sealed after collection. Normalized events,
attributions, findings, and reports identify the exact raw evidence plus the
Forge/normalizer/rule version that produced them. Reprocessing writes a new
derivation identity rather than overwriting history.

### 3. The manifest is the bundle boundary

Every retained byte except the manifest and its detached attestation must be
listed in the manifest. Ephemeral target workspace files are either converted
into bounded, manifest-listed snapshot evidence or removed before finalization.

### 4. Completion is a protocol, not the existence of `report.json`

A completed hosted run requires:

1. Verified target termination and sandbox cleanup.
2. Sealed local artifacts.
3. Successful schema and reference validation.
4. Successful streaming checksum verification.
5. Durable artifact upload.
6. Durable canonical manifest upload.
7. A detached attestation over the canonical manifest digest.
8. A transactional metadata transition to `completed`.

### 5. Limits are evidence

Quota values, usage, the first violated dimension, termination action, cleanup
outcome, and retained partial artifacts must be persisted. Silent truncation is
not acceptable. An explicitly marked truncated artifact can be retained when
the contract states exactly what was omitted.

### 6. Indexes are rebuildable

The immutable manifest and artifact bytes are the durable evidence record. The
database is authoritative for workflow state and authorization, but searchable
evidence indexes should be rebuildable from completed manifests.

## Target architecture

```text
                       trusted control plane

 operator / API
      |
      v
 run repository  <---------------------------+
      |                                       |
      | lease + limits                        | status + manifest digest
      v                                       |
 disposable worker                           |
      |                                       |
      | creates bounded local spool           |
      v                                       |
 target sandbox --> observer --> sealed segments
                              |               |
                              v               |
                       artifact uploader -----+
                              |
                              v
                  immutable object storage
                     | raw evidence
                     | normalized evidence
                     | reports
                     | canonical manifest
                     ` detached attestation

 PostgreSQL indexes run/experiment/artifact/finding metadata.
 SQLite provides the equivalent local-only index where useful.
```

The target receives no object-store, database, signing, or tenant credentials.
Only the trusted worker controller can write evidence objects.

## Evidence classes

| Class | Examples | Canonical status | Default access | Retention direction |
| --- | --- | --- | --- | --- |
| Executed inputs | Target config, scenario, policy, source identity | Canonical | Analyst and service | Long |
| Provenance | Package tree digest, lockfile, observer image, toolchain | Canonical | Analyst and service | Long |
| Raw observation | `strace`, MCP transcript, stderr, install output | Canonical raw evidence | Restricted forensic | Shorter/configurable |
| Captured static evidence | Admitted source, static inspections | Canonical evidence | Restricted analyst | Configurable |
| State evidence | Before/after snapshots and deltas | Canonical bounded evidence | Restricted analyst | Configurable |
| Normalized facts | Events and lifecycle phases | Versioned derivation | Analyst/query | Medium to long |
| Inference | Attributions and claim classifications | Versioned derivation | Analyst/query | Medium to long |
| Findings | Deterministic policy results | Versioned derivation | Analyst/query | Long |
| Presentation | Report summaries and future HTML | Rebuildable view | Broader reviewed access | Long |

Raw evidence may contain data not shown in a sanitized report. The storage and
UI layers must not assume that a clean report implies nonsensitive artifacts.

## Run lifecycle

The hosted state machine should be explicit:

```text
created
  -> collecting
      -> finalizing
          -> completed
          -> failed
          -> interrupted
          -> quarantined
      -> failed
      -> interrupted
      -> quarantined
```

- `created`: Identity, tenant, requested target, policy, limits, and worker
  lease are recorded; target execution has not begun.
- `collecting`: The worker owns an active lease and writes only beneath the
  bounded spool.
- `finalizing`: Target termination and cleanup are verified; no producer may
  append to sealed evidence.
- `completed`: All required artifacts, manifest, and attestation are durable
  and verified.
- `failed`: The controller reached a deterministic failure and successfully
  finalized the available evidence.
- `interrupted`: The worker disappeared or recovery could not establish a
  normal controller conclusion. Retained evidence is explicitly partial.
- `quarantined`: Cleanup, identity, checksum, or storage consistency is
  uncertain enough that the bundle must not be used as a normal completed run.

State transitions use compare-and-swap or database transactions. Finalization
is idempotent for the same manifest digest; a different digest for an already
finalized run is an integrity incident.

## Hard resource budgets

The deterministic core should receive one effective run-budget object whose
values are persisted in `run.json` and the final manifest. At minimum:

- `maxRunBytes`
- `maxArtifacts`
- `maxArtifactBytes`
- `maxRawTraceBytes`
- `maxRawTraceFiles`
- `maxTranscriptBytes`
- `maxTranscriptMessages`
- `maxStderrBytes`
- `maxWorkspaceBytes`
- `maxWorkspaceEntries`
- `maxFilesystemSnapshotEntries`
- `maxNormalizedEvents`
- `maxNormalizationInputBytes`
- `maxRunDurationMs`
- `reservedTerminalEvidenceBytes`

The last value reserves space for a quota artifact, run-state update, cleanup
result, and minimal manifest. A target must not be able to consume the bytes
needed to explain why it was terminated.

### Enforcement layers

Use multiple independent layers:

1. A hard-size/inode-limited filesystem or volume for writable target state.
2. A separate hard-bounded observer spool that the target cannot write.
3. Per-file process limits for trace writers where supported.
4. Aggregate byte/file accounting in the trusted controller.
5. Existing time, memory, CPU, and PID limits.
6. Post-termination bounded traversal and hashing.

Agent V1 already contains useful quota-monitoring and tmpfs patterns. The core
can reuse the generic mechanisms after separating agent-specific contracts and
preserving the core trust model. Polling is useful evidence but should not be
the only hard storage boundary.

### Quota outcome

When a quota is reached, Forge should:

1. Stop accepting new controller-originated work.
2. Terminate the target through the trusted control plane.
3. Verify target/container absence.
4. Seal the evidence already produced.
5. Write a bounded `forge.resource-usage/v1` artifact.
6. Mark affected artifacts complete, truncated, or unavailable.
7. Finalize the run as failed, interrupted, or quarantined according to the
   evidence and cleanup outcome.

It must never publish an ordinary completed report after a required evidence
budget failed.

## Sealed artifact writing

### Complete JSON artifacts

Keep the existing temporary-file, sync, and rename pattern, then add a parent
directory sync where the platform supports it. Enforce a maximum serialized
size before or during writing.

### Incremental JSONL and text artifacts

Replace indefinite append files with bounded segments:

```text
events/
|-- 00000001-00010000.jsonl.zst
|-- 00010001-00020000.jsonl.zst
`-- 00020001.partial
```

Each sealed segment records:

- First and last sequence.
- Record count.
- Uncompressed and stored byte counts.
- SHA-256 of the stored bytes.
- Optional SHA-256 of canonical uncompressed bytes.
- Compression and media type.
- Producer and schema version.
- Completion/truncation state.

The active segment uses a `.partial` suffix. Sealing flushes the compressor,
syncs the file, closes it, verifies its digest, and renames it. Recovery may
retain an active partial segment only as explicitly partial raw evidence; it
must not guess that its final line is complete.

### Streaming checksums

Hash and upload through bounded streams. Do not use a whole-file `readFile` for
arbitrarily sized artifacts. The artifact inventory traversal must cap entries,
depth, per-file bytes, and aggregate work, and it must skip excluded
directories before descending into them.

## Manifest and attestation

Introduce a storage envelope without changing the meaning of existing
`forge.report/v1` fields.

### Canonical manifest

Suggested shape:

```json
{
  "schema": "forge.evidence-manifest/v2",
  "runId": "run-...",
  "tenantId": "tenant-...",
  "targetId": "target-...",
  "status": "completed",
  "createdAt": "...",
  "finalizedAt": "...",
  "inputs": {
    "configSha256": "...",
    "runtimeSnapshotSha256": "...",
    "observerImageId": "sha256:..."
  },
  "limits": {},
  "usage": {},
  "artifacts": [
    {
      "artifactId": "artifact-...",
      "logicalPath": "raw/tool-a/strace.11.zst",
      "role": "raw_trace",
      "schema": null,
      "mediaType": "text/plain",
      "contentEncoding": "zstd",
      "sizeBytes": 12345,
      "sha256": "...",
      "storageKey": "opaque/tenant-scoped-key",
      "classification": "restricted_raw",
      "retentionClass": "raw_default",
      "state": "complete"
    }
  ],
  "derivations": [],
  "limitations": []
}
```

The manifest excludes its own digest and signature so canonicalization is not
circular.

### Detached attestation

Suggested shape:

```json
{
  "schema": "forge.evidence-attestation/v1",
  "runId": "run-...",
  "manifestSha256": "...",
  "algorithm": "ed25519",
  "keyId": "kms-key-version-or-public-key-id",
  "signature": "base64...",
  "signedAt": "..."
}
```

The signature establishes which trusted service attested to the manifest. It
does not prove that the sensors were complete or that the target was safe.

For local-only operation, attestation may be absent and verification should
report `integrity_verified_authenticity_unavailable` rather than pretending a
local hash is a service signature.

## Storage interfaces

The first refactor should introduce narrow interfaces while keeping the local
backend behavior:

```ts
interface ArtifactStore {
  createWriter(request: ArtifactWriteRequest): Promise<ArtifactWriter>;
  open(reference: ArtifactReference): Promise<NodeJS.ReadableStream>;
  verify(reference: ArtifactReference): Promise<ArtifactVerification>;
  delete(reference: ArtifactReference): Promise<void>;
}

interface ArtifactWriter {
  write(chunk: Uint8Array): Promise<void>;
  seal(): Promise<ArtifactReference>;
  abort(reason: string): Promise<PartialArtifactReference | undefined>;
}

interface RunRepository {
  create(run: NewRun): Promise<void>;
  acquireLease(runId: string, workerId: string): Promise<RunLease>;
  transition(request: RunTransition): Promise<void>;
  attachManifest(request: ManifestCommit): Promise<void>;
  get(runId: string): Promise<RunRecord | undefined>;
}
```

Important constraints:

- The controller supplies logical artifact roles; target-controlled paths do
  not become object keys.
- Writer implementations enforce the same effective budget.
- `seal()` is idempotent only for identical bytes and metadata.
- Storage retries must not create multiple logical artifacts.
- References carry byte size and checksum; callers never trust only a URI.

## Storage backends

### Local backend

The local backend remains the default CLI behavior:

- Mode `0700` run/spool directories where practical.
- Mode `0600` evidence files.
- Same-directory atomic rename for sealed artifacts.
- Canonical `manifest.json` and optional local attestation.
- `forge verify-run <directory>` for offline validation.
- Optional SQLite index built from manifests. The index may be deleted and
  rebuilt without losing evidence.

The current `report.json`, `run.json`, and evidence paths should remain
available during migration so existing samples and consumers continue to work.

### Hosted artifact backend

Use an S3-compatible object store with:

- Server-side encryption using tenant-appropriate KMS keys.
- Bucket versioning.
- Object-lock/WORM for deployments whose retention policy permits it.
- Tenant-scoped opaque keys.
- Multipart upload with part and final checksum verification.
- Lifecycle rules for raw, derived, and report tiers.
- Access logs and narrowly scoped worker credentials.
- No public bucket access and no target-held credentials.

An uploader writes to a run-scoped temporary namespace. The manifest references
only verified immutable objects. The canonical manifest and attestation are
published last.

Cross-tenant content-addressed deduplication is not recommended initially. It
can create information-disclosure and deletion-semantics problems. Deduplication
may be evaluated later within one tenant and retention class.

### Metadata backend

PostgreSQL should initially index:

- `runs`: tenant, target, configured source, status, timestamps, worker,
  manifest digest, policy identity, and deletion state.
- `experiments`: run, kind, tool, status, timing, and configured input digest.
- `artifacts`: artifact ID, logical role, checksum, size, storage key,
  classification, retention, and state.
- `findings`: rule, severity, confidence, experiment, and derivation version.
- `capability_summaries`: advertised/static/observed/operator-scope states.
- `attestations`: manifest digest, key ID, signature, and verification state.

Do not put raw artifacts into relational blobs. Do not index every normalized
event in PostgreSQL until a concrete query and measured volume justify it.

## Query strategy

The first hosted queries should answer product questions rather than expose a
generic log platform:

- Show all runs for a package and exact version.
- Compare two artifact or MCP-interface identities.
- Find runs with a rule, severity, destination, executable, or sensitive path
  class.
- Show runs invalidated by a changed artifact, observer, policy, or metadata
  fingerprint.
- Retrieve all evidence for one finding.
- Identify incomplete, interrupted, quarantined, or unverifiable runs.
- Measure bytes, duration, quota use, and cleanup outcomes.

At moderate scale, summaries in PostgreSQL plus compressed per-run JSONL are
enough. When repeated cross-run event scans become material, write normalized
events as Parquet partitioned by tenant/date/run/experiment or ingest a bounded
projection into ClickHouse. Raw traces remain object artifacts.

## Integrity and chain of custody

`forge verify-run` should perform at least:

1. Parse the manifest under its exact versioned schema.
2. Enforce unique logical paths and artifact IDs.
3. Reject path escape, symlink, unexpected special-file, and duplicate coverage.
4. Recompute every retained artifact's size and SHA-256 by streaming.
5. Verify all event-to-raw, finding-to-event, attribution-to-event, report-to-
   artifact, and derivation-to-input references.
6. Confirm that no retained local file exists outside manifest coverage, except
   the manifest and detached attestation.
7. Verify the detached signature when present.
8. Verify run, target, experiment, runtime snapshot, observer image, and
   derivation identities agree.
9. Report truncation, missing optional evidence, and incomplete required
   evidence distinctly.
10. Produce a machine-readable verification result without modifying the run.

A valid signature means that the named key signed the manifest digest. It does
not elevate attribution inference, advertised claims, or incomplete sensor
coverage into facts.

## Crash recovery and reconciliation

Workers maintain a renewable lease in the run repository. A reconciler handles
expired leases:

1. Establish whether the worker and managed container still exist.
2. Terminate only label-verified Forge-managed resources.
3. Inspect the spool through bounded, non-following traversal.
4. Preserve sealed segments unchanged.
5. Retain active partial segments only with explicit partial state.
6. Upload recoverable artifacts when storage is available.
7. Publish an interrupted or quarantined manifest.
8. Release or quarantine the spool according to cleanup certainty.

No recovery path executes target-authored content or accepts target-authored
instructions. A stale `running` record is not automatically upgraded to
`failed`; the recovery result must say what was and was not established.

## Privacy, secrets, and tenant isolation

Production policy should assume raw evidence is sensitive even when Forge
intends to use synthetic resources.

- Never mount provider credentials, storage credentials, or real operator
  secrets into the target sandbox.
- Encrypt each tenant's artifacts with an appropriate KMS boundary.
- Separate restricted raw-evidence access from report access.
- Apply output encoding and safe download behavior; never render artifact HTML
  or execute uploaded files.
- Exact-match scan registered service credentials before persistence at trusted
  outbound/inbound boundaries, as Agent V1 already does.
- Secret detection beyond registered exact bytes should tag and quarantine
  evidence; it must not silently rewrite canonical raw bytes.
- Produce a separately identified sanitized export for sharing.
- Record every raw artifact read and export in an audit log.
- Define tenant deletion, legal hold, and retention precedence explicitly.
- Avoid shared host directories with world-writable permissions in hosted
  workers; use isolated volumes, user namespaces, or id-mapped mounts.

If policy requires redaction before durable storage, that is a different
evidence mode and must record that canonical raw bytes were intentionally not
retained. Forge must not call redacted evidence byte-identical to the observed
stream.

## Retention and deletion

Define retention by evidence class rather than one run-wide timer. A reasonable
starting policy for review, not a fixed product promise, is:

- Raw traces/transcripts: restricted and shorter-lived.
- Captured source and filesystem evidence: tenant-configurable and restricted.
- Normalized events/attributions: medium-lived.
- Findings, manifests, provenance, and attestations: longer-lived.
- Sanitized reports: longest-lived where appropriate.

Deletion is a stateful workflow:

1. Mark the run deletion-pending and prevent new exports.
2. Resolve legal holds and policy conflicts.
3. Delete or crypto-shred eligible artifacts.
4. Verify absence/version handling in object storage.
5. Remove query projections.
6. Retain only the minimum permitted tombstone and deletion audit event.

Object-lock retention and privacy deletion requirements can conflict. The
selected product policy must resolve that before enabling WORM broadly.

## Failure semantics

| Failure | Required result |
| --- | --- |
| Target exits nonzero | Failed run with sealed available evidence |
| Target timeout | Failed run with timeout phase, usage, cleanup, and partial evidence |
| Run or trace quota | Failed run with quota artifact; never ordinary completion |
| Container cleanup uncertain | Quarantined run |
| JSONL segment ends partially | Sealed prior segments plus explicitly partial final segment |
| Artifact checksum mismatch | Quarantined run and integrity alert |
| Object store unavailable | Keep bounded spool and retry; do not mark remotely durable |
| Database unavailable after collection | Upload artifacts if authorized, retain commit intent, retry idempotently |
| Worker disappears | Lease reconciliation; interrupted or quarantined result |
| Duplicate finalization with same digest | Idempotent success |
| Duplicate finalization with different digest | Integrity incident; reject mutation |
| Retention deletion partially fails | Deletion-pending with retries and explicit remaining objects |

## Implementation phases

### Immediate thin slice: completed-run publisher

**Target effort:** one focused engineering day with AI-assisted implementation

This is an isolated integration spike against already-completed bundles. It
does not reverse the production sequencing below: the collector still needs
Phase 0/1 producer hardening before hosted storage is treated as the durable
system of record.

This slice deliberately avoids changing collection. It takes an already
completed `forge.run/v1` directory, verifies the manifest-listed bytes, uploads
artifacts to S3-compatible storage, uploads the exact manifest last, and records
queryable run, artifact, and finding metadata in PostgreSQL. The same run ID and
manifest digest can be retried safely; a conflicting digest is rejected.

Deliverables:

- `forge publish-run <run-directory>` using ordinary AWS credential discovery
  and a PostgreSQL connection string supplied outside the target sandbox.
- Bounded streaming verification of every manifest-listed artifact into
  publisher-owned anonymous read-only snapshots, path and symlink confinement,
  report-contract validation, run/target identity binding, and cross-binding
  of report evidence references to the manifest.
- Content-addressed, conditional S3 writes with exact service-checksum
  verification of existing objects.
- PostgreSQL schema initialization plus transactional publication metadata.
- Unit tests for corruption, unsafe paths, object conflicts, retries, and
  database rollback; a local S3/PostgreSQL demo path.

This is useful infrastructure, but it is not yet the initial hosted system in
Phase 3 plus the operational/governance hardening in Phase 4. In particular,
it does not add live upload, worker leases, orphan reconciliation, detached
KMS attestation, tenant-scoped
authorization, automated retention/deletion, cross-region recovery, or an
operator API. Those are the reasons the production phase is measured in days
or weeks rather than hours.

The synchronous slice currently rejects more than 2,048 artifacts, 4,096
findings, 256 MiB per artifact, or 1 GiB total artifact bytes, and applies a
five-minute local verification deadline. These are safety bounds for the demo,
not measured production defaults. Hosted work still needs end-to-end S3
request deadlines, a reconciler, immutable-bucket policy, versioned migrations,
backend/deployment identity, TLS policy, and tenant authorization.

Acceptance:

- No remote manifest is created before all referenced artifacts are present.
- Repeating publication with identical bytes converges without duplicate
  logical metadata; a reused run ID with a different manifest digest fails.
- PostgreSQL never marks a run `published` until its artifact and finding rows
  have committed atomically.
- The S3 manifest is an artifact-completeness marker, while PostgreSQL
  `published` is query authority. A manifest-before-database failure is
  retryable and explicitly requires reconciliation in the hosted design.
- Publishing is additive: a storage outage cannot change the completed local
  evidence bundle or the behavior of `forge analyze`.

### Phase 0: freeze requirements and measure

**Estimated effort:** 0.5-1 engineering day

Deliverables:

- Record run byte/file/event distributions for the checked-in cases and one
  intentionally noisy fixture.
- Define default and maximum budget values with reserved terminal capacity.
- Decide whether exceeded limits produce `failed`, `interrupted`, or
  `quarantined` in each case.
- Freeze the first `forge.run-budget/v1` and resource-usage contracts.

Acceptance:

- Every storage-producing component maps to one persisted limit or an explicit
  reason that it cannot be target-amplified.

### Phase 1: hardened local evidence backend

**Estimated effort:** 3-7 focused engineering days

Deliverables:

1. Core hard limits for workspace bytes/inodes, trace files/bytes, total spool
   bytes/files, and normalized event count.
2. Streaming checksum and bounded artifact traversal.
3. Sealed segments for incrementally written artifacts.
4. Explicit resource-usage and truncation evidence.
5. Sandbox-tree removal or full manifest coverage.
6. Canonical evidence manifest with artifact sizes and roles.
7. `forge verify-run` with machine-readable output.
8. Recovery of killed/interrupted local runs.

Acceptance:

- A syscall-flood fixture cannot exceed the configured spool budget beyond a
  documented kernel/controller burst allowance.
- A write-flood fixture cannot consume unbounded host workspace bytes or inodes.
- `SIGKILL` at each lifecycle phase leaves a recoverable partial bundle or an
  explicit unrecoverable/quarantined state.
- Mutation of any retained artifact makes verification fail.
- No completed local bundle contains an unmanifested retained file.
- Existing deceptive and Filesystem findings remain unchanged except for
  additive storage metadata.

### Phase 2: pluggable storage and local index

**Estimated effort:** 3-5 engineering days

Deliverables:

- `ArtifactStore` and `RunRepository` interfaces.
- Local filesystem and optional SQLite implementations.
- Import/index command for existing `forge.run/v1` directories.
- Versioned derivation identity for normalization, attribution, and reporting.
- Compressed raw and JSONL artifact support.

Acceptance:

- The same core analysis passes against the local backend through interfaces.
- Deleting and rebuilding the SQLite index does not change evidence bytes.
- Current V1 run directories remain verifiable or importable with explicit
  legacy limitations.

### Phase 3: durable hosted backend

**Estimated effort:** 5-10 engineering days for an initial deployment

Deliverables:

- S3-compatible artifact store.
- PostgreSQL run repository and query projection.
- Worker leases, idempotent uploader, and orphan reconciler.
- Canonical manifest upload and KMS-backed detached attestation.
- Encryption, tenant-scoped credentials, and basic retention policies.
- Hosted retrieval and verification API.

Acceptance:

- Forced network loss during upload never produces a completed run with
  missing artifacts.
- Uploader retries do not duplicate logical artifacts.
- A database restart and object-store retry preserve correct state transitions.
- An actor with artifact-write access but no signing key cannot produce a valid
  Forge attestation.
- Tenant A cannot enumerate or retrieve Tenant B's artifacts or metadata.

### Phase 4: operational and governance hardening

**Estimated effort:** 2-4 additional engineering weeks, depending on product
and compliance requirements

Deliverables:

- Retention/deletion/legal-hold workflow.
- Access audit logs and reviewed sanitized exports.
- Key rotation and attestation verification history.
- Capacity forecasting, worker backpressure, alarms, and disaster recovery.
- Optional Parquet/ClickHouse projection for measured cross-run event queries.
- Security review and failure-injection exercise.

Acceptance:

- Recovery, retention, deletion, key rotation, and tenant-isolation runbooks are
  tested rather than only documented.

## Verification strategy

### Unit and property tests

- Path traversal, Unicode edge cases, duplicate logical paths, and symlinks.
- Atomic writer state transitions and idempotent sealing.
- Budget arithmetic overflow and reserved-terminal-space invariants.
- Segment boundary, empty segment, partial final line, and compression errors.
- Manifest canonicalization, digest, and signature verification.
- Illegal run-state transitions.
- Derivation identity and exact input coverage.

### Fault-injection tests

Interrupt after every durable step:

- Before and after local file sync.
- Before and after rename.
- During segment compression.
- During multipart upload.
- After artifact upload but before manifest upload.
- After manifest upload but before database commit.
- During container cleanup.
- During retention deletion.

Every injected failure must converge through retry or reconciliation to one
documented state without silently losing required evidence.

### Adversarial fixtures

- Syscall flood across many child processes.
- Large sequential and sparse file writes.
- Many tiny files and deep directory trees.
- Endless stderr and MCP message output.
- JSONL records at the exact byte limit.
- Output containing secret-like values, terminal escapes, invalid UTF-8, and
  attacker-controlled filenames.
- Trace files modified after sealing.
- Manifest/artifact mismatch.
- Worker loss with a live managed container.

### Shared verification gates

Storage changes touch core evidence, runtime observation, and reports. Each
milestone therefore requires:

```bash
npm run typecheck
npm test
npm run build
npm run verify:e2e
```

Changes shared with Agent V1 also require:

```bash
npm run verify:agent
```

Add a storage-specific end-to-end verifier that exercises quotas, abrupt
termination, offline verification, and manifest mutation.

## Migration and compatibility

1. Treat existing `forge.run/v1` directories as legacy portable bundles.
2. Add an importer that validates the V1 manifest and reconstructs artifact
   metadata where safe.
3. Record legacy gaps explicitly, including absent size/role/signature fields
   and intentionally unmanifested sandbox contents.
4. During transition, write the established V1 evidence files plus the new
   storage manifest and attestation.
5. Keep `forge.report/v1` semantics stable; storage metadata is additive or
   lives in a separate envelope.
6. Do not rewrite checked-in representative reports merely to simulate a
   migration. Refresh them only from a newly verified full run.
7. Never upgrade a legacy hash-only bundle to signed authenticity without a new
   trusted verification and attestation event.

## Operational signals

At minimum, export:

- Runs by lifecycle state and age.
- Active leases and expired leases.
- Spool bytes/files/inodes and worker disk headroom.
- Raw trace, transcript, normalized event, and total bytes per run.
- Quota violations by dimension.
- Artifact upload latency, retries, and checksum failures.
- Finalization latency and reconciliation outcomes.
- Managed-container cleanup failures.
- Manifest/signature verification failures.
- Orphaned local spools and temporary object prefixes.
- Retention/deletion backlog.
- Artifact retrievals and sanitized exports by tenant and actor.

Alerts should prioritize cleanup uncertainty, checksum/signature failure,
cross-tenant authorization failure, exhausted terminal-evidence reserve, and
spool capacity that threatens active runs.

## Suggested first issue breakdown

1. Define `forge.run-budget/v1` and `forge.resource-usage/v1` contracts.
2. Extract reusable hard workspace/spool quota mechanisms from Agent V1.
3. Add aggregate raw-trace enforcement with terminal evidence reserve.
4. Replace whole-file SHA-256 with a streaming implementation.
5. Bound and correct artifact traversal so exclusions happen before descent.
6. Remove ephemeral sandbox trees after verified snapshots.
7. Introduce artifact roles, sizes, completion state, and a canonical manifest.
8. Add `forge verify-run` and mutation tests.
9. Add sealed JSONL segments and interrupted-run recovery.
10. Run the paired E2E cases plus flood, kill, corruption, and cleanup fixtures.

These issues form one coherent hardened-local milestone. Beyond the isolated
completed-run integration spike above, production object storage and
PostgreSQL rollout should begin only after this milestone establishes reliable
producer semantics.

## Open decisions

1. Which hard filesystem mechanism should enforce aggregate observer-spool
   bytes on the supported Linux worker: dedicated volume, project quota, tmpfs,
   or another disposable-worker primitive?
2. What burst allowance is acceptable between detecting a quota and stopping
   all trace writers?
3. Which raw artifacts are mandatory for a completed run versus allowed to be
   explicitly unavailable?
4. Should the first hosted release retain raw MCP tool results, retain a
   restricted encrypted copy, or run in a declared redacted-evidence mode?
5. What tenant and deployment identity should the attestation bind in addition
   to the manifest digest?
6. What are the initial raw, derived, and report retention periods?
7. Is SQLite useful enough for the CLI to justify maintaining it, or should
   local discovery initially rebuild directly from manifests?
8. Which measured cross-run queries would justify Parquet or ClickHouse?
9. How should deletion interact with object lock and customer legal holds?
10. Which storage fields belong in an additive V1 envelope and which require a
    clean V2 contract?

## Definition of done for hardened local infrastructure

The first milestone is complete when:

- Every target-amplifiable storage dimension is hard-bounded or explicitly
  justified.
- Quota exhaustion preserves bounded terminal evidence and cannot publish an
  ordinary completed result.
- Every retained byte is covered by a manifest or detached attestation.
- Every artifact is hashed by a bounded streaming path.
- Abrupt termination produces a recoverable partial run or explicit quarantine.
- `forge verify-run` detects corruption, missing artifacts, reference breakage,
  unexpected files, and unsupported authenticity.
- The existing real and deceptive case studies retain their evidence semantics.
- The storage backend can later be replaced without changing target execution,
  normalization, attribution, or rule meaning.

At that point Forge has a defensible local evidence appliance. Object storage,
PostgreSQL indexing, signing, and multi-tenant governance can then turn it into
a durable service without redesigning the analysis pipeline.
