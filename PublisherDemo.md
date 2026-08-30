# Forge S3/Postgres publisher demo

This demo keeps `forge analyze` unchanged. It verifies one completed local run,
streams its manifest-listed artifacts to an S3-compatible object store, writes
queryable metadata to PostgreSQL, and publishes the exact `run.json` last.

The bundled stack binds only to localhost and uses conspicuously non-production
credentials. It is for demonstration and automated verification, not shared
deployment. Publish only synthetic, non-sensitive runs: evidence bundles can
contain raw traces, transcripts, source, environment-derived data, or
credentials, while this demo uses plaintext localhost services, public demo
passwords, and persistent named volumes.

## 1. Start the local services

Prerequisites are Node.js 22+, npm, and Docker with Compose.

```bash
npm ci
docker compose -f compose.publisher-demo.yml up -d --wait postgres minio
docker compose -f compose.publisher-demo.yml run --rm create-bucket
```

This starts PostgreSQL on `127.0.0.1:55432`, MinIO's S3 API on
`127.0.0.1:59000`, and the MinIO console on `http://127.0.0.1:59001`. The
second command creates `forge-evidence` idempotently.

## 2. Configure the publisher process

These credentials stay in the Forge controller process. They are never passed
to the target sandbox.

```bash
export AWS_ACCESS_KEY_ID=forge_demo
export AWS_SECRET_ACCESS_KEY=forge-demo-secret
export AWS_REGION=us-east-1
export FORGE_PUBLISH_S3_BUCKET=forge-evidence
export FORGE_PUBLISH_S3_ENDPOINT=http://127.0.0.1:59000
export FORGE_PUBLISH_S3_FORCE_PATH_STYLE=true
export FORGE_PUBLISH_S3_PREFIX=demo
export FORGE_PUBLISH_DATABASE_URL=postgresql://forge:forge-demo-only@127.0.0.1:55432/forge
```

## 3. Publish a completed run

Use an existing synthetic completed run directory or create one with the
checked-in deceptive fixture. The following captures the exact `runDirectory`
printed by `analyze`, even when other runs already exist:

```bash
npm run build
export FORGE_RUN_DIRECTORY="$(
  node dist/cli.js analyze fixtures/deceptive-mcp/target.yaml --output runs |
  node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => process.stdout.write(JSON.parse(s).runDirectory));'
)"
node dist/cli.js publish-run "$FORGE_RUN_DIRECTORY"
```

Success prints a JSON object containing the run ID, manifest digest, artifact
count, finding count, and the final S3 manifest location.

Run the same command again. It should succeed idempotently: immutable S3
objects are verified rather than overwritten, and PostgreSQL retains one
logical set of run, artifact, and finding rows.

## 4. Inspect the result

Query the metadata directly:

```bash
docker compose -f compose.publisher-demo.yml exec -T postgres \
  psql -U forge -d forge -c \
  'select r.run_id, r.target_id, r.status, (select count(*) from forge_published_artifacts a where a.run_id = r.run_id) as artifact_count, (select count(*) from forge_published_findings f where f.run_id = r.run_id) as finding_count, r.published_at from forge_published_runs r order by r.published_at desc;'
```

Open `http://127.0.0.1:59001`, sign in with `forge_demo` /
`forge-demo-secret`, and inspect the `forge-evidence` bucket. Artifact objects
live under `demo/objects/sha256/`; the artifact-completeness marker lives under
`demo/runs/<run-id>/run.json`. PostgreSQL `status = 'published'` is the query
authority for overall publication state.

The object store holds the evidence bytes. PostgreSQL holds the searchable
index and object references; it does not duplicate large traces or reports as
database blobs.

## 5. Exercise the failure boundary

Create a second, never-published synthetic run, copy it to a temporary
directory, alter one manifest-listed artifact, and try to publish that copy.
Verification must fail before a remote manifest or database row is created for
that second run ID. Tampering with a copy of an already-published run cannot
prove absence, because the original run's remote state already exists; in that
case assert that publication state does not change.

An interruption after some artifact uploads is also safe to retry. Artifacts
are content addressed and conditionally created, while the per-run manifest is
the last S3 write and PostgreSQL becomes `published` only in its final metadata
transaction. S3 and PostgreSQL do not share an atomic transaction: a database
failure after manifest upload can leave an S3 completeness marker with a
PostgreSQL row still in `publishing`. An identical retry converges this state;
a hosted deployment also needs reconciliation and alerting.

## 6. Stop or reset the demo

Stop services while preserving their named volumes:

```bash
docker compose -f compose.publisher-demo.yml down
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION
unset FORGE_PUBLISH_S3_BUCKET FORGE_PUBLISH_S3_ENDPOINT
unset FORGE_PUBLISH_S3_FORCE_PATH_STYLE FORGE_PUBLISH_S3_PREFIX
unset FORGE_PUBLISH_DATABASE_URL FORGE_RUN_DIRECTORY
```

Delete the demo database and object data as well:

```bash
docker compose -f compose.publisher-demo.yml down --volumes
```

The second command is intentionally destructive only to the named volumes
owned by this demo stack.

For an isolated automated check, run `npm run verify:publisher`. That verifier
uses a unique Compose project, temporary ports and volumes, exercises first
publication, exact retry, exact Postgres object references, service checksums,
GET-and-hash verification of the manifest and every synthetic artifact, and
pre-publication tamper rejection, then removes only the resources it created.

## What this demo does not claim

This thin slice establishes verified, retryable S3/PostgreSQL publication. A
production service still needs worker leases and reconciliation, independent
attestation/signing, tenant-scoped identities and authorization, retention and
deletion workflows, backups and recovery exercises, monitoring, and deliberate
failure injection. Those follow-up controls—not basic object/database writes—
are the main complexity in the full hardened-infrastructure estimate.
