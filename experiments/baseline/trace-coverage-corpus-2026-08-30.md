# Representative MCP trace-coverage corpus

**Status:** Implemented on 2026-08-30

## Question

Which selected trace families are actually missing useful deterministic
runtime evidence across representative public MCP servers, and which apparent
gaps are installer noise or deliberately conservative dual accounting?

## Why this is useful

Raw syscall frequency is a poor implementation priority. Package installation
can overwhelm the activity caused by MCP startup and tool calls, and mapping a
metadata probe to a content read would make Forge's report stronger than its
evidence. This experiment separates installation, initialization, and tool
cohorts before choosing the next normalizer work.

## Hypothesis

Tool and initialization gaps will be much smaller than install-lifecycle gaps.
A diverse file, process, network, compression, and compute corpus should either
identify a repeated, low-ambiguity missing behavior or show that the immediate
value is in better accounting and false-positive reduction.

## Controls and synthetic setup

The pinned configurations and reproduction commands live in the
[trace-corpus case study](../../case-studies/trace-corpus/README.md). The corpus
contains:

- official Memory for a synthetic JSONL write;
- official Everything for in-memory gzip plus a failed connection to the
  container-local `127.0.0.1:54321`;
- official Sequential Thinking as a compute-oriented control; and
- a community Shell server for a fixed Bash command and synthetic workspace
  write.

Every runtime uses blocked Docker networking, a fresh synthetic home and
workspace, bounded resources, exact top-level package versions, and no real
credentials. Install scripts disabled/enabled form a paired acquisition
control for every target.

## Procedure

1. Validate all four target configurations.
2. Analyze each target in an isolated run, retaining its raw trace, canonical
   events, report, run manifest, and `observation-health.json`.
3. Aggregate only the four explicitly selected terminal run directories with
   `scripts/summarize-trace-coverage.mjs`.
4. Keep `install_lifecycle`, `baseline_initialization`, and `tool` totals
   separate.
5. Inspect every non-install gap fingerprint and any report finding against its
   canonical event and raw trace.
6. Implement only changes supported by that evidence, then rerun the affected
   target.

## Retained run evidence

Generated runs remain gitignored. These exact local run identities produced the
recorded result:

| Target | Run ID | Tool experiments | Final findings | Tool gap records |
| --- | --- | ---: | ---: | ---: |
| Memory | `run-20260830220441-a105ae93` | 1 | 0 | 1 `openat` |
| Sequential Thinking | `run-20260830220519-c6aa0f41` | 1 | 0 | 0 |
| Everything | `run-20260830221048-ab50a46c` | 2 | 0 | 0 |
| Community Shell, post-fix | `run-20260830223403-5dedeb50` | 1 | 0 | 11 (`openat` ×2, metadata probes ×6, failed capability probes ×3) |

Every experiment had complete selected-trace integrity and completed
canonicalization.

## Aggregate result

| Cohort | Experiments | Parsed selected syscall records | Selected policy-gap records |
| --- | ---: | ---: | ---: |
| Install lifecycle | 8 | 547,483 | 204,966 |
| Baseline initialization | 4 | 14,950 | 6 |
| Tool | 5 | 18,703 | 12 |
| **Total** | **17** | **581,136** | **204,984** |

Installation produced 204,966 of 204,984 gaps (99.991%). Within installation,
`statx`, `mkdirat`, and mutating `openat` contributed 203,796 records (99.43%).
The scripts-disabled and scripts-enabled counts differed by only 2–8 records
per target. This is primarily common npm extraction and module-resolution
activity, not behavior that distinguishes an MCP tool or lifecycle-script
treatment.

The eighteen non-install gaps were fully inspectable:

- Four `openat` records represented truncation/creation ambiguity while already
  emitting canonical file evidence.
- The other eight records were `faccessat`, `newfstatat`, or `statx` metadata
  probes. One failed; none proved a content read or a new filesystem mutation.
- Six failed `io_uring_setup` records were classified as
  `failed_capability_probe`; they created no ring and are not evidence of a
  submitted asynchronous I/O operation.
- Sequential Thinking and both Everything tool cases had zero selected
  policy-gap records.
- Everything's failed TCP attempt to `127.0.0.1:54321` emitted a canonical
  `network.connect_attempt` with the expected destination and no gap.

This is evidence that the selected corpus did not expose a repeated,
high-consequence runtime operation that Forge silently discarded. It is not a
claim of complete Linux or application behavior coverage.

## Implemented improvements

The exploratory Shell run exposed four false `runtime.unexpected_network_attempt`
findings for `/var/run/nscd/socket`. Forge now applies one narrow exemption for
outbound connection attempts to the routine `/run/nscd/socket` and
`/var/run/nscd/socket` endpoints across initialization, tool, cooldown, and
comparison paths; listeners are not exempted. The final Shell rerun
retained those events as evidence and produced zero findings. Arbitrary Unix
socket paths such as `/var/run/docker.sock` remain network-policy evidence and
can be listed in `expected.networkConnections` by address; focused regression
tests preserve both sides of that boundary as well as unexpected TCP findings.

The broader retained-run audit also showed failed `io_uring_setup` calls being
grouped with opaque I/O even though a definitive setup failure creates no ring.
Observation health now classifies only definitively failed `io_uring_setup`
records as `failed_capability_probe`. The final Shell rerun made six such
non-install probes explicitly visible. Successful or indeterminate setup and
all submission/control calls remain `opaque_io`; counts are not suppressed.

The new manifest-bound corpus summarizer provides stable cohort, run, and
experiment aggregates. It accepts only direct `runs/run-*` inputs, caps the
input count, and rejects symlinks, oversized or malformed JSON, nonterminal or
identity-mismatched manifests, missing or wrong-media health rows, and health
bytes whose SHA-256 does not match the run manifest.

## Decision and next priority

Do not canonicalize `statx` or `mkdirat` as file content behavior merely to
reduce the install gap count. That would add volume while weakening semantic
honesty. Likewise, retain the conservative `openat` gap when creation semantics
are not losslessly represented, even when the useful truncate/write effect is
already canonical.

The next highest-value refinement is to distinguish exact unrepresented
behavior from lossy-but-canonical projections in health summaries. After that,
target successful file-transfer families such as `sendfile`, `splice`, and
`copy_file_range`: they can move content around ordinary `read`/`write`, but
need multi-effect source/destination evidence and careful file/socket/pipe
direction handling. New typed namespace, bind, signal, mapping, and metadata
effects should follow only with explicit contract and report semantics.

## Limitations

- Four Node.js/STDIO MCP packages are a useful calibration set, not a
  representative sample of every MCP implementation or workload.
- Health accounts for Forge's selected `strace` surface. It neither observes
  every syscall nor turns every parsed record into a canonical effect.
- Tool inputs are synthetic and narrow; other inputs and delayed behavior can
  differ.
- Exact top-level versions are pinned, but compatible transitive dependency
  resolution can change on a fresh acquisition. Compare retained lockfiles and
  provenance across dates.
- These configs contain no workflows. The summarizer labels non-install,
  non-baseline experiment IDs as `tool`, so it must not be reused as a general
  phase-kind classifier for workflow-bearing runs.
- Zero findings means no deterministic rule fired for the configured expected
  scope. It is not a safety verdict.
