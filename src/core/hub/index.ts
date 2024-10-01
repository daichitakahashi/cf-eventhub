import { ok, safeTry } from "neverthrow";
import * as v from "valibot";

import type { Executor } from "../executor";
import type { NewDispatch, NewEvent } from "../model";
import type { Repository } from "../repository";
import type { EventPayload } from "../type";
import { type QueueMessage, enqueue } from "./queue";
import { Config, findRoutes } from "./routing";

const constVoid = (() => {})();

export interface EventHub {
  putEvent(events: EventPayload[]): Promise<void>;
}

export class EventSink {
  constructor(
    private repo: Repository,
    private queue: Queue,
    private routeConfig: Config,
  ) {}

  async putEvent(events: EventPayload[]): Promise<void> {
    // Skip empty.
    if (events.length === 0) {
      return;
    }
    const routing = this.routeConfig;
    const queue = this.queue;
    const repo = this.repo;

    const result = await repo.enterTransactionalScope(async (tx) =>
      safeTry(async function* () {
        const createdAt = new Date();

        // Create events.
        const newEvents = events.map(
          (e): Omit<NewEvent, "id"> => ({
            payload: e,
            createdAt,
          }),
        );
        const created = yield* (await tx.createEvents(newEvents)).safeUnwrap();

        // Find destinations for each event and create dispatches.
        const dispatches = created.flatMap((e) =>
          findRoutes(routing, e).map(
            ({ destination, delaySeconds }): NewDispatch => ({
              eventId: e.id, // Event id is created by Persistence.saveEvents.
              destination,
              createdAt,
              delaySeconds: delaySeconds || null,
              maxRetryCount: 5, // TODO: should be configurable
            }),
          ),
        );

        if (dispatches.length > 0) {
          // Create dispatches.
          const createdDispatches = yield* (
            await tx.createDispatches(dispatches)
          ).safeUnwrap();

          // Dispatch messages.
          const messages = createdDispatches.map(
            (d): MessageSendRequest<QueueMessage> => ({
              body: {
                dispatchId: d.id, // Dispatch id is created by Persistence.saveDispatches.
              },
              contentType: "v8",
              delaySeconds: d.delaySeconds || undefined,
            }),
          );
          yield* enqueue(queue, messages).safeUnwrap();
        }
        return ok(constVoid);
      }),
    );

    if (result.isErr()) {
      return Promise.reject(result.error);
    }
  }
}

export const getQueue = (env: Record<string, unknown>) => {
  const queue = env.EVENTHUB_QUEUE;
  if (!queue) {
    throw new Error("cf-eventhub: EVENTHUB_QUEUE not set");
  }
  if (typeof queue !== "object" || "send" in queue) {
    throw new Error("cf-eventhub: value of EVENTHUB_QUEUE is not a Queue");
  }
  return queue as Queue;
};

export const getRouteConfig = (env: Record<string, unknown>) => {
  const routing = env.EVENTHUB_ROUTING;
  if (!routing) {
    throw new Error("cf-eventhub: EVENTHUB_ROUTING not set");
  }
  if (typeof routing !== "string") {
    throw new Error("cf-eventhub: value of EVENTHUB_Routing is not a string");
  }

  return v.parse(Config, JSON.parse(routing));
};

export const getExecutor = (env: Record<string, unknown>) => {
  const executor = env.EVENTHUB_EXECUTOR;
  if (!executor) {
    throw new Error("cf-eventhub: EVENTHUB_EXECUTOR not set");
  }
  if (typeof executor !== "object" || "dispatch" in executor) {
    throw new Error(
      "cf-eventhub: value of EVENTHUB_EXECUTOR is not a Executor",
    );
  }
  return executor as Executor;
};

export class EventConsumer {
  constructor(private executor: Executor) {}

  private async dispatch(msg: Message<QueueMessage>) {
    await this.executor
      .dispatch(msg.body)
      .then((result) => {
        switch (result) {
          case "complete":
          case "ignored":
          case "misconfigured":
          case "notfound":
            msg.ack();
            break;
          case "failed":
            msg.retry();
            break;
          default: {
            const _: never = result;
          }
        }
      })
      .catch(() => {
        msg.retry();
      });
  }

  async queue(batch: MessageBatch<QueueMessage>) {
    for (const msg of batch.messages) {
      await this.dispatch(msg);
    }
  }
}
