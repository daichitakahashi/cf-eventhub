import { env } from "cloudflare:workers";
import { createWebConsole } from "@cf-eventhub/web-console";
import {
  EventHub,
  EventHubRegistry,
  configureDelivery,
  getEventHubFromPayload,
  routeByConfig,
} from "cf-eventhub";

export { EventHubRegistry };

export class DevEventHub extends EventHub<Env> {
  registry = env.EVENT_HUB_REGISTRY;
  routing = routeByConfig(env, {
    routes: [
      {
        destination: "STABLE_QUEUE",
        condition: {
          path: "$.flaky",
          exact: false,
        },
      },
      {
        destination: "FLAKY_QUEUE",
        condition: {
          path: "$.flaky",
          exact: true,
        },
      },
      {
        destination: "SINK_BUCKET",
        condition: {
          allOf: [],
        },
      },
    ],
  });
  deliveryConfig = configureDelivery({
    includeDeliveryMetadata: true,
  });
}

const eventHubName = "default";
const exampleEventHubNames = [eventHubName, "tenant:acme", "orders"] as const;
const placeholder = `// example payload for this demo
{
  "eventName": "", // this will be used as a title of the event
  "flaky": false // if true, queue consumer may fail
}`;

export default {
  fetch: async (request, env) => {
    if (new URL(request.url).pathname === "/setup") {
      await Promise.all(
        exampleEventHubNames.map((name) =>
          env.EVENT_HUB.getByName(name).list(),
        ),
      );
      return new Response(
        "Initialized default, tenant:acme, and orders. Reload the console after Registry synchronization completes.",
      );
    }

    const handler = createWebConsole({
      pageSize: 10,
      refreshIntervalSeconds: 10,
      dateFormatter: new Intl.DateTimeFormat("ja", {
        dateStyle: "short",
        timeStyle: "long",
      }),
      eventTitle: (e) =>
        e.payload.eventName ? String(e.payload.eventName) : e.id,
      eventHub: {
        binding: "EVENT_HUB",
      },
      registry: { binding: "EVENT_HUB_REGISTRY" },
      createEventPlaceholder: placeholder,
    });
    return handler.fetch(request, env);
  },

  queue: async (batch, env) => {
    switch (batch.queue) {
      case "stable-queue":
        batch.ackAll();
        break;
      case "flaky-queue":
        for (const msg of batch.messages) {
          const n = Math.floor(Math.random() * 10);
          console.log("n", n);
          if (n % 2 === 0) {
            msg.ack();
          } else {
            console.log("flaky consumer failed");
            msg.retry();
          }
        }
        break;
      case "dlq":
        console.log("reportFailure");
        for (const msg of batch.messages) {
          const eventHub = getEventHubFromPayload(env.EVENT_HUB, msg.body);
          if (!eventHub) {
            console.error("Invalid EventHub metadata", msg.id);
            msg.retry();
            continue;
          }
          await eventHub.reportFailure(msg.body);
          msg.ack();
        }
    }
  },
} satisfies ExportedHandler<Env>;
