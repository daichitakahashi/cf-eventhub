---
"cf-eventhub": patch
---

Prevent overlapping delivery attempts by atomically leasing persisted jobs
before immediate or alarm-driven Queue and R2 delivery.
Keep running attempts exclusive beyond lease expiry while allowing interrupted
attempts to recover after an instance restart. Handle full Queue batches without
exceeding the SQL parameter limit when recording delivery results.
