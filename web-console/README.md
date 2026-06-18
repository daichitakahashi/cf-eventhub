# @cf-eventhub/web-console

@cf-eventhub/web-console is a web UI for inspecting EventHub payloads and delivery jobs.
It lets operators view recent events, inspect delivery status and errors, create events, and redrive failed delivery jobs.

## Basic Usage

Install the console package alongside your EventHub Worker application.

```sh
npm install @cf-eventhub/web-console cf-eventhub
```

Create a Worker entrypoint that mounts the console handler.

```ts
import { createWebConsole } from "@cf-eventhub/web-console";

export default createWebConsole({
  eventHub: {
    binding: "EVENT_HUB",
    instance: "default",
  },
  environment: "production",
});
```

By default, the console targets the Durable Object named `default` through the
`EVENT_HUB` binding. Use `eventHub.instance` when you operate multiple EventHub
instances.

The console periodically checks for newer events or delivery-job updates. If the
current page is stale, it shows a reload prompt. Pages with ongoing deliveries
reload automatically on the refresh interval.

## Wrangler Configuration

Bind the console Worker to the EventHub Durable Object class. If the console is
deployed as a separate Worker, set `script_name` to the Worker that owns the
EventHub Durable Object class.

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "eventhub-console",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-11",
  "durable_objects": {
    "bindings": [
      {
        "name": "EVENT_HUB",
        "class_name": "MyEventHub",
        // If the console and EventHub Durable Object are deployed from the same Worker, omit `script_name`.
        "script_name": "eventhub-app"
      }
    ]
  }
}
```

Run locally and deploy with Wrangler:

```sh
npm run dev
npm run deploy
```

## Configuration Options

`createWebConsole()` accepts the following commonly used options:

- `eventHub.binding`: Durable Object binding name. Defaults to `EVENT_HUB`.
- `eventHub.instance`: Durable Object name. Defaults to `default`.
- `environment`: Label shown in the page title and header.
- `pageSize`: Number of events shown per page. Defaults to `5`.
- `refreshIntervalSeconds`: Polling interval for update detection. Defaults to
  `5`.
- `dateFormatter`: `Intl.DateTimeFormat` used for timestamps.
- `eventTitle`: Function for rendering a custom event title.
- `createEventPlaceholder`: Placeholder text for the create-event form.

## Protecting with Cloudflare Access

The console is an operational interface. It can display event payloads, expose
delivery errors, create test events, and redrive delivery jobs. Do not expose it
as an unauthenticated public endpoint.

The recommended deployment pattern is to protect the console hostname or path
with Cloudflare Access:

1. Deploy the console on a dedicated hostname such as
   `eventhub-console.example.com`, or under a dedicated path such as
   `/eventhub-console`.
2. Create a Cloudflare Access application for that hostname or path.
3. Add policies that allow only the operators, groups, or service identities
   that need EventHub access.
4. Keep the EventHub publishing endpoints separate from the console route so
   Access policies for operators do not affect producer traffic.

For production, prefer a dedicated console hostname protected by Access. This
keeps the operational UI isolated from application routes and makes the access
policy easier to audit.
