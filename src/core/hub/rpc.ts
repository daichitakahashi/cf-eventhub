import { WorkerEntrypoint } from "cloudflare:workers";
import * as v from "valibot";

import { type EventHub, EventSink } from ".";
import type { Executor } from "../executor";
import type { Repository } from "../repository";
import type { EventPayload } from "../type";
import type { QueueMessage } from "./queue";
import { Config } from "./routing";

const getQueue = (env: Record<string, unknown>) => {
  const queue = env.EVENTHUB_QUEUE;
  if (!queue) {
    throw new Error("cf-eventhub: EVENTHUB_QUEUE not set");
  }
  if (typeof queue !== "object" || "send" in queue) {
    throw new Error("cf-eventhub: value of EVENTHUB_QUEUE is not a Queue");
  }
  return queue as Queue;
};

const getRouteConfig = (env: Record<string, unknown>) => {
  const routing = env.EVENTHUB_ROUTING;
  if (!routing) {
    throw new Error("cf-eventhub: EVENTHUB_ROUTING not set");
  }
  if (typeof routing !== "string") {
    throw new Error("cf-eventhub: value of EVENTHUB_Routing is not a string");
  }

  return v.parse(Config, JSON.parse(routing));
};

const getExecutor = (env: Record<string, unknown>) => {
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

export abstract class RpcEventHub<
    Env extends Record<string, unknown> = Record<string, unknown>,
  >
  extends WorkerEntrypoint<Env>
  implements EventHub
{
  private sink: EventSink;
  private executor: Executor;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    const repo = this.getRepository();
    this.sink = new EventSink(repo, getQueue(env), getRouteConfig(env));
    this.executor = getExecutor(env);
  }

  protected abstract getRepository(): Repository;

  putEvent(events: EventPayload[]) {
    return this.sink.putEvent(events);
  }

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
