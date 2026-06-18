import { env } from "cloudflare:workers";
import { createWebConsole } from "@cf-eventhub/web-console";
import { EventHub, configureDelivery, routeByConfig } from "cf-eventhub";

export class DevEventHub extends EventHub<Env> {
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
    includeDeliveryJobId: true,
  });
}

const eventHubName = "hub";
const placeholder = `// example payload for this demo
{
  "eventName": "", // this will be used as a title of the event
  "flaky": false // if true, queue consumer may fail
}`;

export default {
  fetch: async (request, env) => {
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
        instance: eventHubName,
      },
      createEventPlaceholder: placeholder,
    });
    return handler.fetch(request, env);
  },

  queue: async (batch, env) => {
    const eventHub = env.EVENT_HUB.getByName(eventHubName);

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
          await eventHub.reportFailure(msg.body);
          msg.ack();
        }
    }
  },
} satisfies ExportedHandler<Env>;
