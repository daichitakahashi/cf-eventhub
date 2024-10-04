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

  dispatch(msg: QueueMessage) {
    return this.dispatcher.dispatch(msg);
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
