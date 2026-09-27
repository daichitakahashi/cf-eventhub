---
"cf-eventhub": minor
---

Freeze the v1 public API: rename `Config` to `RoutingConfig`, reuse
`ListResult` for live and ejected listings, stop exporting the internal
Registry staleness interval, and make the fully populated delivery
configuration shape explicit.
