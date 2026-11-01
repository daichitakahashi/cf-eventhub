---
"cf-eventhub": patch
---

Avoid scanning retained finalized delivery jobs when loading a claimed batch.
Build live payload pages from at most 100 candidate rows before applying the
body byte budget, avoiding recursive rescans as retained state grows.
