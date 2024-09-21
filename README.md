# cf-eventhub

Developing message hub that works with Cloudflare Workers and Queues with following functionalities.

- Configure destinations of each message in IaC(currently, we will support Pulumi)
- Record execution info including lost job(**Cloudflare Queues is Beta**)

## Designs
### Sequence

```mermaid
sequenceDiagram
  participant Worker1 as Worker(producer)
  participant eventhub as eventhub
  participant DB
  participant Queue as Queue
  participant executor as executor
  participant Worker2 as Worker(consumer)

  autonumber
  Worker1 ->> eventhub: emit() [RPC]
  activate eventhub
  eventhub ->> eventhub: routing
  eventhub ->> DB: begin
  activate DB
  eventhub ->> DB: save event payload
  opt if routes matched
    eventhub ->> DB: create dispatches of the event<br>for matched routes
    eventhub ->> Queue: enqueue dispatches
  end
  eventhub ->> DB: commit
  deactivate DB
  eventhub -->> Worker1: return Promise<void>
  deactivate eventhub

  Queue ->> Queue: wait delaySeconds

  par execute each dispatch
    Queue ->> eventhub: dequeue dispatch
    activate eventhub
    eventhub ->> executor: dispatch() [RPC]
    activate executor
    executor ->> DB: begin
    activate DB
    executor ->> DB: load payload<br>(UPDATE RETURNING)
    opt dispatch is not completed
      executor ->> Worker2: handle() [RPC]
      activate Worker2
      Worker2 ->> Worker2: event handling
      Worker2 -->> executor: return<br>Promise<"complete" | "ignored">
      deactivate Worker2
      executor ->> DB: update dispatch as completed/ignored/failed
    end
    executor ->> DB: commit

    executor -->> eventhub: return Promise<"complete" | "ignored" | "failed" | "misconfigured">
    deactivate executor
    eventhub ->> Queue: ack() or retry()
    deactivate eventhub
  end
```

### Tables(Postgres)
```mermaid
erDiagram
    events {
        uuid id PK "Event ID"
        jsonb payload "Payload of the event"
        timestamp created_at "Create time of the event"
    }

    ongoing_dispatches {
        uuid id PK "Dispatch ID"
        uuid event_id FK "Event ID"
        text destination "Dispatch destination"
        timestamp created_at "Create time"
        integer execution_count "Current execution count"
        integer max_retry_count "Max retry count"
    }
    events ||--o{ ongoing_dispatches: "for each matched destination"

    resulted_dispatches {
        uuid id PK "Dispatch ID"
        uuid event_id FK "Event ID"
        text destination "Dispatch destination"
        timestamp created_at "Create time"
        text result "Result of the dispatch('succeeded' | 'ignored' | 'failed' | 'lost')"
        timestamp resulted_at "Resulted time"
        integer execution_count "Execution count"
        integer max_retry_count "Max retry count"
    }
    events ||--o{ resulted_dispatches: "for each resulted dispatch"
```
