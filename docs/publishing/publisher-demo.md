# Forge S3/Postgres publisher demo

Plain `forge analyze` remains unchanged. With the explicit `--publish` flag,
the same command can continue into the verified completed-run publisher: it
streams manifest-listed artifacts to an S3-compatible object store, writes
queryable metadata to PostgreSQL, and publishes the exact `run.json` last. For
the two reviewed demo targets, `--refresh-dashboard` can also store a
disclosure-safe projection and regenerate the script-free results page after
publication succeeds. The page shows the latest selected result plus a
script-free run explorer with up to five eligible published runs per target,
newest completed run first. Each retained run exposes only the projection's
bounded canonical findings, static and aggregate runtime counts, and selected
initialization/tool comparison scopes.

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

## 3. Analyze, publish, and refresh

The convenience form runs the checked-in deceptive fixture, publishes only the
exact completed run returned by that analysis, and refreshes the local page:

```bash
npm run build:dashboard
node dist/cli.js analyze fixtures/deceptive-mcp/target.yaml \
  --output runs \
  --publish \
  --refresh-dashboard
```

Success prints one JSON object containing the local `runDirectory` and a nested
`publication` result with the manifest digest, artifact and finding counts,
final S3 manifest location, and dashboard status. Reload the local page after
the command completes: the controlled card should say `Published ...`; its row
appears in the `Published run explorer`; and the unrefreshed reference card
remains clearly labeled `Pinned sample`. Select a timestamp in the past-runs
index to move to that run. Its result contains bounded counts, canonical
findings, static capability callsites, aggregate runtime event and filesystem
change counts, and native disclosure tables for selected initialization/tool
scopes.

```bash
npm run serve:dashboard
```

Open `http://127.0.0.1:4173/`. The browser reads only generated HTML and CSS;
it has no PostgreSQL or evidence-bucket credentials.

The update boundaries remain explicit even though the happy path is one
command:

- plain `forge analyze` creates a local run and uploads nothing.
- `forge analyze --publish` first completes the local run, then invokes the
  same verified publisher as `publish-run`.
- adding `--refresh-dashboard` also regenerates the website as a local static
  snapshot; the flag is rejected unless `--publish` is explicit.
- `publish-run` writes canonical evidence and metadata but does not refresh the
  page unless `--refresh-dashboard` is supplied, and remains the retry command
  for an already-completed run.
- the public AWS copy changes only after the explicit content-only deployment
  in [`DashboardAwsDemo.md`](../dashboard/dashboard-aws-demo.md).

Neither form deploys the website to AWS. Evidence publication requires either
`analyze --publish` or the explicit `publish-run` command, and website upload
still requires the separate deployment step.

To test idempotency, copy the exact `runDirectory` from the JSON output and run:

```bash
node dist/cli.js publish-run "/absolute/path/from/runDirectory" --refresh-dashboard
```

That retry verifies immutable S3 objects rather than overwriting them, and
PostgreSQL retains one logical set of run, artifact, finding, and
public-projection rows. The dashboard result should report `unchanged`. Do not
retry the full convenience command when publication is uncertain: it would
perform a new analysis and create a new run.

The command exits 1 if configuration validation or analysis fails, or if
canonical publication is not confirmed. A post-analysis publication error
still prints the completed run ID, directory, and structured `publish-run`
retry arguments. It exits 2 if canonical publication succeeded but the local
dashboard refresh failed; retry `publish-run` with `--refresh-dashboard`
against that same directory.

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

The separate `forge_dashboard_projections` table contains only the bounded,
schema-validated presentation contract. It is populated only for exact
allowlisted target/config/source/scope identities and only after the joined run
is `published`. The generated history queries only the exact current policy,
caps each selected target at five rows, and never puts pinned samples into the
published list:

```bash
docker compose -f compose.publisher-demo.yml exec -T postgres \
  psql -U forge -d forge -c \
  "select p.role, r.target_id, r.status, r.run_completed_at from forge_dashboard_projections p join forge_published_runs r on r.run_id = p.run_id order by r.run_completed_at desc;"
```

Report summaries, arbitrary finding text, paths, run/finding/event IDs, hashes,
object keys, package-authored prose, and raw evidence are not copied into that
projection. The run explorer uses ordinal fragment links rather than private run
identifiers, and its finer tables are rendered from the existing stored
projection rather than querying PostgreSQL from the browser.

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
publish-driven dashboard regeneration plus pre-publication tamper rejection,
then removes only the resources it created.

## What this demo does not claim

This thin slice establishes verified, retryable S3/PostgreSQL publication. A
production service still needs worker leases and reconciliation, independent
attestation/signing, tenant-scoped identities and authorization, retention and
deletion workflows, backups and recovery exercises, monitoring, and deliberate
failure injection. Those follow-up controls—not basic object/database writes—
are the main complexity in the full hardened-infrastructure estimate.
