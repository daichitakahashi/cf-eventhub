import { WorkerEntrypoint } from "cloudflare:workers";

import { Dispatcher } from "./core/executor";
import type { Handler } from "./core/executor/handler";
import { DefaultLogger, type LogLevel, type Logger } from "./core/logger";
import type { Repository } from "./core/repository";
import { nextDelay } from "./core/retry-delay";
import type { EventPayload, QueueMessage } from "./core/type";

const getLogLevel = (env: Record<string, unknown>) =>
  (env.EVENTHUB_LOG_LEVEL as LogLevel) || "INFO";

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
    const nextDelaySeconds = nextDelay({
      retryDelay: msg.body.retryDelay,
      attempts: msg.attempts,
    });
    return this.dispatcher
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
        logger.error("dispatch rejected", { error: e });
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
