import { type Result, ok, safeTry } from "neverthrow";

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
};

type EventHub = {
  emit(
    events: Record<string, unknown>[],
  ): Promise<Result<void, "INTERNAL_SERVER_ERROR">>;
};

/**
 * FIXME:
 * @param config
 * @returns
 */
export const eventHub = (config: Config): EventHub => {
  return {
    emit: emit(config),
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
                eventId: d.eventId,
                dispatchId: d.id, // Dispatch id is created by Persistence.saveDispatches.
                createdAt: d.createdAt,
              },
              delaySeconds: d.delaySeconds,
            }),
          );
          yield* enqueue(queue, messages).safeUnwrap();
        }
        return ok(constVoid);
      }),
    );
  };
