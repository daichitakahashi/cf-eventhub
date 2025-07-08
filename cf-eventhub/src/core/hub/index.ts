import { err, ok, safeTry } from "neverthrow";

import type { Logger } from "../logger";
import {
  type CreatedEvent,
  type Dispatch,
  type NewDispatch,
  type NewEvent,
  type ResultedDispatch,
  makeDispatchLost,
} from "../model";
import type { EventWithDispatches, Repository } from "../repository";
import type { EventPayload } from "../type";
import { type QueueMessage, enqueue } from "./queue";
import { type Config, findRoutes } from "./routing";

const constVoid = (() => {})();

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

    const result = await repo.mutate(async (tx) =>
      safeTry(async function* () {
        const createdAt = new Date();

        logger.info(`put ${events.length} events`, { events });

        // Create events.
        const newEvents = events.map(
          (e): Omit<NewEvent, "id"> => ({
            payload: e,
            createdAt,
          }),
        );
        const created = yield* await tx.createEvents(newEvents);

        // Find destinations for each event and create dispatches.
        const dispatches = created.flatMap((e) =>
          findRoutes(routing, e.payload).map(
            ({
              destination,
              delaySeconds,
              maxRetries,
              retryDelay,
            }): NewDispatch => ({
              eventId: e.id, // Event id is created by Persistence.saveEvents.
              destination,
              createdAt,
              delaySeconds,
              maxRetries,
              retryDelay,
            }),
          ),
        );

        if (dispatches.length > 0) {
          logger.info(`create ${dispatches.length} dispatches`, () => {
            const eventMap = created.reduce((acc, e) => {
              acc.set(e.id, e);
              return acc;
            }, new Map<string, CreatedEvent>());
            return {
              dispatches: dispatches.map((d) => ({
                destination: d.destination,
                event: eventMap.get(d.eventId)?.payload,
              })),
            };
          });

          // Create dispatches.
          const createdDispatches = yield* await tx.createDispatches(
            dispatches,
          );

          // Dispatch messages.
          const messages = createdDispatches.map(
            (d): MessageSendRequest<QueueMessage> => ({
              body: {
                dispatchId: d.id, // Dispatch id is created by Persistence.saveDispatches.
                retryDelay: d.retryDelay,
              },
              contentType: "v8",
              delaySeconds: d.delaySeconds || undefined, // first delay
            }),
          );
          yield* enqueue(queue, messages, logger);
        } else {
          logger.info("no dispatches created");
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
    const result = await this.repo.readDispatches(
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

  async listEvents(args?: {
    maxItems?: number;
    continuationToken?: string;
    orderBy?: "CREATED_AT_ASC" | "CREATED_AT_DESC";
  }): Promise<{ list: EventWithDispatches[]; continuationToken?: string }> {
    const result = await this.repo.readEvents(
      args?.maxItems || 10,
      args?.continuationToken,
      args?.orderBy,
    );
    if (result.isErr()) {
      return Promise.reject(result.error);
    }
    return result.value;
  }

  async getEvent(eventId: string): Promise<EventWithDispatches | null> {
    const result = await this.repo.readEvent(eventId);
    if (result.isErr()) {
      return Promise.reject(result.error);
    }
    return result.value;
  }

  async getDispatch(dispatchId: string): Promise<Dispatch | null> {
    const result = await this.repo.mutate((tx) =>
      tx.getTargetDispatch(dispatchId),
    );
    if (result.isErr()) {
      return Promise.reject(result.error);
    }
    return result.value?.dispatch || null;
  }

  async retryDispatch(args: {
    dispatchId: string;
    options?: {
      delaySeconds?: number;
      maxRetries?: number;
      retryDelay?: NewDispatch["retryDelay"];
    };
  }): Promise<void> {
    const queue = this.queue;
    const repo = this.repo;
    const logger = this.logger;

    const result = await repo.mutate(async (tx) =>
      safeTry(async function* () {
        const { dispatchId, options } = args;

        // Get target dispatch.
        const data = yield* await tx.getTargetDispatch(dispatchId);
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
          retryDelay: options?.retryDelay || dispatch.retryDelay,
        };
        const [created] = yield* await tx.createDispatches([newDispatch]);

        const message: MessageSendRequest<QueueMessage> = {
          body: {
            dispatchId: created.id,
            retryDelay: created.retryDelay,
          },
          contentType: "v8",
          delaySeconds: created.delaySeconds || undefined, // first delay
        };

        yield* await enqueue(queue, [message], logger);
        return ok(constVoid);
      }),
    );

    if (result.isErr()) {
      return Promise.reject(result.error);
    }
  }

  private async markDispatchLost(args: {
    dispatchId: string;
    elapsedSeconds?: number;
  }) {
    const repo = this.repo;
    const elapsedSeconds = args?.elapsedSeconds || 60 * 15; // Default value (15 min) is derived from duration limit of Queue Consumers.

    return repo.mutate(async (tx) =>
      safeTry(async function* () {
        const result = yield* await tx.getTargetDispatch(args.dispatchId);
        if (result === null) {
          return ok(null);
        }

        const { dispatch: d } = result;
        if (d.status !== "ongoing") {
          return ok(null);
        }

        const lastTime =
          d.executionLog.length > 0
            ? d.executionLog[d.executionLog.length - 1].executedAt
            : d.createdAt;
        const elapsed = (Date.now() - lastTime.getTime()) / 1000;

        const lost = elapsed > (d.delaySeconds || 0) + elapsedSeconds; // elapsed from last execution or its creation.
        if (!lost) {
          return ok(null);
        }

        const lostDispatch = makeDispatchLost(d, new Date());
        yield* await tx.saveDispatch(lostDispatch);
        return ok(lostDispatch);
      }),
    );
  }

  async markLostDispatches(args?: {
    maxItems?: number;
    elapsedSeconds?: number;
    continuationToken?: string;
  }): Promise<{ list: ResultedDispatch[]; continuationToken?: string }> {
    const repo = this.repo;
    const logger = this.logger;
    const elapsedSeconds = args?.elapsedSeconds || 60 * 15; // Default value (15 min) is derived from duration limit of Queue Consumers.

    const sink = this;

    const result = await safeTry(async function* () {
      const listResult = yield* await repo.readDispatches(
        args?.maxItems || 20,
        args?.continuationToken,
        ["ongoing"],
        "CREATED_AT_ASC",
      );

      const lostDispatches: ResultedDispatch[] = [];
      for (const d of listResult.list) {
        const lost = yield* await sink.markDispatchLost({
          dispatchId: d.id,
          elapsedSeconds,
        });
        if (lost) {
          lostDispatches.push(lost);
        }
      }

      logger.debug("markLostDispatches", {
        ongoingDispatches: listResult.list,
        lostDispatches,
        elapsedSeconds,
      });
      return ok({
        list: lostDispatches,
        continuationToken: listResult.continuationToken,
      });
    });

    if (result.isErr()) {
      return Promise.reject(result.error);
    }
    return result.value;
  }
}
