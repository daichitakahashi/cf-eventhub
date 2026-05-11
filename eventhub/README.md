# EventHub

EventHub is an event aggregation component built on Cloudflare Durable Objects. It persists JSON events published from Workers and delivers them to Queue or R2 destinations based on routing rules.

Delivery is attempted immediately, and failed jobs are retried via Durable Object Alarms. Once delivery has completed or permanently failed, finalized events can be snapshotted with `eject()`, paged through with `listEjected()`, archived elsewhere, and then removed with `evict()`.

## What It Does

- Persist events published from a Worker with `publish()`
- Route events with JSONPath-based conditions
- Retry failed deliveries to Queue or R2 automatically
- Archive finalized events gradually with `eject -> listEjected -> evict`

## Public API

The `EventHub` Durable Object exposes the following RPC methods:

- `publish(payload, ...rest)`
- `eject(before, options?)`
- `listEjected(ejectKey, options?)`
- `evict(ejectKey)`

`payload` must be a JSON object.

## Routing

Pass routing rules through `EVENTHUB_ROUTING`. The `destination` value must match the binding name of a Queue or R2 bucket. The implementation resolves `env[destination]` directly, so mismatched names will fail at delivery time.

```json
{
  "routes": [
    {
      "condition": {
        "path": "$.type",
        "exact": "member.created"
      },
      "destination": "MEMBER_EVENTS"
    },
    {
      "condition": {
        "path": "$.severity",
        "gte": 50
      },
      "destination": "HIGH_SEVERITY_ARCHIVE"
    }
  ]
}
```

Supported operators are `exact`, `match`, `exists`, `lt`, `lte`, `gt`, `gte`, `allOf`, `anyOf`, and `not`.

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
        "class_name": "EventHub"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["EventHub"]
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
  ],
  "vars": {
    "EVENTHUB_ROUTING": {
      "routes": [
        {
          "condition": {
            "path": "$.type",
            "exact": "member.created"
          },
          "destination": "MEMBER_EVENTS"
        },
        {
          "condition": {
            "path": "$.severity",
            "gte": 50
          },
          "destination": "HIGH_SEVERITY_ARCHIVE"
        }
      ]
    }
  }
}
```

## Publishing from a Worker

This example accepts HTTP requests and pushes the received event(s) into EventHub. `publish()` supports both a single payload and a batch.

```ts
import { EventHub, type EventPayload } from "eventhub";

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

## Workflow Example: `eject -> R2.put -> evict`

This Workflow archives finalized events periodically. It creates an ejection snapshot with `eject()`, paginates through the snapshot with `listEjected()`, writes each page to R2, and finally removes the snapshot from EventHub with `evict()`.

Cloudflare Workflows should keep side effects inside `step.do()`, so this example executes `eject`, `R2.put`, and `evict` only inside workflow steps.

```ts
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { EventHub } from "eventhub";

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
