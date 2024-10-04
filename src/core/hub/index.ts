import { ok, safeTry } from "neverthrow";

import type { NewDispatch, NewEvent } from "../model";
import type { Repository } from "../repository";
import type { EventPayload } from "../type";
import { type QueueMessage, enqueue } from "./queue";
import { type Config, findRoutes } from "./routing";

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
              maxRetries: 5, // TODO: should be configurable
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
