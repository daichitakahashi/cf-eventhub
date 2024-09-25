import { type Result, ok, safeTry } from "neverthrow";

import type { NewDispatch, NewEvent } from "../core/model";
import type { Repository } from "../core/repository";
import type { Executor } from "../executor";
import type { EventPayload } from "../type";
import { type QueueMessage, enqueue } from "./queue";
import { type RouteConfig, findRoutes } from "./routing";

const constVoid = (() => {})();

type Config = {
  repository: Repository;
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
  ({ repository: repo, queue, routing }: Config) =>
  async (events: EventPayload[]) => {
    // Skip empty.
    if (events.length === 0) {
      return ok(constVoid);
    }

    return repo.enterTransactionalScope(async (tx) =>
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
            ({ destination, delaySeconds }): Omit<NewDispatch, "id"> => ({
              eventId: e.id, // Event id is created by Persistence.saveEvents.
              destination,
              createdAt,
              delaySeconds,
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
