# Deployed durable-delivery chaos validation

This release-validation harness uses real Cloudflare Queue, R2 and Workflow
bindings. It adds no injection hooks to the published package. Requirements:
Node.js 24, pnpm 11, authenticated Wrangler, and an account with Workers Paid,
Queues, R2 and Workflows enabled. All resources use the dedicated name
`cf-eventhub-chaos`; never point the configuration at production resources.

## Deploy and run

```sh
pnpm install
pnpm --filter eventhub-chaos exec wrangler queues create cf-eventhub-chaos
pnpm --filter eventhub-chaos exec wrangler r2 bucket create cf-eventhub-chaos
pnpm --filter eventhub-chaos deploy
pnpm --filter eventhub-chaos exec wrangler secret put CHAOS_TOKEN
export CHAOS_URL=https://cf-eventhub-chaos.YOUR_SUBDOMAIN.workers.dev
export CHAOS_TOKEN_FILE=/absolute/path/to/private-token-file
node validation/chaos/run.mjs
```

Use the same secret for the Worker and runner. Keep it out of command arguments,
logs and Git. Every endpoint requires the bearer token. Keep only one runner
active per run ID and do not deploy code changes during a run.

The runner creates one `chaos-test-<runId>` hub, one fault controller, and one
receipt ledger per run. A repeated run ID is rejected; use a fresh ID. It
publishes batches of ten distinct `{testRunId, eventIndex}` events, each routed
to all three destinations. Injection is enabled before the first publish because
EventHub starts handoff immediately. It captures the authoritative persisted
job set after publication, before recovery, in an ignored `.expected.json` file.
Publication is never automatically retried after a lost HTTP acknowledgement.

## Methodology

The controller advances a persisted xorshift32 PRNG and appends a decision in
one synchronous SQLite transaction. Decisions include run ID, monotonic sequence,
destination, delivery job IDs, selected mode, timestamp and completion outcome.
The persisted log is authoritative: the seed alone cannot reproduce concurrent
runtime ordering. `GET /decisions?runId=ID&after=SEQUENCE` pages through it in
batches of 100. Logs remain in the deployed controller until teardown; download
them to ignored local storage or CI artifacts when investigating a failure.

The wrappers preserve destination detection and delegate unmodified methods to
the real binding with the correct receiver. The harness wraps the explicit
`createBatch({instances})` overload used by EventHub; count-based/legacy array
creation is outside its test interface.

- `pass`: call the real binding and return its result.
- `fail-before`: persist the decision, throw before calling the destination.
- `commit-then-fail`: await the real `sendBatch`, `put`, or `createBatch`, then
  throw before returning to EventHub. Workflow coverage counts only batches
  that created at least one new instance. Existing-instance responses alone
  cannot satisfy ambiguous-commit coverage. Real destination errors are logged
  separately and never count as an injected durable commit.

Coverage is the number of **calls**, not jobs, with an applied fault for each
of the six destination/mode combinations. Chaos ends only after both minimum
payload count and all six minimum coverage counts are met. Additional payloads
are published up to a fixed maximum if needed. At that maximum, retries continue
until coverage or timeout. There is no forced coverage selection: an unlucky
seed or exhausted jobs fails explicitly rather than silently lowering coverage.

Recovery disables the persisted controller flag. Already-issued decisions may
finish; the runner waits for zero in-flight decisions and successful, unleased
terminal jobs. Only EventHub's ordinary alarms/retries can recover the jobs.
There is no redrive, eject, restart/eviction injection, latency injection or
manual invocation of alarms. Recovery timing includes draining old decisions,
destination execution, independent observation and a ten-second quiet window.

Independent observations are:

- Queue consumer: aggregate receipt ledger keyed by run, destination and delivery
  job ID. Each message is acknowledged only after the ledger write. Duplicate
  deliveries and ambiguous ledger acknowledgements remain observable as counts.
- R2: paginated real bucket listing plus object reads under
  `chaos/<runId>/<deliveryJobId>.json`. Repeated puts overwrite the same key.
- Workflow: the Workflow's durable step writes an independent receipt including
  its actual instance ID. Reconciliation also queries real instance status by
  delivery job ID. Repeated receipt-step execution is counted separately from
  distinct logical instances; only one matching instance ID is allowed per job.

The reconciler checks payload count and event-index uniqueness, exact three-way
fan-out, immutable expected/final job sets, successful unleased terminal state,
missing side effects, phantom receipts/objects, deterministic R2 keys, Workflow
identity and completed Workflow status. It accepts and reports Queue duplicates.
A ten-second observation window follows the first successful reconciliation to
include late consumer receipts. This is a bounded empirical release test, not a
proof about arbitrary future runtime schedules.

## Configuration and evidence

Environment variables (positive integers unless noted):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHAOS_RUN_ID` | `run-<timestamp>` | Unique run ID, letters/digits/underscore/hyphen, at most 80 chars |
| `CHAOS_SEED` | `193` | Nonzero uint32 PRNG seed |
| `CHAOS_WEIGHTS` | `{"pass":1,"fail-before":4,"commit-then-fail":4}` | JSON positive weights |
| `CHAOS_MIN_COVERAGE` | `3` | Minimum applied calls for each of six combinations |
| `CHAOS_PAYLOADS` | `100` | Minimum payload count |
| `CHAOS_MAX_PAYLOADS` | `1000` | Maximum payload count (at most 10000) |
| `CHAOS_TIMEOUT_SECONDS` | `300` | Chaos deadline |
| `CHAOS_RECOVERY_SECONDS` | `600` | Recovery/reconciliation deadline |
| `CHAOS_OUTPUT` | `validation/chaos/.wrangler/results/<runId>.json` | Compact summary path |

Retry settings: initial 1s, maximum 5s, 1000 retries, 30s lease, alarm batch 100,
`includeDeliveryMetadata: true`. Automatic eviction is not configured.

The runner exits nonzero on failure and writes a machine-readable summary,
including actual coverage, configuration, provenance, durations, reconciliation
totals and errors. Failed runs also write an ignored full state diagnostic.
HTTP calls time out after 30s. Keep raw logs, expected job files and diagnostics
outside Git. Commit only a compact release summary and a self-contained report
under `docs/validation/`, including unexpected observations and any limitations.

Local checks (also included in CI):

```sh
pnpm --filter eventhub-chaos typecheck
pnpm --filter eventhub-chaos test
```

The local tests validate the observation oracle's rejection behavior; the
committed release report provides evidence from the real deployed runtime.

## Teardown

After saving evidence, destroy the dedicated environment:

```sh
CHAOS_DESTROY=true node validation/chaos/teardown.mjs
```

This empties the entire dedicated bucket, removes the consumer, deletes the
Workflow and its instances, deploys deleted-class tombstones for all three DO
namespaces, then deletes the Worker, Queue and bucket. It preserves local
reports. The explicit flag prevents accidental teardown. Run it only after the
runner has stopped; it also removes state from failed runs.

API behavior references: [Queue JavaScript APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/),
[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[Workflow Workers API](https://developers.cloudflare.com/workflows/build/workers-api/),
[Workflow rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/),
[Durable Object rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).
