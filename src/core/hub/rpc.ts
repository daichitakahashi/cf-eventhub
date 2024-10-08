import { WorkerEntrypoint } from "cloudflare:workers";
import * as v from "valibot";

import { type EventHub, EventSink } from ".";
import type { Repository } from "../repository";
import type { EventPayload } from "../type";
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

export abstract class RpcEventHub<
    Env extends Record<string, unknown> = Record<string, unknown>,
  >
  extends WorkerEntrypoint<Env>
  implements EventHub
{
  private sink: EventSink;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    const repo = this.getRepository();
    this.sink = new EventSink(repo, getQueue(env), getRouteConfig(env));
  }

  protected abstract getRepository(): Repository;

  putEvent(events: EventPayload[]) {
    return this.sink.putEvent(events);
  }
}
