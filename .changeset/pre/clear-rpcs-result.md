---
"cf-eventhub": minor
"@cf-eventhub/web-console": patch
---

Return application-level EventHub and Registry RPC failures as typed `Result`
values, reserve Promise rejection for RPC infrastructure failures, and update
the Web Console and examples to consume the new contract. Remove the custom
`eventHubError` helper; synchronous configuration failures now use standard
`Error` values.
