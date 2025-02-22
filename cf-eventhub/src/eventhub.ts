import { WorkerEntrypoint } from "cloudflare:workers";
import * as v from "valibot";

import type { Handler } from "./core/executor/handler";
import { EventSink } from "./core/hub";
import { Config, type ConfigInput } from "./core/hub/routing";
import { DefaultLogger, type LogLevel, type Logger } from "./core/logger";
import type { Dispatch, Event, ResultedDispatch } from "./core/model";
import type { EventWithDispatches, Repository } from "./core/repository";
import type { EventPayload, RpcSerializable } from "./core/type";

export type RpcEnv = Record<string, unknown> & {
  EVENTHUB_QUEUE: Queue;
  EVENTHUB_ROUTING: string | ConfigInput;
  EVENTHUB_LOG_LEVEL?: string;
  EVENTHUB_LOST_DETECTION_ELAPSED_SECONDS?: string;
};

const getQueue = (env: RpcEnv) => {
  const queue = env.EVENTHUB_QUEUE;
  if (!queue) {
    throw new Error("cf-eventhub: EVENTHUB_QUEUE not set");
  }
  if (typeof queue !== "object" || !("send" in queue)) {
    throw new Error("cf-eventhub: value of EVENTHUB_QUEUE is not a Queue");
  }
  return queue as Queue;
};

const getRouteConfig = (env: RpcEnv) => {
  const routing = env.EVENTHUB_ROUTING;
  if (!routing) {
    throw new Error("cf-eventhub: EVENTHUB_ROUTING not set");
  }
  const maybeConfig =
    typeof routing === "string" ? JSON.parse(routing) : routing;
  return v.parse(Config, maybeConfig);
};

const getLostDetectionElapsedSeconds = (env: RpcEnv) => {
  if (!env.EVENTHUB_LOST_DETECTION_ELAPSED_SECONDS) {
    return undefined;
  }
  const elapsedSeconds = Number.parseInt(
    env.EVENTHUB_LOST_DETECTION_ELAPSED_SECONDS,
  );
  if (!Number.isSafeInteger(elapsedSeconds)) {
    throw new Error(
      "cf-eventhub: EVENTHUB_LOST_DETECTION_ELAPSED_SECONDS is not a safe integer",
    );
  }
  return elapsedSeconds;
};

const getLogLevel = (env: RpcEnv) =>
  (env.EVENTHUB_LOG_LEVEL as LogLevel) || "INFO";

export abstract class RpcEventHub<Env extends RpcEnv = RpcEnv>
  extends WorkerEntrypoint<Env>
  implements Handler
{
  private sink: EventSink;
  private lostDetectionElapsedSeconds: number | undefined;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    const logger = this.getLogger();
    const repo = this.getRepository(logger);
    this.sink = new EventSink(repo, getQueue(env), getRouteConfig(env), logger);
    this.lostDetectionElapsedSeconds = getLostDetectionElapsedSeconds(env);
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

  async handle(
    payload: EventPayload,
  ): Promise<"complete" | "ignored" | "failed"> {
    return this.putEvent([payload])
      .then(() => "complete" as const)
      .catch(() => "failed" as const);
  }

  /**
   * List dispatches.
   * @param args.maxItems Maximum number of dispatches to list. Default is 10.
   * @param args.continuationToken Continuation token for pagination.
   * @param args.filterByStatus Filter dispatches by status.
   * @param args.orderBy Sort order. Default is "CREATED_AT_ASC".
   * @returns List of dispatches and continuation token.
   */
  async listDispatches(args?: {
    maxItems?: number;
    continuationToken?: string;
    filterByStatus?: Dispatch["status"][];
    orderBy?: "CREATED_AT_ASC" | "CREATED_AT_DESC";
  }): Promise<
    RpcSerializable<{ list: Dispatch[]; continuationToken?: string }>
  > {
    return this.sink.listDispatches(args);
  }

  /**
   * Get event.
   * @param eventId Event ID to get.
   */
  async getEvent(eventId: string): Promise<RpcSerializable<Event> | null> {
    return this.sink.getEvent(eventId);
  }

  /**
   * List events.
   * @param args.maxItems Maximum number of events to list. Default is 10.
   * @param args.continuationToken Continuation token for pagination.
   * @param args.orderBy Sort order. Default is "CREATED_AT_ASC".
   * @returns List of events and continuation token.
   */
  async listEvents(args?: {
    maxItems?: number;
    continuationToken?: string;
    orderBy?: "CREATED_AT_ASC" | "CREATED_AT_DESC";
  }): Promise<
    RpcSerializable<{ list: EventWithDispatches[]; continuationToken?: string }>
  > {
    return this.sink.listEvents(args);
  }

  /**
   * Retry dispatch which is in any resulted status.
   * @param args.dispatchId Dispatch ID to retry.
   * @param args.options Dispatch options to override. If options are not provided, the original options are used.
   */
  async retryDispatch(args: {
    dispatchId: string;
    options?: {
      delaySeconds?: number;
      maxRetries?: number;
      retryDelay?: Dispatch["retryDelay"];
    };
  }): Promise<void> {
    return this.sink.retryDispatch(args);
  }

  /**
   * Mark non-resulted dispatches which are meet condition.
   * @param args.maxItems Maximum number of dispatches to mark as lost. Default is 20.
   * @param args.elapsedSeconds Elapsed seconds from last execution time or creation time to mark as lost. Default is 15min(900).
   * @param args.continuationToken Continuation token for pagination.
   * @returns List of dispatches and continuation token.
   *  Even if list is empty, continuation token may be returned (there are ongoing dispatches not scanned).
   */
  async markLostDispatches(args?: {
    maxItems?: number;
    elapsedSeconds?: number;
    continuationToken?: string;
  }): Promise<
    RpcSerializable<{ list: ResultedDispatch[]; continuationToken?: string }>
  > {
    return this.sink.markLostDispatches(args);
  }

  /**
   * Reference implementation of scheduled handler.
   */
  async scheduled(_ctrl: ScheduledController): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const result = await this.markLostDispatches({
        maxItems: 20,
        elapsedSeconds: this.lostDetectionElapsedSeconds,
        continuationToken,
      });
      continuationToken = result.continuationToken;
    } while (continuationToken);
  }
}
