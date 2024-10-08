import { WorkerEntrypoint } from "cloudflare:workers";

import { Dispatcher, type Executor } from ".";
import type { Repository } from "../repository";
import type { EventPayload, QueueMessage } from "../type";
import { type Handler, handler } from "./handler";

export abstract class RpcExecutor<
    Env extends Record<string, unknown> = Record<string, unknown>,
  >
  extends WorkerEntrypoint<Env>
  implements Executor
{
  private dispatcher: Dispatcher;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    this.dispatcher = new Dispatcher(this.getRepository(), env);
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
        msg.retry();
      });
  }

  async queue(batch: MessageBatch<QueueMessage>) {
    for (const msg of batch.messages) {
      await this.dispatch(msg);
    }
  }

  protected abstract getRepository(): Repository;
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
