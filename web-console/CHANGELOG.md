# @cf-eventhub/web-console

## 1.0.0-rc.0

### Major Changes

- Prepare the Web Console v1 release candidate.

### Minor Changes

- 7bd6ef6: Add EventHub Registry discovery, best-effort named-instance self-registration,
  Registry-backed instance selection throughout the Web Console, and name-aware
  originating instance resolution from delivered payload metadata.

### Patch Changes

- 926d629: Return application-level EventHub and Registry RPC failures as typed `Result`
  values, reserve Promise rejection for RPC infrastructure failures, and update
  the Web Console and examples to consume the new contract. Remove the custom
  `eventHubError` helper; synchronous configuration failures now use standard
  `Error` values.
- 125f145: Expose payload IDs and creation times from live and ejected event listings, and
  use them in the Web Console for stable rendering and no-route event polling.
- 5c2d8bf: Add direct EventHub Registry lookup and use it to validate instance-specific
  Web Console API requests without enumerating Registry pages.
- 9534ff6: Display EventHub RPC errors when publishing events or redriving delivery jobs.
- 0160163: Rename the delivery status field to `failedAttemptCount` and display accurate attempt counts for ongoing, completed, and permanently failed jobs.
- cff33f1: Keep observational EventHub reads from refreshing Registry liveness or reviving
  tombstoned instances, and document the operations that count as activity.
- Updated dependencies [7bd6ef6]
- Updated dependencies [12720c4]
- Updated dependencies [926d629]
- Updated dependencies [f2076cd]
- Updated dependencies [125f145]
- Updated dependencies [5c2d8bf]
- Updated dependencies [04ed0d3]
- Updated dependencies [d6935a5]
- Updated dependencies [0160163]
- Updated dependencies [cff33f1]
- Updated dependencies [69e0138]
- Updated dependencies
- Updated dependencies [e7c9b5e]
  - cf-eventhub@1.0.0-rc.0

## Unreleased

### Minor Changes

- Replace the instance select with a searchable, paginated picker modal.
- Replace the static EventHub instance setting with Registry-based active and stale instance discovery, selection, and URL state propagation.
- Allow a selected stale EventHub instance to be deleted from the Registry.

## 0.0.17

### Patch Changes

- c7783c2: updpate lockfile

## 0.0.16

### Patch Changes

- 42c1b70: chore(web-console): remove @cloudflare/workers-types from dependencies

## 0.0.15

### Patch Changes

- 2c37a12: Update dependencies

## 0.0.14

### Patch Changes

- 3104362: fix(web-console): fix some mistakes

## 0.0.13

### Patch Changes

- c3ad623: feat(web-console): add copy payload button
- 755b618: feat: improve web-console experience

## 0.0.12

### Patch Changes

- e04f6f3: feat(web-console): show retry strategy
- c3867ae: chore: update wrangler and other dependencies

## 0.0.11

### Patch Changes

- 657d58f: feat(web-console): add options(color customization and environment display)

## 0.0.10

### Patch Changes

- a239039: fix(web-console): remove ISO date string after Destination

## 0.0.9

### Patch Changes

- 261c207: Use shared modal for dispatch details

## 0.0.8

### Patch Changes

- b1de929: Fix event status

## 0.0.7

### Patch Changes

- 1bce12c: Brand-new web console

## 0.0.6

### Patch Changes

- 98cc4f3: Change binding name

## 0.0.5

### Patch Changes

- bonsai

## 0.0.4

### Patch Changes

- 70a9c8f: fix exports

## 0.0.3

### Patch Changes

- Refixwq

## 0.0.2

### Patch Changes

- 7eee82d: Fix publish
- Updated dependencies [7eee82d]
  - cf-eventhub@0.0.2

## 0.0.1

### Patch Changes

- fde5252: First publish
