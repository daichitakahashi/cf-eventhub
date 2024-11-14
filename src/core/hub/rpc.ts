import { WorkerEntrypoint } from "cloudflare:workers";
import * as v from "valibot";

import { type EventHub, EventSink } from ".";
import { DefaultLogger, type LogLevel, type Logger } from "../logger";
import type { Dispatch } from "../model";
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

const getLogLevel = (env: Record<string, unknown>) =>
  (env.EVNTHUB_LOG_LEVEL as LogLevel) || "INFO";

export abstract class RpcEventHub<
    Env extends Record<string, unknown> = Record<string, unknown>,
  >
  extends WorkerEntrypoint<Env>
  implements EventHub
{
  private sink: EventSink;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    const logger = this.getLogger();
    const repo = this.getRepository(logger);
    this.sink = new EventSink(repo, getQueue(env), getRouteConfig(env), logger);
  }

  protected getLogger(): Logger {
    return new DefaultLogger(getLogLevel(this.env));
  }

  protected abstract getRepository(logger: Logger): Repository;

  /**
   * Put events.
   * Events are persisted and dispatched to destinations.
   * @param events Events to be put.
   */
  async putEvent(events: EventPayload[]) {
    return this.sink.putEvent(events);
  }

  /**
   * List dispatches.
   * @param args.maxItems Maximum number of dispatches to list. Default is 10.
   * @param args.continuationToken Continuation token for pagination.
   * @param args.filterByStatus Filter dispatches by status.
   * @returns List of dispatches and continuation token.
   */
  async listDispatches(args?: {
    maxItems?: number;
    continuationToken?: string;
    filterByStatus?: Dispatch["status"][];
  }): Promise<{ list: Dispatch[]; continuationToken?: string }> {
    throw new Error("Not implemented");
  }

  /**
   * Retry dispatches which are in any resulted status.
   * @param args.dispatchIds Dispatch IDs to retry.
   * @param args.options Dispatch options to override. If options are not provided, the original options are used.
   */
  async retryDispatches(args: {
    dispatchIds: string[];
    options?: { maxRetries?: number; delaySeconds?: number };
  }): Promise<void> {
    throw new Error("Not implemented");
  }

  scheduled(_ctrl: ScheduledController): Promise<void> {
    return this.sink.markLostDispatches();
  }
}
