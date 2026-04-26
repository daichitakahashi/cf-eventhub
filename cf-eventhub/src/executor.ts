import { WorkerEntrypoint } from "cloudflare:workers";

import { Dispatcher } from "./core/executor";
import type { Handler } from "./core/executor/handler";
import { FAST_PATH_PATH, parseFastPathRequest } from "./core/fast-path";
import { DefaultLogger, type LogLevel, type Logger } from "./core/logger";
import type { Repository } from "./core/repository";
import { nextDelay } from "./core/retry-delay";
import type { EventPayload, QueueMessage } from "./core/type";
import { formatException } from "./utils/format-exception";

const getLogLevel = (env: Record<string, unknown>) =>
  (env.EVENTHUB_LOG_LEVEL as LogLevel) || "INFO";

const getFastPathSecret = (env: Record<string, unknown>) => {
  const secret = env.EVENTHUB_FAST_PATH_SECRET;
  return typeof secret === "string" && secret.length > 0 ? secret : undefined;
};

export abstract class RpcExecutor<
  Env extends Record<string, unknown> = Record<string, unknown>,
> extends WorkerEntrypoint<Env> {
  private dispatcher: Dispatcher;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    const logger = this.getLogger();
    this.dispatcher = new Dispatcher(this.getRepository(logger), env, logger);
  }

  private async dispatch(msg: Message<QueueMessage>) {
    const logger = this.getLogger();
    const attempt = await this.dispatcher.attemptDispatch(
      msg.body,
      msg.attempts,
    );
    if (attempt.type === "postponed") {
      msg.retry({ delaySeconds: attempt.delaySeconds });
      return;
    }
    const nextDelaySeconds = nextDelay({
      retryDelay: msg.body.retryDelay,
      attempts: msg.attempts,
    });
    return Promise.resolve(attempt.result)
      .then((result) => {
        switch (result) {
          case "complete":
          case "ignored":
          case "misconfigured":
          case "notfound":
            msg.ack();
            break;
          case "failed":
            msg.retry({
              delaySeconds: nextDelaySeconds,
            });
            break;
          default: {
            const _: never = result;
          }
        }
      })
      .catch((e) => {
        logger.error("dispatch rejected", { error: formatException(e) });
        msg.retry({
          delaySeconds: nextDelaySeconds,
        });
      });
  }

  async queue(batch: MessageBatch<QueueMessage>) {
    for (const msg of batch.messages) {
      await this.dispatch(msg);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== FAST_PATH_PATH) {
      return new Response(null, { status: 404 });
    }

    const secret = getFastPathSecret(this.env);
    if (!secret) {
      return new Response(null, { status: 404 });
    }

    const payload = await parseFastPathRequest(request, secret).catch((e) => {
      this.getLogger().error("failed to parse fast path request", {
        error: formatException(e),
      });
      return null;
    });
    if (!payload) {
      return new Response(null, { status: 401 });
    }

    const results = [];
    for (const msg of payload.dispatches) {
      const attempt = await this.dispatcher.attemptDispatch(msg);
      if (attempt.type === "postponed") {
        results.push({
          dispatchId: msg.dispatchId,
          result: "postponed",
          delaySeconds: attempt.delaySeconds,
        });
        continue;
      }
      results.push({
        dispatchId: msg.dispatchId,
        result: attempt.result,
      });
    }

    return Response.json({ results });
  }

  protected getLogger() {
    return new DefaultLogger(getLogLevel(this.env));
  }

  protected abstract getRepository(logger: Logger): Repository;
}

export abstract class RpcHandler<
    Env extends Record<string, unknown> = Record<string, unknown>,
  >
  extends WorkerEntrypoint<Env>
  implements Handler
{
  abstract handle(
    payload: EventPayload,
  ): Promise<"complete" | "ignored" | "failed">;
}
