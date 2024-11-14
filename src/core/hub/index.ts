import { err, ok, safeTry } from "neverthrow";

import type { Logger } from "../logger";
import {
  type Dispatch,
  type Event,
  type NewDispatch,
  type NewEvent,
  type OngoingDispatch,
  type ResultedDispatch,
  makeDispatchLost,
} from "../model";
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
    private logger: Logger,
  ) {}

  async putEvent(events: EventPayload[]): Promise<void> {
    // Skip empty.
    if (events.length === 0) {
      return;
    }
    const routing = this.routeConfig;
    const queue = this.queue;
    const repo = this.repo;
    const logger = this.logger;

    const result = await repo.enterTransactionalScope(async (tx) =>
      safeTry(async function* () {
        const createdAt = new Date();

        logger.debug(`put ${events.length} events`);

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
          findRoutes(routing, e.payload).map(
            ({ destination, delaySeconds, maxRetries }): NewDispatch => ({
              eventId: e.id, // Event id is created by Persistence.saveEvents.
              destination,
              createdAt,
              delaySeconds: delaySeconds || routing.defaultDelaySeconds || null,
              maxRetries: maxRetries || routing.defaultMaxRetries || 5,
            }),
          ),
        );

        if (dispatches.length > 0) {
          logger.debug(`create ${dispatches.length} dispatches`);

          // Create dispatches.
          const createdDispatches = yield* (
            await tx.createDispatches(dispatches)
          ).safeUnwrap();

          // Dispatch messages.
          const messages = createdDispatches.map(
            (d): MessageSendRequest<QueueMessage> => ({
              body: {
                dispatchId: d.id, // Dispatch id is created by Persistence.saveDispatches.
                delaySeconds: d.delaySeconds || undefined,
              },
              contentType: "v8",
              delaySeconds: d.delaySeconds || undefined,
            }),
          );
          yield* enqueue(queue, messages, logger).safeUnwrap();
        } else {
          logger.debug("no dispatches created");
        }
        return ok(constVoid);
      }),
    );

    if (result.isErr()) {
      return Promise.reject(result.error);
    }
  }

  async listDispatches(args?: {
    maxItems?: number;
    continuationToken?: string;
    filterByStatus?: Dispatch["status"][];
    orderBy?: "CREATED_AT_ASC" | "CREATED_AT_DESC";
  }): Promise<{ list: Dispatch[]; continuationToken?: string }> {
    const result = await this.repo.listDispatches(
      args?.maxItems || 10,
      args?.continuationToken,
      args?.filterByStatus,
      args?.orderBy,
    );
    if (result.isErr()) {
      return Promise.reject(result.error);
    }
    return result.value;
  }

  async getEvent(eventId: string): Promise<Event> {
    const result = await this.repo.getEvent(eventId);
    if (result.isErr()) {
      return Promise.reject(result.error);
    }
    if (result.value === null) {
      return Promise.reject("event not found");
    }
    return result.value;
  }

  async retryDispatch(args: {
    dispatchId: string;
    options?: { maxRetries?: number; delaySeconds?: number };
  }): Promise<void> {
    const queue = this.queue;
    const repo = this.repo;
    const logger = this.logger;

    const result = await safeTry(async function* () {
      const { dispatchId, options } = args;

      // Get target dispatch.
      const data = yield* (await repo.getDispatch(dispatchId)).safeUnwrap();
      if (data === null) {
        return Promise.reject("dispatch not found");
      }
      const { dispatch } = data;
      if (dispatch.status === "ongoing") {
        return err("DISPATCH_IS_ONGOING" as const);
      }

      // Create new dispatch for retry.
      // Override options if provided.
      const newDispatch: NewDispatch = {
        eventId: dispatch.eventId,
        destination: dispatch.destination,
        createdAt: new Date(),
        delaySeconds: options?.delaySeconds || dispatch.delaySeconds,
        maxRetries: options?.maxRetries || dispatch.maxRetries,
      };
      const [created] = yield* (
        await repo.createDispatches([newDispatch])
      ).safeUnwrap();

      const message: MessageSendRequest<QueueMessage> = {
        body: {
          dispatchId: created.id,
          delaySeconds: created.delaySeconds || undefined,
        },
        contentType: "v8",
        delaySeconds: created.delaySeconds || undefined,
      };

      yield* (await enqueue(queue, [message], logger)).safeUnwrap();
      return ok(constVoid);
    });

    if (result.isErr()) {
      return Promise.reject(result.error);
    }
  }

  async markLostDispatches(args?: {
    maxItems?: number;
    elapsedSeconds?: number;
    continuationToken?: string;
  }): Promise<{ list: ResultedDispatch[]; continuationToken?: string }> {
    const repo = this.repo;
    const elapsedSeconds = args?.elapsedSeconds || 60 * 15; // Default value (15 min) is derived from duration limit of Queue Consumers.

    const result = await repo.enterTransactionalScope(async (tx) =>
      safeTry(async function* () {
        const listResult = yield* (
          await tx.listDispatches(
            args?.maxItems || 20,
            args?.continuationToken,
            ["ongoing"],
            "CREATED_AT_ASC",
          )
        ).safeUnwrap();

        const lostDispatches = listResult.list.filter((d) => {
          const lastTime =
            d.executionLog.length > 0
              ? d.executionLog[d.executionLog.length - 1].executedAt
              : d.createdAt;
          const elapsed = Date.now() - lastTime.getTime();

          return elapsed > ((d.delaySeconds || 0) + elapsedSeconds) * 1000; // elapsed from last execution or its creation.
        });

        const result: ResultedDispatch[] = [];
        for (const d of lostDispatches) {
          const resulted = makeDispatchLost(d as OngoingDispatch, new Date());
          result.push(resulted);
          yield* (await repo.saveDispatch(resulted)).safeUnwrap();
        }
        return ok({
          list: result,
          continuationToken: listResult.continuationToken,
        });
      }),
    );
    if (result.isErr()) {
      return Promise.reject(result.error);
    }
    return result.value;
  }
}
