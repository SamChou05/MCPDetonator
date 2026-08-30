/**
 * Hard limits for the synchronous publisher thin slice. These bounds keep a
 * contract-valid run from turning one CLI invocation into unbounded local I/O
 * or an unbounded row-by-row Postgres transaction.
 */
export const MAX_PUBLICATION_ARTIFACT_COUNT = 2_048;
export const MAX_PUBLICATION_FINDING_COUNT = 4_096;
export const MAX_PUBLICATION_ARTIFACT_BYTES = 256 * 1_024 * 1_024;
export const MAX_PUBLICATION_TOTAL_ARTIFACT_BYTES = 1_024 * 1_024 * 1_024;
export const MAX_PUBLICATION_VERIFICATION_MS = 5 * 60 * 1_000;
