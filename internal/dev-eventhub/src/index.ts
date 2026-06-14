import { env } from "cloudflare:workers";
import { EventHub, routeByConfig, configureDelivery } from "eventhub";
import { createWebConsole } from "@cf-eventhub/web-console";

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

export default {
  fetch: async (request, env) => {
    const handler = createWebConsole({
      pageSize: 10,
      refreshIntervalSeconds: 10,
      eventTitle: (e) => e.payload.eventName || e.id,
      hubName: eventHubName,
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
