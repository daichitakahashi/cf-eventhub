import { WorkerEntrypoint } from "cloudflare:workers";

import { type Executor as BaseExecutor, Dispatcher } from "../core/executor";
import {
  type EventHub as BaseEventHub,
  EventConsumer,
  EventSink,
  getExecutor,
  getQueue,
  getRouteConfig,
} from "../core/hub";
import type { EventPayload, QueueMessage } from "../core/type";
import { createRepository } from "./postgresjs-repository";

export class Executor<
    Env extends Record<string, unknown> = Record<string, unknown>,
  >
  extends WorkerEntrypoint<Env>
  implements BaseExecutor
{
  private dispatcher: Dispatcher;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    const repo = createRepository(env);
    this.dispatcher = new Dispatcher(repo, env);
  }

  dispatch(msg: QueueMessage) {
    return this.dispatcher.dispatch(msg);
  }
}

export class EventHub<
    Env extends Record<string, unknown> = Record<string, unknown>,
  >
  extends WorkerEntrypoint<Env>
  implements BaseEventHub
{
  private sink: EventSink;
  private consumer: EventConsumer;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    const repo = createRepository(env);
    this.sink = new EventSink(repo, getQueue(env), getRouteConfig(env));
    this.consumer = new EventConsumer(getExecutor(env));
  }

  putEvent(events: EventPayload[]) {
    return this.sink.putEvent(events);
  }

  queue(batch: MessageBatch<QueueMessage>) {
    return this.consumer.queue(batch);
  }
}
