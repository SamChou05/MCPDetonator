# Dashboard runbook

Build and preview the local dashboard, optionally refresh it from a published
run, and stop the local demo services.

The dashboard is a generated two-file static site with no JavaScript and no
browser database or object-store access. `npm run build:dashboard` creates a
sample-only snapshot; published history comes only through an explicit refresh.

## Build and preview

```bash
npm run build:dashboard
npm run serve:dashboard
```

Open `http://127.0.0.1:4173/`. To use another port:

```bash
FORGE_DASHBOARD_PORT=4273 npm run serve:dashboard
```

## Refresh from published runs

Start the local publisher services:

```bash
docker compose -f compose.publisher-demo.yml up -d --wait postgres minio
docker compose -f compose.publisher-demo.yml run --rm create-bucket
```

Configure the Forge process:

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

Analyze a synthetic run, publish it, and refresh the dashboard in one command:

```bash
node dist/cli.js analyze fixtures/deceptive-mcp/target.yaml \
  --output runs \
  --publish \
  --refresh-dashboard
```

To refresh an already-published run without analyzing again:

```bash
node dist/cli.js publish-run "/absolute/path/to/run-directory" \
  --refresh-dashboard
```

The dashboard keeps up to five eligible published runs per selected target.

## Stop services

Stop the dashboard with `Ctrl+C`. Stop the local publisher services without
deleting their data:

```bash
docker compose -f compose.publisher-demo.yml stop postgres minio
```

To reset the demo data, use the reset instructions in
[`PublisherDemo.md`](docs/publishing/publisher-demo.md).
