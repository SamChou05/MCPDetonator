# Forge dashboard runbook

This runbook is the quick operator path for the local, script-free dashboard.
It covers what the page shows, how to start it, how to refresh it from
published runs, and what to do when the run history disappears. The publisher
and AWS deployment boundaries are covered separately in
[`PublisherDemo.md`](PublisherDemo.md) and [`DashboardAwsDemo.md`](DashboardAwsDemo.md).

## What the dashboard is

The dashboard is a generated, two-file static site:

- `dist/dashboard-site/index.html`
- `dist/dashboard-site/styles.css`

It contains no JavaScript, makes no browser database or object-store
connections, and exposes no private run IDs, raw traces, source bundles,
credentials, or artifact paths. Each run article contains only the reviewed,
disclosure-safe public projection: bounded findings, aggregate counts, and
selected behavior-scope disclosures.

The page has two main views:

1. **Latest result cards** — the newest eligible result for each selected
   target.
2. **Published run explorer** — the sidebar-like index on the left. It lists
   up to five eligible published runs per target, newest first. Selecting a
   timestamp scrolls to that run's full article on the same page.

The page also includes a bounded **Unseen MCP holdout** study section. It lists
the package names and versions tried, whether startup/catalog discovery
succeeded, the selected-call outcome, and the deterministic finding counts for
each case. It deliberately excludes private run IDs, report hashes, raw
traces, transcripts, and artifact paths. This section is a study summary, not a
publication-history sidebar and not a general safety verdict.

There is no client-side routing. Sidebar links are ordinary same-page anchors,
such as `#published-controlled-run-1`, and all runs are already rendered in the
single HTML document.

## What the current targets mean

- **Deceptive control** (`deceptive-document-summarizer`) is a purpose-built
  negative fixture. It demonstrates that the deterministic pipeline can surface
  findings when the selected tool behaves deceptively.
- **Official Filesystem MCP** (`official-filesystem`) is the reviewed real
  package case study. A zero-finding result means no deterministic finding was
  produced for the selected tools and inputs; it is not a universal safety
  approval.

Results cover only the selected synthetic cases, tools, inputs, and current
deterministic rules.

## Prerequisites

- Node.js 22+
- npm dependencies installed with `npm ci`
- Docker with Compose, when refreshing from published runs
- The publisher stack from `compose.publisher-demo.yml`

## Start the dashboard

Generate the site and start the local preview:

```bash
npm run build:dashboard
npm run serve:dashboard
```

Open:

```text
http://127.0.0.1:4173/
```

The server binds only to `127.0.0.1` and accepts only `GET` and `HEAD` requests.
It serves only `/`, `/index.html`, and `/styles.css`; every other path returns
404. Responses include a strict Content Security Policy and `Cache-Control:
no-store`, so refreshing the browser always fetches the latest generated page.

Use `FORGE_DASHBOARD_PORT` before starting the server to choose another port:

```bash
FORGE_DASHBOARD_PORT=4273 npm run serve:dashboard
```

## Start the local publisher stack

These services are required only when refreshing the page from published runs:

```bash
docker compose -f compose.publisher-demo.yml up -d --wait postgres minio
docker compose -f compose.publisher-demo.yml run --rm create-bucket
```

This starts:

- PostgreSQL on `127.0.0.1:55432`
- MinIO S3 API on `127.0.0.1:59000`
- MinIO console on `http://127.0.0.1:59001`

Configure the publisher process in the shell that runs Forge:

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

These credentials are for the local demo only. They stay in the Forge
controller process and are not passed to the target sandbox.

## Publish a new run and refresh

The convenience command analyzes the deceptive fixture, publishes only that
completed run, and refreshes the dashboard:

```bash
npm run build:dashboard
node dist/cli.js analyze fixtures/deceptive-mcp/target.yaml \
  --output runs \
  --publish \
  --refresh-dashboard
```

After it completes, reload `http://127.0.0.1:4173/`. The new run should appear
at the top of that target's index and its latest card should say
`Published`.

The command exits 1 if analysis or publication fails, or 2 if publication
succeeded but the dashboard refresh failed. On exit 2, retry only the refresh
against the exact run directory printed by the command; do not create a new
analysis run.

## Refresh an existing run without re-analyzing

Use `publish-run` against a completed run directory. It verifies immutable
objects instead of overwriting them, preserves one logical publication, and
regenerates the local page:

```bash
node dist/cli.js publish-run "/absolute/path/to/run-directory" \
  --refresh-dashboard
```

This is the correct recovery command after:

- `npm run build:dashboard` reset the page to pinned samples,
- a dashboard refresh failed after successful publication,
- or the static output was rebuilt but not refreshed from PostgreSQL.

For the reference target, use an already-completed official-filesystem run
directory. Do not rerun analysis just to restore the sidebar.

## Restore missing run history

If the sidebar says `No eligible published runs yet`, the generated page has
fallen back to pinned samples. The usual cause is rebuilding with plain
`npm run build:dashboard`, which intentionally creates a self-contained sample
page without querying PostgreSQL.

To restore history:

1. Ensure PostgreSQL and MinIO are healthy.
2. Find an already-completed run directory for each target.
3. Run `publish-run ... --refresh-dashboard` for one run in each group.
4. Reload the dashboard.

The refresh retains up to five eligible projections per target, newest first.

## Verify the page

Check that the server is reachable:

```bash
curl -I http://127.0.0.1:4173/
```

Confirm sidebar history exists:

```bash
curl -s http://127.0.0.1:4173/ |
  grep -E 'published-(controlled|reference)-run-[0-9]+' |
  sort -u
```

A missing index can also be verified in the page itself: the text
`No eligible published runs yet` means the current snapshot is pinned-only.

## Stop the demo

Stop the dashboard with `Ctrl+C` in the server terminal.

Stop the publisher services without deleting their data:

```bash
docker compose -f compose.publisher-demo.yml stop postgres minio
```

To remove the local demo data as well, follow the reset instructions in
[`PublisherDemo.md`](PublisherDemo.md). Do not remove named volumes unless the
local synthetic demo data is no longer needed.

## Common questions

**Why does the sidebar link not change the URL path?**

The dashboard is one HTML document. Links use fragment anchors such as
`#published-controlled-run-1`, so the browser scrolls within the current page.
There is no server-side per-run route.

**Why does the hosted AWS copy differ?**

The local page refreshes immediately from eligible local publications. The
hosted copy changes only after the separate content deployment documented in
`DashboardAwsDemo.md`.

**Why does rebuilding lose run history?**

Plain `build:dashboard` intentionally produces a portable sample snapshot
without database access. Published history returns through
`publish-run --refresh-dashboard` or the analyze `--publish
--refresh-dashboard` path.

**Can I publish arbitrary runs?**

Only publish synthetic, non-sensitive runs. Evidence bundles can contain raw
traces, transcripts, source, environment-derived data, or credentials. Never
publish real secrets or unreviewed sensitive workloads.
