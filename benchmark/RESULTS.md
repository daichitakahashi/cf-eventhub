# Deployed performance baseline

## Environment and method

- Date: 2026-11-01 (UTC); load generator in Tokyo, Japan; observed Worker ingress NRT.
- Workers Paid, with R2 enabled separately before deployment.
- Base commit: `129f1c8`; cf-eventhub `1.0.0-rc.0` plus the list/claim fixes in this branch.
- Worker compatibility date: `2026-09-11`; `nodejs_compat` enabled; Wrangler `4.131.0`.
- External generator: Node `v25.2.1`, macOS arm64; closed-loop fetch clients.
- Each measured condition: 20 concurrent clients and a 30-second request-start window.
  Throughput uses actual elapsed time, including in-flight completions. Percentiles
  are nearest-rank values over successful operations, in milliseconds.
- Partition and destination runs have 5 seconds of excluded publish warmup.
  Retained-state runs start after seeding; each state size uses a fresh named DO.
- Small JSON bodies, zero padding, one event per publish, no Registry or auto-eviction.
- Destination publish latency ends after persistence and the HTTP response body;
  handoff runs in the background. Completion is checked separately.
- List reads the first 100 rows through the real EventHub RPC, but the HTTP handler
  returns only their count. These numbers do not include sending the complete
  payload page to the external client.
- Claim latency covers one claim-and-finalize RPC; cycle throughput includes a
  separate preparation RPC. Each successful cycle claims exactly one real job.
  This is the SQLite primitive used by alarm processing, not timer scheduling or
  an external-destination retry test. Seeded claim jobs are already finalized.

The complete [raw summaries](./results/2026-11-01-fixed/cases.json) contain exact
before/after row counts and elapsed time for every condition. Worker version IDs,
source hashes and bundle figures are in [provenance.json](./results/2026-11-01-fixed/provenance.json).
The benchmark-only one-job claim cap was deployed during the R2 condition;
that cap does not affect publish, list or destination behavior. Both fixed Worker
versions contain identical library code. The last version is
`11e277a0-6e0e-49ec-a175-dde65f4eebfa`.

## Measured results

There were **119,590 successful operations and zero HTTP failures** across these
15 measured conditions. Warmup, seeding and diagnostics are excluded from this count.

| Condition | Partitions | Initial retained payloads | Operations/s | p50 ms | p95 ms | p99 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [Publish, no destination](./results/2026-11-01-fixed/publish-p1.json) | 1 | 1,563 | 357.59 | 46.33 | 81.98 | 248.71 |
| [Publish, no destination](./results/2026-11-01-fixed/publish-p10.json) | 10 | 1,852 | 413.02 | 39.28 | 78.48 | 296.20 |
| [Publish, no destination](./results/2026-11-01-fixed/publish-p100.json) | 100 | 988 | 263.90 | 42.37 | 84.77 | 374.92 |
| [Publish, Queue](./results/2026-11-01-fixed/publish-queue.json) | 10 | 1,262 | 279.11 | 63.37 | 113.00 | 299.84 |
| [Publish, R2](./results/2026-11-01-fixed/publish-r2.json) | 10 | 1,181 | 258.66 | 66.08 | 139.07 | 349.92 |
| [Publish, Workflow](./results/2026-11-01-fixed/publish-workflow.json) | 10 | 1,107 | 267.04 | 45.58 | 229.17 | 512.94 |
| [list 100](./results/2026-11-01-fixed/list-100.json) | 1 | 100 | 320.76 | 58.69 | 87.23 | 189.17 |
| [claim 100](./results/2026-11-01-fixed/claim-100.json) | 1 | 100 | 155.53 | 54.55 | 104.90 | 188.06 |
| [publish 100](./results/2026-11-01-fixed/publish-100.json) | 1 | 100 | 323.92 | 54.07 | 83.59 | 242.02 |
| [list 10000](./results/2026-11-01-fixed/list-10000.json) | 1 | 10,000 | 131.18 | 144.57 | 234.84 | 454.10 |
| [claim 10000](./results/2026-11-01-fixed/claim-10000.json) | 1 | 10,000 | 199.01 | 40.82 | 87.15 | 271.60 |
| [publish 10000](./results/2026-11-01-fixed/publish-10000.json) | 1 | 10,000 | 191.48 | 92.75 | 163.94 | 327.67 |
| [list 100000](./results/2026-11-01-fixed/list-100000.json) | 1 | 100,000 | 331.36 | 55.95 | 85.79 | 121.50 |
| [claim 100000](./results/2026-11-01-fixed/claim-100000.json) | 1 | 100,000 | 141.06 | 60.91 | 133.15 | 284.34 |
| [publish 100000](./results/2026-11-01-fixed/publish-100000.json) | 1 | 100,000 | 328.82 | 53.05 | 80.98 | 297.30 |

