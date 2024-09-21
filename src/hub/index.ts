import { type Result, ok, safeTry } from "neverthrow";

import type { Executor } from "../executor";
import type {
  CreatedDispatch,
  CreatedEvent,
  Persistence,
} from "../persistence";
import { type QueueMessage, enqueue } from "./queue";
import { type RouteConfig, findRoutes } from "./routing";

const constVoid = (() => {})();

type Config = {
  persistence: Persistence;
  queue: Queue;
  routing: RouteConfig;
  executor: Executor;
};

type EventHub = {
  emit(
    events: Record<string, unknown>[],
  ): Promise<Result<void, "INTERNAL_SERVER_ERROR">>;
  dispatch(msg: Message<QueueMessage>): Promise<void>;
};

/**
 * FIXME:
 * @param config
 * @returns
 */
export const eventHub = (config: Config): EventHub => {
  return {
    emit: emit(config),
    dispatch: dispatch(config),
  };
};

const emit =
  ({ persistence: p, queue, routing }: Config) =>
  async (events: Record<string, unknown>[]) => {
    // Skip empty.
    if (events.length === 0) {
      return ok(constVoid);
    }

    return p.enterTransactionalScope(async (tx) =>
      safeTry(async function* () {
        const createdAt = new Date();

        // Save events.
        const createdEvents = events.map(
          (e): Omit<CreatedEvent, "id"> => ({
            payload: e,
            createdAt,
          }),
        );
        const created = yield* (
          await tx.saveEvents(createdEvents)
        ).safeUnwrap();

        // Find destinations for each event and create dispatches.
        const dispatches = created.flatMap((e) =>
          findRoutes(routing, e).map(
            ({ destination, delaySeconds }): Omit<CreatedDispatch, "id"> => ({
              eventId: e.id, // Event id is created by Persistence.saveEvents.
              destination,
              createdAt,
              delaySeconds,
            }),
          ),
        );

        if (dispatches.length > 0) {
          // Save dispatches.
          const createdDispatches = yield* (
            await p.saveDispatches(dispatches)
          ).safeUnwrap();

          // Dispatch messages.
          const messages = createdDispatches.map(
            (d): MessageSendRequest<QueueMessage> => ({
              body: {
                dispatchId: d.id, // Dispatch id is created by Persistence.saveDispatches.
              },
              contentType: "v8",
              delaySeconds: d.delaySeconds,
            }),
          );
          yield* enqueue(queue, messages).safeUnwrap();
        }
        return ok(constVoid);
      }),
    );
  };

const dispatch =
  (cfg: Config) =>
  async (msg: Message<QueueMessage>): Promise<void> => {
    await cfg.executor
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
  };
