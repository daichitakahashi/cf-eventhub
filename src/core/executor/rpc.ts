import { WorkerEntrypoint } from "cloudflare:workers";

import { Dispatcher, type Executor } from ".";
import { DefaultLogger, type LogLevel, type Logger } from "../logger";
import type { Repository } from "../repository";
import type { EventPayload, QueueMessage } from "../type";
import { type Handler, handler } from "./handler";

const getLogLevel = (env: Record<string, unknown>) =>
  (env.EVNTHUB_LOG_LEVEL as LogLevel) || "INFO";

export abstract class RpcExecutor<
    Env extends Record<string, unknown> = Record<string, unknown>,
  >
  extends WorkerEntrypoint<Env>
  implements Executor
{
  private dispatcher: Dispatcher;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    const logger = this.getLogger();
    this.dispatcher = new Dispatcher(this.getRepository(logger), env, logger);
  }

  private async dispatch(msg: Message<QueueMessage>) {
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
            msg.retry();
            break;
          default: {
            const _: never = result;
          }
        }
      })
      .catch(() => {
        msg.retry({
          delaySeconds: msg.body.delaySeconds,
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
  [handler] = true as const;

  abstract handle(
    payload: EventPayload,
  ): Promise<"complete" | "ignored" | "failed">;
}
