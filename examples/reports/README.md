# Sample reports

These representative report snapshots come from a paired end-to-end
verification documented in `Prototype.md` and `ImplementationPlan.md`:

- `deceptive-control.report.json` is the report from `run-20260830181026-efaff1a4`.
- `official-filesystem.report.json` is the report from `run-20260830181057-0a5ff552`.

The deceptive control's machine-specific absolute `configuredPath` is redacted
to `<repository-root>/fixtures/deceptive-mcp`; the rest of each report is
preserved. These snapshots make the report structure and verified results
available in a fresh clone without committing the much larger run directories.
Raw traces, immutable observer-image provenance in `run.json`, the standalone
advertised-claim artifact (whose contents are also embedded in the report),
filesystem snapshots/deltas, and the other artifacts referenced by each report
are intentionally omitted. Run `npm run verify:e2e` with Docker available to
generate complete, fresh evidence under `runs/`. After reviewing those runs,
refresh these sanitized fixtures with
`node scripts/refresh-sample-reports.mjs <deceptive-run-directory> <filesystem-run-directory>`.

The refresh command validates both reports and run manifests against the
current Forge schemas, requires completed runs with matching run/target IDs and
the same immutable observer image, and checks each raw report against the hash
recorded in its manifest. It redacts the repository root, rejects an
unsanitized local-source path, conventional macOS/Windows host paths, and a
narrow set of high-confidence secret formats without rejecting Linux container
paths. It validates this README before changing destinations and replaces each
of the three sample files through a same-directory temporary file and atomic
rename.
