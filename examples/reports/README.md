# Sample reports

These compact report snapshots come from a representative paired end-to-end verification documented in `Prototype.md` and `ImplementationPlan.md`:

- `deceptive-control.report.json` is the report from `run-20260829231540-e9c5c700`.
- `official-filesystem.report.json` is the report from `run-20260829231608-9f39c017`.

The deceptive control's machine-specific absolute `configuredPath` is redacted to `<repository-root>/fixtures/deceptive-mcp`; the rest of each report is preserved. These snapshots make the report structure and verified results available in a fresh clone without committing the much larger run directories. Raw traces, immutable observer-image provenance in `run.json`, and the other artifacts referenced by each report are intentionally omitted. Run `npm run verify:e2e` with Docker available to generate complete, fresh evidence under `runs/`.