The retained publish and claim cases grow their tables during the interval.
For example, the 100k publish case finishes with 109,881 payloads; the 100k claim
case finishes with 104,240 payloads/jobs. List state does not change.

## Destination handoff

Queue and R2 jobs were all completed by the post-run checks. Workflow publish
returned successfully at 267.04 operations/s, but the first drain check (120 seconds)
still showed 42 pending jobs out of 9,246, including warmup. The final
[follow-up](./results/2026-11-01-fixed/delivery-workflow-followup.json) confirmed
all 9,246 completed; none failed. This interrupted the original matrix driver;
the retained portion was then resumed with the same fixed series.

The input rate exceeded the documented
[100 creations/s per Workflow](https://developers.cloudflare.com/workflows/reference/limits/).
Rate limiting is a plausible explanation for the delayed handoff, not a measured
proof of every retry's cause. HTTP publish throughput must not be read as
Workflow creation or business completion throughput. The harness now allows a
600-second drain window by default. The pre-teardown API snapshot also showed
all 15,393 Workflow instances from both series completed, with no errored instances.

## Scaling findings and fixes

Two SQL issues were investigated and corrected:

1. Live list used a recursive query that repeatedly searched for the next row.
   Before the fix, the 10k case achieved 3.28 operations/s, p50 6,098.71 ms;
   the 100k attempt timed out before its post-run summary could be saved.
   The replacement materializes at most 100 rows of metadata, applies a cumulative
   byte budget, then fetches only permitted payload bodies. Pagination order,
   byte limits and the first-oversized-item behavior remain covered by tests.
   The fixed 10k measurement is 131.18 operations/s, p50 144.57 ms; 100k is
   331.36 operations/s, p50 55.95 ms. These observations include placement/network
   variation, so their ratio is not a universal speedup claim.
2. Loading a claimed batch searched by lease token without excluding finalized
   rows, scanning retained delivery history. Restricting the query to active
   jobs uses an existing index and requires no schema migration. A regression
   test read 1,009 SQLite rows with 1,000 completed jobs before the fix; it now
   stays below 100. The list regression test bounds reads for both ascending and
   descending pages, including cursor continuation.

The deployed [SQL profiles](./results/2026-11-01-fixed/list-query-profiles.json)
read **1,005 rows** for each 100-row first page against the older series' retained
100/10k/100k-sized instances. Their execution plans are recorded. `elapsedMs: 0`
in those profiles reflects Workers' synchronous clock behavior, not zero CPU cost.
The complete library suite passes 293 tests; the harness suite passes 5 tests.

The [original partial run](./results/2026-11-01/incomplete.json) is preserved for
audit, not used as the accepted baseline. Its claim RPC allowed batches, so its
claim latencies are not directly comparable with the fixed one-job measurements.
The previous 2026-10-03 attempt stopped at Cloudflare API error 10042 because R2
was not enabled; enabling Workers Paid alone did not enable R2.

## Interpretation and limits

Ten partitions improved throughput relative to one in this run; 100 partitions
did not improve it further and had a 7.8-second maximum latency outlier. Different
named instances may be placed differently; ingress location is not a measurement
of DO location. Retained-state cases use different DOs, so non-monotonic timings
cannot be attributed to row count alone. There is one measured interval per
condition, no confidence interval, no fixed arrival rate and no saturation search.
Client networking, load-generator capacity and ambient platform load can dominate.

The bounded SQL reads and successful 100k runs support removal of the observed
retained-history scans. This does not establish scaling for arbitrary pending-job
backlogs, deep pagination, large bodies, Registry traffic or multi-region clients.
These are a reproducible deployed reference, **not an SLA or a universal
cf-eventhub throughput number**.

## Bundle and startup

Wrangler deployment reported 100.03 KiB upload, 20.63 KiB gzip, and 2 ms Worker
startup time. The previous 2026-10-03 dry run was 98.71 KiB / 19.85 KiB gzip.
Startup is Wrangler's runtime startup metric, not external request cold-start latency.

## Resource disposal

All dedicated benchmark resources were deleted after saving the results,
including 15,364 R2 objects, both DO namespaces/data, and 15,393 Workflow
instances. The Worker, Queue and R2 bucket were also deleted. See
[the teardown verification](./results/2026-11-01-fixed/teardown-verification.json)
for the final API inventory. The reusable harness and local raw measurements are
retained in this repository. No lifecycle rule is needed for this full teardown.
