# cf-eventhub

## 1.0.0-rc.1

### Minor Changes

- 7315686: Add idempotent Cloudflare Workflow destinations with delivery-job IDs as
  Workflow instance IDs and document the durable handoff requirement.

### Patch Changes

- 4e6c038: Make validated delivery and eviction configuration snapshots immutable.
- 43b73b3: Disable manual eviction APIs when automatic eviction is configured and teach
  the web console about the new error code.

## 1.0.0-rc.0

### Major Changes

- Prepare the first v1 release candidate.

### Minor Changes

- 7bd6ef6: Add EventHub Registry discovery, best-effort named-instance self-registration,
  Registry-backed instance selection throughout the Web Console, and name-aware
  originating instance resolution from delivered payload metadata.
- 12720c4: Add optional alarm-driven automatic eviction with bounded delete and retry-safe R2 archive actions.
- 926d629: Return application-level EventHub and Registry RPC failures as typed `Result`
  values, reserve Promise rejection for RPC infrastructure failures, and update
  the Web Console and examples to consume the new contract. Remove the custom
  `eventHubError` helper; synchronous configuration failures now use standard
  `Error` values.
- 125f145: Expose payload IDs and creation times from live and ejected event listings, and
  use them in the Web Console for stable rendering and no-route event polling.
- 5c2d8bf: Add direct EventHub Registry lookup and use it to validate instance-specific
  Web Console API requests without enumerating Registry pages.
- d6935a5: Expose stable error codes for intentional RPC failures and add structured logs for internally handled failures.
- 0160163: Rename the delivery status field to `failedAttemptCount` and display accurate attempt counts for ongoing, completed, and permanently failed jobs.

### Patch Changes

- f2076cd: Validate and precompile configured routing paths when `routeByConfig()` creates a routing strategy.
- 04ed0d3: Prevent overlapping delivery attempts by atomically leasing persisted jobs
  before immediate or alarm-driven Queue and R2 delivery.
  Keep running attempts exclusive beyond lease expiry while allowing interrupted
  attempts to recover after an instance restart. Handle full Queue batches without
  exceeding the SQL parameter limit when recording delivery results.
- cff33f1: Keep observational EventHub reads from refreshing Registry liveness or reviving
  tombstoned instances, and document the operations that count as activity.
- 69e0138: Track SQLite schema versions for EventHub and Registry Durable Objects, with each internal migration in its own source file and applied transactionally.
- e7c9b5e: Split Queue delivery batches by serialized byte size and reject oversized Queue payloads during publish.

## Unreleased

### Minor Changes

- Add literal name-fragment search to paginated `EventHubRegistry.list()` results.
- Add optional automatic eviction using Durable Object Alarms, with bounded direct deletion or retry-safe R2 archival through `configureEviction()`.
- Add the SQLite-backed `EventHubRegistry` API and best-effort self-registration for named EventHub instances.
- Add delivery instance metadata and `getEventHubFromPayload()` for resolving the originating EventHub from shared destination payloads.
- Add configurable, destination-aware object keys for direct R2 delivery through `routeByConfig()` and `routeFunc()`.

### Patch Changes

- Reject stateful global or sticky regular expressions in `routeByConfig()` match conditions.

## 0.3.5

### Patch Changes

- c7783c2: updpate lockfile

## 0.3.4

### Patch Changes

- bab8298: fix(cf-eventhub): fix invalid executedAt
- 42c1b70: chore(web-console): remove @cloudflare/workers-types from dependencies

## 0.3.3

### Patch Changes

- 2c37a12: Update dependencies

## 0.3.2

### Patch Changes

- 755b618: feat: improve web-console experience
- 1b3fb41: feat(cf-eventhub): add `getDispatch` to EventHub

## 0.3.1

### Patch Changes

- 87a0b82: feat(cf-eventhub): executor put payload to R2 bucket when the destination is a R2Bucket instance

## 0.3.0

### Minor Changes

- b0b6810: fix last migration and add migration test

## 0.2.1

### Patch Changes

- eb8d31f: print exception detail
- 153f6ff: EventHub as a Handler

## 0.2.0

### Minor Changes

- 54f2bed: feat(cf-eventhub): introduce retry delay strategy

### Patch Changes

- c3867ae: chore: update wrangler and other dependencies

## 0.1.0

### Minor Changes

- 538b396: feat(cf-eventhub): fix deadlock issue

## 0.0.20

### Patch Changes

- d04e7e2: fix(cf-eventhub): catch and report error during transaction

## 0.0.19

### Patch Changes

- 3c0fcb6: feat(cf-eventhub): support Hyperdrive for postgres

## 0.0.18

### Patch Changes

- 1894474: Improve JSON typing

## 0.0.17

### Patch Changes

- 4a28d78: bump

## 0.0.16

### Patch Changes

- 9d3a2a5: Fix event status

## 0.0.15

### Patch Changes

- e088cd6: New feature: list events

## 0.0.14

### Patch Changes

- fb0d41a: Fix PgRepository.listDispatches to list lost dispatches

## 0.0.13

### Patch Changes

- be464f4: Add debug log for markLostDispatches

## 0.0.12

### Patch Changes

- 368754c: Fix PgRepository.listDispatches

## 0.0.11

### Patch Changes

- Fix PgRepository.listDispatches

## 0.0.10

### Patch Changes

- 527e94d: Fix PgRepository.listDispatches

## 0.0.9

### Patch Changes

- 2a8ca9c: Fix log level

## 0.0.8

### Patch Changes

- 47a871d: add debug log for PgRepository

## 0.0.7

### Patch Changes

- 9a96d47: Add indices and change index style

## 0.0.6

### Patch Changes

- fix build

## 0.0.5

### Patch Changes

- bump dependencies

## 0.0.4

### Patch Changes

- 9a22301: New separated "@cf-eventhub/pulumi" package

## 0.0.3

### Patch Changes

- Refixwq

## 0.0.2

### Patch Changes

- 7eee82d: Fix publish

## 0.0.1

### Patch Changes

- fde5252: First publish
