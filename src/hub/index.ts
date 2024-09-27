import { WorkerEntrypoint } from "cloudflare:workers";
import { ok, safeTry } from "neverthrow";
import * as v from "valibot";

import type { NewDispatch, NewEvent } from "../core/model";
import type { Repository } from "../core/repository";
import type { Executor } from "../executor";
import type { EventPayload } from "../type";
import { type QueueMessage, enqueue } from "./queue";
import { RouteConfig, findRoutes } from "./routing";

const constVoid = (() => {})();

export abstract class EventHub<
  Env extends Record<string, unknown> = Record<string, unknown>,
> extends WorkerEntrypoint<Env> {
  private _repo: Repository;
  private _queue: Queue;
  private _routing: RouteConfig;
  private _executor: Executor;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    this._repo = this.getRepository(env);
    this._queue = this.getQueue();
    this._routing = this.getRouting();
    this._executor = this.getExecutor();
  }

  private getQueue() {
    const queue = this.env.EVENTHUB_QUEUE;
    if (!queue) {
      throw new Error("cf-eventhub: EVENTHUB_QUEUE not set");
    }
    if (typeof queue !== "object" || "send" in queue) {
      throw new Error("cf-eventhub: value of EVENTHUB_QUEUE is not a Queue");
    }
    return queue as Queue;
  }

  private getRouting() {
    const routing = this.env.EVENTHUB_ROUTING;
    if (!routing) {
      throw new Error("cf-eventhub: EVENTHUB_ROUTING not set");
    }
    if (typeof routing !== "string") {
      throw new Error("cf-eventhub: value of EVENTHUB_Routing is not a string");
    }

    return v.parse(RouteConfig, JSON.parse(routing));
  }

  private getExecutor() {
    const executor = this.env.EVENTHUB_EXECUTOR;
    if (!executor) {
      throw new Error("cf-eventhub: EVENTHUB_EXECUTOR not set");
    }
    if (typeof executor !== "object" || "dispatch" in executor) {
      throw new Error(
        "cf-eventhub: value of EVENTHUB_EXECUTOR is not a Executor",
      );
    }
    return executor as Executor;
  }

  protected abstract getRepository(env: Env): Repository;

  /**
   *
   * @param events Events to be emitted
   */
  async emit(events: EventPayload[]) {
    // Skip empty.
    if (events.length === 0) {
      return;
    }
    const routing = this._routing;
    const queue = this._queue;

    const result = await this._repo.enterTransactionalScope(async (tx) =>
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
    return Promise.resolve(constVoid);
  }

  private async dispatch(msg: Message<QueueMessage>) {
    await this._executor
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
