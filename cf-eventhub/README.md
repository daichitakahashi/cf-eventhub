# cf-eventhub

cf-eventhub is an event aggregation component built on Cloudflare Durable Objects. It persists JSON events published from Workers and delivers them to Queue or R2 destinations based on routing rules.

Delivery is attempted immediately, and failed jobs are retried via Durable Object Alarms. Once delivery has completed or permanently failed, finalized events can be snapshotted with `eject()`, paged through with `listEjected()`, archived elsewhere, and then removed with `evict()`.

## Table of Contents

- [What It Does](#what-it-does)
- [Public API](#public-api)
- [Delivery Configuration](#delivery-configuration)
- [Automatic Eviction](#automatic-eviction)
- [Routing](#routing)
- [Wrangler Configuration Example](#wrangler-configuration-example)
- [Publishing from a Worker](#publishing-from-a-worker)
- [Failure Reporting with Dead-Letter Queues](#failure-reporting-with-dead-letter-queues)
- [Workflow Example: eject -> R2.put -> evict](#workflow-example-eject---r2put---evict)
- [Starting the Workflow](#starting-the-workflow)
- [eject() and listEjected() Behavior](#eject-and-listejected-behavior)
- [Local Development](#local-development)

## What It Does

- Persist events published from a Worker with `publish()`
- Route events with JSONPath-based conditions
- Retry failed deliveries to Queue or R2 automatically
- Archive finalized events gradually with `eject -> listEjected -> evict`
- Automatically delete or archive finalized events after a retention period

## Public API

The `EventHub` Durable Object exposes the following RPC methods:

- `publish(payload, ...rest)`
- `redrive(deliveryJobId)`
- `reportFailure(payload)`
- `list(options?)`
- `eject(before, options?)`
- `listEjected(ejectKey, options?)`
- `evict(ejectKey)`

`payload` must be a JSON object.

## Delivery Configuration

Configure delivery behavior by overriding the `deliveryConfig` field. Use `configureDelivery()` to create a configuration object:

```ts
import { EventHub, configureDelivery } from "cf-eventhub";

export class MyEventHub extends EventHub<Env> {
  deliveryConfig = configureDelivery({
    includeDeliveryJobId: true, // Include job ID in delivered payloads (default: false)
    initialRetryDelayMs: 5000,  // Initial retry delay (default: 10000)
    maxRetryDelayMs: 300000,    // Maximum retry delay (default: 900000)
    alarmBatchSize: 100,        // Jobs per alarm batch (default: 50)
  });

  routing = /* ... */;
}
```

When `includeDeliveryJobId` is `true`, EventHub injects the delivery job ID into each payload at `__eventhub__.deliveryJobId` before sending it to Queue or R2 destinations. This ID can be used with `reportFailure()` to record downstream processing failures for that delivery job.

## Automatic Eviction

Automatic eviction is disabled unless a subclass explicitly defines `eviction` with `configureEviction()`. Retention is specified in milliseconds. `batchSize` defaults to 50 and accepts values from 1 through 100.

To delete finalized events directly from SQLite in bounded, atomic batches:

```ts
import { EventHub, configureEviction } from "cf-eventhub";

export class MyEventHub extends EventHub<Env> {
  eviction = configureEviction({
    afterMs: 30 * 24 * 60 * 60 * 1000,
    action: { type: "delete" },
    batchSize: 100,
  });

  routing = /* ... */;
}
```

To archive each batch to R2 before deleting it:

```ts
import { env } from "cloudflare:workers";

export class MyArchivedEventHub extends EventHub<Env> {
  eviction = configureEviction({
    afterMs: 30 * 24 * 60 * 60 * 1000,
    action: {
      type: "archive",
      bucket: env.EVENT_ARCHIVE,
      prefix: "production/member-events",
    },
    batchSize: 100,
  });

  routing = /* ... */;
}
```

The archive binding must be an `R2Bucket`, and `prefix` must be non-empty with no leading, trailing, or repeated slash. Objects use deterministic keys:

```text
<prefix>/objects/<durableObjectId>/ejections/<ejectKey>/pages/000000.json
<prefix>/objects/<durableObjectId>/ejections/<ejectKey>/manifest.json
```

Each alarm performs at most one archive `put`: pages contain up to 100 payloads and 256 KiB of serialized payload bodies, and the completion manifest is written by a later alarm. A successful manifest write is the completion marker. EventHub deletes the SQLite snapshot only after that write succeeds. Failed R2 writes preserve the snapshot and cursor and retry with persistent exponential backoff from one minute up to one hour. At-least-once alarm execution may rewrite a page, but its key and body remain deterministic.

Manual `eject()`, `listEjected()`, and `evict()` remain available for custom policies. A manual snapshot takes priority and pauses automatic eviction until it is manually evicted. Disabling eviction or changing its action or archive prefix while an automatic archive is active preserves and pauses that snapshot; restoring the original archive action and prefix resumes it. Changing the bucket behind the same binding while a run is active is unsupported.

Delivery retries and eviction share the Durable Object's single alarm, with delivery processed first and one bounded eviction unit processed afterward. Adding eviction configuration does not wake idle Durable Objects: scheduling begins on that object's next RPC, publish, or existing alarm.

## Routing

Define routing rules by extending `EventHub` and assigning a `RoutingStrategy` to the `routing` field. Use `routeByConfig(env, config)` to create a strategy from a route configuration. The `destination` value must match the binding name of a Queue or R2 bucket. The routing strategy resolves destination bindings from the Worker environment, so mismatched names fail when the strategy validates or resolves that destination.

```ts
import { env } from "cloudflare:workers";
import { EventHub, routeByConfig } from "cf-eventhub";

export class MyEventHub extends EventHub<Env> {
  routing = routeByConfig(env, {
    routes: [
      {
        condition: {
          path: "$.type",
          exact: "member.created",
        },
        destination: "MEMBER_EVENTS",
      },
      {
        condition: {
          path: "$.severity",
          gte: 50,
        },
        destination: "HIGH_SEVERITY_ARCHIVE",
      },
    ],
  });
}
```

Supported operators are `exact`, `match`, `exists`, `lt`, `lte`, `gt`, `gte`, `allOf`, `anyOf`, and `not`.

The `path` field uses JSONPath-like syntax to extract values from event payloads:
- `$.property` - Root-level property
- `$.nested.path` - Nested property
- `$.items[0]` - Array index
- `$.items[*]` - Array wildcard (matches if any element satisfies the condition)
- `$["complex-key"]` - Bracket notation for keys with special characters

> [!NOTE]
> Routing treats `undefined` the same as an absent property. This is intentional: EventHub handles payloads as JSON-serialized data, and `undefined` keys are not present in that model. As a result, `{ path: "$.field", exists: true }` matches `null` but does not match `undefined`.

## Wrangler Configuration Example

This is a minimal `wrangler.jsonc` example. If you change bindings, run `npx wrangler types`.

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "eventhub-app",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-11",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      {
        "name": "EVENT_HUB",
        "class_name": "MyEventHub"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["MyEventHub"]
    }
  ],
  "queues": {
    "producers": [
      {
        "binding": "MEMBER_EVENTS",
        "queue": "member-events"
      }
    ]
  },
  "r2_buckets": [
    {
      "binding": "HIGH_SEVERITY_ARCHIVE",
      "bucket_name": "high-severity-archive"
    },
    {
      "binding": "EVENT_ARCHIVE_EXPORT",
      "bucket_name": "event-archive-export"
    }
  ],
  "workflows": [
    {
      "name": "event-archive-workflow",
      "binding": "EVENT_ARCHIVE_WORKFLOW",
      "class_name": "EventArchiveWorkflow"
    }
  ]
}
```

## Publishing from a Worker

This example accepts HTTP requests and pushes the received event(s) into EventHub. `publish()` supports both a single payload and a batch.

```ts
import type { EventHub, EventPayload } from "cf-eventhub";

type Env = {
  EVENT_HUB: DurableObjectNamespace<EventHub>;
};

const getHub = (env: Env, name = "default") =>
  env.EVENT_HUB.get(env.EVENT_HUB.idFromName(name));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/publish") {
      return new Response("Not found", { status: 404 });
    }

    const body = (await request.json()) as EventPayload | EventPayload[];
    const hub = getHub(env);

    if (Array.isArray(body)) {
      if (body.length === 0) {
        return new Response("payloads must not be empty", { status: 400 });
      }
      const [first, ...rest] = body;
      await hub.publish(first, ...rest);
    } else {
      await hub.publish(body);
    }

    return new Response(null, { status: 202 });
  },
};
```

Notes:

- `publish()` persists first, then starts delivery
- Queue destinations are delivered with `sendBatch()`
- R2 destinations are delivered with `put()`
- Events with no matching route are still persisted as payloads
- `redrive(deliveryJobId)` creates a new independent payload and delivery job from an existing, non-ejected job, then starts delivery immediately. It returns `false` if the source job no longer exists.

## Failure Reporting with Dead-Letter Queues

EventHub supports consumer-reported failures through the `reportFailure()` method. The recommended pattern is to configure a shared dead-letter queue (DLQ) for all EventHub destination queues and have the DLQ consumer call `reportFailure()` to record a separate consumer-reported failure for the failed payload. This does not change `finalStatus` for the original delivery job. `reportFailure()` returns `true` when it actually writes a new failure record, or `false` when the failure was already recorded or the job no longer exists.

### Setup Overview

1. Enable `includeDeliveryJobId` in your EventHub configuration
2. Configure a DLQ for each destination queue
3. Implement a DLQ consumer that calls `reportFailure()` with the failed payload to record the consumer-reported failure

### Wrangler Configuration with DLQ

```jsonc
{
  "queues": {
    "producers": [
      { "binding": "MEMBER_EVENTS", "queue": "member-events" },
      { "binding": "PAYMENT_EVENTS", "queue": "payment-events" }
    ],
    "consumers": [
      {
        "queue": "member-events",
        "max_batch_size": 100,
        "max_retries": 3,
        "dead_letter_queue": "eventhub-dlq"
      },
      {
        "queue": "payment-events",
        "max_batch_size": 100,
        "max_retries": 3,
        "dead_letter_queue": "eventhub-dlq"
      },
      {
        "queue": "eventhub-dlq",
        "max_batch_size": 10,
        "max_retries": 0
      }
    ]
  }
}
```

### EventHub Configuration

```ts
import { env } from "cloudflare:workers";
import { EventHub, configureDelivery, routeByConfig } from "cf-eventhub";

export class MyEventHub extends EventHub<Env> {
  // Enable delivery job ID injection
  deliveryConfig = configureDelivery({
    includeDeliveryJobId: true,
  });

  routing = routeByConfig(env, {
    routes: [
      {
        condition: { path: "$.type", exact: "member.created" },
        destination: "MEMBER_EVENTS",
      },
      {
        condition: { path: "$.type", exact: "payment.completed" },
        destination: "PAYMENT_EVENTS",
      },
    ],
  });
}
```

### DLQ Consumer Implementation

```ts
import type { EventHub } from "cf-eventhub";

type Env = {
  EVENT_HUB: DurableObjectNamespace<EventHub>;
};

const getHub = (env: Env, name = "default") =>
  env.EVENT_HUB.get(env.EVENT_HUB.idFromName(name));

export default {
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    const hub = getHub(env);

    // Report all DLQ messages as failures
    for (const message of batch.messages) {
      try {
        // The payload already contains __eventhub__.deliveryJobId
        await hub.reportFailure(message.body);
        message.ack();
      } catch (error) {
        console.error("Failed to report failure:", error);
        message.retry();
      }
    }
  },
};
```

### How It Works

1. EventHub publishes events to `MEMBER_EVENTS` and `PAYMENT_EVENTS` queues
2. Each payload includes `__eventhub__.deliveryJobId` (e.g., `{ type: "member.created", __eventhub__: { deliveryJobId: "01JG..." } }`)
3. If a consumer fails to process a message after `max_retries`, the message moves to `eventhub-dlq`
4. The DLQ consumer calls `reportFailure()` with the failed payload
5. EventHub records a consumer-reported failure for the extracted job ID, but the job's `finalStatus` remains unchanged.

### Benefits

- **Centralized failure tracking**: All queue failures go through one DLQ
- **Simple consumer logic**: Just call `reportFailure(message.body)`
- **Idempotent**: Multiple calls with the same payload are safe
- **Type-safe**: `reportFailure()` validates the payload structure

### Advanced Usage

While the DLQ pattern is recommended for most use cases, you can also call `reportFailure()` directly from primary queue consumers for custom failure handling, or from R2-triggered workflows if you store payloads in R2 and need to report processing failures.

## Workflow Example: `eject -> R2.put -> evict`

This Workflow archives finalized events periodically. It creates an ejection snapshot with `eject()`, paginates through the snapshot with `listEjected()`, writes each page to R2, and finally removes the snapshot from EventHub with `evict()`.

Cloudflare Workflows should keep side effects inside `step.do()`, so this example executes `eject`, `R2.put`, and `evict` only inside workflow steps.

```ts
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { EventHub } from "cf-eventhub";

type ArchivePayload = {
  hubName?: string;
  before: number;
  max?: number;
};

type Env = {
  EVENT_HUB: DurableObjectNamespace<EventHub>;
  EVENT_ARCHIVE_EXPORT: R2Bucket;
};

const getHub = (env: Env, name = "default") =>
  env.EVENT_HUB.get(env.EVENT_HUB.idFromName(name));

export class EventArchiveWorkflow extends WorkflowEntrypoint<
  Env,
  ArchivePayload
> {
  async run(
    event: WorkflowEvent<ArchivePayload>,
    step: WorkflowStep,
  ): Promise<{ ejectKey: string | null; archivedCount: number }> {
    const hub = getHub(this.env, event.payload.hubName ?? "default");

    const ejection = await step.do("create ejection", async () => {
      return await hub.eject(event.payload.before, {
        max: event.payload.max ?? 100,
      });
    });

    if (!ejection.ejectKey) {
      return {
        ejectKey: null,
        archivedCount: 0,
      };
    }

    const ejectKey = ejection.ejectKey;

    const archivedCount = await step.do("export to r2", async () => {
      let cursor: string | undefined;
      let pageIndex = 0;
      let count = 0;

      while (true) {
        const page = await hub.listEjected(ejectKey, {
          cursor,
          max: 100,
          maxBytes: 262_144,
        });
        if (page.payloads.length === 0) {
          break;
        }

        const objectKey = `eventhub-ejections/${ejectKey}/page-${String(
          pageIndex,
        ).padStart(4, "0")}.json`;
        await this.env.EVENT_ARCHIVE_EXPORT.put(
          objectKey,
          JSON.stringify(page.payloads),
          {
            httpMetadata: {
              contentType: "application/json",
            },
          },
        );

        count += page.payloads.length;
        cursor = page.cursor;
        pageIndex += 1;

        if (!cursor) {
          break;
        }
      }

      return count;
    });

    await step.do("evict ejection", async () => {
      await hub.evict(ejectKey);
    });

    return {
      ejectKey,
      archivedCount,
    };
  }
}
```

## Starting the Workflow

This example starts the archive workflow from another Worker.

```ts
type Env = {
  EVENT_ARCHIVE_WORKFLOW: Workflow;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/archive") {
      return new Response("Not found", { status: 404 });
    }

    const instance = await env.EVENT_ARCHIVE_WORKFLOW.create({
      id: `archive-${Date.now()}`,
      payload: {
        hubName: "default",
        before: Date.now() - 60_000,
        max: 100,
      },
    });

    return Response.json({
      id: instance.id,
    });
  },
};
```

## `eject()` and `listEjected()` Behavior

- `eject(before)` moves finalized payloads older than `before` into one snapshot
- If an active snapshot already exists, `eject()` returns the existing `ejectKey`
- `listEjected()` supports pagination with `cursor`, `max`, and `maxBytes`
- `evict(ejectKey)` is idempotent

## Local Development

```sh
npx wrangler dev
npx wrangler types
npm test
```
