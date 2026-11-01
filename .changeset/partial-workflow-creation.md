---
"cf-eventhub": patch
---

Migrate Workflow delivery to the object-form createBatch API and handle partial
failures per job. Preserve stable IDs for ambiguous retries, treat existing
instances as completed handoffs, and reject duplicate or missing results.
Workflow destinations now require Wrangler 4.148.0+ types and a compatible runtime.
