# Deployed benchmark

This harness measures cf-eventhub through a deployed Cloudflare Worker. The
load generator runs outside Workers, so reported latency includes the client to
Worker request, Worker to Durable Object RPC, SQLite persistence, and (where
selected) destination handoff.

It is a reproducible baseline and scaling check, not a throughput SLA. Results
depend on the load-generator location, Cloudflare placement, account plan, and
ambient platform load.

## Provision and deploy

Requirements: Node.js 24, pnpm 11, an authenticated Wrangler session, and a
Cloudflare account with Workers Paid, Queues, R2, and Workflows enabled.

```sh
pnpm install
pnpm --filter eventhub-benchmark exec wrangler queues create cf-eventhub-benchmark
pnpm --filter eventhub-benchmark exec wrangler r2 bucket create cf-eventhub-benchmark
pnpm --filter eventhub-benchmark exec wrangler secret put BENCHMARK_TOKEN
pnpm --filter eventhub-benchmark run deploy
```

Use a unique `--prefix` for each state-size series. The bearer token prevents an
untrusted caller from creating billable benchmark traffic.

## Publish and partitioning

Run each destination independently for the same duration and concurrency. The
examples below use a 60-second measurement window.

```sh
node benchmark/load.mjs run --url https://WORKER.workers.dev --token TOKEN --operation publish --destination none --partitions 1 --concurrency 20 --duration 60 --prefix publish-single
node benchmark/load.mjs run --url https://WORKER.workers.dev --token TOKEN --operation publish --destination queue --partitions 10 --concurrency 20 --duration 60 --prefix queue-p10
node benchmark/load.mjs run --url https://WORKER.workers.dev --token TOKEN --operation publish --destination r2 --partitions 100 --concurrency 20 --duration 60 --prefix r2-p100
node benchmark/load.mjs run --url https://WORKER.workers.dev --token TOKEN --operation publish --destination workflow --partitions 10 --concurrency 20 --duration 60 --prefix workflow-p10
```

`publish` latency ends when persistence succeeds. EventHub starts destination
handoff with `waitUntil()`, so the measured response does not wait for Queue,
R2, or Workflow completion. Destination-specific runs still expose contention
and resource use caused by that handoff.

## Retained state and list

Seed one named EventHub, then measure `publish` and first-page `list` against the
same name. Repeat with fresh prefixes for near-empty, 10k, and 100k payloads.

```sh
node benchmark/load.mjs seed --url https://WORKER.workers.dev --token TOKEN --target 10000 --partitions 1 --concurrency 10 --prefix retained-10k
node benchmark/load.mjs run --url https://WORKER.workers.dev --token TOKEN --operation list --partitions 1 --concurrency 20 --duration 60 --prefix retained-10k
node benchmark/load.mjs run --url https://WORKER.workers.dev --token TOKEN --operation publish --destination none --partitions 1 --concurrency 20 --duration 60 --prefix retained-10k
```

The list benchmark requests the first 100 rows. This keeps response size stable
while the retained row count changes. The Worker returns only the row count;
the measurement includes the EventHub's list work and RPC serialization, but
does not include transferring all payload bodies to the external client.

## Delivery-job claiming

The CLI operation `retry` measures the SQLite delivery-job claiming primitive
used by `alarm()`. Each cycle prepares one due job, then times a separate RPC
that calls the real `claimDeliverableJobs()` and `markDeliveryJobsCompleted()`
helpers in a synchronous SQLite transaction. The response reports the number of
claimed jobs; the matrix requires exactly one claimed job per successful cycle.
No automatic alarm or failing external destination runs in this scenario.

Latency covers only the claim-and-finalize HTTP/RPC call, including response
body consumption. Throughput counts full prepare-plus-claim cycles, so it also
includes the untimed preparation HTTP call. It is neither alarm scheduling
latency nor an external-destination retry benchmark.

Seed finalized delivery jobs into the same claim instance to measure retained
job-table scaling without leaving a growing pending backlog:

