# v1 durable-delivery chaos validation

**Result: PASS.** The deployed harness published 300 payloads and reconciled all
900 persisted delivery jobs against independently observed real Queue, R2 and
Workflow side effects. Every job reached `completed`, with no remaining lease.
No delivery was missing and no phantom delivery was observed.

## Provenance and configuration

| Item | Value |
| --- | --- |
| Date | 2026-11-03 JST (start: 2026-11-02 16:27:50.020 UTC) |
| cf-eventhub | `1.0.0-rc.0` |
| Package source commit | `5629fb685f633a0564627cb23c0582a87ee81061` |
| Harness source | `validation/chaos/` accompanying this report |
| Deployed Worker version | `482ce171-204a-40bd-b315-0cc9869440cc` |
| Worker compatibility date | `2026-09-11`, `nodejs_compat` |
| Wrangler | `4.148.0` |
| Resources | Dedicated `cf-eventhub-chaos` Worker, Queue, R2 bucket and Workflow; three SQLite DO namespaces |
| Run ID / EventHub name | `v1-20261103-193` / `chaos-test-v1-20261103-193` |
| Published payloads / expected jobs | 300 / 900 (300 each for Queue, R2, Workflow) |
| Publication | 30 batches of 10 payloads, with 1s between batches |
| PRNG / seed | Persisted xorshift32 / `193` |
| Mode weights | `pass: 1`, `fail-before: 4`, `commit-then-fail: 4` |
| Required fault coverage | At least 5 applied calls for each of six combinations |
| Payload bounds | Minimum 300, maximum 1000; no additional payloads were needed |
| Chaos / recovery timeout | 300s / 600s |
| Retry delays / retry limit | Initial 1000ms, maximum 5000ms / 1000 retries |
| Alarm batch / attempt lease | 100 jobs / 30000ms |
| Delivery metadata | Enabled |
| Automatic eviction / manual recovery | None / none |

The workspace was dirty because the new harness and repository integration had
not yet been committed when it ran. The cf-eventhub package source itself was
unchanged from the source commit above. The seed controls fault selection, but
runtime ordering is not reproducible from the seed alone; the persisted decision
log was the authoritative fault record.

## Observed faults and recovery

Coverage counts below are destination API **calls**, not delivery jobs. They
include completion of decisions already issued when injection was disabled.
Workflow ambiguous-commit coverage counts only calls that actually created at
least one new instance before the wrapper threw.

| Destination | fail-before | commit-then-fail |
| --- | ---: | ---: |
| Queue | 15 | 17 |
| R2 | 140 | 175 |
| Workflow | 15 | 11 |

All six combinations exceeded the minimum. The controller persisted 698
consecutive decisions. Before teardown, an audit of the persisted log confirmed
sequences 1–698 without gaps, matching run IDs, valid affected job IDs and
destinations, and no unfinished decision. No underlying destination API exception
was recorded (`destination-error: 0`).

The chaos phase lasted **35.382s**. The runner then disabled injection and relied
only on EventHub's normal alarms/retries. Recovery plus independent reconciliation
and the observation window took **313.889s**, within the 600s bound. That duration
includes R2 reads, Workflow status queries and a ten-second observation window;
it is not a measure of alarm latency or a throughput benchmark.

## Independent reconciliation

| Check | Observed result |
| --- | --- |
| Persisted payloads / unique event indices | 300 / 300 |
| Expected / final delivery job set | Same 900 IDs with exact three-way fan-out |
| Successful terminal jobs | 900 |
| Pending, retryable or leased jobs | 0 |
| Queue logical jobs / total receipt count | 300 / 519 |
| Additional Queue receipts | 219 (allowed at-least-once duplicates) |
| Deterministic R2 objects | 300 / 300 expected, listed and read from the real bucket |
| Workflow instances | 300 / 300, all queried by delivery job ID and `complete` |
| Workflow independent receipt identities | Exactly one matching logical instance ID for each of 300 jobs |
| Workflow repeated receipt-step writes | 0 |
| Workflow jobs affected by successful ambiguous handoff calls | 110 distinct job IDs |
| Missing destination side effects | 0 |
| Phantom deliveries / identity mismatches | 0 |
| Reconciliation errors | 0 |

Queue evidence came from the real Queue consumer's aggregate receipt ledger.
R2 evidence came from paginated listing and object-body reads under the run's
prefix. Workflow evidence came from the Workflow's own durable receipt step and
real instance status queries. The fault controller was not used as evidence of
any destination side effect. Workflow instances used the delivery job ID, including
the 110 distinct jobs affected by ambiguous creation outcomes.

Late Queue consumption raised the receipt count after EventHub jobs had already
completed; the final count above comes from the successful final reconciliation.
Duplicates are expected under the injected lost acknowledgements and remained
observable rather than being deduplicated by the ledger.

## Observations and release decision

There were no unexpected delivery failures, phantom deliveries or extra logical
Workflow instances. An initial deployment attempt rejected eager module-scope
binding wrappers; wrapper construction was moved into the EventHub instance
before the recorded test began. No changes to the cf-eventhub package were needed.

This run supports the v1 durable-handoff release decision for the tested
configuration and finite fault schedule. It is a coverage-driven deployed test,
not an exhaustive proof over arbitrary schedules or a performance result. It does
not inject eviction/restarts, artificial latency or indefinitely hanging calls.
The local suite additionally checks the reconciliation oracle and verifies that
a recovery timeout exits nonzero, disables injection and retains diagnostics
(13 tests passed). TypeScript, generated Worker types and repository Biome checks
also passed.

The compact [machine-readable result](./v1-chaos.json) preserves configuration,
coverage, timings, duplicates and reconciliation totals. The full reproducible
[methodology and commands](../../validation/chaos/README.md) accompany the harness.
Verbose decision logs, receipt records and expected-job dumps remain in ignored
local storage and are not committed. This report contains the release evidence
without depending on those raw records.

## Cleanup

After saving the evidence, the teardown command successfully removed all 300 R2
objects, detached the Queue consumer, deleted the Workflow and its execution
history, reconciled all three DO classes to `deleted`, and deleted the Worker,
Queue and R2 bucket. Wrangler confirmed each deletion. No dedicated test
resources were retained.
