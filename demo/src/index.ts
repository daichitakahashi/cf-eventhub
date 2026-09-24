import {
  env,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createWebConsole } from "@cf-eventhub/web-console";
import {
  configureDelivery,
  EVENT_HUB_REGISTRY_NAME,
  EventHub,
  EventHubRegistry,
  type EventPayload,
  getEventHubFromPayload,
  routeByConfig,
} from "cf-eventhub";
import { createSetupNames, MAX_SETUP_COUNT, parseSetupCount } from "./setup";

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
      {
        destination: "FLAKY_WORKFLOW",
        condition: {
          path: "$.workflow",
          exact: true,
        },
      },
    ],
  });
  deliveryConfig = configureDelivery({
    includeDeliveryMetadata: true,
  });
}

export class FlakyWorkflow extends WorkflowEntrypoint<Env, EventPayload> {
  async run(event: WorkflowEvent<EventPayload>, step: WorkflowStep) {

    await step.sleep("wait", "6 seconds");

    await step.do(
      "process event",
      async () => {
        const n = Math.floor(Math.random() * 10);
        console.log("workflow n", n);
        if (n % 2 !== 0) {
          throw new NonRetryableError("flaky workflow failed");
        }
      },
      {
        rollback: async () => {
          const eventHub = getEventHubFromPayload(
            this.env.EVENT_HUB,
            event.payload,
          );
          if (!eventHub) {
            throw new NonRetryableError("Invalid EventHub metadata");
          }

          const result = await eventHub.reportFailure(event.payload);
          if (!result.ok) throw new Error(result.error.message);
        },
        rollbackConfig: {
          retries: {
            limit: 3,
            delay: "10 seconds",
            backoff: "exponential",
          },
          timeout: "1 minute",
        },
      },
    );
  }
}

const placeholder = `// example payload for this demo
{
  "eventName": "", // this will be used as a title of the event
  "flaky": false, // if true, queue consumer may fail
  "workflow": false // if true, a flaky Workflow instance is created
}`;

export default {
  fetch: async (request, env) => {
    const url = new URL(request.url);
    if (url.pathname === "/setup") {
      const count = parseSetupCount(url.searchParams);
      if (count === null) {
        return Response.json(
          { error: `count must be an integer in 1..${MAX_SETUP_COUNT}` },
          { status: 400 },
        );
      }
      const names = createSetupNames(count);
      const registry = env.EVENT_HUB_REGISTRY.getByName(
        EVENT_HUB_REGISTRY_NAME,
      );
      try {
        for (let offset = 0; offset < names.length; offset += 25) {
          const results = await Promise.all(
            names
              .slice(offset, offset + 25)
              .map((name) => registry.register(name)),
          );
          for (const result of results) {
            if (!result.ok) {
              return Response.json(result.error, { status: 500 });
            }
          }
        }
      } catch {
        return Response.json(
          { error: "EventHub Registry unavailable" },
          { status: 503 },
        );
      }
      return new Response(
        `Registered ${names.length} instance${names.length === 1 ? "" : "s"}. Reload the console.`,
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
          const result = await eventHub.reportFailure(msg.body);
          if (result.ok) {
            msg.ack();
          } else {
            console.error("Failed to report failure", result.error);
            msg.retry();
          }
        }
    }
  },
} satisfies ExportedHandler<Env>;