```sh
node benchmark/load.mjs seed --url https://WORKER.workers.dev --target 100000 --claims true --partitions 1 --concurrency 5 --prefix claims-100k
node benchmark/load.mjs run --url https://WORKER.workers.dev --operation retry --partitions 1 --concurrency 20 --duration 30 --prefix claims-100k
```

## Full matrix

Pass the token through the environment to keep it out of process arguments.
The matrix runs conditions sequentially, uses a fresh named-instance prefix for
each series, saves raw summaries and exact before/after row counts, and waits
for destination delivery jobs to complete (up to 600 seconds; override with
`BENCHMARK_DRAIN_SECONDS`). HTTP failure or an unexpected claim
count causes a nonzero exit. Use a fresh `BENCHMARK_SERIES` on every full run.

```sh
export BENCHMARK_URL=https://WORKER.workers.dev
export BENCHMARK_TOKEN=YOUR_SECRET
BENCHMARK_SERIES=my-baseline BENCHMARK_OUTPUT=benchmark/results/my-baseline node benchmark/matrix.mjs
```

Defaults: 20 concurrent clients, 30 seconds per measured condition, 5 seconds
of excluded publish warmup for partition/destination cases. Set
`BENCHMARK_DURATION=60` for longer runs. The matrix measures 1/10/100 partitions,
Queue/R2/Workflow with 10 partitions, and first-page list, claim, and publish
with initial retained sizes of 100/10k/100k. Retained publish and claim grow the
state during the interval; before/after counts are part of the result. The
near-empty list case has 100 rows so all list cases retrieve the same page size.
To resume only the retained-state portion after a destination run, set
`BENCHMARK_PHASE=retained` with the same series and output directory, before
any retained-state seeds have run.

Each HTTP request has a 30-second timeout and latency ends after its JSON body
has been consumed. Latency percentiles describe successful operations only;
failures are counted separately. There is no fixed arrival rate: this is a
closed-loop concurrency test, and the load generator/network may be the limit.

`GET /stats?hub=NAME` returns payload counts and delivery job status counts;
add `&claims=true` to inspect the claim instance. It is authenticated and runs
outside timed intervals. Destination completion confirms binding handoff, not
Queue consumer completion or Workflow business success. Workflow publish
rate may exceed the [per-workflow instance creation
limit](https://developers.cloudflare.com/workflows/reference/limits/), causing
background retries even when publish succeeds. Record the drain state alongside
HTTP throughput; these are different measurements.

## Cleanup and bundle information

Cleanup repeatedly ejects and evicts finalized payloads in batches of 100:

```sh
node benchmark/load.mjs cleanup --url https://WORKER.workers.dev --token TOKEN --partitions 1 --prefix retained-10k
pnpm --filter eventhub-benchmark exec wrangler deploy --dry-run --outdir /tmp/cf-eventhub-benchmark
```

Set `BENCHMARK_CLEANUP=true` to eject/evict all matrix instances after measuring.
This deletes only data in the uniquely prefixed benchmark instances.

R2 destination objects, Queue messages, and Workflow execution history follow
their own Cloudflare retention/lifecycle settings and are not deleted by the
cleanup command.

To destroy the entire dedicated benchmark environment after saving results:

```sh
BENCHMARK_DESTROY=true node benchmark/teardown.mjs
```

Use the same `BENCHMARK_URL` and `BENCHMARK_TOKEN` (or
`BENCHMARK_TOKEN_FILE`) as the matrix. This empties the dedicated R2 bucket,
detaches the Queue consumer, deletes the Workflow and its instances, deploys
[deleted class tombstones](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
to destroy both DO namespaces and their data, then deletes the Worker, Queue,
and bucket. It preserves the local result files. A lifecycle rule is not
needed for this teardown.

`GET /profile-list?hub=NAME` is an authenticated, untimed SQL diagnostic. It
records SQLite rows read and execution plans. Its `elapsedMs` is not a CPU
measurement: Workers clocks may stay unchanged during synchronous SQL.

Record raw JSON output, load-generator region, Worker compatibility date,
cf-eventhub version, Wrangler version, concurrency, partitions, retained state,
destination, duration, and dry-run bundle sizes in `RESULTS.md`.
