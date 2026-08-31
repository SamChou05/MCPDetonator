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

## All npm commands

The package exposes these npm scripts. Docker-backed checks require Docker to
be available; network-dependent commands require the explicit credential or
package access noted below.

### Build, inspect, and serve

- `npm run build` — compile TypeScript into `dist/` using
  `tsconfig.build.json`.
- `npm run build:dashboard` — build TypeScript, then generate the private
  script-free dashboard snapshot in `dist/dashboard-site/` from sample
  projections and the template/stylesheet.
- `npm run serve:dashboard` — serve `dist/dashboard-site/` at
  `http://127.0.0.1:4173/`; it reads the generated files fresh on each request.
  Set `FORGE_DASHBOARD_PORT` to another integer port.
- `npm run typecheck` — typecheck the source configuration with `--noEmit`.

### Runtime commands through npm

`npm run dev` runs the CLI through `tsx` without building first. Extra
arguments follow `--`. The built equivalent is `npm start`.

- `npm run dev -- --version` — print the CLI version.
- `npm run dev -- validate <target.yaml>` — validate a target configuration
  without starting or executing the MCP.
- `npm run dev -- analyze <target.yaml> [-o <directory>] [--image <name>]`
  — run isolated MCP experiments and retain local evidence. Defaults to
  `runs` and `forge-sandbox:dev`.
- `npm run dev -- analyze <target.yaml> --publish [--refresh-dashboard]` —
  after the local run completes, publish to configured S3-compatible storage
  and PostgreSQL; `--refresh-dashboard` regenerates only the eligible local
  demo dashboard snapshot after queryable publication.
- `npm run dev -- publish-run <run-directory> [--refresh-dashboard]` — verify
  and publish a completed run; publication requires the publisher environment
  and dashboard refresh requires `npm run build:dashboard` first.
- `npm run dev -- agent-evaluate <scenario.yaml> [-o <directory>]` — run the
  separate opt-in Agent V1 evaluation. Requires `OPENROUTER_API_KEY`; it is
  never mounted into the target sandbox. Docker-backed.
- `npm start` — run `dist/cli.js`; use the same CLI arguments after it.

The direct built equivalents are documented in `README.md`; the publication
environment is shown in [`PublisherDemo.md`](docs/publishing/publisher-demo.md).

### Tests and verification

- `npm test` — run the non-watch Vitest suite once.
- `npm run test:watch` — run Vitest in watch mode.
- `npm run verify:e2e` — build, then run the standard core deterministic-core
  end-to-end verifier. Docker required.
- `npm run verify:agent` — build, then run the deterministic local-provider
  Agent V1 verifier; no real provider credential is required. Docker required.
- `npm run verify:publisher` — build, then run an isolated temporary
  PostgreSQL/MinIO publication and dashboard-refresh verifier. Docker required.
- `npm run verify:v2-outcome` — build, then rerun the controlled V2 outcome
  experiment and verify its stable fields. Docker required.
- `npm run verify:v2-enrollment:local` — build, then verify the reviewed
  unseen-MCP enrollment path using local fixtures only. No npm acquisition.
- `npm run verify:v2-enrollment` — build, then also acquire the exact npm
  versions recorded by the enrollment study. Requires network access for npm
  and Docker for execution.

### Experimental proposal commands

- `npm run experiment:v2-proposals` — run the provider-free scripted V2
  proposal comparison; it does not execute an MCP or create an
  `ApprovalReceipt`/`ExperimentPlan`.
- `npm run experiment:v2-proposals -- --live --model <provider/model>` — send
  only the bounded proposal context to OpenRouter; requires
  `OPENROUTER_API_KEY`.
- `npm run experiment:v2-proposal-study -- --trials <1-10> --model <provider/model>`
  — run sequential live proposal trials and write tracked JSON and Markdown
  results. Requires `OPENROUTER_API_KEY`, normally loaded from the ignored
  `.env` by the script command. No target execution or plan approval occurs.
