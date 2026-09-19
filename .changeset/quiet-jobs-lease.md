---
"cf-eventhub": patch
---

Prevent overlapping delivery attempts by atomically leasing persisted jobs
before immediate or alarm-driven Queue and R2 delivery.
